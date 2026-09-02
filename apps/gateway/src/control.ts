// Control-plane REST API (ADR-0004/0005/0008): tenants, users, machines
// (approve/revoke), assignments, pairing codes, console seats, and audit.
// All routes are under /gw/* and are protected by the RBAC guard from auth.ts.

import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { IStore, Role, User, Machine } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import type { Auth } from './auth.js'
import { hashPassword } from './auth.js'

function isAdmin(user: User): boolean {
  return user.role === 'platform-admin' || user.role === 'tenant-admin'
}

function tenantScope(user: User, requested?: string): string | undefined {
  // platform-admin may pass any tenant; everyone else is fixed to their own.
  if (user.role === 'platform-admin') return requested ?? user.tenantId
  return user.tenantId
}

async function enrichMachines(store: IStore, registry: NodeRegistry, machines: Machine[]) {
  const out = []
  for (const m of machines) {
    const seat = await store.getSeat(m.id)
    out.push({
      id: m.id,
      tenantId: m.tenantId,
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

  // ---- tenants (platform-admin only) --------------------------------------
  app.get('/gw/tenants', { preHandler: requireRole('platform-admin') }, async () => ({ tenants: await store.listTenants() }))

  app.post('/gw/tenants', { preHandler: requireRole('platform-admin') }, async (req, reply) => {
    const { id, name } = (req.body ?? {}) as { id?: string; name?: string }
    if (!id || !name) return reply.code(400).send({ error: 'id and name required' })
    await store.upsertTenant({ id, name, createdAt: new Date().toISOString() })
    return { ok: true, tenant: { id, name } }
  })

  // ---- users ----------------------------------------------------------------
  app.get('/gw/users', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req) => {
    const tenantId = tenantScope(req.user!, (req.query as any)?.tenantId)
    const users = await store.listUsers(tenantId!)
    return { users: users.map((u) => ({ id: u.id, tenantId: u.tenantId, role: u.role })) }
  })

  app.post('/gw/users', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const user = req.user!
    const { id, password, role, tenantId } = (req.body ?? {}) as { id?: string; password?: string; role?: Role; tenantId?: string }
    if (!id || !password) return reply.code(400).send({ error: 'id and password required' })
    const targetRole = (role ?? 'user') as Role
    const targetTenant = tenantScope(user, tenantId)!
    if (user.role === 'tenant-admin' && (targetRole === 'platform-admin' || targetTenant !== user.tenantId)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await store.upsertUser({ id, tenantId: targetTenant, role: targetRole, authHash: hashPassword(password) })
    return { ok: true, user: { id, tenantId: targetTenant, role: targetRole } }
  })

  // ---- machines -------------------------------------------------------------
  app.get('/gw/machines', { preHandler: requireRole() }, async (req) => {
    const user = req.user!
    let machines: Machine[]
    if (user.role === 'platform-admin') {
      machines = []
      for (const t of await store.listTenants()) machines.push(...(await store.listMachines(t.id)))
    } else if (user.role === 'tenant-admin') {
      machines = await store.listMachines(user.tenantId)
    } else {
      machines = []
      for (const a of await store.listAssignmentsForUser(user.id)) {
        const m = await store.getMachine(a.machineId)
        if (m) machines.push(m)
      }
    }
    return { machines: await enrichMachines(store, registry, machines) }
  })

  app.post('/gw/machines/:id/approve', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const id = (req.params as any).id as string
    const m = await store.getMachine(id)
    if (m && req.user!.role === 'tenant-admin' && m.tenantId !== req.user!.tenantId) return reply.code(403).send({ error: 'forbidden' })
    try {
      await registry.approveMachine(id)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  app.post('/gw/machines/:id/revoke', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const id = (req.params as any).id as string
    const m = await store.getMachine(id)
    if (m && req.user!.role === 'tenant-admin' && m.tenantId !== req.user!.tenantId) return reply.code(403).send({ error: 'forbidden' })
    try {
      await registry.revokeMachine(id)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  // ---- assignments -----------------------------------------------------------
  app.get('/gw/assignments', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req) => {
    const user = req.user!
    if (user.role === 'platform-admin') {
      const all = []
      for (const t of await store.listTenants()) all.push(...(await store.listAssignments(t.id)))
      return { assignments: all }
    }
    return { assignments: await store.listAssignments(user.tenantId) }
  })

  app.post('/gw/assignments', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const user = req.user!
    const { machineId, userId } = (req.body ?? {}) as { machineId?: string; userId?: string }
    if (!machineId || !userId) return reply.code(400).send({ error: 'machineId and userId required' })
    const m = await store.getMachine(machineId)
    const u = await store.getUser(userId)
    if (!m || !u) return reply.code(404).send({ error: 'machine or user not found' })
    if (user.role === 'tenant-admin' && (m.tenantId !== user.tenantId || u.tenantId !== user.tenantId)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await store.addAssignment({ machineId, userId, createdAt: new Date().toISOString() })
    return { ok: true }
  })

  app.delete('/gw/assignments/:machineId/:userId', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const user = req.user!
    const { machineId, userId } = req.params as any
    const m = await store.getMachine(machineId)
    if (m && user.role === 'tenant-admin' && m.tenantId !== user.tenantId) return reply.code(403).send({ error: 'forbidden' })
    await store.removeAssignment(machineId, userId)
    return { ok: true }
  })

  // ---- pairing codes ----------------------------------------------------------
  app.post('/gw/pairing-codes', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req, reply) => {
    const user = req.user!
    const { tenantId, ttlMs } = (req.body ?? {}) as { tenantId?: string; ttlMs?: number }
    const target = tenantScope(user, tenantId)!
    if (user.role === 'tenant-admin' && target !== user.tenantId) return reply.code(403).send({ error: 'forbidden' })
    const { code, expiresAt } = await registry.issuePairingCode(target, ttlMs ?? 600_000)
    return { ok: true, code, expiresAt, tenantId: target }
  })

  app.get('/gw/pairing-codes', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req) => {
    const user = req.user!
    if (user.role === 'platform-admin') {
      const all = []
      for (const t of await store.listTenants()) all.push(...(await store.listPairingCodes(t.id)))
      return { codes: all.map((c) => ({ tenantId: c.tenantId, machineId: c.machineId, consumedBy: c.consumedBy, expiresAt: c.expiresAt })) }
    }
    const codes = await store.listPairingCodes(user.tenantId)
    return { codes: codes.map((c) => ({ tenantId: c.tenantId, machineId: c.machineId, consumedBy: c.consumedBy, expiresAt: c.expiresAt })) }
  })

  // ---- console seats -----------------------------------------------------------
  app.post('/gw/seats/:machineId/acquire', { preHandler: requireRole() }, async (req, reply) => {
    const user = req.user!
    const machineId = (req.params as any).machineId as string
    const m = await store.getMachine(machineId)
    if (!m || m.status !== 'approved') return reply.code(404).send({ error: 'machine not approved' })

    if (!isAdmin(user)) {
      const assigned = (await store.listAssignmentsForUser(user.id)).some((a) => a.machineId === machineId)
      if (!assigned) return reply.code(403).send({ error: 'not assigned to this machine' })
    } else if (user.role === 'tenant-admin' && m.tenantId !== user.tenantId) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const seat = { machineId, userId: user.id, sessionRef: randomUUID(), acquiredAt: new Date().toISOString(), ttlMs: 60_000 }
    const ok = await store.acquireSeat(seat)
    if (!ok) {
      const held = await store.getSeat(machineId)
      return reply.code(409).send({ error: 'seat already held', heldBy: held?.userId })
    }
    await store.appendAudit({ ts: seat.acquiredAt, actor: user.id, tenantId: m.tenantId, machineId, action: 'seat_acquire', result: 'ok' })
    return { ok: true, seat: { machineId, userId: user.id, sessionRef: seat.sessionRef } }
  })

  app.post('/gw/seats/:machineId/release', { preHandler: requireRole() }, async (req, reply) => {
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
  app.get('/gw/audit', { preHandler: requireRole('tenant-admin', 'platform-admin') }, async (req) => {
    const user = req.user!
    const q = req.query as any
    if (user.role === 'platform-admin') {
      const tenantId = q?.tenantId
      if (tenantId) return { events: await store.queryAudit(tenantId, { machineId: q?.machineId, since: q?.since }) }
      const all = []
      for (const t of await store.listTenants()) all.push(...(await store.queryAudit(t.id, { machineId: q?.machineId, since: q?.since })))
      return { events: all }
    }
    return { events: await store.queryAudit(user.tenantId, { machineId: q?.machineId, since: q?.since }) }
  })
}
