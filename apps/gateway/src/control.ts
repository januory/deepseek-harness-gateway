// Control-plane REST API (ADR-0004/0008): users, machines (approve/revoke),
// assignments, pairing codes, and audit. All routes are under /gw/* and are
// protected by the RBAC guard from auth.ts. The console seat (ADR-0005
// single-operator mutex) is not part of the permission model — assignment is
// the permission, so a machine list carries no seat field and there are no
// seat acquire/release endpoints.

import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import type { AuditEvent, AuditQueryOptions, IStore, Role, User, Machine } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import type { Auth } from './auth.js'
import { hashPassword, verifyPassword } from './auth.js'

/** Roles that can manage machines/users/assignments/audit. */
const ADMIN_ROLES: Role[] = ['admin', 'system-admin']

/** All valid roles, for validating an edit target role. */
const ROLES: Role[] = ['system-admin', 'admin', 'user']

/** Cap for a single GET /gw/audit page. Exports page internally at this size. */
const AUDIT_PAGE_MAX = 1000

// ---- audit query helpers (ADR-0012: composable filters + pagination) -------

function queryStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Parse GET /gw/audit + /gw/audit/export query params into store options. */
function parseAuditQuery(q: Record<string, unknown>): AuditQueryOptions {
  const opts: AuditQueryOptions = {
    since: queryStr(q.since),
    until: queryStr(q.until),
    machineId: queryStr(q.machineId),
    actor: queryStr(q.actor),
    action: queryStr(q.action),
    result: queryStr(q.result),
  }
  const limit = Number(q.limit)
  const offset = Number(q.offset)
  if (Number.isInteger(limit) && limit > 0) opts.limit = Math.min(limit, AUDIT_PAGE_MAX)
  if (Number.isInteger(offset) && offset >= 0) opts.offset = offset
  return opts
}

/** One JSONL line: `{ts,actor,machineId,action,result,detail}` (undefined omitted). */
function auditLineJsonl(e: AuditEvent): string {
  return JSON.stringify({
    ts: e.ts,
    actor: e.actor,
    machineId: e.machineId,
    action: e.action,
    result: e.result,
    detail: e.detail,
  }) + '\n'
}

function csvField(v: string | undefined): string {
  if (v === undefined) return ''
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

function auditLineCsv(e: AuditEvent): string {
  return [e.ts, e.actor, e.machineId ?? '', e.action, e.result, e.detail ?? ''].map(csvField).join(',') + '\n'
}

/**
 * Streaming export generator (ADR-0012 §C): pages through the store in
 * chronological order and yields one line per event, so an arbitrarily large
 * match never has to be materialized in memory. The Readable's backpressure
 * paces the store reads (one page query per pulled chunk).
 */
async function* streamAuditLines(
  store: IStore,
  opts: AuditQueryOptions,
  format: 'jsonl' | 'csv',
): AsyncGenerator<string> {
  if (format === 'csv') yield 'ts,actor,machineId,action,result,detail\n'
  let offset = 0
  for (;;) {
    const page = await store.queryAudit({ ...opts, limit: AUDIT_PAGE_MAX, offset })
    if (page.length === 0) return
    for (const e of page) yield format === 'csv' ? auditLineCsv(e) : auditLineJsonl(e)
    if (page.length < AUDIT_PAGE_MAX) return
    offset += page.length
  }
}

export function isAdmin(user: User): boolean {
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
    await store.upsertUser({ id, role: targetRole, authHash: await hashPassword(password) })
    return { ok: true, user: { id, role: targetRole } }
  })

  // Edit a user: change the role and/or reset the password. Partial — only the
  // fields present in the body are touched; an absent password keeps the old
  // one. System-admin accounts can only be managed by a system admin (mirrors
  // the create-guard below), and a user cannot edit their own row here (self
  // password changes go through /gw/me/password).
  app.patch('/gw/users/:id', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const actor = req.user!
    const id = (req.params as any).id as string
    if (id === actor.id) return reply.code(400).send({ error: '不能编辑自己的账号' })
    const target = await store.getUser(id)
    if (!target) return reply.code(404).send({ error: 'user not found' })

    const body = (req.body ?? {}) as { role?: unknown; password?: unknown }
    const hasRole = typeof body.role === 'string'
    const hasPassword = typeof body.password === 'string' && body.password.length > 0
    if (!hasRole && !hasPassword) return reply.code(400).send({ error: 'nothing to update' })

    let nextRole = target.role
    if (hasRole && (ROLES as string[]).includes(body.role as string)) {
      nextRole = body.role as Role
    } else if (hasRole) {
      return reply.code(400).send({ error: 'invalid role' })
    }

    // A plain admin must not be able to promote themselves/others to system
    // admin, nor to edit a system-admin account (reassignment / demotion).
    if (actor.role !== 'system-admin' && (target.role === 'system-admin' || nextRole === 'system-admin')) {
      return reply.code(403).send({ error: 'only a system admin can manage system admins' })
    }

    let authHash = target.authHash
    if (hasPassword) {
      const pw = body.password as string
      if (pw.length < 6) return reply.code(400).send({ error: '新密码至少 6 位' })
      authHash = await hashPassword(pw)
    }

    const changes: string[] = []
    if (nextRole !== target.role) changes.push(`role: ${target.role} -> ${nextRole}`)
    if (changes.length === 0 && hasPassword) changes.push('password reset')

    if (changes.length > 0) {
      await store.upsertUser({ id, role: nextRole, authHash })
      await store.appendAudit({
        ts: new Date().toISOString(),
        actor: actor.id,
        action: 'update_user',
        result: 'ok',
        detail: changes.join('; '),
      })
    }
    return { ok: true, user: { id, role: nextRole } }
  })

  // Delete a user. Forbidden on your own account and on the last remaining
  // system admin; a plain admin cannot delete a system-admin account.
  app.delete('/gw/users/:id', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const actor = req.user!
    const id = (req.params as any).id as string
    if (id === actor.id) return reply.code(400).send({ error: '不能删除自己的账号' })
    const target = await store.getUser(id)
    if (!target) return reply.code(404).send({ error: 'user not found' })
    if (actor.role !== 'system-admin' && target.role === 'system-admin') {
      return reply.code(403).send({ error: 'only a system admin can delete a system admin' })
    }
    if (target.role === 'system-admin') {
      const sysAdmins = (await store.listUsers()).filter((u) => u.role === 'system-admin')
      if (sysAdmins.length <= 1) return reply.code(400).send({ error: '不能删除最后一个系统管理员' })
    }
    await store.deleteUser(id)
    // A re-created account with the same id should not inherit the deleted
    // account's lockout state.
    await store.deleteThrottleAccount(id)
    await store.appendAudit({
      ts: new Date().toISOString(),
      actor: actor.id,
      action: 'delete_user',
      result: 'ok',
      detail: `${target.id} (${target.role})`,
    })
    return { ok: true }
  })

  // ---- self: change password ---------------------------------------------------
  app.post('/gw/me/password', { preHandler: requireRole() }, async (req, reply) => {
    const user = req.user!
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string }
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' })
    if (!(await verifyPassword(oldPassword, user.authHash))) return reply.code(401).send({ error: '当前密码不正确' })
    if (newPassword.length < 6) return reply.code(400).send({ error: '新密码至少 6 位' })
    await store.upsertUser({ id: user.id, role: user.role, authHash: await hashPassword(newPassword) })
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
  // Composable filters (since/until/machineId/actor/action/result) + optional
  // limit/offset pagination, chronological order (ADR-0012 §D).
  app.get('/gw/audit', { preHandler: requireRole(...ADMIN_ROLES) }, async (req) => {
    return { events: await store.queryAudit(parseAuditQuery((req.query ?? {}) as Record<string, unknown>)) }
  })

  // Manual admin export (ADR-0012 §C): streams every matching event as JSONL
  // (default) or CSV, reusing the query filters (no pagination — a full dump).
  app.get('/gw/audit/export', { preHandler: requireRole(...ADMIN_ROLES) }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const opts = parseAuditQuery(q)
    delete opts.limit
    delete opts.offset
    const format: 'jsonl' | 'csv' = q.format === 'csv' ? 'csv' : 'jsonl'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    reply.header('Cache-Control', 'no-store, private')
    reply.header('Content-Disposition', `attachment; filename="audit-export-${stamp}.${format}"`)
    reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
    return reply.send(Readable.from(streamAuditLines(store, opts, format)))
  })
}
