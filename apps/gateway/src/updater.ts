// Version + hot-update (git-based).
//
// - GET    /gw/version          local state only (no network): repo/branch/remote/HEAD/dirty
// - POST   /gw/version/check    `git fetch origin` then count commits behind/ahead + list them
// - POST   /gw/version/update   `git pull --ff-only origin <branch>`, spawn the
//                               build command detached, then reload the gateway
//
// Reload is DETERMINISTIC: after a successful pull the gateway exits, and the
// entrypoint's supervisor loop restarts it on the new HEAD. We deliberately do
// NOT rely on `tsx watch`'s file watcher — git's atomic renames are not reliably
// detected, so a pull could advance HEAD while the running process kept serving
// pre-pull code (the earlier failure mode).
//
// The build command runs DETACHED from the gateway (see spawnBuildCommand) so a
// slow `pnpm -r build` never blocks the reload or graceful shutdown; the gateway
// serves TypeScript from source (`tsx`), so it does not wait for the build.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  reload: 'supervised'
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

/**
 * Spawn an operator-configured build command (e.g. `pnpm -r build`) detached from
 * the gateway process, after a successful pull.
 *
 * Detached + unref'd so the build survives the gateway's deterministic reload and
 * never blocks graceful shutdown: the gateway exits right after the pull and the
 * supervisor loop restarts it, so a build awaited inside the request handler would
 * keep `app.close()` open. The build keeps running on its own; the gateway serves
 * TypeScript from source, so it does not wait for the build to finish. Output is
 * redirected to a log file so failures stay inspectable.
 */
function spawnBuildCommand(repo: string, cmd: string): void {
  const logPath = process.env.DSH_GATEWAY_BUILD_LOG ?? join(tmpdir(), 'dsh-gateway-hot-update-build.log')
  // Shell redirect so the detached child's stdout/stderr survive the parent and
  // remain readable if the build fails. `( ... )` groups the operator command so
  // `&&`-chained build commands are still captured as a whole.
  const wrapped = `( ${cmd} ) >> "${logPath}" 2>&1`
  const child = spawn('sh', ['-c', wrapped], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

/** Exit so the entrypoint supervisor loop restarts the gateway on the new HEAD. */
function scheduleReload(): void {
  setTimeout(() => {
    // Exit unconditionally. `app.close()` can hang on the console's live
    // WebSocket / HTTP keep-alive connections, which closes the listener but
    // leaves the process alive — a permanent 502 that the supervisor loop can
    // never recover. The audit is already flushed before this runs, and the OS
    // releases the port the instant the process dies, so the loop rebinds.
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
        log.info('[updater] spawning detached build command: ' + buildCmd)
        spawnBuildCommand(repo, buildCmd)
      }

      await store.appendAudit({
        ts: new Date().toISOString(),
        actor: req.user!.id,
        action: 'version_update',
        result: 'ok',
        detail: `${res.pulled.length} commit(s) ${res.from.slice(0, 8)}→${res.to.slice(0, 8)}`,
      })

      // Deterministic reload: exit and let the entrypoint supervisor loop
      // restart the gateway on the new HEAD. Never rely on a file watcher.
      log.info('[updater] update applied — exiting for deterministic supervised reload')
      scheduleReload()

      return { ok: true, ...res, reload: 'supervised' } satisfies UpdateResult
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      log.warn('[updater] update failed: ' + msg)
      await store.appendAudit({ ts: new Date().toISOString(), actor: req.user!.id, action: 'version_update', result: 'error', detail: msg })
      return reply.code(400).send({ error: msg })
    }
  })
}
