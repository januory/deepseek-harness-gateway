import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../src/index.js'

describe('InMemoryStore', () => {
  it('stores and reads machines', async () => {
    const store = new InMemoryStore()
    await store.open()

    await store.upsertMachine({
      id: 'm1',
      name: 'dev-box',
      nodeKeyHash: 'h1',
      status: 'pending',
      configRev: 0,
      createdAt: '2026-09-01T00:00:00Z',
    })

    expect(await store.getMachine('m1')).toMatchObject({ id: 'm1', status: 'pending' })
    expect(await store.listMachines()).toHaveLength(1)
  })

  it('deletes a user and cascades assignments', async () => {
    const store = new InMemoryStore()
    await store.open()

    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'approved', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.upsertUser({ id: 'u2', role: 'admin', authHash: 'ah2' })
    await store.addAssignment({ machineId: 'm1', userId: 'u1', createdAt: '2026-09-01T00:00:01Z' })

    await store.deleteUser('u1')

    expect(await store.getUser('u1')).toBeUndefined()
    expect((await store.listUsers()).map((u) => u.id)).toEqual(['u2'])
    expect(await store.listAssignmentsForUser('u1')).toHaveLength(0)
    expect((await store.listAssignments()).map((a) => a.userId)).toEqual([])
  })

  it('filters audit by machine', async () => {
    const store = new InMemoryStore()
    await store.appendAudit({ ts: '2026-09-01T00:00:00Z', actor: 'admin', machineId: 'm1', action: 'approve', result: 'ok' })
    await store.appendAudit({ ts: '2026-09-01T00:00:01Z', actor: 'admin', machineId: 'm9', action: 'approve', result: 'ok' })
    expect(await store.queryAudit()).toHaveLength(2)
    expect(await store.queryAudit({ machineId: 'm1' })).toHaveLength(1)
    expect(await store.queryAudit({ machineId: 'm9' })).toHaveLength(1)
  })

  it('filters audit by time/actor/action/result and paginates chronologically', async () => {
    const store = new InMemoryStore()
    const mk = (ts: string, over: Partial<Parameters<typeof store.appendAudit>[0]> = {}) => ({
      ts,
      actor: 'admin',
      action: 'login',
      result: 'ok' as const,
      ...over,
    })
    await store.appendAudit(mk('2026-09-01T00:00:00.000Z'))
    await store.appendAudit(mk('2026-09-02T00:00:00.000Z', { action: 'approve', machineId: 'm1' }))
    await store.appendAudit(mk('2026-09-03T00:00:00.000Z', { actor: 'alice', action: 'login', result: 'denied' }))
    await store.appendAudit(mk('2026-09-04T00:00:00.000Z', { action: 'approve', machineId: 'm2' }))
    await store.appendAudit(mk('2026-09-05T00:00:00.000Z', { action: 'approve', result: 'error' }))

    expect(await store.queryAudit({ since: '2026-09-03T00:00:00.000Z' })).toHaveLength(3)
    expect(await store.queryAudit({ until: '2026-09-02T00:00:00.000Z' })).toHaveLength(2)
    expect(await store.queryAudit({ since: '2026-09-02T00:00:00.000Z', until: '2026-09-04T00:00:00.000Z' })).toHaveLength(3)
    expect(await store.queryAudit({ actor: 'admin' })).toHaveLength(4)
    expect(await store.queryAudit({ action: 'approve' })).toHaveLength(3)
    expect(await store.queryAudit({ result: 'ok' })).toHaveLength(3)
    expect(await store.queryAudit({ machineId: 'm1' })).toHaveLength(1)
    expect(
      await store.queryAudit({ actor: 'admin', action: 'approve', machineId: 'm2', since: '2026-09-04T00:00:00.000Z' }),
    ).toHaveLength(1)

    // Pagination is chronological over the same filters.
    const page1 = await store.queryAudit({ action: 'approve', limit: 2 })
    expect(page1.map((e) => e.ts)).toEqual(['2026-09-02T00:00:00.000Z', '2026-09-04T00:00:00.000Z'])
    const page2 = await store.queryAudit({ action: 'approve', limit: 2, offset: 2 })
    expect(page2.map((e) => e.ts)).toEqual(['2026-09-05T00:00:00.000Z'])
    // No limit → offset ignored (full set), mirroring the sqlite store.
    expect(await store.queryAudit({ offset: 3 })).toHaveLength(5)
  })

  it('purges audit rows older than a cutoff, batched or in full', async () => {
    const store = new InMemoryStore()
    const mk = (ts: string) => ({ ts, actor: 'admin', action: 'login', result: 'ok' as const })
    for (const ts of [
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
      '2026-09-04T00:00:00.000Z',
    ]) {
      await store.appendAudit(mk(ts))
    }

    // Batched: deletes at most `limit` of the OLDEST matching rows.
    expect(await store.purgeAudit('2026-09-04T00:00:00.000Z', 2)).toBe(2)
    expect((await store.queryAudit()).map((e) => e.ts)).toEqual([
      '2026-09-03T00:00:00.000Z',
      '2026-09-04T00:00:00.000Z',
    ])
    // Strict cutoff: ts === cutoff is kept, so only Sep-03 (older) goes.
    expect(await store.purgeAudit('2026-09-04T00:00:00.000Z', 2)).toBe(1)
    expect((await store.queryAudit()).map((e) => e.ts)).toEqual(['2026-09-04T00:00:00.000Z'])
    // No limit → everything older than the cutoff is deleted at once.
    expect(await store.purgeAudit('2026-09-05T00:00:00.000Z')).toBe(1)
    expect(await store.queryAudit()).toHaveLength(0)
    expect(await store.purgeAudit('2026-09-05T00:00:00.000Z')).toBe(0)
  })
})
