// Loopback same-origin emulation for relayed requests.
//
// The gateway deliberately strips the browser's Origin/Referer/sec-fetch-*
// markers before relaying, because their authority is the public gateway and
// the machine's dsh web refuses anything whose Origin does not match its own
// Host. The agent then rewrites Host to `127.0.0.1:<dshPort>` so dsh sees a
// trusted loopback client.
//
// A relayed request is therefore markerless. dsh's own Host/Origin fence
// accepts that (the loopback Host already binds the request), but third-party
// handlers that require `Origin === Host` on mutating routes do not: dshmarket
// answers every POST with 403 {"error":"untrusted origin"}, which the plugin
// market surfaces as a failed update when the console is driven through the
// gateway. Declaring the loopback authority we already use for Host — on
// Origin, and on a forwarded Referer — makes the relayed request one
// consistent same-origin loopback request again, which both fences accept.

/** Loopback authority this agent bridges to on one machine. */
export function loopbackAuthority(dshPort) {
  return `127.0.0.1:${dshPort}`
}

/** Loopback origin URL (`http://127.0.0.1:<port>`). */
export function loopbackOrigin(dshPort) {
  return `http://${loopbackAuthority(dshPort)}`
}

/** Read one header case-insensitively, mirroring how Node folds wire headers. */
function readHeader(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/**
 * Rewrite the browser-authority headers of one relayed request to the loopback
 * authority this agent bridges to, so dsh and its plugins read one consistent
 * same-origin loopback client instead of a markerless (or foreign-origin)
 * request.
 *
 * `Referer` keeps its path and query because routing handlers may read it; a
 * Referer that cannot be parsed is dropped rather than forwarded with a foreign
 * authority. Unrelated headers, including Fetch-Metadata, pass through
 * untouched, so a cross-site marker still reaches dsh's fence and fails closed.
 *
 * @param {Record<string, string> | undefined} headers - relayed request headers.
 * @param {number} dshPort - local dsh web port.
 * @returns {Record<string, string>} a new lowercase-keyed header map; the input is not mutated.
 */
export function loopbackSameOriginHeaders(headers, dshPort) {
  const origin = loopbackOrigin(dshPort)
  const referer = readHeader(headers, 'referer')
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.toLowerCase()
    if (name === 'host' || name === 'origin' || name === 'referer') continue
    out[name] = value
  }
  out.host = loopbackAuthority(dshPort)
  out.origin = origin
  if (referer !== undefined) {
    try {
      const parsed = new URL(String(referer))
      out.referer = `${origin}${parsed.pathname}${parsed.search}`
    } catch {
      /* an unparsable Referer carries no usable path; send none */
    }
  }
  return out
}
