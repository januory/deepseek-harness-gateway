// Audit retention unit tests (ADR-0012): the purge task in audit-retention.ts
// (batched purge, periodic interval, probabilistic lazy write-path backstop,
// and the retention-disabled no-op) driven against an InMemoryStore.

import { describe, it, expect } from 'vitest'
import { InMemoryStore } from 'dsh-gateway-store'
import { createAuditRetention, cutoffBefore, type AuditRetentionOptions } from '../src/audit-retention.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-08T00:00:00.000Z')

const OLD_TS = [
  '2020-01-01T00:00:00.000Z',
  '2020-02-01T00:00:00.000Z',
  '2020-03-01T00:00:00.000Z',
  '2020-04-01T00:00:00.000Z',
  '2020-05-01T00:00:00.000Z',
]
const RECENT_TS = '2026-09-01T00:00:00.000Z' // inside the default 30-day window

function makeEvent(ts: string) {
  return { ts, actor: 'admin', action: 'login', result: 'ok' as const }
}

async function seedOld(store: InMemoryStore, n = OLD_TS.length) {
  for (const ts of OLD_TS.slice(0, n)) await store.appendAudit(makeEvent(ts))
}

function makeRetention(store: InMemoryStore, overrides: Partial<AuditRetentionOptions> = {}) {
  return createAuditRetention(store, {
    retentionDays: 30,
    purgeIntervalMs: 60_000,
    now: () => NOW,
    random: () => 0.9999, // lazy almost never fires unless lazySample forces it
    ...overrides,
  })
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

describe('cutoffBefore', () => {
  it('returns an ISO cutoff exactly retentionDays before now', () => {
    expect(cutoffBefore(30, NOW)).toBe('2026-08-09T00:00:00.000Z')
    expect(cutoffBefore(0, NOW)).toBe('2026-09-08T00:00:00.000Z')
    expect(cutoffBefore(30, NOW)).toBe(new Date(NOW - 30 * DAY_MS).toISOString())
  })
})

describe('createAuditRetention', () => {
  it('is a no-op when retention is disabled (days < 1)', async () => {
    const store = new InMemoryStore()
    await seedOld(store)
    const ret = makeRetention(store, { retentionDays: 0 })
    expect(await ret.purgeNow()).toBe(0)
    expect(await store.queryAudit()).toHaveLength(OLD_TS.length) // nothing removed
    // start() with retention disabled also schedules nothing (no crash).
    ret.start()
    await tick()
    expect(await store.queryAudit()).toHaveLength(OLD_TS.length)
    ret.stop()
  })

  it('purges everything older than the cutoff in batches', async () => {
    const store = new InMemoryStore()
    await seedOld(store, 5)
    await store.appendAudit(makeEvent(RECENT_TS))
    const ret = makeRetention(store, { batchSize: 2 }) // 5 old rows → 3 store calls
    expect(await ret.purgeNow()).toBe(5)
    const left = await store.queryAudit()
    expect(left).toHaveLength(1)
    expect(left[0].ts).toBe(RECENT_TS) // inside-window rows are kept
    // A second pass has nothing left to delete.
    expect(await ret.purgeNow()).toBe(0)
    ret.stop()
  })

  it('keeps rows exactly at the cutoff (strict < comparison)', async () => {
    const store = new InMemoryStore()
    await store.appendAudit(makeEvent('2026-08-09T00:00:00.000Z')) // === cutoff
    await store.appendAudit(makeEvent('2026-08-08T23:59:59.999Z')) // 1ms older
    const ret = makeRetention(store)
    expect(await ret.purgeNow()).toBe(1)
    expect((await store.queryAudit()).map((e) => e.ts)).toEqual(['2026-08-09T00:00:00.000Z'])
    ret.stop()
  })

  it('lazy write-path backstop purges after an append', async () => {
    const store = new InMemoryStore()
    await seedOld(store, 2)
    const ret = makeRetention(store, { lazySample: 1, lazyCooldownMs: 0, random: () => 0 })
    // The next append (through the wrapped store.appendAudit) must trigger a purge.
    await store.appendAudit(makeEvent(RECENT_TS))
    await tick()
    const left = await store.queryAudit()
    expect(left).toHaveLength(1)
    expect(left[0].ts).toBe(RECENT_TS)
    ret.stop()
  })

  it('periodic interval keeps purging rows that age past the window', async () => {
    const store = new InMemoryStore()
    await store.appendAudit(makeEvent(RECENT_TS))
    const ret = makeRetention(store, {
      purgeIntervalMs: 40,
      lazySample: 10_000, // keep lazy out of the way: interval is under test
      now: Date.now,
    })
    ret.start()
    await tick(20)
    // A row that is already far older than the window when the interval ticks.
    await store.appendAudit(makeEvent('2020-06-01T00:00:00.000Z'))
    await tick(200)
    const left = await store.queryAudit()
    expect(left.map((e) => e.ts)).not.toContain('2020-06-01T00:00:00.000Z')
    expect(left.map((e) => e.ts)).toContain(RECENT_TS)
    ret.stop()
  })
})
