import { describe, it, expect } from 'vitest'
import { LoginThrottle } from '../src/login-throttle.js'

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

function makeThrottle(clock: ReturnType<typeof makeClock>, overrides: Partial<ConstructorParameters<typeof LoginThrottle>[0]> = {}) {
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
  )
}

describe('LoginThrottle', () => {
  it('allows up to accountMax failures then locks with the first backoff', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 5; i++) {
      expect(t.check('1.1.1.1', 'admin').ok).toBe(true)
      t.recordFailure('1.1.1.1', 'admin')
    }
    const blocked = t.check('1.1.1.1', 'admin')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(180)
  })

  it('keeps denying during the lockout and releases after it', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 5; i++) t.recordFailure('ip', 'admin')
    expect(t.check('ip', 'admin').ok).toBe(false)
    clock.advance(2 * MIN) // still inside the 3-minute lock
    expect(t.check('ip', 'admin').ok).toBe(false)
    clock.advance(2 * MIN) // 4 minutes total — past the lock
    expect(t.check('ip', 'admin').ok).toBe(true)
  })

  it('escalates the lockout duration across successive lockouts', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    const fail5 = (ip: string) => {
      for (let i = 0; i < 5; i++) t.recordFailure(ip, 'admin')
    }
    fail5('ip1')
    let blocked = t.check('ip1', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(180)

    clock.advance(3 * MIN) // first lock expires
    fail5('ip2')
    blocked = t.check('ip2', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(300)

    clock.advance(5 * MIN) // second lock expires
    fail5('ip3')
    blocked = t.check('ip3', 'admin')
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(900)
  })

  it('a success clears the account failure history', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 4; i++) t.recordFailure('ip', 'admin')
    t.recordSuccess('admin')
    for (let i = 0; i < 5; i++) {
      expect(t.check('ip', 'admin').ok).toBe(true)
      t.recordFailure('ip', 'admin')
    }
  })

  it('caps per-IP attempts within the window', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    for (let i = 0; i < 10; i++) {
      expect(t.check('1.2.3.4', `user${i}`).ok).toBe(true)
      t.recordFailure('1.2.3.4', `user${i}`)
    }
    expect(t.check('1.2.3.4', 'another').ok).toBe(false)
  })

  it('prune drops expired account and IP state', () => {
    const clock = makeClock()
    const t = makeThrottle(clock)
    t.recordFailure('1.1.1.1', 'admin')
    expect(t.check('1.1.1.1', 'admin').ok).toBe(true)
    clock.advance(16 * MIN)
    t.prune()
    for (let i = 0; i < 5; i++) {
      expect(t.check('1.1.1.1', 'admin').ok).toBe(true)
      t.recordFailure('1.1.1.1', 'admin')
    }
    expect(t.check('1.1.1.1', 'admin').ok).toBe(false)
  })
})
