import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
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

  it('deletes a machine and cascades assignments (audit retained)', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'approved', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.addAssignment({ machineId: 'm1', userId: 'u1', createdAt: '2026-09-01T00:00:01Z' })
    await store.appendAudit({ ts: '2026-09-01T00:00:03Z', actor: 'admin', machineId: 'm1', action: 'approve', result: 'ok' })

    await store.deleteMachine('m1')

    expect(await store.getMachine('m1')).toBeUndefined()
    expect(await store.listMachines()).toHaveLength(0)
    expect(await store.listAssignmentsForUser('u1')).toHaveLength(0)
    // Audit is retained even after the machine is gone.
    expect(await store.queryAudit({ machineId: 'm1' })).toHaveLength(1)
    await store.close()
  })

  it('deletes a user and cascades assignments (audit retained)', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    await store.upsertMachine({ id: 'm1', name: 'dev-box', nodeKeyHash: 'h1', status: 'approved', configRev: 0, createdAt: '2026-09-01T00:00:00Z' })
    await store.upsertUser({ id: 'u1', role: 'user', authHash: 'ah1' })
    await store.upsertUser({ id: 'u2', role: 'admin', authHash: 'ah2' })
    await store.addAssignment({ machineId: 'm1', userId: 'u1', createdAt: '2026-09-01T00:00:01Z' })
    await store.appendAudit({ ts: '2026-09-01T00:00:03Z', actor: 'u1', action: 'login', result: 'ok' })

    await store.deleteUser('u1')

    expect(await store.getUser('u1')).toBeUndefined()
    expect((await store.listUsers()).map((u) => u.id)).toEqual(['u2'])
    expect(await store.listAssignmentsForUser('u1')).toHaveLength(0)
    expect((await store.listAssignments()).map((a) => a.userId)).toEqual([])
    // Audit is retained even after the user is gone.
    expect(await store.queryAudit({ actor: 'u1' })).toHaveLength(1)
    await store.close()
  })

  it('persists login-throttle state across reopen (persistent lockout)', async () => {
    const filename = tmpfile()
    const store = new SqliteStore({ filename })
    await store.open()
    await store.saveThrottleAccount({
      account: 'admin',
      lockUntil: 1_000_000_180_000,
      lockCount: 2,
      fails: [],
      updatedAt: 1_000_000_000_000,
    })
    await store.saveThrottleIp({ ip: '10.0.0.9', attempts: [1_000_000_050_000, 1_000_000_060_000], updatedAt: 1_000_000_060_000 })
    await store.close()

    const reopened = new SqliteStore({ filename })
    await reopened.open()
    expect(await reopened.listThrottleAccounts()).toEqual([
      { account: 'admin', lockUntil: 1_000_000_180_000, lockCount: 2, fails: [], updatedAt: 1_000_000_000_000 },
    ])
    expect(await reopened.listThrottleIps()).toEqual([
      { ip: '10.0.0.9', attempts: [1_000_000_050_000, 1_000_000_060_000], updatedAt: 1_000_000_060_000 },
    ])
    await reopened.deleteThrottleAccount('admin')
    expect(await reopened.listThrottleAccounts()).toHaveLength(0)
    await reopened.close()
  })

  it('filters audit by time/actor/action/result and paginates chronologically', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    const rows = [
      { ts: '2026-09-01T00:00:00.000Z', actor: 'admin', action: 'login', result: 'ok' as const },
      { ts: '2026-09-02T00:00:00.000Z', actor: 'admin', action: 'approve', result: 'ok' as const, machineId: 'm1' },
      { ts: '2026-09-03T00:00:00.000Z', actor: 'alice', action: 'login', result: 'denied' as const },
      { ts: '2026-09-04T00:00:00.000Z', actor: 'admin', action: 'approve', result: 'ok' as const, machineId: 'm2' },
      { ts: '2026-09-05T00:00:00.000Z', actor: 'admin', action: 'approve', result: 'error' as const },
    ]
    for (const r of rows) await store.appendAudit(r)

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
    // No limit → offset ignored (full set), mirroring the memory store.
    expect(await store.queryAudit({ offset: 3 })).toHaveLength(5)
    await store.close()
  })

  it('purges audit rows older than a cutoff, batched or in full', async () => {
    const store = new SqliteStore({ filename: ':memory:' })
    await store.open()
    const rows = [
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
      '2026-09-04T00:00:00.000Z',
    ].map((ts) => ({ ts, actor: 'admin', action: 'login', result: 'ok' as const }))
    for (const r of rows) await store.appendAudit(r)

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
    await store.close()
  })

  it('applies migration 0003 (audit_events.ts index) on fresh open', async () => {
    const filename = tmpfile()
    const store = new SqliteStore({ filename })
    await store.open()
    await store.close()
    // Index existence is observable via sqlite_master on the same file.
    const db = new Database(filename, { readonly: true })
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='audit_events_ts_idx'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('audit_events_ts_idx')
    db.close()
  })
})
