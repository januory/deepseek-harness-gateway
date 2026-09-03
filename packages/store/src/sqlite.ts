// Durable SQLite IStore (ADR-0007): better-sqlite3 + Drizzle ORM.
//
// - Persistent source data: users / machines / assignments / pairing_codes /
//   audit_events — transactional, with foreign keys.
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
    this.seats.delete(id)
    // FK ON DELETE CASCADE removes assignments + the seats audit row.
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

  async getSeat(machineId: string): Promise<Seat | undefined> {
    const r = await this.db.select().from(schema.seats).where(eq(schema.seats.machineId, machineId)).get()
    return r
      ? { machineId: r.machineId, userId: r.userId, sessionRef: r.sessionRef, acquiredAt: r.acquiredAt, ttlMs: r.ttlMs }
      : undefined
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

  async queryAudit(opts: { since?: string; machineId?: string } = {}): Promise<AuditEvent[]> {
    const conds = []
    if (opts.machineId !== undefined) conds.push(eq(schema.auditEvents.machineId, opts.machineId))
    if (opts.since !== undefined) conds.push(gte(schema.auditEvents.ts, opts.since))
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.auditEvents.ts))
    return rows.map((r) => ({
      ts: r.ts,
      actor: r.actor,
      machineId: r.machineId ?? undefined,
      action: r.action,
      result: r.result as AuditEvent['result'],
      detail: r.detail ?? undefined,
    }))
  }
}
