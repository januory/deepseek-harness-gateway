// deepseek-harness-gateway — prepare a clean npm publish tarball.
//
// apps/gateway is a pnpm workspace package: its manifest uses `workspace:*`
// devDependencies (dsh-gateway-protocol, dsh-gateway-store) so the dev/docker
// `tsx src/main.ts` flow can resolve them. Those are NOT runtime dependencies
// of the published package (they are bundled into dist/cli.js by bundle.mjs),
// and `workspace:*` is not understood by `npm publish`, so we publish a staging
// directory whose package.json carries only the consumer-facing fields:
// name/version/bin/main/files + the third-party runtime dependencies that the
// bundle imports externally (fastify, @fastify/*, ws, zod, better-sqlite3,
// drizzle-orm).
//
// Run after `pnpm --filter deepseek-harness-gateway build`:
//   node scripts/publish-prep.mjs && npm publish .npm-publish --provenance --access public

import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')
const stage = join(pkgDir, '.npm-publish')

const root = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

// Consumer-facing manifest. devDependencies are intentionally omitted: they are
// either bundled (the workspace packages) or irrelevant to an installed CLI.
const clean = {
  name: root.name,
  version: root.version,
  description: root.description,
  type: root.type,
  bin: root.bin,
  main: root.main,
  files: ['dist'],
  dependencies: root.dependencies,
  engines: { node: '>=22' },
  publishConfig: { access: 'public' },
  keywords: ['deepseek-harness', 'gateway', 'router', 'dsh'],
  repository: {
    type: 'git',
    url: 'https://github.com/januory/deepseek-harness-gateway.git',
  },
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
writeFileSync(join(stage, 'package.json'), JSON.stringify(clean, null, 2) + '\n')
cpSync(join(pkgDir, 'dist'), join(stage, 'dist'), { recursive: true })

for (const f of ['README.md', 'README.zh.md']) {
  const src = join(pkgDir, '..', '..', f)
  if (existsSync(src)) copyFileSync(src, join(stage, f))
}

console.log(`[publish-prep] staged clean tarball at ${stage}`)
