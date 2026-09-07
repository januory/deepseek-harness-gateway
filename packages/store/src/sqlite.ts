// Durable SQLite IStore (ADR-0007): better-sqlite3 + Drizzle ORM.
//
// - Persistent source data: users / machines / assignments / pairing_codes /
//   audit_events — transactional, with foreign keys.
// - Relay payloads (HTTP/WS frames) are never persisted here.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { and, asc, eq, gte, inArray, lt, lte } from 'drizzle-orm'
import type {
  User,
  Machine,
  Assignment,
  PairingCode,
  AuditEvent,
  ThrottleAccount,
  ThrottleIp,
  Role,
  MachineStatus,
} from './domain.js'
import type { AuditQueryOptions, IStore } from './IStore.js'
import * as schema from './schema.js'

type DB = BetterSQLite3Database<typeof schema>

export interface SqliteStoreOptions {
  /** ':memory:' for tests, or a file path (e.g. `gateway.db`). */
  filename: string
  /** Apply Drizzle migrations on open(). Defaults to true. */
  runMigrations?: boolean
}

function userRow(u: User) {
  return { id: u.id, role: u.role as Role, authHash: u.authHash }
}

function machineRow(m: Machine) {
  return {
    id: m.id,
    name: m.name,
    nodeKeyHash: m.nodeKeyHash,
    status: m.status as MachineStatus,
    dshVersion: m.dshVersion ?? null,
    configRev: m.configRev,
    lastHeartbeatAt: m.lastHeartbeatAt ?? null,
    createdAt: m.createdAt,
  }
}

function machineFromRow(r: typeof schema.machines.$inferSelect): Machine {
  return {
    id: r.id,
    name: r.name,
    nodeKeyHash: r.nodeKeyHash,
    status: r.status as MachineStatus,
    dshVersion: r.dshVersion ?? undefined,
    configRev: r.configRev,
    lastHeartbeatAt: r.lastHeartbeatAt ?? undefined,
    createdAt: r.createdAt,
  }
}

export class SqliteStore implements IStore {
  private raw!: Database.Database
  private db!: DB

  constructor(private readonly options: SqliteStoreOptions) {}

  async open(): Promise<void> {
    this.raw = new Database(this.options.filename)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma('busy_timeout = 5000')
    this.db = drizzle(this.raw, { schema })

    if (this.options.runMigrations !== false) {
      // Resolve the committed drizzle migrations. In dev (tsx) they live at
      // ../drizzle alongside the store package; in the published dshgw bundle
      // apps/gateway/scripts/bundle.mjs copies them into dist/drizzle. Try both.
      const here = dirname(fileURLToPath(import.meta.url))
      const candidates = [join(here, '..', 'drizzle'), join(here, 'drizzle')]
      const folder = candidates.find((c) => existsSync(join(c, 'meta', '_journal.json')))
      if (folder) {
        migrate(this.db, { migrationsFolder: folder })
      }
    }
  }

  async close(): Promise<void> {
    this.raw?.close()
  }

  async upsertUser(u: User): Promise<void> {
    const row = userRow(u)
    await this.db
      .insert(schema.users)
      .values(row)
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { role: row.role, authHash: row.authHash },
      })
  }

  async getUser(id: string): Promise<User | undefined> {
    const r = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    return r ? { id: r.id, role: r.role as Role, authHash: r.authHash } : undefined
  }

  async listUsers(): Promise<User[]> {
    const rows = await this.db.select().from(schema.users)
    return rows.map((r) => ({ id: r.id, role: r.role as Role, authHash: r.authHash }))
  }

  async upsertMachine(m: Machine): Promise<void> {
    const row = machineRow(m)
    await this.db
      .insert(schema.machines)
      .values(row)
      .onConflictDoUpdate({
        target: schema.machines.id,
        set: {
          name: row.name,
          nodeKeyHash: row.nodeKeyHash,
          status: row.status,
          dshVersion: row.dshVersion,
          configRev: row.configRev,
          lastHeartbeatAt: row.lastHeartbeatAt,
          createdAt: row.createdAt,
        },
      })
  }

  async getMachine(id: string): Promise<Machine | undefined> {
    const r = await this.db.select().from(schema.machines).where(eq(schema.machines.id, id)).get()
    return r ? machineFromRow(r) : undefined
  }

  async listMachines(): Promise<Machine[]> {
    const rows = await this.db.select().from(schema.machines)
    return rows.map(machineFromRow)
  }

  async deleteMachine(id: string): Promise<void> {
    // FK ON DELETE CASCADE removes assignments.
    await this.db.delete(schema.machines).where(eq(schema.machines.id, id))
  }

  async addAssignment(a: Assignment): Promise<void> {
    await this.db
      .insert(schema.assignments)
      .values({ machineId: a.machineId, userId: a.userId, createdAt: a.createdAt })
      .onConflictDoNothing()
  }

  async removeAssignment(machineId: string, userId: string): Promise<void> {
    await this.db
      .delete(schema.assignments)
      .where(and(eq(schema.assignments.machineId, machineId), eq(schema.assignments.userId, userId)))
  }

  async listAssignmentsForUser(userId: string): Promise<Assignment[]> {
    const rows = await this.db.select().from(schema.assignments).where(eq(schema.assignments.userId, userId))
    return rows.map((r) => ({ machineId: r.machineId, userId: r.userId, createdAt: r.createdAt }))
  }

  async listAssignments(): Promise<Assignment[]> {
    const rows = await this.db
      .select({
        machineId: schema.assignments.machineId,
        userId: schema.assignments.userId,
        createdAt: schema.assignments.createdAt,
      })
      .from(schema.assignments)
    return rows.map((r) => ({ machineId: r.machineId, userId: r.userId, createdAt: r.createdAt }))
  }

  async upsertPairingCode(c: PairingCode): Promise<void> {
    await this.db
      .insert(schema.pairingCodes)
      .values({
        codeHash: c.codeHash,
        machineId: c.machineId ?? null,
        expiresAt: c.expiresAt,
        consumedBy: c.consumedBy ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pairingCodes.codeHash,
        set: { machineId: c.machineId ?? null, expiresAt: c.expiresAt, consumedBy: c.consumedBy ?? null },
      })
  }

  async getPairingCodeByHash(codeHash: string): Promise<PairingCode | undefined> {
    const r = await this.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.codeHash, codeHash)).get()
    return r
      ? {
          codeHash: r.codeHash,
          machineId: r.machineId ?? undefined,
          expiresAt: r.expiresAt,
          consumedBy: r.consumedBy ?? undefined,
        }
      : undefined
  }

  async consumePairingCode(codeHash: string, machineId: string): Promise<void> {
    await this.db
      .update(schema.pairingCodes)
      .set({ machineId, consumedBy: machineId })
      .where(eq(schema.pairingCodes.codeHash, codeHash))
  }

  async listPairingCodes(): Promise<PairingCode[]> {
    const rows = await this.db.select().from(schema.pairingCodes)
    return rows.map((r) => ({
      codeHash: r.codeHash,
      machineId: r.machineId ?? undefined,
      expiresAt: r.expiresAt,
      consumedBy: r.consumedBy ?? undefined,
    }))
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      ts: e.ts,
      actor: e.actor,
      machineId: e.machineId ?? null,
      action: e.action,
      result: e.result,
      detail: e.detail ?? null,
    })
  }

  async queryAudit(opts: AuditQueryOptions = {}): Promise<AuditEvent[]> {
    const conds = []
    if (opts.since !== undefined) conds.push(gte(schema.auditEvents.ts, opts.since))
    if (opts.until !== undefined) conds.push(lte(schema.auditEvents.ts, opts.until))
    if (opts.machineId !== undefined) conds.push(eq(schema.auditEvents.machineId, opts.machineId))
    if (opts.actor !== undefined) conds.push(eq(schema.auditEvents.actor, opts.actor))
    if (opts.action !== undefined) conds.push(eq(schema.auditEvents.action, opts.action))
    if (opts.result !== undefined) conds.push(eq(schema.auditEvents.result, opts.result))
    // Chronological order; offset only applies together with a page size
    // (without `limit` the full matching set is returned) — sqlite/memory parity.
    const base = this.db
      .select()
      .from(schema.auditEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.auditEvents.ts))
    const paged =
      opts.limit !== undefined && opts.offset !== undefined && opts.offset > 0
        ? base.limit(Math.max(0, opts.limit)).offset(opts.offset)
        : opts.limit !== undefined
          ? base.limit(Math.max(0, opts.limit))
          : base
    const rows = await paged
    return rows.map((r) => ({
      ts: r.ts,
      actor: r.actor,
      machineId: r.machineId ?? undefined,
      action: r.action,
      result: r.result as AuditEvent['result'],
      detail: r.detail ?? undefined,
    }))
  }

  async purgeAudit(beforeTs: string, limit?: number): Promise<number> {
    if (limit !== undefined && limit <= 0) return 0
    if (limit === undefined) {
      // Full cleanup pass.
      const res = await this.db.delete(schema.auditEvents).where(lt(schema.auditEvents.ts, beforeTs)).run()
      return res.changes
    }
    // Batched cleanup (ADR-0012): delete only the `limit` OLDEST matching rows
    // per call so a long purge never runs as one big DELETE holding the WAL
    // (and the matching query rides the audit_events_ts_idx index).
    const target = await this.db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(lt(schema.auditEvents.ts, beforeTs))
      .orderBy(asc(schema.auditEvents.id))
      .limit(limit)
      .all()
    if (target.length === 0) return 0
    const res = await this.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.id, target.map((r) => r.id)))
      .run()
    return res.changes
  }

  // ---- Persistent login throttling (throttle state, JSON-encoded arrays) ----

  async listThrottleAccounts(): Promise<ThrottleAccount[]> {
    const rows = await this.db.select().from(schema.throttleAccounts)
    return rows.map((r) => ({
      account: r.account,
      lockUntil: r.lockUntil,
      lockCount: r.lockCount,
      fails: JSON.parse(r.fails) as number[],
      updatedAt: r.updatedAt,
    }))
  }

  async saveThrottleAccount(a: ThrottleAccount): Promise<void> {
    await this.db
      .insert(schema.throttleAccounts)
      .values({
        account: a.account,
        lockUntil: a.lockUntil,
        lockCount: a.lockCount,
        fails: JSON.stringify(a.fails),
        updatedAt: a.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.throttleAccounts.account,
        set: {
          lockUntil: a.lockUntil,
          lockCount: a.lockCount,
          fails: JSON.stringify(a.fails),
          updatedAt: a.updatedAt,
        },
      })
  }

  async deleteThrottleAccount(account: string): Promise<void> {
    await this.db.delete(schema.throttleAccounts).where(eq(schema.throttleAccounts.account, account))
  }

  async listThrottleIps(): Promise<ThrottleIp[]> {
    const rows = await this.db.select().from(schema.throttleIps)
    return rows.map((r) => ({
      ip: r.ip,
      attempts: JSON.parse(r.attempts) as number[],
      updatedAt: r.updatedAt,
    }))
  }

  async saveThrottleIp(r: ThrottleIp): Promise<void> {
    await this.db
      .insert(schema.throttleIps)
      .values({ ip: r.ip, attempts: JSON.stringify(r.attempts), updatedAt: r.updatedAt })
      .onConflictDoUpdate({
        target: schema.throttleIps.ip,
        set: { attempts: JSON.stringify(r.attempts), updatedAt: r.updatedAt },
      })
  }

  async deleteThrottleIp(ip: string): Promise<void> {
    await this.db.delete(schema.throttleIps).where(eq(schema.throttleIps.ip, ip))
  }
}
