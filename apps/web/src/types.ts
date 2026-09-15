// Portal-side wire types (mirror packages/store domain + control.ts responses).

export type Role = 'system-admin' | 'admin' | 'user'

export interface PublicUser {
  id: string
  role: Role
}

export interface UserView {
  id: string
  role: Role
}

export type MachineStatus = 'pending' | 'approved' | 'revoked'

/**
 * Machine lifecycle as reported by the machine's own supervisor (DaemonState).
 * `''` means no supervisor has ever reported — the machine is not supervised.
 */
export type DaemonState = 'unknown' | 'starting' | 'running' | 'stopped' | 'exited' | ''

export interface MachineView {
  id: string
  name: string
  status: MachineStatus
  dshVersion?: string
  configRev: number
  lastHeartbeatAt?: string
  createdAt: string
  /** Either socket is live (plugin or supervisor). */
  online: boolean
  /** The data-plane plugin (inside dsh) holds a socket — console availability. */
  consoleConnected: boolean
  /** The lifecycle supervisor holds a socket — start/stop/restart is possible. */
  supervisorConnected: boolean
  /** Daemon supervision switched on in the machine's own plugin config. */
  daemonEnabled: boolean
  /** Last reported dsh lifecycle state. */
  daemonState: DaemonState
}

export interface Assignment {
  machineId: string
  userId: string
  createdAt: string
}

export interface PairingCodeView {
  machineId?: string
  consumedBy?: string
  expiresAt: string
}

export type AuditResult = 'ok' | 'denied' | 'error'

export interface AuditEvent {
  ts: string
  actor: string
  machineId?: string
  action: string
  result: AuditResult
  detail?: string
}

// ==== audit action names (closed set emitted by the gateway control plane) =========
// Every value here matches an `action:` literal in apps/gateway/src audit writes.
// Keep in sync when a new appendAudit/action is added on the gateway side.
export const AUDIT_ACTIONS = [
  'approve_machine',
  'bootstrap_admin',
  'change_password',
  'daemon_restart',
  'daemon_start',
  'daemon_stop',
  'delete_machine',
  'delete_user',
  'login',
  'login_throttled',
  'register_pending',
  'rename_machine',
  'revoke_machine',
  'update_user',
  'version_update',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

// ---- version / hot-update ----------------------------------------------------

export interface CommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface VersionInfo {
  /** false when not inside a git checkout (baked Docker image without a source repo). */
  git: boolean
  repo: string
  branch: string
  remote: string | null
  dirty: boolean
  head: CommitInfo | null
}

export interface UpdateStatus extends VersionInfo {
  behind: number
  ahead: number
  remoteHead: string | null
  incoming: CommitInfo[]
}

export interface UpdateResult {
  ok: boolean
  from: string
  to: string
  pulled: CommitInfo[]
  reload: 'supervised'
}
