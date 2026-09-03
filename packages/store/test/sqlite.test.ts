import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SqliteStore } from '../src/index.js'

const files: string[] = []
afterEach(() => {
  for (const f of files) {
    try {
      rmSync(f, { force: true })
      rmSync(`${f}-wal`, { force: true })
      rmSync(`${f}-shm`, { force: true })
    } catch {
      /* ignore */
    }
  }
  files.length = 0
})

function tmpfile() {
  const f = join(tmpdir(), `dshgw-store-${randomUUID()}.db`)
  files.push(f)
  return f
}

describe('SqliteStore', () => {
  it('persists machines, assignments and audit across reopen (durable)', async () => {
    const filename = tmpfile()
    const store = new SqliteStore({ filename })
    await store.open()

    await store.upsertMachine({
      id: 'm1',
      name: 'dev-box',
      nodeKeyHash: 'h1',
      status: 'approved',
      configRev: 0,
      createdAt: '2026-09-01T00:00:00Z',
    })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.addAssignment({ machineId: 'm1', userId: 'u1', createdAt: '2026-09-01T00:00:01Z' })
    await store.appendAudit({ ts: '2026-09-01T00:00:02Z', actor: 'admin', machineId: 'm1', action: 'approve', result: 'ok' })
    await store.close()

    const reopened = new SqliteStore({ filename })
    await reopened.open()
    expect((await reopened.getMachine('m1'))?.status).toBe('approved')
    expect(await reopened.listMachines()).toHaveLength(1)
    expect(await reopened.listAssignmentsForUser('u1')).toHaveLength(1)
    expect(await reopened.queryAudit()).toHaveLength(1)
    await reopened.close()
  })

  it('enforces a single operator per machine (seat mutex)', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'approved', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.upsertUser({ id: 'u2', role: 'user', authHash: 'ah2' })
    const seat = {
      machineId: 'm1',
      userId: 'u1',
      sessionRef: 's1',
      acquiredAt: '2026-09-01T00:00:00Z',
      ttlMs: 60_000,
    }
    expect(await store.acquireSeat(seat)).toBe(true)
    expect(await store.acquireSeat(seat)).toBe(true) // same user renews
    expect(await store.acquireSeat({ ...seat, userId: 'u2' })).toBe(false) // other user refused
    await store.releaseSeat('m1', 'u1')
    expect(await store.acquireSeat({ ...seat, userId: 'u2' })).toBe(true)
    await store.close()
  })

  it('consumes a pairing code by hash', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'pending', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertPairingCode({
      codeHash: 'hash1',
      expiresAt: '2026-09-02T00:00:00Z',
    })
    await store.consumePairingCode('hash1', 'm1')
    expect(await store.getPairingCodeByHash('hash1')).toMatchObject({ machineId: 'm1', consumedBy: 'm1' })
    await store.close()
  })

  it('deletes a machine and cascades assignments + seats (audit retained)', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'approved', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.addAssignment({ machineId: 'm1', userId: 'u1', createdAt: '2026-09-01T00:00:01Z' })
    await store.acquireSeat({ machineId: 'm1', userId: 'u1', sessionRef: 's1', acquiredAt: '2026-09-01T00:00:02Z', ttlMs: 60_000 })
    await store.appendAudit({ ts: '2026-09-01T00:00:03Z', actor: 'admin', machineId: 'm1', action: 'approve', result: 'ok' })

    await store.deleteMachine('m1')

    expect(await store.getMachine('m1')).toBeUndefined()
    expect(await store.listMachines()).toHaveLength(0)
    expect(await store.listAssignmentsForUser('u1')).toHaveLength(0)
    expect(await store.getSeat('m1')).toBeUndefined()
    // Audit is retained even after the machine is gone.
    expect(await store.queryAudit({ machineId: 'm1' })).toHaveLength(1)
    await store.close()
  })
})
