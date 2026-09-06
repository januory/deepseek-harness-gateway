// Login rate limiting: per-IP volume cap + per-account failure lockout with
// escalating backoff. In-memory only (single-process gateway, same as
// SessionStore) — resets on restart, which the security plan accepts.
//
// Chosen over @fastify/rate-limit because one route needs TWO dimensions
// (source IP and target account) AND a per-account lockout whose duration
// escalates across successive lockouts (3 → 5 → 15 minutes). A single
// plugin rule can express neither the composite key nor the growing window.

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

export type ThrottleCheck = { ok: true } | { ok: false; retryAfterSec: number }

export class LoginThrottle {
  private readonly accounts = new Map<string, AccountState>()
  private readonly ips = new Map<string, IpState>()
  private readonly now: () => number

  constructor(
    private readonly cfg: LoginThrottleConfig,
    now: () => number = Date.now,
  ) {
    this.now = now
  }

  /** Whether a login attempt may proceed; returns Retry-After seconds if blocked. */
  check(ip: string, account: string): ThrottleCheck {
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
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(backoff / 1000)) }
      }
    }

    return { ok: true }
  }

  /** Record a failed (invalid-credentials) attempt. */
  recordFailure(ip: string, account: string): void {
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
  }

  /** Clear an account's failure history after a successful login. */
  recordSuccess(account: string): void {
    this.accounts.delete(account)
  }

  /** Drop expired state to bound memory. */
  prune(now: number = this.now()): void {
    for (const [ip, s] of this.ips) {
      s.attempts = s.attempts.filter((t) => now - t < this.cfg.ipWindowMs)
      if (s.attempts.length === 0) this.ips.delete(ip)
    }
    for (const [account, s] of this.accounts) {
      s.fails = s.fails.filter((t) => now - t < this.cfg.accountWindowMs)
      if (s.lockUntil <= now && s.fails.length === 0) this.accounts.delete(account)
    }
  }
}
