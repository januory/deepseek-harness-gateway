// Framework-less tests for dsh-gateway-agent secret + config handling.
// Run: node test/secrets.test.js   (uses a fresh temp dir as DSH_HOME internally)

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encrypt, decrypt, isEncrypted, loadOrCreateKey, secretKeyPath, ENC_PREFIX } from '../src/secrets.js'
import { createConfigStore, sanitizeConfig, CLIENT_FIELDS } from '../src/config.js'

let passed = 0
function check(cond, msg) {
  if (cond) {
    passed++
  } else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dshgw-agent-test-'))
}

// --- secrets.js ---
{
  const dir = tempDir()
  const key = loadOrCreateKey(dir)
  check(key.length === 32, 'key is 32 bytes')
  check(existsSync(secretKeyPath(dir)), 'key file created')

  const pt = '0123456789abcdef0123456789abcdef'
  const ct = encrypt(key, pt)
  check(typeof ct === 'string' && ct.startsWith(ENC_PREFIX), 'encrypt produces enc:v1: prefix')
  check(ct !== pt && !ct.includes(pt), 'ciphertext hides plaintext')
  check(decrypt(key, ct) === pt, 'roundtrip decrypt')
  check(decrypt(key, pt) === pt, 'legacy plaintext passes through decrypt')
  check(encrypt(key, ct) === ct, 'encrypt idempotent on ciphertext')
  check(isEncrypted(ct) && !isEncrypted(pt), 'isEncrypted detects prefix')
  check(encrypt(key, '') === '' && encrypt(key, undefined) === undefined, 'empty/undefined untouched')

  const key2 = loadOrCreateKey(dir) // reload the existing key file
  check(key2.length === 32, 'existing key reloaded')
}

// --- config.js: seal/open ---
{
  const dir = tempDir()
  const store = createConfigStore(dir)
  const nodeKey = '0123456789abcdef0123456789abcdef'

  store.write({ gatewayUrl: 'wss://gw/agent', machineId: 'm1', nodeKey })
  const raw = readFileSync(join(dir, 'config.json'), 'utf8')
  check(!raw.includes(nodeKey), 'node key NOT plaintext on disk')
  check(raw.includes(ENC_PREFIX), 'config.json holds enc:v1: ciphertext')

  const cfg = store.read()
  check(cfg.nodeKey === nodeKey, 'read returns plaintext node key in memory')
  check(cfg.machineId === 'm1', 'non-secret fields preserved')
}

// --- config.js: legacy plaintext migration ---
{
  const dir = tempDir()
  const nodeKey = '0123456789abcdef0123456789abcdef'
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ gatewayUrl: 'wss://gw/agent', nodeKey }, null, 2))
  const store = createConfigStore(dir)
  const cfg = store.read()
  check(cfg.nodeKey === nodeKey, 'legacy plaintext read in memory')
  const raw = readFileSync(join(dir, 'config.json'), 'utf8')
  check(raw.includes(ENC_PREFIX) && !raw.includes(nodeKey), 'legacy plaintext migrated to ciphertext on read')
}

// --- config.js: sanitize + client fields ---
{
  const cfg = { gatewayUrl: 'wss://gw/agent', machineId: 'm1', nodeKey: 'secret', operatorCookie: 'cookie=1' }
  const s = sanitizeConfig(cfg)
  check(s.nodeKey === undefined, 'sanitize removes nodeKey')
  check(s.operatorCookie === undefined, 'sanitize removes operatorCookie')
  check(s.hasNodeKey === true, 'sanitize adds hasNodeKey boolean')
  check(s.machineId === 'm1', 'sanitize keeps machineId')
  check(s.gatewayUrl === 'wss://gw/agent', 'sanitize keeps non-secret fields')

  check(CLIENT_FIELDS.includes('gatewayUrl'), 'CLIENT_FIELDS includes gatewayUrl')
  check(CLIENT_FIELDS.includes('pairingCode'), 'CLIENT_FIELDS includes pairingCode')
  check(CLIENT_FIELDS.includes('dshPort'), 'CLIENT_FIELDS includes dshPort')
  check(!CLIENT_FIELDS.includes('nodeKey') && !CLIENT_FIELDS.includes('machineId'), 'CLIENT_FIELDS excludes server-authoritative identity')
}

console.log(`dsh-gateway-agent secrets: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
