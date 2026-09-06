// Portal-user authentication + session management + RBAC (ADR-0004/0008).
//
// - Opaque, high-entropy session ids in an HttpOnly / SameSite=Strict cookie
//   (no signing needed: the token itself is the secret).
// - Passwords are stored only as scrypt hashes (never plaintext).
// - A bootstrap system admin is ensured on startup.
// - `requireRole(...)` is a fail-closed guard for control-plane routes.
// - Login is throttled (per-IP + per-account, escalating lockout) and every
//   failed attempt is audited (security audit M-2).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import fastifyCookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IStore, User, Role } from 'dsh-gateway-store'
import { LoginThrottle } from './login-throttle.js'

const scryptAsync = promisify(scrypt) as unknown as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>

export const SESSION_COOKIE = 'gw_session'

const MIN = 60 * 1000

// ---- Tunables (env-overridable; defaults fixed by the security plan §6.2) ----
function envNum(name: string, def: number): number {
  const raw = process.env[name]
  if (!raw) return def
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : def
}
const SESSION_IDLE_TTL_MS = envNum('DSH_GATEWAY_SESSION_IDLE_TTL_MS', 8 * 60 * MIN)
const SESSION_ABSOLUTE_TTL_MS = envNum('DSH_GATEWAY_SESSION_ABSOLUTE_TTL_MS', 24 * 60 * MIN)
const SESSION_MAX = envNum('DSH_GATEWAY_SESSION_MAX', 10_000)
const LOGIN_IP_MAX = envNum('DSH_GATEWAY_LOGIN_IP_MAX', 10)
const LOGIN_IP_WINDOW_MS = envNum('DSH_GATEWAY_LOGIN_IP_WINDOW_MS', 15 * MIN)
const LOGIN_ACCOUNT_MAX = envNum('DSH_GATEWAY_LOGIN_ACCOUNT_MAX', 5)
const LOGIN_ACCOUNT_WINDOW_MS = envNum('DSH_GATEWAY_LOGIN_ACCOUNT_WINDOW_MS', 15 * MIN)
const LOGIN_BACKOFF_MS = [3 * MIN, 5 * MIN, 15 * MIN]

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(plain, salt, 64)
  return `${salt}:${hash.toString('hex')}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = await scryptAsync(plain, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// Never-valid scrypt record used to burn the same CPU work when the submitted
// id does not exist, so login latency does not reveal whether an account is
// real (audit M-2: user enumeration via timing).
const DUMMY_STORED = `${'00'.repeat(16)}:${'00'.repeat(64)}`

interface SessionRecord {
  userId: string
  issuedAt: number
  /** Sliding idle expiry (renewed on activity). */
  expiresAt: number
  machineId?: string
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>()

  create(userId: string): string {
    const id = randomBytes(32).toString('hex')
    const now = Date.now()
    this.sessions.set(id, { userId, issuedAt: now, expiresAt: now + SESSION_IDLE_TTL_MS })
    this.evict(now)
    return id
  }

  private expired(s: SessionRecord, now: number): boolean {
    return now > s.expiresAt || now > s.issuedAt + SESSION_ABSOLUTE_TTL_MS
  }

  get(id: string): { userId: string } | undefined {
    const now = Date.now()
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (this.expired(s, now)) {
      this.sessions.delete(id)
      return undefined
    }
    s.expiresAt = now + SESSION_IDLE_TTL_MS // sliding renewal
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
      s.expiresAt = Date.now() + SESSION_IDLE_TTL_MS
    }
  }

  /** The console machine this session is bound to, or undefined. */
  machineOf(id: string): string | undefined {
    const now = Date.now()
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (this.expired(s, now)) {
      this.sessions.delete(id)
      return undefined
    }
    return s.machineId
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }

  /** Bound the in-memory session map: drop expired first, then oldest-by-issue. */
  private evict(now: number): void {
    if (this.sessions.size <= SESSION_MAX) return
    for (const [id, s] of this.sessions) {
      if (this.expired(s, now)) this.sessions.delete(id)
    }
    if (this.sessions.size > SESSION_MAX) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt)
      const remove = this.sessions.size - SESSION_MAX
      for (let i = 0; i < remove; i++) this.sessions.delete(oldest[i][0])
    }
  }

  /** Periodic expired-session sweep (unref'd so it never holds the process open). */
  startPrune(intervalMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => {
      const now = Date.now()
      for (const [id, s] of this.sessions) {
        if (this.expired(s, now)) this.sessions.delete(id)
      }
    }, intervalMs)
    t.unref?.()
    return t
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
      authHash: await hashPassword(opts.adminPassword),
    })
    await store.appendAudit({ ts: now, actor: 'system', action: 'bootstrap_admin', result: 'ok' })
  }
}

export function publicUser(u: User) {
  return { id: u.id, role: u.role }
}

export interface RegisterOptions {
  /**
   * Force the session cookie's Secure flag. `undefined` (default) derives it
   * from the request (`req.protocol === 'https'`), so TLS-terminating proxies
   * get Secure automatically while plain-http loopback dev does not.
   */
  cookieSecure?: boolean
}

export interface Auth {
  sessions: SessionStore
  register(app: FastifyInstance, store: IStore, opts?: RegisterOptions): Promise<void>
  requireRole(...roles: Role[]): (req: FastifyRequest, reply: FastifyReply) => Promise<void>
}

export function buildAuth(): Auth {
  const sessions = new SessionStore()
  const throttle = new LoginThrottle({
    ipMax: LOGIN_IP_MAX,
    ipWindowMs: LOGIN_IP_WINDOW_MS,
    accountMax: LOGIN_ACCOUNT_MAX,
    accountWindowMs: LOGIN_ACCOUNT_WINDOW_MS,
    backoffMs: LOGIN_BACKOFF_MS,
  })

  async function register(app: FastifyInstance, store: IStore, opts: RegisterOptions = {}): Promise<void> {
    await app.register(fastifyCookie)
    sessions.startPrune()

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
      const id = typeof body.id === 'string' ? body.id : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (!id || !password) return reply.code(400).send({ error: 'id and password required' })

      const ip = req.ip
      const allowed = throttle.check(ip, id)
      if (!allowed.ok) {
        return reply
          .code(429)
          .header('Retry-After', String(allowed.retryAfterSec))
          .send({ error: 'too many attempts', retryAfterSec: allowed.retryAfterSec })
      }

      const user = await store.getUser(id)
      // Always burn one scrypt pass (dummy when the user is unknown) so the
      // response time carries no account-existence signal.
      const ok = user ? await verifyPassword(password, user.authHash) : await verifyPassword(password, DUMMY_STORED)
      if (!user || !ok) {
        throttle.recordFailure(ip, id)
        await store.appendAudit({
          ts: new Date().toISOString(),
          actor: id,
          action: 'login',
          result: 'denied',
          detail: JSON.stringify({ ip, ua: String(req.headers['user-agent'] ?? '').slice(0, 120) }),
        })
        return reply.code(401).send({ error: 'invalid credentials' })
      }

      throttle.recordSuccess(id)
      const token = sessions.create(user.id)
      const secure = opts.cookieSecure ?? req.protocol === 'https'
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure })
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
