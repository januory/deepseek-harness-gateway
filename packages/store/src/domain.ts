// Control-plane domain model (persistent entities). Mirrors architecture.md §6.3.

export type Role = 'platform-admin' | 'tenant-admin' | 'user'

export type MachineStatus = 'pending' | 'approved' | 'revoked'

export interface Tenant {
  id: string
  name: string
  createdAt: string
}

export interface User {
  id: string
  tenantId: string
  role: Role
  /** Hash of the authentication credential — never a plaintext secret. */
  authHash: string
}

export interface Machine {
  id: string
  tenantId: string
  name: string
  /** Hash of the node's long-term key — plaintext key never stored. */
  nodeKeyHash: string
  status: MachineStatus
  dshVersion?: string
  configRev: number
  lastHeartbeatAt?: string
  createdAt: string
}

export interface Assignment {
  machineId: string
  userId: string
  createdAt: string
}

export interface PairingCode {
  /** Hash of the one-time code — plaintext code never stored. */
  codeHash: string
  tenantId: string
  machineId?: string
  expiresAt: string
  consumedBy?: string
}

export interface Seat {
  machineId: string
  userId: string
  sessionRef: string
  acquiredAt: string
  ttlMs: number
}

export interface AuditEvent {
  ts: string
  actor: string
  tenantId: string
  machineId?: string
  action: string
  result: 'ok' | 'denied' | 'error'
  detail?: string
}
