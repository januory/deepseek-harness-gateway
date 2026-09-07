// Login rate limiting: per-IP volume cap + per-account failure lockout with
// escalating backoff. Dual-dimension key + growing window (3 → 5 → 15 min)
// cannot be expressed by a single @fastify/rate-limit rule, hence the custom
// class.
//
// Persistence (persistent lockout): when constructed with a `persist` sink the
// account/IP state is hydrated on start and every mutation is written through,
// so lockouts and per-IP windows survive a gateway restart instead of being
// wiped (security audit M-2 backlog). Without a sink the class is plain
// in-memory (single-process dev), same as before.

export interface LoginThrottleConfig {
  /** Max login attempts per IP within `ipWindowMs`. */
  ipMax: number
  ipWindowMs: number
  /** Failed attempts per account within `accountWindowMs` before lockout. */
  accountMax: number
  accountWindowMs: number
  /** Escalating lockout durations (ms) for successive lockouts of one account. */
  backoffMs: number[]
}

interface AccountState {
  /** Timestamps of recent failures (within accountWindowMs). */
  fails: number[]
  /** Epoch ms until which the account is locked out (0 = not locked). */
  lockUntil: number
  /** Number of lockouts already served (drives the backoff escalation). */
  lockCount: number
}

interface IpState {
  /** Timestamps of recent attempts (within ipWindowMs). */
  attempts: number[]
}

export interface LoginThrottlePersistence {
  /** Load all persisted account/IP state (called once before serving). */
  hydrate(): Promise<{
    accounts: Array<{ account: string; fails: number[]; lockUntil: number; lockCount: number }>
    ips: Array<{ ip: string; attempts: number[] }>
  }>
  saveAccount(account: string, state: { fails: number[]; lockUntil: number; lockCount: number }): Promise<void>
  saveIp(ip: string, attempts: number[]): Promise<void>
  deleteAccount(account: string): Promise<void>
  deleteIp(ip: string): Promise<void>
}

export type ThrottleCheck = { ok: true } | { ok: false; retryAfterSec: number }

export class LoginThrottle {
  private readonly accounts = new Map<string, AccountState>()
  private readonly ips = new Map<string, IpState>()
  private readonly now: () => number

  constructor(
    private readonly cfg: LoginThrottleConfig,
    now: () => number = Date.now,
    private readonly persist?: LoginThrottlePersistence,
  ) {
    this.now = now
  }

  /** Load persisted state so a lockout/attempt window survives a restart. */
  async hydrate(): Promise<void> {
    if (!this.persist) return
    const [{ accounts, ips }, now] = await Promise.all([this.persist.hydrate(), Promise.resolve(this.now())])
    for (const a of accounts) {
      this.accounts.set(a.account, {
        fails: a.fails.filter((t) => now - t < this.cfg.accountWindowMs),
        lockUntil: a.lockUntil,
        lockCount: a.lockCount,
      })
    }
    for (const r of ips) {
      this.ips.set(r.ip, { attempts: r.attempts.filter((t) => now - t < this.cfg.ipWindowMs) })
    }
  }

  /** Whether a login attempt may proceed; returns Retry-After seconds if blocked. */
  async check(ip: string, account: string): Promise<ThrottleCheck> {
    const now = this.now()

    const ipState = this.ips.get(ip)
    if (ipState) {
      ipState.attempts = ipState.attempts.filter((t) => now - t < this.cfg.ipWindowMs)
      if (ipState.attempts.length >= this.cfg.ipMax) {
        const retryMs = ipState.attempts[0] + this.cfg.ipWindowMs - now
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) }
      }
    }

    const acc = this.accounts.get(account)
    if (acc) {
      if (acc.lockUntil > now) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((acc.lockUntil - now) / 1000)) }
      }
      acc.fails = acc.fails.filter((t) => now - t < this.cfg.accountWindowMs)
      if (acc.fails.length >= this.cfg.accountMax) {
        const backoff = this.cfg.backoffMs[Math.min(acc.lockCount, this.cfg.backoffMs.length - 1)]
        acc.lockUntil = now + backoff
        acc.lockCount += 1
        acc.fails = []
        if (this.persist) {
          await this.persist.saveAccount(account, { fails: acc.fails, lockUntil: acc.lockUntil, lockCount: acc.lockCount })
        }
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(backoff / 1000)) }
      }
    }

    return { ok: true }
  }

  /** Record a failed (invalid-credentials) attempt. */
  async recordFailure(ip: string, account: string): Promise<void> {
    const now = this.now()
    let ipState = this.ips.get(ip)
    if (!ipState) {
      ipState = { attempts: [] }
      this.ips.set(ip, ipState)
    }
    ipState.attempts.push(now)

    let acc = this.accounts.get(account)
    if (!acc) {
      acc = { fails: [], lockUntil: 0, lockCount: 0 }
      this.accounts.set(account, acc)
    }
    acc.fails.push(now)

    if (this.persist) {
      await Promise.all([
        this.persist.saveIp(ip, ipState.attempts),
        this.persist.saveAccount(account, { fails: acc.fails, lockUntil: acc.lockUntil, lockCount: acc.lockCount }),
      ])
    }
  }

  /** Clear an account's failure history after a successful login. */
  async recordSuccess(account: string): Promise<void> {
    this.accounts.delete(account)
    if (this.persist) {
      await this.persist.deleteAccount(account)
    }
  }

  /** Drop expired state to bound memory (and persisted rows when enabled). */
  async prune(now: number = this.now()): Promise<void> {
    const droppedIps: string[] = []
    for (const [ip, s] of this.ips) {
      s.attempts = s.attempts.filter((t) => now - t < this.cfg.ipWindowMs)
      if (s.attempts.length === 0) {
        this.ips.delete(ip)
        droppedIps.push(ip)
      }
    }
    const droppedAccounts: string[] = []
    for (const [account, s] of this.accounts) {
      s.fails = s.fails.filter((t) => now - t < this.cfg.accountWindowMs)
      if (s.lockUntil <= now && s.fails.length === 0) {
        this.accounts.delete(account)
        droppedAccounts.push(account)
      }
    }
    const persist = this.persist
    if (persist) {
      await Promise.all([
        ...droppedIps.map((ip) => persist.deleteIp(ip)),
        ...droppedAccounts.map((a) => persist.deleteAccount(a)),
      ])
    }
  }

  /** Periodic expired-state sweep (unref'd so it never holds the process open). */
  startPrune(intervalMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => {
      void this.prune()
    }, intervalMs)
    t.unref?.()
    return t
  }
}
