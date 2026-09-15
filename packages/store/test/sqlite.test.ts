import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
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

  // Daemon supervision: the portal must still be able to describe a machine
  // whose supervisor is gone, so the last reported lifecycle state is durable.
  it('persists daemon supervision state (migration 0004) across reopen', async () => {
    const filename = tmpfile()
    const store = new SqliteStore({ filename })
    await store.open()
    await store.upsertMachine({
      id: 'm1',
      name: 'supervised-box',
      nodeKeyHash: 'h1',
      status: 'approved',
      configRev: 0,
      createdAt: '2026-09-01T00:00:00Z',
      daemonState: 'stopped',
      daemonEnabled: true,
    })
    // A plain metadata heartbeat must not wipe the daemon columns.
    const fetched = (await store.getMachine('m1'))!
    await store.upsertMachine({ ...fetched, lastHeartbeatAt: '2026-09-01T00:00:05Z' })
    await store.close()

    const reopened = new SqliteStore({ filename })
    await reopened.open()
    const machine = await reopened.getMachine('m1')
    expect(machine?.daemonState).toBe('stopped')
    expect(machine?.daemonEnabled).toBe(true)
    // A machine with no supervision reads back as undefined, not false/"unknown".
    await reopened.upsertMachine({
      id: 'm2',
      name: 'plain-box',
      nodeKeyHash: 'h2',
      status: 'approved',
      configRev: 0,
      createdAt: '2026-09-01T00:00:00Z',
    })
    const plain = await reopened.getMachine('m2')
    expect(plain?.daemonState).toBeUndefined()
    expect(plain?.daemonEnabled).toBeFalsy()
    await reopened.close()
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

  it('upgrades an existing pre-daemon database in place (migration 0004)', async () => {
    const filename = tmpfile()
    // Reach the pre-daemon schema by replaying the committed migrations through
    // drizzle with a journal that stops at 0003...
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const partial = mkdtempSync(join(tmpdir(), 'dshgw-migrations-'))
    mkdirSync(join(partial, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const kept = journal.entries.filter((e) => e.idx <= 3)
    writeFileSync(join(partial, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }))
    for (const e of kept) copyFileSync(join(migrations, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    const legacyRaw = new Database(filename)
    legacyRaw.pragma('journal_mode = WAL')
    migrate(drizzle(legacyRaw), { migrationsFolder: partial })
    const preColumns = (legacyRaw.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(preColumns).not.toContain('daemon_state')
    legacyRaw
      .prepare(
        "INSERT INTO machines (id, name, node_key_hash, status, config_rev, created_at) VALUES ('m1','old-box','h1','approved',0,'2026-09-01T00:00:00Z')",
      )
      .run()
    legacyRaw.close()

    // ...then let the real store open it: 0004 must apply in place.
    const store = new SqliteStore({ filename })
    await store.open()
    const machine = await store.getMachine('m1')
    expect(machine?.name).toBe('old-box')
    expect(machine?.daemonState).toBeUndefined()
    await store.upsertMachine({ ...machine!, daemonState: 'running', daemonEnabled: true })
    expect((await store.getMachine('m1'))?.daemonState).toBe('running')
    await store.close()

    rmSync(partial, { recursive: true, force: true })
  })
})