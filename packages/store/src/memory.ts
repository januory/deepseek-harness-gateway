// In-memory IStore for the P0 skeleton and tests. Not durable.

import type {
  User,
  Machine,
  Assignment,
  PairingCode,
  Seat,
  AuditEvent,
} from './domain.js'
import type { IStore } from './IStore.js'

export class InMemoryStore implements IStore {
  private users = new Map<string, User>()
  private machines = new Map<string, Machine>()
  private assignments = new Map<string, Assignment>() // `${machineId}:${userId}`
  private pairingCodes = new Map<string, PairingCode>() // by codeHash
  private seats = new Map<string, Seat>() // by machineId (single operator per machine)
  private audit: AuditEvent[] = []

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertUser(u: User): Promise<void> {
    this.users.set(u.id, u)
  }
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id)
  }
  async listUsers(): Promise<User[]> {
    return [...this.users.values()]
  }

  async upsertMachine(m: Machine): Promise<void> {
    this.machines.set(m.id, m)
  }
  async getMachine(id: string): Promise<Machine | undefined> {
    return this.machines.get(id)
  }
  async listMachines(): Promise<Machine[]> {
    return [...this.machines.values()]
  }
  async deleteMachine(id: string): Promise<void> {
    this.machines.delete(id)
    for (const key of [...this.assignments.keys()]) {
      if (key.startsWith(`${id}:`)) this.assignments.delete(key)
    }
    this.seats.delete(id)
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
  async listAssignments(): Promise<Assignment[]> {
    return [...this.assignments.values()]
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
  async listPairingCodes(): Promise<PairingCode[]> {
    return [...this.pairingCodes.values()]
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
  async queryAudit(opts: { since?: string; machineId?: string } = {}): Promise<AuditEvent[]> {
    return this.audit.filter(
      (e) =>
        (opts.machineId === undefined || e.machineId === opts.machineId) &&
        (opts.since === undefined || e.ts >= opts.since),
    )
  }
}
