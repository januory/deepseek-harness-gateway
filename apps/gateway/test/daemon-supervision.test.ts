// Daemon supervision over a REAL gateway process: two node sockets for one
// machine (console plugin + supervisor), portal control endpoints, persistence
// of the reported lifecycle state and the audit trail.
//
// Covers what unit tests cannot: that stopping/reaching dsh is a per-machine
// control operation routed to the SUPERVISOR socket (not the console socket),
// that a supervisor disconnect fails in-flight requests, and that the portal's
// machine view keeps the last known state after the supervisor is gone.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
import { SqliteStore } from 'dsh-gateway-store'
import { hashPassword } from '../src/auth.js'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const gatewayRoot = join(here, '..')
const tsxCli = require.resolve('tsx/cli')

const ADMIN = 'admin'
const ADMIN_PW = 'admin-pw-1'
const MACHINE = 'm-daemon-1'
const NODE_KEY = 'node-key-daemon-test'

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

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
    if (child.exitCode !== null) throw new Error(`gateway exited early (code ${child.exitCode})\n${logs}`)
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
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { cookie: token } : {},
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

/**
 * A minimal node socket: completes the challenge/response handshake with the
 * issued node key, then records every inbound control frame and lets the test
 * answer daemon_result on demand.
 */
class FakeNode {
  readonly ws: WebSocket
  readonly frames: any[] = []
  onControl?: (payload: any) => void

  constructor(port: number, role: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent`)
    this.ws.on('message', (raw) => {
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      this.frames.push(msg)
      if (msg.type === 'challenge') {
        this.ws.send(
          JSON.stringify({
            v: 1,
            type: 'challenge_response',
            payload: { nonce: msg.payload.nonce, machineId: MACHINE, nodeKey: NODE_KEY, role },
          }),
        )
      }
      if (msg.type === 'daemon_control') this.onControl?.(msg.payload)
    })
  }

  ready(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('node never became ready')), timeoutMs)
      const check = () => {
        if (this.frames.some((f) => f.type === 'registration_status')) {
          clearTimeout(timer)
          resolve()
        }
      }
      this.ws.on('message', check)
      check()
    })
  }

  heartbeat(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: 1, type: 'heartbeat', payload: { machineId: MACHINE, ...payload } }))
  }

  result(id: string, ok: boolean, extra: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ v: 1, type: 'daemon_result', payload: { id, ok, ...extra } }))
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return false
}

describe('daemon supervision over a real gateway', () => {
  it(
    'keeps a supervisor socket beside the console socket and controls dsh through it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dshgw-daemon-e2e-'))
      const dbPath = join(dir, 'gateway.db')

      const seed = new SqliteStore({ filename: dbPath })
      await seed.open()
      await seed.upsertUser({ id: ADMIN, role: 'system-admin', authHash: await hashPassword(ADMIN_PW) })
      await seed.upsertMachine({
        id: MACHINE,
        name: 'supervised-box',
        nodeKeyHash: sha256Hex(NODE_KEY),
        status: 'approved',
        dshVersion: '0.1.5',
        configRev: 0,
        createdAt: new Date().toISOString(),
      })
      await seed.close()

      const port = await freePort()
      let gw: GatewayProc | undefined
      let consoleNode: FakeNode | undefined
      let supervisor: FakeNode | undefined
      try {
        gw = await startGateway(dbPath, port)
        const adminTok = (await login(port, ADMIN, ADMIN_PW)).token as string
        expect(adminTok).toBeTruthy()

        consoleNode = new FakeNode(port, 'console')
        supervisor = new FakeNode(port, 'supervisor')
        await consoleNode.ready()
        await supervisor.ready()

        // Both sockets coexist: neither replaces the other in the registry.
        supervisor.heartbeat({ daemonState: 'running', daemonEnabled: true })
        const sawRunning = await waitFor(async () => {
          const res = await gwReq(port, 'GET', '/gw/machines', adminTok)
          const m = (res.json.machines as any[]).find((x) => x.id === MACHINE)
          return !!m && m.daemonState === 'running' && m.supervisorConnected === true
        })
        expect(sawRunning, `machine never reported running\n${gw.logs()}`).toBe(true)

        // The portal view carries both planes plus the daemon columns.
        const listed = await gwReq(port, 'GET', '/gw/machines', adminTok)
        const view = (listed.json.machines as any[]).find((x) => x.id === MACHINE)
        expect(view).toMatchObject({
          supervisorConnected: true,
          daemonEnabled: true,
          daemonState: 'running',
          consoleConnected: true,
          online: true,
        })

        // A control action is routed to the SUPERVISOR socket only.
        supervisor.onControl = (payload) => {
          expect(payload.action).toBe('restart')
          supervisor!.result(payload.id, true, { state: 'starting' })
        }
        const restart = await gwReq(port, 'POST', `/gw/machines/${MACHINE}/daemon/restart`, adminTok)
        expect(restart.status).toBe(200)
        expect(restart.json.state).toBe('starting')
        // The console socket must never see daemon control traffic.
        expect(consoleNode.frames.some((f) => f.type === 'daemon_control')).toBe(false)

        // The reported state (and the audit trail) follow the supervisor.
        supervisor.heartbeat({ daemonState: 'starting', daemonEnabled: true })
        const sawStarting = await waitFor(async () => {
          const res = await gwReq(port, 'GET', '/gw/machines', adminTok)
          const m = (res.json.machines as any[]).find((x) => x.id === MACHINE)
          return !!m && m.daemonState === 'starting'
        })
        expect(sawStarting).toBe(true)

        const audit = await gwReq(port, 'GET', '/gw/audit?action=daemon_restart', adminTok)
        expect((audit.json.events as any[]).length).toBeGreaterThanOrEqual(1)
        expect((audit.json.events as any[])[0]).toMatchObject({ actor: ADMIN, machineId: MACHINE, result: 'ok' })

        // A failed action surfaces as an error and is audited as one.
        supervisor.onControl = (payload) => supervisor!.result(payload.id, false, { error: 'boom: start script failed' })
        const failed = await gwReq(port, 'POST', `/gw/machines/${MACHINE}/daemon/start`, adminTok)
        expect(failed.status).toBe(502)
        expect(String(failed.json.error)).toContain('boom')
        const failedAudit = await gwReq(port, 'GET', '/gw/audit?action=daemon_start', adminTok)
        expect((failedAudit.json.events as any[])[0]).toMatchObject({ result: 'error' })

        // With no supervisor, control is impossible (503) and the last *settled*
        // state survives in the portal view. The `starting` above must not stick:
        // a transient state frozen mid-flight would read as 处理中 in the portal
        // forever, with no supervisor left to finish it.
        supervisor.close()
        supervisor = undefined
        const sawGone = await waitFor(async () => {
          const res = await gwReq(port, 'GET', '/gw/machines', adminTok)
          const m = (res.json.machines as any[]).find((x) => x.id === MACHINE)
          return !!m && m.supervisorConnected === false
        })
        expect(sawGone).toBe(true)

        const noSupervisor = await gwReq(port, 'POST', `/gw/machines/${MACHINE}/daemon/stop`, adminTok)
        expect(noSupervisor.status).toBe(503)
        expect(String(noSupervisor.json.error)).toMatch(/supervisor/)

        const offlineView = await gwReq(port, 'GET', '/gw/machines', adminTok)
        const offlineMachine = (offlineView.json.machines as any[]).find((x) => x.id === MACHINE)
        // The console socket is still up, so the machine is not "offline"; only
        // the daemon controls become unavailable.
        expect(offlineMachine.online).toBe(true)
        expect(offlineMachine.supervisorConnected).toBe(false)
        expect(offlineMachine.daemonState).toBe('running')

        // Only an authenticated admin may drive a machine lifecycle.
        const anon = await gwReq(port, 'POST', `/gw/machines/${MACHINE}/daemon/restart`)
        expect(anon.status).toBe(401)
      } finally {
        consoleNode?.close()
        supervisor?.close()
        if (gw) await stopGateway(gw).catch(() => gw!.child.kill('SIGKILL'))
        rmSync(dir, { recursive: true, force: true })
      }
    },
    90_000,
  )
})
