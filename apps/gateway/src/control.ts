// Control-plane REST API (ADR-0004/0005/0008): users, machines
// (approve/revoke), assignments, pairing codes, console seats, and audit.
// All routes are under /gw/* and are protected by the RBAC guard from auth.ts.

import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { IStore, Role, User, Machine } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import type { Auth } from './auth.js'
import { hashPassword, verifyPassword } from './auth.js'
import { SEAT_TTL_MS } from './authz.js'

/** Roles that can manage machines/users/assignments/audit. */
const ADMIN_ROLES: Role[] = ['admin', 'system-admin']

function isAdmin(user: User): boolean {
  return user.role === 'system-admin' || user.role === 'admin'
}

async function enrichMachines(store: IStore, registry: NodeRegistry, machines: Machine[]) {
  const out = []
  for (const m of machines) {
    const seat = await store.getSeat(m.id)
    out.push({
      id: m.id,
      name: m.name,
      status: m.status,
      dshVersion: m.dshVersion,
      configRev: m.configRev,
      lastHeartbeatAt: m.lastHeartbeatAt,
      createdAt: m.createdAt,
      online: registry.isConnected(m.id),
      seat: seat ? { userId: seat.userId, acquiredAt: seat.acquiredAt } : null,
    })
  }
  return out
}

export async function registerControl(app: FastifyInstance, store: IStore, registry: NodeRegistry, auth: Auth): Promise<void> {
  const { requireRole } = auth

  // ---- users ----------------------------------------------------------------
  app.get('/gw/users', { preHandler: requireRole(...ADMIN_ROLES) }, async () => {
    const users = await store.listUsers()
    return { users: users.map((u) => ({ id: u.id, role: u.role })) }
  })

  app.post('/gw/users', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const user = req.user!
    const { id, password, role } = (req.body ?? {}) as { id?: string; password?: string; role?: Role }
    if (!id || !password) return reply.code(400).send({ error: 'id and password required' })
    const targetRole = (role ?? 'user') as Role
    if (targetRole === 'system-admin' && user.role !== 'system-admin') {
      return reply.code(403).send({ error: 'only a system admin can create a system admin' })
    }
    await store.upsertUser({ id, role: targetRole, authHash: hashPassword(password) })
    return { ok: true, user: { id, role: targetRole } }
  })

  // ---- self: change password ---------------------------------------------------
  app.post('/gw/me/password', { preHandler: requireRole() }, async (req, reply) => {
    const user = req.user!
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string }
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' })
    if (!verifyPassword(oldPassword, user.authHash)) return reply.code(401).send({ error: '当前密码不正确' })
    if (newPassword.length < 6) return reply.code(400).send({ error: '新密码至少 6 位' })
    await store.upsertUser({ id: user.id, role: user.role, authHash: hashPassword(newPassword) })
    await store.appendAudit({ ts: new Date().toISOString(), actor: user.id, action: 'change_password', result: 'ok' })
    return { ok: true }
  })

  // ---- machines -------------------------------------------------------------
  app.get('/gw/machines', { preHandler: requireRole() }, async (req) => {
    const user = req.user!
    let machines: Machine[]
    if (isAdmin(user)) {
      machines = await store.listMachines()
    } else {
      machines = []
      for (const a of await store.listAssignmentsForUser(user.id)) {
        const m = await store.getMachine(a.machineId)
        if (m) machines.push(m)
      }
    }
    return { machines: await enrichMachines(store, registry, machines) }
  })

  app.post('/gw/machines/:id/approve', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const id = (req.params as any).id as string
    try {
      await registry.approveMachine(id)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  app.post('/gw/machines/:id/revoke', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const id = (req.params as any).id as string
    try {
      await registry.revokeMachine(id)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  app.delete('/gw/machines/:id', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const id = (req.params as any).id as string
    try {
      await registry.deleteMachine(id)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  // ---- assignments -----------------------------------------------------------
  app.get('/gw/assignments', { preHandler: requireRole(...ADMIN_ROLES) }, async () => {
    return { assignments: await store.listAssignments() }
  })

  app.post('/gw/assignments', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const { machineId, userId } = (req.body ?? {}) as { machineId?: string; userId?: string }
    if (!machineId || !userId) return reply.code(400).send({ error: 'machineId and userId required' })
    const m = await store.getMachine(machineId)
    const u = await store.getUser(userId)
    if (!m || !u) return reply.code(404).send({ error: 'machine or user not found' })
    await store.addAssignment({ machineId, userId, createdAt: new Date().toISOString() })
    return { ok: true }
  })

  app.delete('/gw/assignments/:machineId/:userId', { preHandler: requireRole(...ADMIN_ROLES) }, async (req) => {
    const { machineId, userId } = req.params as any
    await store.removeAssignment(machineId, userId)
    return { ok: true }
  })

  // ---- pairing codes ----------------------------------------------------------
  app.post('/gw/pairing-codes', { preHandler: requireRole(...ADMIN_ROLES) }, async (req) => {
    const { ttlMs } = (req.body ?? {}) as { ttlMs?: number }
    const { code, expiresAt } = await registry.issuePairingCode(ttlMs ?? 600_000)
    return { ok: true, code, expiresAt }
  })

  app.get('/gw/pairing-codes', { preHandler: requireRole(...ADMIN_ROLES) }, async () => {
    const codes = await store.listPairingCodes()
    return { codes: codes.map((c) => ({ machineId: c.machineId, consumedBy: c.consumedBy, expiresAt: c.expiresAt })) }
  })

  // ---- console seats -----------------------------------------------------------
  app.post('/gw/seats/:machineId/acquire', { preHandler: requireRole() }, async (req, reply) => {
    const user = req.user!
    const machineId = (req.params as any).machineId as string
    const m = await store.getMachine(machineId)
    if (!m || m.status !== 'approved') return reply.code(404).send({ error: 'machine not approved' })

    if (user.role === 'user') {
      const assigned = (await store.listAssignmentsForUser(user.id)).some((a) => a.machineId === machineId)
      if (!assigned) return reply.code(403).send({ error: 'not assigned to this machine' })
    }

    const seat = { machineId, userId: user.id, sessionRef: randomUUID(), acquiredAt: new Date().toISOString(), ttlMs: SEAT_TTL_MS }
    const ok = await store.acquireSeat(seat)
    if (!ok) {
      const held = await store.getSeat(machineId)
      return reply.code(409).send({ error: 'seat already held', heldBy: held?.userId })
    }
    await store.appendAudit({ ts: seat.acquiredAt, actor: user.id, machineId, action: 'seat_acquire', result: 'ok' })
    return { ok: true, seat: { machineId, userId: user.id, sessionRef: seat.sessionRef } }
  })

  app.post('/gw/seats/:machineId/release', { preHandler: requireRole() }, async (req) => {
    const user = req.user!
    const machineId = (req.params as any).machineId as string
    await store.releaseSeat(machineId, user.id)
    return { ok: true }
  })

  app.get('/gw/seats/:machineId', { preHandler: requireRole() }, async (req) => {
    const machineId = (req.params as any).machineId as string
    const seat = await store.getSeat(machineId)
    return { seat: seat ? { machineId, userId: seat.userId, acquiredAt: seat.acquiredAt } : null }
  })

  // ---- audit --------------------------------------------------------------------
  app.get('/gw/audit', { preHandler: requireRole(...ADMIN_ROLES) }, async (req) => {
    const q = req.query as any
    return { events: await store.queryAudit({ machineId: q?.machineId, since: q?.since }) }
  })
}
