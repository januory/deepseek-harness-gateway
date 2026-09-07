// Admin user management test over a REAL gateway process: boots src/main.ts
// against a pre-seeded SQLite DB with a system admin, a second system admin,
// a tenant admin and a regular user, then verifies end-to-end that
//  1. GET  /gw/users lists all users,
//  2. PATCH /gw/users/:id edits a role and/or resets a password,
//  3. self-edit / self-delete are rejected (400),
//  4. a plain admin cannot edit/delete a system-admin account (403),
//  5. DELETE /gw/users/:id removes the user (and their password stops working).
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { SqliteStore } from 'dsh-gateway-store'
import { hashPassword } from '../src/auth.js'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const gatewayRoot = join(here, '..')
const tsxCli = require.resolve('tsx/cli')

const ADMIN = 'admin'
const ADMIN_PW = 'admin-pw-1'
const SYS2 = 'sys2'
const SYS2_PW = 'sys2-pw-1'
const OP = 'op'
const OP_PW = 'op-pw-1'
const ALICE = 'alice'
const ALICE_PW = 'alice-pw-1'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface GatewayProc {
  child: ChildProcess
  logs: () => string
}

async function startGateway(dbPath: string, port: number): Promise<GatewayProc> {
  const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
    cwd: gatewayRoot,
    env: {
      ...process.env,
      DSH_GATEWAY_HOST: '127.0.0.1',
      DSH_GATEWAY_PORT: String(port),
      DSH_GATEWAY_DB_PATH: dbPath,
      DSH_GATEWAY_ADMIN_ID: ADMIN,
      DSH_GATEWAY_ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (d: Buffer) => (logs += d.toString()))
  child.stderr.on('data', (d: Buffer) => (logs += d.toString()))

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (code ${child.exitCode})\n${logs}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return { child, logs: () => logs }
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  child.kill('SIGKILL')
  throw new Error(`gateway did not become healthy in time\n${logs}`)
}

async function stopGateway(gw: GatewayProc): Promise<void> {
  const { child } = gw
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(killer)
}

async function login(port: number, id: string, password: string): Promise<{ status: number; token?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = /(?:^|;\s*)(gw_session|__Host-gw_session)=([^;]+)/.exec(setCookie)
  return { status: res.status, token: m ? `${m[1]}=${m[2]}` : undefined }
}

async function gwReq(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { cookie: token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  return { status: res.status, json }
}

describe('admin user edit/delete over a real gateway', () => {
  it(
    'lists, edits and deletes users with role/password and RBAC guards',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dshgw-users-'))
      const dbPath = join(dir, 'gateway.db')

      // Seed the DB BEFORE the gateway boots: `admin` already exists as a
      // system admin, so the bootstrap step does not recreate it.
      const seed = new SqliteStore({ filename: dbPath })
      await seed.open()
      await seed.upsertUser({ id: ADMIN, role: 'system-admin', authHash: await hashPassword(ADMIN_PW) })
      await seed.upsertUser({ id: SYS2, role: 'system-admin', authHash: await hashPassword(SYS2_PW) })
      await seed.upsertUser({ id: OP, role: 'admin', authHash: await hashPassword(OP_PW) })
      await seed.upsertUser({ id: ALICE, role: 'user', authHash: await hashPassword(ALICE_PW) })
      await seed.close()

      const port = await freePort()
      let gw: GatewayProc | undefined
      try {
        gw = await startGateway(dbPath, port)

        const me = await login(port, ADMIN, ADMIN_PW)
        expect(me.status).toBe(200)
        const adminTok = me.token as string

        // ---- list all users ----
        const list = await gwReq(port, 'GET', '/gw/users', adminTok)
        expect(list.status).toBe(200)
        const ids = (list.json.users as Array<{ id: string; role: string }>).map((u) => u.id).sort()
        expect(ids).toEqual([ADMIN, ALICE, OP, SYS2].sort())

        // ---- edit a role ----
        const roleEdit = await gwReq(port, 'PATCH', `/gw/users/${ALICE}`, adminTok, { role: 'admin' })
        expect(roleEdit.status).toBe(200)
        expect(roleEdit.json.user.role).toBe('admin')
        const afterEdit = await gwReq(port, 'GET', '/gw/users', adminTok)
        expect((afterEdit.json.users as Array<{ id: string; role: string }>).find((u) => u.id === ALICE)?.role).toBe('admin')

        // ---- reset a password (role untouched) ----
        const newPw = 'alice-new-pw-9'
        const pwEdit = await gwReq(port, 'PATCH', `/gw/users/${ALICE}`, adminTok, { password: newPw })
        expect(pwEdit.status).toBe(200)
        const aliceLogin = await login(port, ALICE, newPw)
        expect(aliceLogin.status).toBe(200)
        const oldLogin = await login(port, ALICE, ALICE_PW)
        expect(oldLogin.status).toBe(401)

        // ---- invalid/empty edits ----
        expect((await gwReq(port, 'PATCH', `/gw/users/${ALICE}`, adminTok, {})).status).toBe(400)
        expect((await gwReq(port, 'PATCH', `/gw/users/${ALICE}`, adminTok, { role: 'superuser' })).status).toBe(400)
        expect((await gwReq(port, 'PATCH', `/gw/users/${ALICE}`, adminTok, { password: 'short' })).status).toBe(400)

        // ---- self-edit / self-delete are rejected ----
        expect((await gwReq(port, 'PATCH', `/gw/users/${ADMIN}`, adminTok, { role: 'user' })).status).toBe(400)
        expect((await gwReq(port, 'DELETE', `/gw/users/${ADMIN}`, adminTok)).status).toBe(400)

        // ---- a plain admin cannot touch a system-admin (403) ----
        const opTok = (await login(port, OP, OP_PW)).token as string
        expect((await gwReq(port, 'PATCH', `/gw/users/${ADMIN}`, opTok, { role: 'user' })).status).toBe(403)
        expect((await gwReq(port, 'PATCH', `/gw/users/${SYS2}`, opTok, { role: 'user' })).status).toBe(403)
        expect((await gwReq(port, 'DELETE', `/gw/users/${SYS2}`, opTok)).status).toBe(403)

        // ---- a system admin can manage another system admin ----
        const sys2Edit = await gwReq(port, 'PATCH', `/gw/users/${SYS2}`, adminTok, { role: 'admin' })
        expect(sys2Edit.status).toBe(200)

        // ---- delete a user: gone from the list and password stops working ----
        const del = await gwReq(port, 'DELETE', `/gw/users/${ALICE}`, adminTok)
        expect(del.status).toBe(200)
        const afterDelete = await gwReq(port, 'GET', '/gw/users', adminTok)
        const delIds = (afterDelete.json.users as Array<{ id: string }>).map((u) => u.id)
        expect(delIds).not.toContain(ALICE)
        expect((await login(port, ALICE, newPw)).status).toBe(401)

        // ---- auditing: the delete event is recorded ----
        const audit = await gwReq(port, 'GET', '/gw/audit?action=delete_user', adminTok)
        const deleteActs = (audit.json.events as Array<{ actor: string; detail?: string }>).filter(
          (e) => e.actor === ADMIN && e.detail && e.detail.includes(ALICE),
        )
        expect(deleteActs.length).toBeGreaterThanOrEqual(1)
      } finally {
        if (gw) await stopGateway(gw).catch(() => gw!.child.kill('SIGKILL'))
      }
      rmSync(dir, { recursive: true, force: true })
    },
    90_000,
  )
})
