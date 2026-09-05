// Console mobile-adapt injection (dsh-web mobile-adapt approach, gateway edition).
//
// The relayed dsh console is the official desktop Web GUI; below ~1024px it
// auto-collapses the sidebar and its narrow/portrait experience is not adapted
// for phones (the dsh-web project fixes the same official UI with an injected
// portrait-touch layer; this module ports the frame/column core of that layer
// so phones reach the conversation reliably without touching the node).
//
// Mechanism: relayHttp() buffers small text/html GET responses from the node
// and passes them through the injection helpers before streaming them out.
// `injectTransportOwnership()` always declares the relayed page as the
// operator's own console (settings durability); `injectMobileAdapt()` adds the
// viewport layer, whose <style> + <script> only activate when the viewport is
// portrait, has a coarse pointer and is narrower than 1100px (sessionStorage
// 'dsh-gw-force-desktop=1' opts out) — desktop and landscape stay visually
// untouched.
//
// Selector strategy mirrors dsh-remote-web-ui: this cohort's CSS Modules
// classes are hash-prefixed with the semantic name as a stable suffix
// (e.g. `T62Cia_centerCol`), so [class$="_centerCol"] survives rebuilds that
// only change the hash prefix.
//
// Kill switch: DSH_GATEWAY_CONSOLE_ADAPT=0 disables the mobile-adapt layer
// (transport ownership stays injected either way).
// Debug aid: open the console with ?gwAdaptDebug=1 to show a live pill with
// viewport/column geometry.

export const CONSOLE_ADAPT_ENABLED = process.env.DSH_GATEWAY_CONSOLE_ADAPT !== '0'

/** Marker placed in injected pages so a proxy chain cannot double-inject. */
const INJECT_MARKER = 'dsh-gw-mobile-adapt'

/** Marker for the transport-ownership injection (also proxy-chain guarded). */
const TRANSPORT_MARKER = 'dsh-gw-transport-owner'

/**
 * Insert one injection payload before </head> (falling back to </body> or
 * document end), shared by every console-HTML injection.
 * @param html - the upstream index document (UTF-8 text).
 * @param payload - the markup/script block to insert.
 * @returns the document with the payload inserted.
 */
function insertBeforeHeadEnd(html: string, payload: string): string {
  const headEnd = html.indexOf('</head>')
  if (headEnd !== -1) return html.slice(0, headEnd) + payload + html.slice(headEnd)
  const bodyEnd = html.lastIndexOf('</body>')
  if (bodyEnd !== -1) return html.slice(0, bodyEnd) + payload + html.slice(bodyEnd)
  return html + payload
}

/**
 * Inject the transport-ownership override into one relayed console HTML
 * document. The relayed page runs under the gateway's authority, not the
 * node's loopback, so the dsh client classifies it as a non-loopback page and
 * disables Host settings persistence (Settings → Model then reports "settings
 * are unavailable in this browser"). Declaring `ownsHost` on the
 * `__DSH_TRANSPORT__` carrier makes `ctx.connection.isLoopback` report the
 * privileged surface as reachable, without replacing the page's HTTP/WebSocket
 * transport — the relay already carries those.
 * @param html - the upstream index document (UTF-8 text).
 * @returns the document with the ownership script inserted before </head> (or </body>).
 */
export function injectTransportOwnership(html: string): string {
  if (html.includes(TRANSPORT_MARKER)) return html
  const payload =
    `<!-- ${TRANSPORT_MARKER} -->` +
    `<script id="${TRANSPORT_MARKER}-js">` +
    `(function(){var t=window.__DSH_TRANSPORT__||(window.__DSH_TRANSPORT__={});t.ownsHost=true})();` +
    `</` + `script>`
  return insertBeforeHeadEnd(html, payload)
}

/**
 * Inject the mobile-adapt layer into one relayed console HTML document.
 * @param html - the upstream index document (UTF-8 text).
 * @returns the document with the layer inserted before </head> (or </body>).
 */
export function injectMobileAdapt(html: string): string {
  if (html.includes(INJECT_MARKER)) return html
  const payload =
    `<!-- ${INJECT_MARKER} -->` +
    `<style id="${INJECT_MARKER}-css">${ADAPT_CSS}</style>` +
    `<script id="${INJECT_MARKER}-js">${ADAPT_JS}</` + `script>`
  return insertBeforeHeadEnd(html, payload)
}

/**
 * Rules are scoped under body.dsh-gw-mobile so desktop/landscape never sees
 * them. Ported from dsh-remote-web-ui mobile-adapt (Apache-2.0) and trimmed to
 * the frame/column + composer essentials verified against this cohort's
 * semantic class suffixes.
 */
const ADAPT_CSS = `
html,body{height:100%}
/* The app frame fills the dynamic viewport (browser chrome collapse). */
body.dsh-gw-mobile [class$="_frame"]{width:100%;height:100dvh}
/* Collapsed rail: bigger touch targets. */
body.dsh-gw-mobile [class$="_railFish"] button,body.dsh-gw-mobile [class$="_panelIcon"],body.dsh-gw-mobile [class$="_newSession"]{min-width:44px;min-height:44px}
/* Pin every column to an explicit track so the conversation always lands on
   the 1fr track regardless of the collapsed rail's computed position (the
   official rail can leave the grid flow on some cohorts, which would
   auto-place the in-flow center into the zero-width first track). */
body.dsh-gw-mobile [class$="_frame"][data-sidebar-collapsed]{grid-template-columns:56px minmax(0,1fr) 0 !important}
body.dsh-gw-mobile [class$="_frame"][data-sidebar-collapsed] [class$="_sidebarCol"]{grid-column:1/2}
body.dsh-gw-mobile [class$="_frame"][data-sidebar-collapsed] [class$="_centerCol"]{grid-column:2/3}
body.dsh-gw-mobile [class$="_frame"][data-sidebar-collapsed] [class$="_detailsCol"]{grid-column:3/4}
/* The right-hand details column has no room on a phone; hide it entirely. */
body.dsh-gw-mobile [class$="_detailsCol"]{display:none !important}
/* Message list breathing room on narrow screens. */
body.dsh-gw-mobile [class$="_scroll"]{padding:8px 10px}
/* 16px inputs prevent iOS focus zoom. */
body.dsh-gw-mobile [class$="_input"],body.dsh-gw-mobile textarea,body.dsh-gw-mobile input{font-size:16px}
/* Composer clears the iOS home indicator. */
body.dsh-gw-mobile [class$="_composer"]{padding-bottom:calc(4px + env(safe-area-inset-bottom))}
/* Slightly smaller message type on phones. */
body.dsh-gw-mobile [class$="_scrollBody"] [class$="_root"],body.dsh-gw-mobile [class$="_scrollBody"] [class$="_bubble"]{font-size:14.5px}
/* Settings dialog: the desktop panel is a two-column layout (188px nav + 157px
   options) that collapses field rows to ~101px on a 390px phone, which forces
   labels/values into one-character-per-line vertical text. Stack a horizontally
   scrollable nav (tabs) above a full-width, scrollable options body instead. */
body.dsh-gw-mobile [class$="_overlay"]{padding:8px!important;align-items:center!important;justify-content:center!important}
body.dsh-gw-mobile [class$="_panel"]{width:min(calc(100vw - 48px),360px)!important;max-width:min(calc(100vw - 48px),360px)!important;height:min(calc(100dvh - 52px),820px)!important;max-height:min(calc(100dvh - 52px),820px)!important;flex-direction:column!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_nav"]{width:100%!important;height:auto!important;flex:0 0 auto!important;flex-direction:row!important;overflow-x:auto!important;border-right:none!important;border-bottom:1px solid rgba(127,127,127,.25)!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_nav"] [class$="_navList"]{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;overflow-x:auto!important;width:auto!important;height:auto!important;gap:4px!important;padding:8px 10px!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_nav"] [class$="_navCell"]{flex:0 0 auto!important;white-space:nowrap!important;padding:8px 12px!important;border-radius:8px!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_nav"] [class$="_navTitle"]{white-space:nowrap!important;padding:10px!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_content"]{width:100%!important;flex:1 1 auto!important;display:flex!important;flex-direction:column!important;overflow:hidden!important}
body.dsh-gw-mobile [class$="_panel"]>[class$="_content"] [class$="_options"]{width:100%!important;flex:1 1 auto!important;overflow-y:auto!important;padding:4px 12px!important}
body.dsh-gw-mobile [class$="_panel"] [class$="_section"],body.dsh-gw-mobile [class$="_panel"] [class$="_row"]{width:100%!important;min-width:0!important}
body.dsh-gw-mobile [class$="_panel"] [class$="_rowText"],body.dsh-gw-mobile [class$="_panel"] [class$="_desc"]{min-width:0!important}
`

/**
 * The injected script: viewport gate + a small floating toggle (the collapsed
 * sidebar's only phone entry) + a debug pill behind ?gwAdaptDebug=1. Runs in
 * the console page (classic browser scope; no imports).
 */
const ADAPT_JS = `
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__dshGwAdaptInstalled) return
  window.__dshGwAdaptInstalled = true
  var KEY = 'dsh-gw-force-desktop'

  // ---- boot/JS-error probe: report to the gateway so device-only failures
  // (e.g. a vendor browser engine crashing early in the console boot) become
  // visible in the gateway log without any device devtools. ----
  var DIAG = '/console-diag'
  function postDiag (kind, detail) {
    try {
      var payload = JSON.stringify({
        kind: kind,
        ua: String(navigator.userAgent || '').slice(0, 120),
        detail: String(detail == null ? '' : detail).slice(0, 500),
        href: String(location.href || '').slice(0, 200)
      })
      if (navigator.sendBeacon) {
        navigator.sendBeacon(DIAG, new Blob([payload], { type: 'application/json' }))
      } else {
        var x = new XMLHttpRequest()
        x.open('POST', DIAG, true)
        x.setRequestHeader('content-type', 'application/json')
        x.send(payload)
      }
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    postDiag('error', (e && e.message ? e.message : String(e)) + ' @' + (e && e.filename ? e.filename : '') + ':' + (e && e.lineno != null ? e.lineno : ''))
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason
    postDiag('rejection', r && r.message ? r.message : String(r))
  }, true)
  try {
    postDiag('boot', 'adapt script ran; readyState=' + document.readyState)
  } catch (e) {}
  var ACTIVE = 'dsh-gw-mobile'
  var FAB_ID = 'dshGwMobileFab'
  var pill = null

  function isMobile () {
    try {
      if (!window.matchMedia('(orientation: portrait)').matches) return false
      if (!window.matchMedia('(pointer: coarse)').matches) return false
      if (window.innerWidth >= 1100) return false
      if (window.sessionStorage.getItem(KEY) === '1') return false
      return true
    } catch (e) { return false }
  }

  function collapsed () {
    return document.querySelector('[class$="_frame"][data-sidebar-collapsed]') !== null
  }

  function toggleSidebar () {
    var before = collapsed()
    var el = document.querySelector(
      '[class$="_railFish"] button, [class$="_logoRow"] [class*="_iconButton"], [class$="_panelIcon"]'
    )
    if (el) el.click()
    window.setTimeout(function () {
      if (collapsed() === before) {
        var b = document.querySelector('[class$="_sidebarCol"] button')
        if (b) b.click()
      }
    }, 150)
  }

  function ensureFab () {
    if (document.getElementById(FAB_ID) !== null || !document.body) return
    var fab = document.createElement('button')
    fab.id = FAB_ID
    fab.type = 'button'
    fab.setAttribute('aria-label', 'Open sidebar')
    fab.title = 'Open sidebar'
    fab.style.cssText = [
      'position:fixed', 'left:calc(10px + env(safe-area-inset-left))',
      'bottom:calc(88px + env(safe-area-inset-bottom))', 'z-index:2147482999',
      'width:44px', 'height:44px', 'border-radius:14px',
      'border:1px solid rgba(127,127,127,.35)', 'background:rgba(30,30,36,.92)',
      'color:#fff', 'display:flex', 'align-items:center', 'justify-content:center',
      'cursor:pointer', 'box-shadow:0 2px 10px rgba(0,0,0,.3)'
    ].join(';')
    fab.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>'
    fab.addEventListener('click', toggleSidebar)
    document.body.appendChild(fab)
  }

  function syncFab () {
    ensureFab()
    var f = document.getElementById(FAB_ID)
    if (!f) return
    f.style.display = document.body.classList.contains(ACTIVE) && collapsed() ? '' : 'none'
  }

  function pillText () {
    var c = document.querySelector('[class$="_centerCol"]')
    var s = document.querySelector('[class$="_scroll"]')
    return 'adapt=' + (document.body.classList.contains(ACTIVE) ? 1 : 0) +
      ' w=' + window.innerWidth + 'px' +
      ' center=' + (c ? Math.round(c.getBoundingClientRect().width) : -1) + 'px' +
      ' scroll=' + (s ? Math.round(s.getBoundingClientRect().height) : -1) + 'px' +
      ' collapsed=' + (collapsed() ? 1 : 0)
  }

  function ensurePill () {
    if (pill !== null || !document.body) return
    if (location.search.indexOf('gwAdaptDebug') === -1) return
    pill = document.createElement('div')
    pill.style.cssText = [
      'position:fixed', 'right:6px', 'top:calc(6px + env(safe-area-inset-top))',
      'z-index:2147483000', 'background:rgba(0,0,0,.72)', 'color:#9f6',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:4px 8px', 'border-radius:8px', 'pointer-events:none', 'white-space:pre'
    ].join(';')
    document.body.appendChild(pill)
  }

  function tick () {
    if (!document.body) return
    var m = isMobile()
    document.body.classList.toggle(ACTIVE, m)
    syncFab()
    if (pill === null) ensurePill()
    if (pill !== null) pill.textContent = pillText()
  }

  function start () {
    ensurePill()
    tick()
    window.setInterval(tick, 600)
    window.addEventListener('orientationchange', tick)
    window.addEventListener('resize', tick)
    // Opening a session from the expanded sidebar must fold the sidebar back so
    // the conversation gets the full phone width (the expanded 280px sidebar
    // would otherwise squeeze the center to ~110px on a 390px phone).
    document.addEventListener('click', function (e) {
      if (!document.body.classList.contains(ACTIVE)) return
      var frame = document.querySelector('[class$="_frame"]')
      if (!frame || frame.hasAttribute('data-sidebar-collapsed')) return
      var t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('[class$="_sessionRow"]') !== null || t.closest('[class$="_newSession"]') !== null) {
        window.setTimeout(toggleSidebar, 120)
      }
    }, true)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
`
