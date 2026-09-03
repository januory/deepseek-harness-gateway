// Portal-side wire types (mirror packages/store domain + control.ts responses).

export type Role = 'platform-admin' | 'tenant-admin' | 'user'

export interface PublicUser {
  id: string
  tenantId: string
  role: Role
}

export interface Tenant {
  id: string
  name: string
  createdAt: string
}

export interface UserView {
  id: string
  tenantId: string
  role: Role
}

export type MachineStatus = 'pending' | 'approved' | 'revoked'

export interface SeatView {
  userId: string
  acquiredAt: string
}

export interface MachineView {
  id: string
  tenantId: string
  name: string
  status: MachineStatus
  dshVersion?: string
  configRev: number
  lastHeartbeatAt?: string
  createdAt: string
  online: boolean
  seat: SeatView | null
}

export interface Assignment {
  machineId: string
  userId: string
  createdAt: string
}

export interface PairingCodeView {
  tenantId: string
  machineId?: string
  consumedBy?: string
  expiresAt: string
}

export type AuditResult = 'ok' | 'denied' | 'error'

export interface AuditEvent {
  ts: string
  actor: string
  tenantId: string
  machineId?: string
  action: string
  result: AuditResult
  detail?: string
}
