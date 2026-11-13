// Operator admission for relayed console requests (ADR-0010 B3(b)).
//
// dsh before 0.2.2-rc.2 exposed BrowserAuth on the `connection` service
// (`authenticatedUrl` + `authorizeIndex`); the agent minted the browser-session
// cookie in-process and replayed it on every relayed request. The Token
// Provider refactor ("connection auth provider for remote connection") removed
// both from Connection: credentials moved into the `connection.authentication`
// registry, where each provider owns a Peer and the webserver admits every
// protected route through it. With no provider registered, every relayed
// request is refused with 401 — the "unauthorized" the portal console showed
// after a dsh update.
//
// New hosts: register our own provider and admit relayed requests by a private
// header secret minted at apply() time. It never touches disk (ADR-0010 §6),
// never leaves this process except on the outbound relay, and depends on
// neither Token's launch token nor its cookie name/expiry. Old hosts keep the
// cookie path in index.js; which one runs is decided by the API the host
// actually exposes, so one artifact serves both generations.

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Header the agent stamps on every relayed HTTP request and WS upgrade. */
export const OPERATOR_HEADER = 'x-dsh-gateway-agent-operator'

/** Fresh in-memory credential for one plugin activation. */
export function createOperatorCredential() {
  return Object.freeze({ header: OPERATOR_HEADER, secret: randomBytes(32).toString('base64url') })
}

/** Read one header from either carrier shape (node:http record or Fetch Headers). */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (typeof value === 'string') return value
    // A repeated header is not our credential; refuse rather than pick one.
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0]
    return undefined
  }
  return undefined
}

/** Constant-time check that a request carries this activation's operator secret. */
export function credentialMatches(headers, credential) {
  if (!credential || typeof credential.secret !== 'string' || typeof credential.header !== 'string') return false
  const actual = headerValue(headers, credential.header)
  if (typeof actual !== 'string') return false
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(credential.secret, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** True when the host exposes the provider registry (dsh ≥ 0.2.2-rc.2). */
export function hasProviderApi(connection) {
  return !!connection
    && typeof connection.createPeer === 'function'
    && !!connection.authentication
    && typeof connection.authentication.register === 'function'
}

/**
 * Own one owner Peer and admit requests carrying our header secret. The
 * calling scope owns both the Peer and the registration, so unloading the
 * plugin withdraws admission; the returned disposer withdraws it explicitly.
 * @param {{createPeer(options: {principal: {kind: string}}): unknown; authentication: {register(provider: {authenticate(request: unknown): unknown}): unknown}}} connection
 * @param {{header: string; secret: string}} credential
 */
export function registerOperatorProvider(connection, credential) {
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  return connection.authentication.register({
    authenticate(request) {
      return credentialMatches(request && request.headers, credential) ? peer : undefined
    },
  })
}
