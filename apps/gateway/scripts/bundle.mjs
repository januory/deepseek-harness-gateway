// deepseek-harness-gateway — build the standalone `dshgw` CLI bundle.
//
// Bundles the gateway server (src/main.ts) together with the first-party
// workspace packages it depends on (dsh-gateway-protocol, dsh-gateway-store)
// into a single ESM file at dist/cli.js. Third-party framework/native deps are
// left external so they resolve from the package's own node_modules at install
// time (better-sqlite3 is a native addon and must never be bundled).
//
// If the portal has been built (../../web/dist), it is copied into
// dist/portal so the published package serves the full UI at `/` + `/portal/*`.
// When absent, the bundle still runs the server; portal hosting degrades
// gracefully (see src/main.ts resolveWebDist).

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')
const outfile = join(pkgDir, 'dist', 'cli.js')

// Third-party packages that must not be inlined into the bundle. First-party
// code (gateway + protocol + store) IS bundled, which is what makes the
// published tarball a single self-contained app.
const external = [
  '@fastify/cookie',
  '@fastify/static',
  'better-sqlite3',
  'drizzle-orm',
  'fastify',
  'ws',
  'zod',
]

async function bundle() {
  await build({
    entryPoints: [join(pkgDir, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external,
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
  })
}

// Optional portal: the monorepo builds it to apps/web/dist; the docker flow and
// the CLI build copy it so a published package ships the full UI.
function copyPortal() {
  const src = join(pkgDir, '..', 'web', 'dist')
  const dst = join(pkgDir, 'dist', 'portal')
  if (!existsSync(src)) {
    console.log('[build] portal not built (apps/web/dist missing) -> portal hosting disabled')
    return
  }
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log(`[build] portal copied into dist/portal (${dst})`)
}

await bundle()
copyPortal()
console.log(`[build] bundled dshgw -> ${outfile}`)
