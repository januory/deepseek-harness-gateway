// Portal → gateway control-plane API client (thin fetch wrapper).
// Mirrors apps/gateway/src/control.ts + auth.ts routes.

import type {
  Assignment,
  AuditEvent,
  MachineView,
  PairingCodeView,
  PublicUser,
  Role,
  UpdateResult,
  UpdateStatus,
  UserView,
  VersionInfo,
} from './types'

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) ?? {}) }
  // Only declare a JSON body when there actually is one — an empty POST body
  // with content-type: application/json makes Fastify reject it with 400.
  if (opts.body != null) headers['content-type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (res.status === 429) {
        const sec = Number((body as any)?.retryAfterSec) || Number(res.headers.get('retry-after')) || 60
        const mins = Math.max(1, Math.ceil(sec / 60))
        message = `尝试过多，请 ${mins} 分钟后再试`
      } else if (body && (body as any).message) {
        message = (body as any).message
      } else if (body && (body as any).error) {
        message = (body as any).error
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, v)
  }
  const s = sp.toString()
  return s ? '?' + s : ''
}

/** Filters shared by GET /gw/audit and /gw/audit/export (ADR-0012). */
export type AuditFilters = {
  since?: string
  until?: string
  machineId?: string
  actor?: string
  action?: string
  result?: string
}

export const api = {
  // ---- session --------------------------------------------------------------
  async me(): Promise<PublicUser | null> {
    const res = await fetch('/gw/me', { credentials: 'same-origin' })
    if (res.status === 401) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { user: PublicUser }
    return data.user
  },
  login: (id: string, password: string) =>
    req<{ user: PublicUser }>('/gw/login', { method: 'POST', body: JSON.stringify({ id, password }) }),
  logout: () => req<{ ok: boolean }>('/gw/logout', { method: 'POST' }),
  changePassword: (oldPassword: string, newPassword: string) =>
    req<{ ok: boolean }>('/gw/me/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) }),

  // ---- users ------------------------------------------------------------------
  users: () => req<{ users: UserView[] }>('/gw/users'),
  createUser: (id: string, password: string, role: Role) =>
    req<{ ok: boolean; user: UserView }>('/gw/users', {
      method: 'POST',
      body: JSON.stringify({ id, password, role }),
    }),
  /** Edit a user: change role and/or reset password (partial). */
  updateUser: (id: string, patch: { role?: Role; password?: string }) =>
    req<{ ok: boolean; user: UserView }>('/gw/users/' + id, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: string) =>
    req<{ ok: boolean }>('/gw/users/' + id, {
      method: 'DELETE',
      body: JSON.stringify({}),
    }),

  // ---- machines ---------------------------------------------------------------
  machines: () => req<{ machines: MachineView[] }>('/gw/machines'),
  approveMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id + '/approve', { method: 'POST' }),
  revokeMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id + '/revoke', { method: 'POST' }),
  deleteMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id, { method: 'DELETE' }),
  renameMachine: (id: string, name: string) =>
    req<{ ok: boolean }>('/gw/machines/' + id + '/rename', { method: 'POST', body: JSON.stringify({ name }) }),

  // ---- assignments -------------------------------------------------------------
  assignments: () => req<{ assignments: Assignment[] }>('/gw/assignments'),
  assign: (machineId: string, userId: string) =>
    req<{ ok: boolean }>('/gw/assignments', { method: 'POST', body: JSON.stringify({ machineId, userId }) }),
  unassign: (machineId: string, userId: string) =>
    req<{ ok: boolean }>('/gw/assignments/' + machineId + '/' + userId, { method: 'DELETE' }),

  // ---- pairing codes -------------------------------------------------------------
  pairingCodes: () => req<{ codes: PairingCodeView[] }>('/gw/pairing-codes'),
  issuePairingCode: (ttlMs?: number) =>
    req<{ ok: boolean; code: string; expiresAt: string }>('/gw/pairing-codes', {
      method: 'POST',
      body: JSON.stringify({ ttlMs }),
    }),

  // ---- audit -------------------------------------------------------------------------
  audit: (filters: AuditFilters = {}) => req<{ events: AuditEvent[] }>('/gw/audit' + qs(filters)),
  /** Admin export URL (ADR-0012): streams the filtered events as JSONL/CSV. */
  auditExportHref: (format: 'jsonl' | 'csv', filters: AuditFilters = {}) =>
    '/gw/audit/export' + qs({ ...filters, format }),

  // ---- version / hot-update ------------------------------------------------------------
  version: () => req<VersionInfo>('/gw/version'),
  checkVersion: () => req<UpdateStatus>('/gw/version/check', { method: 'POST' }),
  updateVersion: () => req<UpdateResult>('/gw/version/update', { method: 'POST' }),
}
