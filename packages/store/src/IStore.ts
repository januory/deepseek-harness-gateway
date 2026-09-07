// Persistence seam. In-memory for tests/P0; SQLite (better-sqlite3 + Drizzle)
// implements the same interface behind a repository swap (ADR-0007).

import type {
  User,
  Machine,
  Assignment,
  PairingCode,
  AuditEvent,
  ThrottleAccount,
  ThrottleIp,
} from './domain.js'

/**
 * Audit query filters + pagination (ADR-0012). All filters compose; results
 * are ordered by `ts` ascending (chronological). `offset` is honored together
 * with `limit`; without `limit` the full matching set is returned.
 */
export interface AuditQueryOptions {
  since?: string
  until?: string
  machineId?: string
  actor?: string
  action?: string
  result?: string
  limit?: number
  offset?: number
}

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
  queryAudit(opts?: AuditQueryOptions): Promise<AuditEvent[]>
  /**
   * Retention cleanup (ADR-0012): delete audit rows with `ts < beforeTs`.
   * With `limit` set, at most that many of the OLDEST matching rows are
   * deleted per call (callers loop for batch cleanup); without it, all
   * matching rows are deleted. Returns the number of rows deleted.
   */
  purgeAudit(beforeTs: string, limit?: number): Promise<number>

  // Persistent login-throttle state (persistent lockout): survives restart.
  listThrottleAccounts(): Promise<ThrottleAccount[]>
  saveThrottleAccount(a: ThrottleAccount): Promise<void>
  deleteThrottleAccount(account: string): Promise<void>
  listThrottleIps(): Promise<ThrottleIp[]>
  saveThrottleIp(r: ThrottleIp): Promise<void>
  deleteThrottleIp(ip: string): Promise<void>
}
