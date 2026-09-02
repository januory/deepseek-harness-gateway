// Portal → gateway control-plane API client (thin fetch wrapper).

export interface PublicUser {
  id: string
  tenantId: string
  role: string
}

export interface MachineView {
  id: string
  tenantId: string
  name: string
  status: string
  dshVersion?: string
  configRev: number
  lastHeartbeatAt?: string
  createdAt: string
  online: boolean
  seat: { userId: string; acquiredAt: string } | null
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts,
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && (body as any).error) message = (body as any).error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export const api = {
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
  machines: () => req<{ machines: MachineView[] }>('/gw/machines'),
  approve: (id: string) => req('/gw/machines/' + id + '/approve', { method: 'POST' }),
  revoke: (id: string) => req('/gw/machines/' + id + '/revoke', { method: 'POST' }),
  issuePairingCode: () =>
    req<{ code: string; expiresAt: string; tenantId: string }>('/gw/pairing-codes', { method: 'POST', body: '{}' }),
  createUser: (id: string, password: string, role: string) =>
    req('/gw/users', { method: 'POST', body: JSON.stringify({ id, password, role }) }),
  assign: (machineId: string, userId: string) =>
    req('/gw/assignments', { method: 'POST', body: JSON.stringify({ machineId, userId }) }),
  acquireSeat: (machineId: string) => req('/gw/seats/' + machineId + '/acquire', { method: 'POST' }),
  releaseSeat: (machineId: string) => req('/gw/seats/' + machineId + '/release', { method: 'POST' }),
  audit: () => req<{ events: Array<Record<string, unknown>> }>('/gw/audit'),
}
