// Portal-user authentication + session management + RBAC (ADR-0004/0008).
//
// - Opaque, high-entropy session ids in an HttpOnly / SameSite=Strict cookie
//   (no signing needed: the token itself is the secret).
// - Passwords are stored only as scrypt hashes (never plaintext).
// - A bootstrap system admin is ensured on startup.
// - `requireRole(...)` is a fail-closed guard for control-plane routes.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fastifyCookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IStore, User, Role } from 'dsh-gateway-store'

export const SESSION_COOKIE = 'gw_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plain, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(plain, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export class SessionStore {
  private sessions = new Map<string, { userId: string; expiresAt: number; machineId?: string }>()

  create(userId: string): string {
    const id = randomBytes(32).toString('hex')
    this.sessions.set(id, { userId, expiresAt: Date.now() + SESSION_TTL_MS })
    return id
  }

  get(id: string): { userId: string } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(id)
      return undefined
    }
    s.expiresAt = Date.now() + SESSION_TTL_MS // sliding renewal
    return { userId: s.userId }
  }

  /**
   * Bind a session to the console machine it is currently operating. The
   * relayed dsh console issues every /api, /plugins, /assets and WebSocket
   * request as an absolute path — the dsh client bases them on
   * `location.origin` (see packages/client/connection resolveBase), which is
   * the gateway, so they carry NO machineId. With more than one connected node
   * the single-node passthrough (`singleNodeId()`) can't disambiguate them and
   * 503s them. The gateway thus routes those machine-less paths to the machine
   * this session is bound to. Bound when the session opens a `/console/<id>`
   * page; overridden on the most recent console the session opened.
   */
  bindMachine(id: string, machineId: string): void {
    const s = this.sessions.get(id)
    if (s) {
      s.machineId = machineId
      s.expiresAt = Date.now() + SESSION_TTL_MS
    }
  }

  /** The console machine this session is bound to, or undefined. */
  machineOf(id: string): string | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(id)
      return undefined
    }
    return s.machineId
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }
}

export interface BootstrapOptions {
  adminId: string
  adminPassword: string
}

export async function bootstrap(store: IStore, opts: BootstrapOptions): Promise<void> {
  const now = new Date().toISOString()
  const admin = await store.getUser(opts.adminId)
  if (!admin) {
    await store.upsertUser({
      id: opts.adminId,
      role: 'system-admin',
      authHash: hashPassword(opts.adminPassword),
    })
    await store.appendAudit({ ts: now, actor: 'system', action: 'bootstrap_admin', result: 'ok' })
  }
}

export function publicUser(u: User) {
  return { id: u.id, role: u.role }
}

export interface Auth {
  sessions: SessionStore
  register(app: FastifyInstance, store: IStore): Promise<void>
  requireRole(...roles: Role[]): (req: FastifyRequest, reply: FastifyReply) => Promise<void>
}

export function buildAuth(): Auth {
  const sessions = new SessionStore()

  async function register(app: FastifyInstance, store: IStore): Promise<void> {
    await app.register(fastifyCookie)

    // Resolve the session → user on every request (cheap; SQLite-backed).
    app.addHook('preHandler', async (req) => {
      const token = req.cookies?.[SESSION_COOKIE]
      if (!token) return
      const s = sessions.get(token)
      if (!s) return
      req.user = await store.getUser(s.userId)
    })

    app.post('/gw/login', async (req, reply) => {
      const body = (req.body ?? {}) as { id?: string; password?: string }
      if (!body.id || !body.password) return reply.code(400).send({ error: 'id and password required' })
      const user = await store.getUser(body.id)
      if (!user || !verifyPassword(body.password, user.authHash)) {
        return reply.code(401).send({ error: 'invalid credentials' })
      }
      const token = sessions.create(user.id)
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: false })
      await store.appendAudit({ ts: new Date().toISOString(), actor: user.id, action: 'login', result: 'ok' })
      return { ok: true, user: publicUser(user) }
    })

    app.post('/gw/logout', async (req, reply) => {
      const token = req.cookies?.[SESSION_COOKIE]
      if (token) sessions.destroy(token)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    })

    app.get('/gw/me', { preHandler: requireRole() }, async (req) => ({ user: publicUser(req.user!) }))
  }

  function requireRole(...roles: Role[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user
      if (!user) return reply.code(401).send({ error: 'unauthorized' })
      if (roles.length > 0 && !roles.includes(user.role)) return reply.code(403).send({ error: 'forbidden' })
    }
  }

  return { sessions, register, requireRole }
}
