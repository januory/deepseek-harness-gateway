// Control-plane domain model (persistent entities).

export type Role = 'system-admin' | 'admin' | 'user'

export type MachineStatus = 'pending' | 'approved' | 'revoked'

export interface User {
  id: string
  role: Role
  /** Hash of the authentication credential — never a plaintext secret. */
  authHash: string
}

export interface Machine {
  id: string
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
  machineId?: string
  expiresAt: string
  consumedBy?: string
}

export interface AuditEvent {
  ts: string
  actor: string
  machineId?: string
  action: string
  result: 'ok' | 'denied' | 'error'
  detail?: string
}

/**
 * Persisted login-throttle state (persistent lockout): lets per-account
 * lockouts and per-IP attempt windows survive a gateway restart instead of
 * being wiped with the in-memory throttle (security audit M-2 backlog).
 * Timestamps are epoch ms; `fails`/`attempts` are the raw decoded arrays
 * (stored as JSON text in SQLite).
 */
export interface ThrottleAccount {
  account: string
  lockUntil: number
  lockCount: number
  fails: number[]
  updatedAt: number
}

export interface ThrottleIp {
  ip: string
  attempts: number[]
  updatedAt: number
}
