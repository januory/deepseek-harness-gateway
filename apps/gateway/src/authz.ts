// Console relay authorization (ADR-0004, revised): every /console/:machineId/*
// request (HTTP and WS upgrade) must be from an authenticated portal user who is
// authorized for that machine — a regular user must be assigned to it; an admin
// reaches any approved machine. Fail-closed. The console seat (single-operator
// mutex, ADR-0005) is intentionally NOT enforced: assignment is the permission,
// so multiple assigned operators may control a machine concurrently.

import type { IStore, User } from 'dsh-gateway-store'

export interface AuthzResult {
  allowed: boolean
  status: number
  error?: string
  heldBy?: string
}

export async function authorizeConsole(
  store: IStore,
  user: User | undefined,
  machineId: string,
): Promise<AuthzResult> {
  if (!user) return { allowed: false, status: 401, error: 'unauthorized' }

  const m = await store.getMachine(machineId)
  if (!m) return { allowed: false, status: 404, error: 'machine not found' }
  if (m.status !== 'approved') return { allowed: false, status: 409, error: 'machine not approved' }

  // Assignment scope: regular users must be assigned; admins reach any machine.
  if (user.role === 'user') {
    const assigned = (await store.listAssignmentsForUser(user.id)).some((a) => a.machineId === machineId)
    if (!assigned) return { allowed: false, status: 403, error: 'not assigned to this machine' }
  }

  return { allowed: true, status: 200 }
}

/** Extract a cookie value from a raw `Cookie` header (opaque tokens, no quoting). */
export function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}
