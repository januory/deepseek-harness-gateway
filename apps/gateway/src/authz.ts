// Console relay authorization (ADR-0004/0005): every /console/:machineId/*
// request (HTTP and WS upgrade) must be from an authenticated portal user who
// is authorized for that machine AND holds its console seat. Fail-closed.

import type { IStore, User } from 'dsh-gateway-store'

export interface AuthzResult {
  allowed: boolean
  status: number
  error?: string
  heldBy?: string
}

export const SEAT_TTL_MS = 8 * 60 * 60 * 1000 // 8h console seat lease

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

  // Console seat (single operator per machine, ADR-0005).
  const seat = await store.getSeat(machineId)
  if (!seat) return { allowed: false, status: 409, error: 'no console seat — acquire it first' }
  if (new Date(seat.acquiredAt).getTime() + seat.ttlMs < Date.now()) {
    await store.releaseSeat(machineId, seat.userId)
    return { allowed: false, status: 409, error: 'console seat expired — re-acquire' }
  }
  if (seat.userId !== user.id) {
    return { allowed: false, status: 409, error: 'seat held by another operator', heldBy: seat.userId }
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
