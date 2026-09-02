import { describe, it, expect } from 'vitest'
import { challenge, signChallenge, verifyChallenge } from '../src/index.js'

describe('HMAC challenge', () => {
  it('verifies a valid signature', () => {
    const { nonce } = challenge()
    const sig = signChallenge('secret', nonce)
    expect(verifyChallenge('secret', nonce, sig)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    const { nonce } = challenge()
    const sig = signChallenge('secret', nonce)
    expect(verifyChallenge('other', nonce, sig)).toBe(false)
  })

  it('rejects tampered nonce and non-hex input', () => {
    const { nonce } = challenge()
    const sig = signChallenge('secret', nonce)
    expect(verifyChallenge('secret', nonce + 'x', sig)).toBe(false)
    expect(verifyChallenge('secret', nonce, 'not-a-sig')).toBe(false)
  })
})
