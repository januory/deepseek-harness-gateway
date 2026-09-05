// Persistence seam. In-memory for tests/P0; SQLite (better-sqlite3 + Drizzle)
// implements the same interface behind a repository swap (ADR-0007).

import type {
  User,
  Machine,
  Assignment,
  PairingCode,
  AuditEvent,
} from './domain.js'

export interface IStore {
  open(): Promise<void>
  close(): Promise<void>

  upsertUser(u: User): Promise<void>
  getUser(id: string): Promise<User | undefined>
  listUsers(): Promise<User[]>

  upsertMachine(m: Machine): Promise<void>
  getMachine(id: string): Promise<Machine | undefined>
  listMachines(): Promise<Machine[]>
  /** Delete a machine record; cascades assignments (audit is retained). */
  deleteMachine(id: string): Promise<void>

  addAssignment(a: Assignment): Promise<void>
  removeAssignment(machineId: string, userId: string): Promise<void>
  listAssignmentsForUser(userId: string): Promise<Assignment[]>
  listAssignments(): Promise<Assignment[]>

  upsertPairingCode(c: PairingCode): Promise<void>
  getPairingCodeByHash(codeHash: string): Promise<PairingCode | undefined>
  consumePairingCode(codeHash: string, machineId: string): Promise<void>
  listPairingCodes(): Promise<PairingCode[]>

  appendAudit(e: AuditEvent): Promise<void>
  queryAudit(opts?: { since?: string; machineId?: string }): Promise<AuditEvent[]>
}
