import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../src/index.js'

describe('InMemoryStore', () => {
  it('stores and reads machines scoped to a tenant', async () => {
    const store = new InMemoryStore()
    await store.open()

    await store.upsertMachine({
      id: 'm1',
      tenantId: 't1',
      name: 'dev-box',
      nodeKeyHash: 'h1',
      status: 'pending',
      configRev: 0,
      createdAt: '2026-09-01T00:00:00Z',
    })

    expect(await store.getMachine('m1')).toMatchObject({ id: 'm1', status: 'pending' })
    expect(await store.listMachines('t1')).toHaveLength(1)
    expect(await store.listMachines('t2')).toHaveLength(0)
  })

  it('acquires a seat only once until released', async () => {
    const store = new InMemoryStore()
    const seat = {
      machineId: 'm1',
      userId: 'u1',
      sessionRef: 's1',
      acquiredAt: '2026-09-01T00:00:00Z',
      ttlMs: 60_000,
    }
    expect(await store.acquireSeat(seat)).toBe(true)
    expect(await store.acquireSeat(seat)).toBe(false)
    await store.releaseSeat('m1', 'u1')
    expect(await store.acquireSeat(seat)).toBe(true)
  })

  it('filters audit by tenant and machine', async () => {
    const store = new InMemoryStore()
    await store.appendAudit({ ts: '2026-09-01T00:00:00Z', actor: 'admin', tenantId: 't1', machineId: 'm1', action: 'approve', result: 'ok' })
    await store.appendAudit({ ts: '2026-09-01T00:00:01Z', actor: 'admin', tenantId: 't2', machineId: 'm9', action: 'approve', result: 'ok' })
    expect(await store.queryAudit('t1')).toHaveLength(1)
    expect(await store.queryAudit('t1', { machineId: 'm1' })).toHaveLength(1)
    expect(await store.queryAudit('t1', { machineId: 'm9' })).toHaveLength(0)
  })
})
