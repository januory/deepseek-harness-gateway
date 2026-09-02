// In-memory IStore for the P0 skeleton and tests. Not durable; replaces SQLite
// until the Drizzle implementation lands (ADR-0007: durable = registry + audit).

import type {
  Tenant,
  User,
  Machine,
  Assignment,
  PairingCode,
  Seat,
  AuditEvent,
} from './domain.js'
import type { IStore } from './IStore.js'

export class InMemoryStore implements IStore {
  private tenants = new Map<string, Tenant>()
  private users = new Map<string, User>()
  private machines = new Map<string, Machine>()
  private assignments = new Map<string, Assignment>() // `${machineId}:${userId}`
  private pairingCodes = new Map<string, PairingCode>() // by codeHash
  private seats = new Map<string, Seat>() // by machineId (single operator per machine)
  private audit: AuditEvent[] = []

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertTenant(t: Tenant): Promise<void> {
    this.tenants.set(t.id, t)
  }
  async getTenant(id: string): Promise<Tenant | undefined> {
    return this.tenants.get(id)
  }
  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()]
  }

  async upsertUser(u: User): Promise<void> {
    this.users.set(u.id, u)
  }
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id)
  }
  async listUsers(tenantId: string): Promise<User[]> {
    return [...this.users.values()].filter((u) => u.tenantId === tenantId)
  }

  async upsertMachine(m: Machine): Promise<void> {
    this.machines.set(m.id, m)
  }
  async getMachine(id: string): Promise<Machine | undefined> {
    return this.machines.get(id)
  }
  async listMachines(tenantId: string): Promise<Machine[]> {
    return [...this.machines.values()].filter((m) => m.tenantId === tenantId)
  }

  async addAssignment(a: Assignment): Promise<void> {
    this.assignments.set(`${a.machineId}:${a.userId}`, a)
  }
  async removeAssignment(machineId: string, userId: string): Promise<void> {
    this.assignments.delete(`${machineId}:${userId}`)
  }
  async listAssignmentsForUser(userId: string): Promise<Assignment[]> {
    return [...this.assignments.values()].filter((a) => a.userId === userId)
  }
  async listAssignments(tenantId: string): Promise<Assignment[]> {
    return [...this.assignments.values()].filter((a) => this.machines.get(a.machineId)?.tenantId === tenantId)
  }

  async upsertPairingCode(c: PairingCode): Promise<void> {
    this.pairingCodes.set(c.codeHash, c)
  }
  async getPairingCodeByHash(codeHash: string): Promise<PairingCode | undefined> {
    return this.pairingCodes.get(codeHash)
  }
  async consumePairingCode(codeHash: string, machineId: string): Promise<void> {
    const c = this.pairingCodes.get(codeHash)
    if (c) {
      c.consumedBy = machineId
      c.machineId = machineId
    }
  }
  async listPairingCodes(tenantId: string): Promise<PairingCode[]> {
    return [...this.pairingCodes.values()].filter((c) => c.tenantId === tenantId)
  }

  async acquireSeat(seat: Seat): Promise<boolean> {
    const existing = this.seats.get(seat.machineId)
    if (existing && existing.userId !== seat.userId) return false
    this.seats.set(seat.machineId, seat)
    return true
  }
  async releaseSeat(machineId: string, userId: string): Promise<void> {
    const existing = this.seats.get(machineId)
    if (existing && existing.userId === userId) this.seats.delete(machineId)
  }
  async getSeat(machineId: string): Promise<Seat | undefined> {
    return this.seats.get(machineId)
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.audit.push(e)
  }
  async queryAudit(
    tenantId: string,
    opts: { since?: string; machineId?: string } = {},
  ): Promise<AuditEvent[]> {
    return this.audit.filter(
      (e) =>
        e.tenantId === tenantId &&
        (opts.machineId === undefined || e.machineId === opts.machineId) &&
        (opts.since === undefined || e.ts >= opts.since),
    )
  }
}
