// dsh-gateway-agent — self-owned config store (ADR-0010 §3/§6).
//
// Config lives at `$DSH_HOME/dsh-gateway-agent/config.json` (0600), away from
// dsh's own settings system. Secret fields (the node key) are sealed at rest and
// opened in memory; every read auto-migrates legacy plaintext. The browser only
// ever receives the sanitized projection (booleans, never secret values).

import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decrypt, encrypt, isEncrypted, loadOrCreateKey } from './secrets.js'

const PACKAGE = 'dsh-gateway-agent'

/** Secret fields: sealed at rest, never returned to the browser. */
const SECRET_FIELDS = ['nodeKey']

/** Fields a client is allowed to write; node identity is server-authoritative. */
export const CLIENT_FIELDS = ['gatewayUrl', 'pairingCode', 'dshPort', 'machineName']

export function configDir() {
  const fromEnv = process.env.DSH_HOME
  const base = fromEnv && String(fromEnv).trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
  return join(base, PACKAGE)
}

function configPath(dir) {
  return join(dir, 'config.json')
}

function readRaw(dir) {
  const p = configPath(dir)
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
      return JSON.parse(raw)
    }
  } catch {
    /* ignore corrupt config */
  }
  return {}
}

function writeRaw(dir, cfg) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

export function createConfigStore(dir) {
  const key = loadOrCreateKey(dir)

  /** Read config with secrets decrypted in memory; migrates legacy plaintext. */
  function read() {
    const cfg = readRaw(dir)
    let migrated = false
    for (const field of SECRET_FIELDS) {
      const raw = cfg[field]
      if (!raw) continue
      if (!isEncrypted(raw)) migrated = true
      try {
        cfg[field] = decrypt(key, raw)
      } catch {
        // Key lost/rotated → the value is unrecoverable; drop it so the machine
        // can re-onboard, and persist the cleared state.
        cfg[field] = undefined
        migrated = true
      }
    }
    if (migrated) write(cfg)
    return cfg
  }

  /** Persist config with secrets sealed at rest. */
  function write(cfg) {
    const out = { ...cfg }
    for (const field of SECRET_FIELDS) {
      out[field] = encrypt(key, out[field])
    }
    writeRaw(dir, out)
  }

  return { read, write }
}

/** Browser-safe projection: secrets become booleans; values never leak. */
export function sanitizeConfig(cfg) {
  const out = { ...cfg }
  delete out.nodeKey
  delete out.operatorCookie
  out.hasNodeKey = !!cfg.nodeKey
  return out
}
