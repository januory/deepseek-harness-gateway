// Control-plane REST API (ADR-0004/0008): users, machines (approve/revoke),
// assignments, pairing codes, and audit. All routes are under /gw/* and are
// protected by the RBAC guard from auth.ts. The console seat (ADR-0005
// single-operator mutex) is not part of the permission model — assignment is
// the permission, so a machine list carries no seat field and there are no
// seat acquire/release endpoints.

import type { FastifyInstance } from 'fastify'
import type { IStore, Role, User, Machine } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import type { Auth } from './auth.js'
import { hashPassword, verifyPassword } from './auth.js'

/** Roles that can manage machines/users/assignments/audit. */
const ADMIN_ROLES: Role[] = ['admin', 'system-admin']

function isAdmin(user: User): boolean {
  return user.role === 'system-admin' || user.role === 'admin'
}

async function enrichMachines(store: IStore, registry: NodeRegistry, machines: Machine[]) {
  const out = []
  for (const m of machines) {
    out.push({
      id: m.id,
      name: m.name,
      status: m.status,
      dshVersion: m.dshVersion,
      configRev: m.configRev,
      lastHeartbeatAt: m.lastHeartbeatAt,
      createdAt: m.createdAt,
      online: registry.isConnected(m.id),
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

  // Rename a machine's display name. The name is a portal-side label stored on
  // the gateway record — the node reports its own hostname on onboarding, but
  // reconnects never overwrite it, so the admin edit sticks across restarts.
  app.post('/gw/machines/:id/rename', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const user = req.user!
    const id = (req.params as any).id as string
    const { name } = (req.body ?? {}) as { name?: string }
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return reply.code(400).send({ error: '名称不能为空' })
    if (trimmed.length > 64) return reply.code(400).send({ error: '名称过长（最多 64 字符）' })
    const m = await store.getMachine(id)
    if (!m) return reply.code(404).send({ error: 'machine not found' })
    if (m.name !== trimmed) {
      await store.upsertMachine({ ...m, name: trimmed })
      await store.appendAudit({
        ts: new Date().toISOString(),
        actor: user.id,
        machineId: id,
        action: 'rename_machine',
        result: 'ok',
        detail: `${m.name} -> ${trimmed}`,
      })
    }
    return { ok: true }
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

  // ---- audit --------------------------------------------------------------------
  app.get('/gw/audit', { preHandler: requireRole(...ADMIN_ROLES) }, async (req) => {
    const q = req.query as any
    return { events: await store.queryAudit({ machineId: q?.machineId, since: q?.since }) }
  })
}
