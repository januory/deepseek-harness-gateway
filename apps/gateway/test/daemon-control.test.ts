import { describe, it, expect } from 'vitest'
import { DaemonControlRegistry } from '../src/daemon-control.js'

/** A settle-once map with an injectable clock, so no test waits on real timers. */
function harness(timeoutMs = 1_000) {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const timedOut: string[] = []
  const registry = new DaemonControlRegistry({
    timeoutMs,
    onTimeout: (_id, action) => timedOut.push(action),
    setTimer: ((fn: () => void) => {
      const handle = { fn } as unknown as ReturnType<typeof setTimeout>
      timers.set(handle, fn)
      return handle
    }) as unknown as typeof setTimeout,
    clearTimer: ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle)
    }) as unknown as typeof clearTimeout,
  })
  const expireAll = () => {
    for (const fn of [...timers.values()]) fn()
    timers.clear()
  }
  return { registry, expireAll, timedOut }
}

describe('DaemonControlRegistry', () => {
  it('resolves a request when the supervisor answers', async () => {
    const { registry } = harness()
    const { id, promise } = registry.register('restart')
    expect(registry.size).toBe(1)
    expect(registry.settle(id, { ok: true, state: 'running' })).toBe(true)
    await expect(promise).resolves.toEqual({ ok: true, state: 'running' })
    expect(registry.size).toBe(0)
  })

  it('rejects when the supervisor never answers', async () => {
    const { registry, expireAll, timedOut } = harness()
    const { promise } = registry.register('stop')
    expireAll()
    await expect(promise).rejects.toThrow(/timed out/)
    expect(timedOut).toEqual(['stop'])
    expect(registry.size).toBe(0)
  })

  it('settles exactly once — a late second result is ignored', async () => {
    const { registry } = harness()
    const { id, promise } = registry.register('start')
    expect(registry.settle(id, { ok: true, state: 'running' })).toBe(true)
    // A duplicate frame (or a result racing a post-timeout settle) must not throw.
    expect(registry.settle(id, { ok: false, error: 'late' })).toBe(false)
    await expect(promise).resolves.toEqual({ ok: true, state: 'running' })
  })

  it('fails every in-flight request when the supervisor disconnects', async () => {
    const { registry } = harness()
    const a = registry.register('start')
    const b = registry.register('restart')
    expect(registry.size).toBe(2)
    registry.failAll('supervisor disconnected')
    await expect(a.promise).resolves.toEqual({ ok: false, error: 'supervisor disconnected' })
    await expect(b.promise).resolves.toEqual({ ok: false, error: 'supervisor disconnected' })
    expect(registry.size).toBe(0)
  })

  it('keeps independent ids per request', () => {
    const { registry } = harness()
    const a = registry.register('start')
    const b = registry.register('start')
    expect(a.id).not.toBe(b.id)
    expect(registry.size).toBe(2)
  })
})
