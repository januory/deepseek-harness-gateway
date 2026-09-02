// Durable SQLite IStore (ADR-0007): better-sqlite3 + Drizzle ORM.
//
// - Persistent source data: tenants / users / machines / assignments /
//   pairing_codes / audit_events — transactional, with foreign keys.
// - The console-seat mutex is kept in process memory (single-writer v1); the
//   `seats` table is written through as an audit helper only.
// - Relay payloads (HTTP/WS frames) are never persisted here.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { and, asc, eq, gte } from 'drizzle-orm'
import type {
  Tenant,
  User,
  Machine,
  Assignment,
  PairingCode,
  Seat,
  AuditEvent,
  Role,
  MachineStatus,
} from './domain.js'
import type { IStore } from './IStore.js'
import * as schema from './schema.js'

type DB = BetterSQLite3Database<typeof schema>

export interface SqliteStoreOptions {
  /** ':memory:' for tests, or a file path (e.g. `gateway.db`). */
  filename: string
  /** Apply Drizzle migrations on open(). Defaults to true. */
  runMigrations?: boolean
}

function tenantRow(t: Tenant) {
  return { id: t.id, name: t.name, createdAt: t.createdAt }
}

function userRow(u: User) {
  return { id: u.id, tenantId: u.tenantId, role: u.role as Role, authHash: u.authHash }
}

function machineRow(m: Machine) {
  return {
    id: m.id,
    tenantId: m.tenantId,
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
    tenantId: r.tenantId,
    name: r.name,
    nodeKeyHash: r.nodeKeyHash,
    status: r.status as MachineStatus,
    dshVersion: r.dshVersion ?? undefined,
    configRev: r.configRev,
    lastHeartbeatAt: r.lastHeartbeatAt ?? undefined,
    createdAt: r.createdAt,
  }
}

function seatRow(s: Seat) {
  return {
    machineId: s.machineId,
    userId: s.userId,
    sessionRef: s.sessionRef,
    acquiredAt: s.acquiredAt,
    ttlMs: s.ttlMs,
  }
}

export class SqliteStore implements IStore {
  private raw!: Database.Database
  private db!: DB
  // In-memory console-seat mutex (ADR-0007 §4): keyed by machineId — one
  // operator per machine (ADR-0005). Self-renewal by the same user is allowed.
  private seats = new Map<string, Seat>()

  constructor(private readonly options: SqliteStoreOptions) {}

  async open(): Promise<void> {
    this.raw = new Database(this.options.filename)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma('busy_timeout = 5000')
    this.db = drizzle(this.raw, { schema })

    if (this.options.runMigrations !== false) {
      // Resolve the committed drizzle migrations relative to this source file
      // (works under tsx; the compiled dist would need the folder copied).
      const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
      if (existsSync(join(folder, 'meta', '_journal.json'))) {
        migrate(this.db, { migrationsFolder: folder })
      }
    }
  }

  async close(): Promise<void> {
    this.seats.clear()
    this.raw?.close()
  }

  async upsertTenant(t: Tenant): Promise<void> {
    const row = tenantRow(t)
    await this.db
      .insert(schema.tenants)
      .values(row)
      .onConflictDoUpdate({ target: schema.tenants.id, set: { name: row.name, createdAt: row.createdAt } })
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const r = await this.db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()
    return r ? { id: r.id, name: r.name, createdAt: r.createdAt } : undefined
  }

  async upsertUser(u: User): Promise<void> {
    const row = userRow(u)
    await this.db
      .insert(schema.users)
      .values(row)
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { tenantId: row.tenantId, role: row.role, authHash: row.authHash },
      })
  }

  async getUser(id: string): Promise<User | undefined> {
    const r = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    return r ? { id: r.id, tenantId: r.tenantId, role: r.role as Role, authHash: r.authHash } : undefined
  }

  async upsertMachine(m: Machine): Promise<void> {
    const row = machineRow(m)
    await this.db
      .insert(schema.machines)
      .values(row)
      .onConflictDoUpdate({
        target: schema.machines.id,
        set: {
          tenantId: row.tenantId,
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

  async listMachines(tenantId: string): Promise<Machine[]> {
    const rows = await this.db.select().from(schema.machines).where(eq(schema.machines.tenantId, tenantId))
    return rows.map(machineFromRow)
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

  async upsertPairingCode(c: PairingCode): Promise<void> {
    await this.db
      .insert(schema.pairingCodes)
      .values({
        codeHash: c.codeHash,
        tenantId: c.tenantId,
        machineId: c.machineId ?? null,
        expiresAt: c.expiresAt,
        consumedBy: c.consumedBy ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pairingCodes.codeHash,
        set: { tenantId: c.tenantId, machineId: c.machineId ?? null, expiresAt: c.expiresAt, consumedBy: c.consumedBy ?? null },
      })
  }

  async getPairingCodeByHash(codeHash: string): Promise<PairingCode | undefined> {
    const r = await this.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.codeHash, codeHash)).get()
    return r
      ? {
          codeHash: r.codeHash,
          tenantId: r.tenantId,
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

  async acquireSeat(seat: Seat): Promise<boolean> {
    const existing = this.seats.get(seat.machineId)
    if (existing && existing.userId !== seat.userId) return false
    this.seats.set(seat.machineId, seat)
    const row = seatRow(seat)
    await this.db
      .insert(schema.seats)
      .values(row)
      .onConflictDoUpdate({
        target: schema.seats.machineId,
        set: { userId: row.userId, sessionRef: row.sessionRef, acquiredAt: row.acquiredAt, ttlMs: row.ttlMs },
      })
    return true
  }

  async releaseSeat(machineId: string, userId: string): Promise<void> {
    const existing = this.seats.get(machineId)
    if (existing && existing.userId === userId) this.seats.delete(machineId)
    await this.db.delete(schema.seats).where(eq(schema.seats.machineId, machineId))
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      ts: e.ts,
      actor: e.actor,
      tenantId: e.tenantId,
      machineId: e.machineId ?? null,
      action: e.action,
      result: e.result,
      detail: e.detail ?? null,
    })
  }

  async queryAudit(
    tenantId: string,
    opts: { since?: string; machineId?: string } = {},
  ): Promise<AuditEvent[]> {
    const conds = [eq(schema.auditEvents.tenantId, tenantId)]
    if (opts.machineId !== undefined) conds.push(eq(schema.auditEvents.machineId, opts.machineId))
    if (opts.since !== undefined) conds.push(gte(schema.auditEvents.ts, opts.since))
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(and(...conds))
      .orderBy(asc(schema.auditEvents.ts))
    return rows.map((r) => ({
      ts: r.ts,
      actor: r.actor,
      tenantId: r.tenantId,
      machineId: r.machineId ?? undefined,
      action: r.action,
      result: r.result as AuditEvent['result'],
      detail: r.detail ?? undefined,
    }))
  }
}
