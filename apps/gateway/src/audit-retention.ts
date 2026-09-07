// Audit retention (ADR-0012): periodic batched cleanup + a probabilistic lazy
// fallback on the write path. Purge ONLY — no archive/offload (the ADR's
// DSH_GATEWAY_AUDIT_ARCHIVE_DIR is intentionally absent). Kept tiny and
// store-agnostic so the gateway wiring (main.ts) and unit tests can drive it.
//
// Design notes:
// - `purgeNow()` deletes in small batches (default 1000 rows per store call)
//   so a long sweep never runs as one big DELETE holding the SQLite WAL.
// - A startup pass + the periodic interval keep a stale database trimmed.
// - Because every append goes through `store.appendAudit`, the wrapper in
//   `createAuditRetention` probabilistically triggers a purge after an append
//   (1-in-lazySample, gated by a cooldown and a single-flight flag). This is
//   the "lazy cleanup" backstop: even if the interval task never ran, the
//   table cannot grow without bound.
// - retentionDays < 1 disables retention entirely (start/interval/lazy no-op).

import type { AuditEvent, IStore } from 'dsh-gateway-store'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 1000
/** Cap purgeNow's inner loop so an unlucky steady state never spins forever. */
const MAX_PURGE_ROUNDS = 10_000

export interface AuditRetentionOptions {
  /** Events older than this many days are deleted. < 1 disables retention. */
  retentionDays: number
  /** Cadence of the periodic purge task (ms). */
  purgeIntervalMs: number
  /** Max rows deleted per store call (default 1000). */
  batchSize?: number
  /** Lazy cleanup: 1-in-N appends may trigger a purge after the cooldown. */
  lazySample?: number
  /** Minimum gap between lazy purges (default 60s). */
  lazyCooldownMs?: number
  /** Injectable clock / RNG for tests. */
  now?: () => number
  random?: () => number
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

export interface AuditRetention {
  /** Run one full batched purge pass now. Returns rows deleted (0 when disabled/running). */
  purgeNow(): Promise<number>
  /** Startup pass + periodic interval. No-op when retention is disabled. */
  start(): void
  stop(): void
}

export function cutoffBefore(retentionDays: number, nowMs: number): string {
  return new Date(nowMs - retentionDays * DAY_MS).toISOString()
}

export function createAuditRetention(store: IStore, opts: AuditRetentionOptions): AuditRetention {
  const { retentionDays, purgeIntervalMs } = opts
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const lazySample = opts.lazySample ?? 100
  const lazyCooldownMs = opts.lazyCooldownMs ?? 60_000
  const now = opts.now ?? Date.now
  const rand = opts.random ?? Math.random
  const log = opts.log

  let timer: NodeJS.Timeout | undefined
  let running = false
  let lastPurgeAt = 0

  async function purgeNow(): Promise<number> {
    if (retentionDays < 1 || running) return 0
    running = true
    try {
      const before = cutoffBefore(retentionDays, now())
      let total = 0
      for (let i = 0; i < MAX_PURGE_ROUNDS; i++) {
        const removed = await store.purgeAudit(before, batchSize)
        total += removed
        if (removed < batchSize) break
      }
      lastPurgeAt = now()
      if (total > 0) log?.info?.(`audit retention: purged ${total} rows older than ${before}`)
      return total
    } finally {
      running = false
    }
  }

  /** Fire-and-forget purge that never surfaces an unhandled rejection. */
  function schedulePurge(): void {
    void purgeNow().catch((err) => log?.warn?.(`audit retention purge failed: ${String((err as Error).message ?? err)}`))
  }

  function start(): void {
    if (retentionDays < 1) {
      log?.warn?.('audit retention disabled (DSH_GATEWAY_AUDIT_RETENTION_DAYS < 1) — audit rows are never auto-purged')
      return
    }
    if (timer) return
    schedulePurge() // trim a stale database immediately on startup
    timer = setInterval(schedulePurge, Math.max(1, purgeIntervalMs))
    timer.unref?.()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  // ---- lazy fallback: wrap appendAudit (ADR-0012 §B) --------------------------
  const originalAppend = store.appendAudit.bind(store)
  store.appendAudit = async (e: AuditEvent) => {
    await originalAppend(e)
    maybeLazyPurge()
  }

  function maybeLazyPurge(): void {
    if (lazySample <= 0 || retentionDays < 1 || running) return
    const t = now()
    if (t - lastPurgeAt < lazyCooldownMs) return
    if (rand() * lazySample >= 1) return // 1-in-lazySample
    schedulePurge()
  }

  return { purgeNow, start, stop }
}
