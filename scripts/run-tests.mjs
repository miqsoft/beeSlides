#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Run every test rig in scripts/ the way it needs to be run.
//
//   npm test                      (from the repo root)
//   node scripts/run-tests.mjs [--e2e] [name-filter …]
//
// WHY THIS EXISTS. Each rig documents its own invocation in its header, and
// they differ: some run directly under Node's type stripping, some must be
// bundled with esbuild first (they import extensionless modules), one needs
// --experimental-test-module-mocks. Run the wrong way, a passing rig fails
// with ERR_MODULE_NOT_FOUND and looks like a regression. This runner tries the
// direct run, falls back to a bundle when the failure is a module-resolution
// one, and decides pass/fail by exit code only.
//
// Browser end-to-end rigs (`*-e2e.mjs`, they drive Chromium via Playwright)
// are skipped unless --e2e is given. The desktop's Electron e2e rigs live in
// desktop/scripts/ and are not run here.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const withE2e = args.includes('--e2e')
const filters = args.filter((a) => !a.startsWith('--'))
const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
const TIMEOUT_MS = 10 * 60 * 1000

const rigs = readdirSync(join(root, 'scripts'))
  .filter((f) => /^test-.*\.(ts|mjs)$/.test(f))
  .filter((f) => withE2e || !/e2e/.test(f))
  .filter((f) => !filters.length || filters.some((q) => f.includes(q)))
  .sort()

const env = {
  ...process.env,
  // rigs that bundle resolve fake-indexeddb & co. from the slides install
  NODE_PATH: join(root, 'slides/node_modules'),
  SLIDOMINGO_TEST_APP: process.env.SLIDOMINGO_TEST_APP ?? 'slidomingo-slides',
  NODE_NO_WARNINGS: '1',
}
const tmp = mkdtempSync(join(tmpdir(), 'beeslides-rigs-'))

const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: root, env, encoding: 'utf8', timeout: TIMEOUT_MS })
const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-3).join('\n      ')
// failures that mean "run me bundled", not "a check failed": extensionless
// imports, and TypeScript syntax Node's type stripping does not support
const unresolved = (r) => /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Dynamic require of/.test(`${r.stdout}${r.stderr}`)
// a rig that prints a failed check but still exits 0 is still a failure
const printedFail = (r) => /^\s*(FAIL\b|✗)/m.test(`${r.stdout}${r.stderr}`)

function runRig(file) {
  const path = join('scripts', file)
  const header = readFileSync(join(root, path), 'utf8').slice(0, 3000)
  const flags = header.includes('--experimental-test-module-mocks') ? ['--experimental-test-module-mocks'] : []
  let r = run(process.execPath, [...flags, path])
  if (r.status === 0 || !file.endsWith('.ts') || !unresolved(r)) return { r, how: 'direct' }
  // Bundle, then (only if the bundle itself needs CommonJS `require`) bundle
  // again with a createRequire banner — the banner collides with rigs that
  // already import createRequire, so it is never the first try.
  const out = join(tmp, file.replace(/\.ts$/, '.mjs'))
  const bundle = (banner) => run(esbuild, [path, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
    '--log-level=error', '--external:electron',
    ...(banner ? ["--banner:js=import { createRequire as __bsRequire } from 'module'; const require = __bsRequire(import.meta.url);"] : [])])
  let b = bundle(false)
  if (b.status !== 0) return { r: b, how: 'bundle failed' }
  r = run(process.execPath, [...flags, out])
  if (r.status !== 0 && /Dynamic require of/.test(`${r.stdout}${r.stderr}`)) {
    b = bundle(true)
    if (b.status !== 0) return { r: b, how: 'bundle failed' }
    r = run(process.execPath, [...flags, out])
  }
  return { r, how: 'bundled' }
}

let failed = 0
const started = Date.now()
for (const file of rigs) {
  const t0 = Date.now()
  const { r, how } = runRig(file)
  const ok = r.status === 0 && !printedFail(r)
  if (!ok) failed++
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${file.padEnd(36)} ${secs.padStart(5)}s  ${how}`)
  if (!ok) console.log(`      ${r.error ? String(r.error) : tail(r)}`)
}
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${rigs.length - failed}/${rigs.length} rigs passed in ${((Date.now() - started) / 1000).toFixed(0)}s${withE2e ? '' : ' (e2e skipped; --e2e to include)'}`)
process.exit(failed ? 1 : 0)
