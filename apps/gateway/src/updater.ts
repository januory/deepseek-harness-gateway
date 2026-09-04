// Version + hot-update (git-based).
//
// - GET    /gw/version          local state only (no network): repo/branch/remote/HEAD/dirty
// - POST   /gw/version/check    `git fetch origin` then count commits behind/ahead + list them
// - POST   /gw/version/update   `git pull --ff-only origin <branch>` then reload the gateway
//
// Reload strategy: in dev the gateway runs under `tsx watch`, which restarts itself
// on changed files (so a pull that touches apps/gateway/src/*.ts is already a hot
// reload). When running compiled JS (`node dist/main.js`) we re-exec the same entry
// as a detached child and exit, relying on that self-spawn as the supervisor.

import { exec, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { IStore, Role } from 'dsh-gateway-store'
import type { Auth } from './auth.js'

const SEP = '\u001f' // unit separator — safe delimiter for git --format
const LOG_FORMAT = ['%H', '%h', '%an', '%ad', '%s'].join(SEP)

export interface CommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface VersionInfo {
  /** false when the process is not inside a git checkout (e.g. baked Docker image without a source repo). */
  git: boolean
  repo: string
  branch: string
  remote: string | null
  dirty: boolean
  head: CommitInfo | null
}

export interface UpdateStatus extends VersionInfo {
  behind: number
  ahead: number
  remoteHead: string | null
  incoming: CommitInfo[]
}

export interface UpdateResult {
  ok: boolean
  from: string
  to: string
  pulled: CommitInfo[]
  reload: 'watch' | 'restart'
}

type GitLog = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').trim() || (err as Error).message
          reject(new Error(msg))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** Resolve the git repo root from the gateway's cwd, falling back to walking up from src/. */
async function findRepoRoot(): Promise<string> {
  try {
    return (await runGit(process.cwd(), ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    let dir = fileURLToPath(new URL('.', import.meta.url))
    for (;;) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    throw new Error('not a git repository')
  }
}

function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash = '', short = '', author = '', date = '', subject = ''] = line.split(SEP)
      return { hash, short, author, date, subject }
    })
}

async function getVersionInfo(repo: string): Promise<VersionInfo> {
  let branch = ''
  try {
    branch = (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    /* no HEAD yet */
  }

  let remote: string | null = null
  try {
    remote = (await runGit(repo, ['remote', 'get-url', 'origin'])).trim()
  } catch {
    remote = null
  }

  let head: CommitInfo | null = null
  try {
    head = parseLog(await runGit(repo, ['log', '-1', `--format=${LOG_FORMAT}`, '--date=short']))[0] ?? null
  } catch {
    head = null
  }

  let dirty = false
  try {
    dirty = (await runGit(repo, ['status', '--porcelain'])).trim() !== ''
  } catch {
    dirty = false
  }

  return { git: true, repo, branch, remote, dirty, head }
}

async function checkForUpdates(repo: string): Promise<UpdateStatus> {
  const info = await getVersionInfo(repo)
  const branch = info.branch || 'main'

  await runGit(repo, ['fetch', 'origin', branch], 90_000)
  const upstream = `origin/${branch}`

  let behind = 0
  let ahead = 0
  try {
    behind = parseInt((await runGit(repo, ['rev-list', '--count', `HEAD..${upstream}`])).trim() || '0', 10) || 0
  } catch {
    behind = 0
  }
  try {
    ahead = parseInt((await runGit(repo, ['rev-list', '--count', `${upstream}..HEAD`])).trim() || '0', 10) || 0
  } catch {
    ahead = 0
  }

  let remoteHead: string | null = null
  try {
    remoteHead = (await runGit(repo, ['rev-parse', upstream])).trim()
  } catch {
    remoteHead = null
  }

  let incoming: CommitInfo[] = []
  if (behind > 0) {
    try {
      incoming = parseLog(await runGit(repo, ['log', `--format=${LOG_FORMAT}`, '--date=short', '-n', '50', `HEAD..${upstream}`]))
    } catch {
      incoming = []
    }
  }

  return { ...info, behind, ahead, remoteHead, incoming }
}

async function applyUpdate(repo: string): Promise<{ from: string; to: string; pulled: CommitInfo[] }> {
  const before = (await runGit(repo, ['rev-parse', 'HEAD'])).trim()

  // No pre-flight dirty check: just attempt the fast-forward pull. `git pull
  // --ff-only` already fails safely when there is a real conflict, and untracked
  // files (e.g. a pnpm store) don't block it — surface the error only on failure.
  let branch = 'main'
  try {
    branch = (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main'
  } catch {
    /* keep default */
  }

  await runGit(repo, ['pull', '--ff-only', 'origin', branch], 120_000)

  const after = (await runGit(repo, ['rev-parse', 'HEAD'])).trim()

  let pulled: CommitInfo[] = []
  if (before !== after) {
    try {
      pulled = parseLog(await runGit(repo, ['log', `--format=${LOG_FORMAT}`, '--date=short', `${before}..${after}`]))
    } catch {
      pulled = []
    }
  }
  return { from: before, to: after, pulled }
}

/** Run an operator-configured build command after a successful pull (e.g. `pnpm -r build` in the container). */
function runBuildCommand(repo: string, cmd: string, timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: repo, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || '').trim() || (err as Error).message
        reject(new Error('build failed: ' + msg))
        return
      }
      resolve()
    })
  })
}

/** `watch` when tsx runs our .ts entry (it reloads on file change); `restart` for compiled JS. */
function reloadStrategy(): 'watch' | 'restart' {
  return (process.argv[1] ?? '').endsWith('.ts') ? 'watch' : 'restart'
}

function scheduleRestart(app: FastifyInstance): void {
  setTimeout(async () => {
    try {
      await app.close() // release the port so the re-spawned child can bind cleanly
    } catch {
      /* ignore */
    }
    try {
      const child = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), detached: true, stdio: 'inherit' })
      child.unref()
    } catch (e) {
      app.log.error('[updater] failed to re-exec: ' + String(e))
    }
    process.exit(0)
  }, 500)
}

const ADMIN_ROLES: Role[] = ['admin', 'system-admin']

export async function registerUpdater(app: FastifyInstance, auth: Auth, store: IStore): Promise<void> {
  const { requireRole } = auth
  const log: GitLog = app.log

  app.get('/gw/version', { preHandler: requireRole(...ADMIN_ROLES) }, async () => {
    try {
      return await getVersionInfo(await findRepoRoot())
    } catch {
      // Not a git checkout (e.g. baked Docker image without a source repo) — report
      // gracefully so the settings page can disable hot-update instead of erroring.
      return { git: false, repo: '', branch: '', remote: null, dirty: false, head: null } satisfies VersionInfo
    }
  })

  app.post('/gw/version/check', { preHandler: requireRole(...ADMIN_ROLES) }, async (_req, reply) => {
    try {
      return await checkForUpdates(await findRepoRoot())
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) })
    }
  })

  app.post('/gw/version/update', { preHandler: requireRole('system-admin') }, async (req, reply) => {
    try {
      const repo = await findRepoRoot()
      const res = await applyUpdate(repo)

      const buildCmd = process.env.DSH_GATEWAY_BUILD_CMD
      if (buildCmd) {
        log.info('[updater] running build command: ' + buildCmd)
        await runBuildCommand(repo, buildCmd)
      }

      const reload = reloadStrategy()

      if (reload === 'restart') {
        log.info('[updater] update applied — re-exec to reload')
        scheduleRestart(app)
      } else {
        log.info('[updater] update applied — tsx watch will reload on changed files')
      }

      await store.appendAudit({
        ts: new Date().toISOString(),
        actor: req.user!.id,
        action: 'version_update',
        result: 'ok',
        detail: `${res.pulled.length} commit(s) ${res.from.slice(0, 8)}→${res.to.slice(0, 8)}`,
      })

      return { ok: true, ...res, reload } satisfies UpdateResult
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      log.warn('[updater] update failed: ' + msg)
      await store.appendAudit({ ts: new Date().toISOString(), actor: req.user!.id, action: 'version_update', result: 'error', detail: msg })
      return reply.code(400).send({ error: msg })
    }
  })
}
