// dsh-gateway-agent — at-rest secret handling (ADR-0010 §6).
//
// The node key is a long-term bearer credential: if it leaks, an attacker can
// impersonate the machine on the gateway (which means RCE on that machine). So
// it is AES-256-GCM encrypted at rest with a SEPARATE 32-byte key file (0600),
// mirroring the machine-store secret convention. Ciphertext carries an
// `enc:v1:` prefix; plaintext is only ever held in memory.
//
// Legacy plaintext values (from earlier config.json files) pass through decrypt
// unchanged and are re-encrypted on the next write (migration).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENC_PREFIX = 'enc:v1:'

export function secretKeyPath(dir) {
  return join(dir, '.secret-key')
}

/** Load the 32-byte AES key, creating it (0600) on first use. */
export function loadOrCreateKey(dir) {
  mkdirSync(dir, { recursive: true })
  const p = secretKeyPath(dir)
  if (existsSync(p)) {
    const key = readFileSync(p)
    if (key.length !== 32) throw new Error(`secret key has wrong length (${key.length})`)
    return key
  }
  const key = randomBytes(32)
  writeFileSync(p, key, { mode: 0o600 })
  return key
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX)
}

/** Encrypt a plaintext string; already-encrypted and empty values pass through. */
export function encrypt(key, plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext
  if (isEncrypted(plaintext)) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/** Decrypt; legacy plaintext passes through unchanged (migrated on next write). */
export function decrypt(key, ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return ciphertext
  if (!isEncrypted(ciphertext)) return ciphertext
  const parts = ciphertext.slice(ENC_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('malformed encrypted value')
  const [ivHex, tagHex, dataHex] = parts
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}
