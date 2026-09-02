// Persistence seam. v1 = in-memory for the P0 skeleton; SQLite (better-sqlite3
// + Drizzle) implements the same interface behind a repository swap (ADR-0007).

import type {
  Tenant,
  User,
  Machine,
  Assignment,
  PairingCode,
  Seat,
  AuditEvent,
} from './domain.js'

export interface IStore {
  open(): Promise<void>
  close(): Promise<void>

  upsertTenant(t: Tenant): Promise<void>
  getTenant(id: string): Promise<Tenant | undefined>

  upsertUser(u: User): Promise<void>
  getUser(id: string): Promise<User | undefined>

  upsertMachine(m: Machine): Promise<void>
  getMachine(id: string): Promise<Machine | undefined>
  listMachines(tenantId: string): Promise<Machine[]>

  addAssignment(a: Assignment): Promise<void>
  removeAssignment(machineId: string, userId: string): Promise<void>
  listAssignmentsForUser(userId: string): Promise<Assignment[]>

  upsertPairingCode(c: PairingCode): Promise<void>
  getPairingCodeByHash(codeHash: string): Promise<PairingCode | undefined>
  consumePairingCode(codeHash: string, machineId: string): Promise<void>

  acquireSeat(seat: Seat): Promise<boolean>
  releaseSeat(machineId: string, userId: string): Promise<void>

  appendAudit(e: AuditEvent): Promise<void>
  queryAudit(tenantId: string, opts?: { since?: string; machineId?: string }): Promise<AuditEvent[]>
}
