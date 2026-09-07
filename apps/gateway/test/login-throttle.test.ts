import { describe, it, expect } from 'vitest'
import { LoginThrottle, type LoginThrottlePersistence } from '../src/login-throttle.js'

const MIN = 60_000

function makeClock(start = 1_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function makeThrottle(
  clock: ReturnType<typeof makeClock>,
  overrides: Partial<ConstructorParameters<typeof LoginThrottle>[0]> = {},
  persist?: LoginThrottlePersistence,
) {
  return new LoginThrottle(
    {
      ipMax: 10,
      ipWindowMs: 15 * MIN,
      accountMax: 5,
      accountWindowMs: 15 * MIN,
      backoffMs: [3 * MIN, 5 * MIN, 15 * MIN],
      ...overrides,
    },
    clock.now,
    persist,
  )
}

/** A map-backed LoginThrottlePersistence shared across "restarts". */
function makeMemPersist(): LoginThrottlePersistence {
  const accounts = new Map<string, { fails: number[]; lockUntil: number; lockCount: number }>()
  const ips = new Map<string, number[]>()
  return {
    async hydrate() {
      return {
        accounts: [...accounts.entries()].map(([account, s]) => ({ account, fails: [...s.fails], lockUntil: s.lockUntil, lockCount: s.lockCount })),
        ips: [...ips.entries()].map(([ip, attempts]) => ({ ip, attempts: [...attempts] })),
      }
    },
    async saveAccount(account, s) {
      accounts.set(account, { fails: [...s.fails], lockUntil: s.lockUntil, lockCount: s.lockCount })
    },
    async saveIp(ip, attempts) {
      ips.set(ip, [...attempts])
    },
    async deleteAccount(account) {
      accounts.delete(account)
    },
    async deleteIp(ip) {
      ips.delete(ip)
    },
  }
}

describe('LoginThrottle', () => {
  it('allows up to accountMax failures then locks with the first backoff', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 5; i++) {
      expect((await t.check('1.1.1.1', 'admin')).ok).toBe(true)
      await t.recordFailure('1.1.1.1', 'admin')
    }
    const blocked = await t.check('1.1.1.1', 'admin')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBe(180)
      expect(blocked.reason).toBe('account')
    }
  })

  it('keeps denying during the lockout and releases after it', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 5; i++) await t.recordFailure('ip', 'admin')
    expect((await t.check('ip', 'admin')).ok).toBe(false)
    clock.advance(2 * MIN) // still inside the 3-minute lock
    const still = await t.check('ip', 'admin')
    expect(still.ok).toBe(false)
    if (!still.ok) expect(still.reason).toBe('account')
    clock.advance(2 * MIN) // 4 minutes total — past the lock
    expect((await t.check('ip', 'admin')).ok).toBe(true)
  })

  it('escalates the lockout duration across successive lockouts', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    const fail5 = async (ip: string) => {
      for (let i = 0; i < 5; i++) await t.recordFailure(ip, 'admin')
    }
    await fail5('ip1')
    let blocked = await t.check('ip1', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(180)

    clock.advance(3 * MIN) // first lock expires
    await fail5('ip2')
    blocked = await t.check('ip2', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(300)

    clock.advance(5 * MIN) // second lock expires
    await fail5('ip3')
    blocked = await t.check('ip3', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(900)
  })

  it('a success clears the account failure history', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 4; i++) await t.recordFailure('ip', 'admin')
    await t.recordSuccess('admin')
    for (let i = 0; i < 5; i++) {
      expect((await t.check('ip', 'admin')).ok).toBe(true)
      await t.recordFailure('ip', 'admin')
    }
  })

  it('caps per-IP attempts within the window', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 10; i++) {
      expect((await t.check('1.2.3.4', `user${i}`)).ok).toBe(true)
      await t.recordFailure('1.2.3.4', `user${i}`)
    }
    const blocked = await t.check('1.2.3.4', 'another')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('ip')
  })

  it('prune drops expired account and IP state', async () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    await t.recordFailure('1.1.1.1', 'admin')
    expect((await t.check('1.1.1.1', 'admin')).ok).toBe(true)
    clock.advance(16 * MIN)
    await t.prune()
    for (let i = 0; i < 5; i++) {
      expect((await t.check('1.1.1.1', 'admin')).ok).toBe(true)
      await t.recordFailure('1.1.1.1', 'admin')
    }
    expect((await t.check('1.1.1.1', 'admin')).ok).toBe(false)
  })
})

describe('LoginThrottle persistence (persistent lockout)', () => {
  it('lockout survives a restart and keeps escalating', async () => {
    const persist = makeMemPersist()
    // High ipMax isolates the account lockout from the (also persisted) per-IP cap.
    const clock = makeClock()

    const t1 = makeThrottle(clock, { ipMax: 1000 }, persist)
    await t1.hydrate()
    for (let i = 0; i < 5; i++) {
      expect((await t1.check('ip', 'admin')).ok).toBe(true)
      await t1.recordFailure('ip', 'admin')
    }
    const blocked = await t1.check('ip', 'admin')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(180)

    // "Restart": a brand-new throttle over the same persistence.
    const clock2 = makeClock(clock.now())
    const t2 = makeThrottle(clock2, { ipMax: 1000 }, persist)
    await t2.hydrate()
    const still = await t2.check('ip', 'admin')
    expect(still.ok).toBe(false)
    if (!still.ok) expect(still.retryAfterSec).toBe(180)

    // After release, the second burst escalates — lockCount survived too.
    clock2.advance(3 * MIN)
    for (let i = 0; i < 5; i++) {
      expect((await t2.check('ip', 'admin')).ok).toBe(true)
      await t2.recordFailure('ip', 'admin')
    }
    const second = await t2.check('ip', 'admin')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.retryAfterSec).toBe(300)
  })

  it('a successful login clears the persisted lockout', async () => {
    const persist = makeMemPersist()
    const clock = makeClock()
    const t1 = makeThrottle(clock, {}, persist)
    await t1.hydrate()
    for (let i = 0; i < 5; i++) await t1.recordFailure('ip', 'admin')
    expect((await t1.check('ip', 'admin')).ok).toBe(false)
    await t1.recordSuccess('admin')

    const t2 = makeThrottle(makeClock(clock.now()), {}, persist)
    await t2.hydrate()
    expect((await t2.check('ip', 'admin')).ok).toBe(true)
  })
})
