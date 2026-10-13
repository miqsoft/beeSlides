#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Desktop IPC sender-check rig (static).
//
//   node scripts/test-desktop-ipc-guard.mjs
//
// WHAT THIS PROVES. Every ipcMain handler in desktop/src/main names the one
// renderer allowed to call it (ipcguard.ts handleFrom/onFrom, DECISIONS
// 2026-10-08 "IPC sender checks"): `slidomingo:*` channels the app shell,
// `terminal:*` / `chat:*` channels the terminal panel. A handler registered
// straight on ipcMain would skip the check — this fails on any. It also
// fails when a preload calls a channel main never registers, or a preload
// talks on the other caller's channels (the doc preload only `slidomingo:*`,
// the terminal preload only `terminal:*` / `chat:*`). The runtime refusals
// are covered by desktop/scripts/e2e-desktop-hardening.mjs (ipc-guard).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = join(repo, 'desktop/src/main')
let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}
/** Source without comments, so prose mentioning ipcMain.handle never counts. */
const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const callerOf = (ch) => (/^(terminal|chat):/.test(ch) ? 'terminal' : /^slidomingo:/.test(ch) ? 'app-shell' : null)

// 1. nothing registers on ipcMain directly, outside ipcguard.ts
const direct = []
for (const f of walk(mainDir)) {
  if (f.endsWith('/ipcguard.ts')) continue
  const src = code(f)
  for (const m of src.matchAll(/ipcMain\s*\.\s*(handle|handleOnce|on|once|addListener|prependListener)\s*\(/g)) {
    direct.push(`${relative(repo, f)}: ipcMain.${m[1]}`)
  }
}
ok(direct.length === 0, `no ipcMain handler bypasses ipcguard.ts${direct.length ? ` (${direct.join('; ')})` : ''}`)

// 2. every guarded registration names the caller its channel belongs to
const registered = new Map()
const wrapperChannels = []
const wrong = []
for (const f of walk(mainDir)) {
  const src = code(f)
  for (const m of src.matchAll(/\b(handleFrom|onFrom)\s*(?:<[^>]*>)?\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    const [, , who, ch] = m
    registered.set(ch, who)
    if (callerOf(ch) !== who) wrong.push(`${ch} → ${who}`)
  }
  // the per-file never-reject wrappers (documents/templates/library/index):
  // `handle('slidomingo:…'` / `safeHandle('slidomingo:…'` / `safeHandle<T>('…'`
  for (const m of src.matchAll(/\b(?:safeHandle|handle)\s*(?:<[^()]*?>)?\(\s*'([^']+)'/g)) {
    registered.set(m[1], 'app-shell')
    wrapperChannels.push(m[1])
  }
}
ok(registered.size >= 70, `found the app's handlers (${registered.size})`)
ok(wrong.length === 0, `each channel is guarded for its own caller${wrong.length ? ` (${wrong.join(', ')})` : ''}`)
const badWrapped = wrapperChannels.filter((ch) => callerOf(ch) !== 'app-shell')
ok(badWrapped.length === 0, `the app-shell wrappers only carry slidomingo:* channels${badWrapped.length ? ` (${badWrapped.join(', ')})` : ''}`)
for (const f of ['documents.ts', 'templates.ts', 'library.ts', 'index.ts']) {
  ok(/handleFrom\(\s*'app-shell'\s*,\s*channel\b/.test(code(join(mainDir, f))), `${f}'s wrapper registers through handleFrom('app-shell', …)`)
}

// 3. the preloads: each talks only on its own caller's channels, all of them registered
for (const [file, who] of [['desktop/src/preload/index.ts', 'app-shell'], ['desktop/src/preload/terminal.ts', 'terminal']]) {
  const src = code(join(repo, file))
  const used = [...new Set([...src.matchAll(/ipcRenderer\s*\.\s*(?:send|invoke|sendSync)\(\s*'([^']+)'/g)].map((m) => m[1]))]
  const foreign = used.filter((ch) => callerOf(ch) !== who)
  const missing = used.filter((ch) => !registered.has(ch))
  ok(used.length > 0 && foreign.length === 0, `${file} only uses ${who} channels (${used.length})${foreign.length ? `: ${foreign.join(', ')}` : ''}`)
  ok(missing.length === 0, `every channel ${file} uses has a handler${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
