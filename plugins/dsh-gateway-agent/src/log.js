// Minimal supervisor logger (plain JS, zero deps).
//
// The supervisor is normally a long-running OS service, so a rotating file is
// the only durable record of what it did on that machine. When no logFile is
// configured it simply mirrors to stdout/stderr (which the service manager
// already captures).

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

export function createLogger(file) {
  const target = typeof file === 'string' && file.trim() ? file.trim() : ''
  let warned = false

  if (target) {
    try {
      mkdirSync(dirname(target), { recursive: true })
    } catch {
      /* fall back to stdout */
    }
  }

  function rotate() {
    try {
      if (!existsSync(target)) return
      if (statSync(target).size < MAX_BYTES) return
      renameSync(target, `${target}.1`)
    } catch {
      /* rotation is best-effort */
    }
  }

  function write(level, message) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
    if (!target) {
      process[level === 'error' ? 'stderr' : 'stdout'].write(line)
      return
    }
    try {
      rotate()
      appendFileSync(target, line)
    } catch (e) {
      if (!warned) {
        warned = true
        process.stderr.write(`[supervisor] cannot write log file ${target}: ${e && e.message ? e.message : e}\n`)
      }
      process[level === 'error' ? 'stderr' : 'stdout'].write(line)
    }
  }

  return {
    file: target,
    info: (message) => write('info', message),
    error: (message) => write('error', message),
  }
}
