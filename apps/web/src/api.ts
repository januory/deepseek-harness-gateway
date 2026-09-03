// Portal → gateway control-plane API client (thin fetch wrapper).
// Mirrors apps/gateway/src/control.ts + auth.ts routes.

import type {
  Assignment,
  AuditEvent,
  MachineView,
  PairingCodeView,
  PublicUser,
  Role,
  SeatView,
  Tenant,
  UserView,
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
      if (body && (body as any).message) message = (body as any).message
      else if (body && (body as any).error) message = (body as any).error
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

  // ---- tenants (platform-admin) ---------------------------------------------
  tenants: () => req<{ tenants: Tenant[] }>('/gw/tenants'),
  createTenant: (id: string, name: string) =>
    req<{ ok: boolean; tenant: Tenant }>('/gw/tenants', { method: 'POST', body: JSON.stringify({ id, name }) }),

  // ---- users ------------------------------------------------------------------
  users: (tenantId?: string) => req<{ users: UserView[] }>('/gw/users' + qs({ tenantId })),
  createUser: (id: string, password: string, role: Role, tenantId?: string) =>
    req<{ ok: boolean; user: UserView }>('/gw/users', {
      method: 'POST',
      body: JSON.stringify({ id, password, role, tenantId }),
    }),

  // ---- machines ---------------------------------------------------------------
  machines: () => req<{ machines: MachineView[] }>('/gw/machines'),
  approveMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id + '/approve', { method: 'POST' }),
  revokeMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id + '/revoke', { method: 'POST' }),
  deleteMachine: (id: string) => req<{ ok: boolean }>('/gw/machines/' + id, { method: 'DELETE' }),

  // ---- assignments -------------------------------------------------------------
  assignments: (tenantId?: string) => req<{ assignments: Assignment[] }>('/gw/assignments' + qs({ tenantId })),
  assign: (machineId: string, userId: string) =>
    req<{ ok: boolean }>('/gw/assignments', { method: 'POST', body: JSON.stringify({ machineId, userId }) }),
  unassign: (machineId: string, userId: string) =>
    req<{ ok: boolean }>('/gw/assignments/' + machineId + '/' + userId, { method: 'DELETE' }),

  // ---- pairing codes -------------------------------------------------------------
  pairingCodes: (tenantId?: string) => req<{ codes: PairingCodeView[] }>('/gw/pairing-codes' + qs({ tenantId })),
  issuePairingCode: (tenantId?: string, ttlMs?: number) =>
    req<{ ok: boolean; code: string; expiresAt: string; tenantId: string }>('/gw/pairing-codes', {
      method: 'POST',
      body: JSON.stringify({ tenantId, ttlMs }),
    }),

  // ---- console seats ---------------------------------------------------------------
  acquireSeat: (machineId: string) =>
    req<{ ok: boolean; seat: { machineId: string; userId: string; sessionRef: string } }>(
      '/gw/seats/' + machineId + '/acquire',
      { method: 'POST' },
    ),
  releaseSeat: (machineId: string) => req<{ ok: boolean }>('/gw/seats/' + machineId + '/release', { method: 'POST' }),
  seat: (machineId: string) => req<{ seat: SeatView | null }>('/gw/seats/' + machineId),

  // ---- audit -------------------------------------------------------------------------
  audit: (filters: { tenantId?: string; machineId?: string; since?: string } = {}) =>
    req<{ events: AuditEvent[] }>('/gw/audit' + qs(filters)),
}
