// Node HMAC challenge handshake for the outbound node channel (per ADR-0002/0004).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * @returns {{ nonce: string }}
 */
export function challenge() {
  return { nonce: randomBytes(16).toString('hex') }
}

/**
 * @param {string} secret
 * @param {string} nonce
 * @returns {string} hex signature
 */
export function signChallenge(secret, nonce) {
  return createHmac('sha256', secret).update(nonce).digest('hex')
}

/**
 * Constant-time verification.
 * @param {string} secret
 * @param {string} nonce
 * @param {string} signature
 * @returns {boolean}
 */
export function verifyChallenge(secret, nonce, signature) {
  if (typeof signature !== 'string') return false
  const expected = Buffer.from(signChallenge(secret, nonce), 'utf8')
  const received = Buffer.from(signature, 'utf8')
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}
