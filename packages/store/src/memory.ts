// In-memory IStore for the P0 skeleton and tests. Not durable.

import type {
  User,
  Machine,
  Assignment,
  PairingCode,
  AuditEvent,
  ThrottleAccount,
  ThrottleIp,
} from './domain.js'
import type { AuditQueryOptions, IStore } from './IStore.js'

export class InMemoryStore implements IStore {
  private users = new Map<string, User>()
  private machines = new Map<string, Machine>()
  private assignments = new Map<string, Assignment>() // `${machineId}:${userId}`
  private pairingCodes = new Map<string, PairingCode>() // by codeHash
  private audit: AuditEvent[] = []
  private throttleAccounts = new Map<string, ThrottleAccount>()
  private throttleIps = new Map<string, ThrottleIp>()

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
  async deleteUser(id: string): Promise<void> {
    this.users.delete(id)
    for (const key of [...this.assignments.keys()]) {
      if (key.endsWith(`:${id}`)) this.assignments.delete(key)
    }
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

  async appendAudit(e: AuditEvent): Promise<void> {
    this.audit.push(e)
  }

  async queryAudit(opts: AuditQueryOptions = {}): Promise<AuditEvent[]> {
    // Mirror SqliteStore semantics: filter, then chronological order, then
    // pagination (offset without limit = everything from that position on).
    const rows = this.audit
      .filter(
        (e) =>
          (opts.since === undefined || e.ts >= opts.since) &&
          (opts.until === undefined || e.ts <= opts.until) &&
          (opts.machineId === undefined || e.machineId === opts.machineId) &&
          (opts.actor === undefined || e.actor === opts.actor) &&
          (opts.action === undefined || e.action === opts.action) &&
          (opts.result === undefined || e.result === opts.result),
      )
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    const start = opts.offset ?? 0
    return opts.limit === undefined ? rows : rows.slice(start, start + opts.limit)
  }

  async purgeAudit(beforeTs: string, limit?: number): Promise<number> {
    let removed = 0
    const survivors: AuditEvent[] = []
    for (const e of this.audit) {
      if (e.ts < beforeTs && (limit === undefined || removed < limit)) {
        removed++
        continue
      }
      survivors.push(e)
    }
    this.audit = survivors
    return removed
  }

  async listThrottleAccounts(): Promise<ThrottleAccount[]> {
    return [...this.throttleAccounts.values()].map((a) => ({ ...a, fails: [...a.fails] }))
  }
  async saveThrottleAccount(a: ThrottleAccount): Promise<void> {
    this.throttleAccounts.set(a.account, { ...a, fails: [...a.fails] })
  }
  async deleteThrottleAccount(account: string): Promise<void> {
    this.throttleAccounts.delete(account)
  }
  async listThrottleIps(): Promise<ThrottleIp[]> {
    return [...this.throttleIps.values()].map((r) => ({ ...r, attempts: [...r.attempts] }))
  }
  async saveThrottleIp(r: ThrottleIp): Promise<void> {
    this.throttleIps.set(r.ip, { ...r, attempts: [...r.attempts] })
  }
  async deleteThrottleIp(ip: string): Promise<void> {
    this.throttleIps.delete(ip)
  }
}
