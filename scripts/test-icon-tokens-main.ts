#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Icon-server tokens — main's IPC, run for real in node with Electron mocked.
//
//   node --experimental-test-module-mocks scripts/test-icon-tokens-main.ts
//
// The REAL desktop/src/main/icontokens.ts + viewerprefs.ts + settings.ts run
// against a temp userData and live mock HTTP servers; only `electron`
// (app.getPath, a reversible safeStorage, BrowserWindow), ipcguard.ts (its
// handlers are captured and called directly) and windows.ts are stand-ins.
// What the desktop e2e (desktop/scripts/e2e-icon-tokens.mjs) checks through
// real windows, minus the windows:
//  1. viewerprefs: a list carrying a token is stored WITHOUT it (moved into
//     icon-tokens.bin, encrypted), the sender gets the clean value back,
//     other windows get it too; first-run adoption cleans as well; the seed
//     snapshot names the key as adopt-if-missing.
//  2. icon-fetch: Bearer on requests under the stored root only; a URL
//     outside the root (or a sibling prefix) is refused; a redirect to
//     another server loses the header; a changed URL gets no token; offline
//     refuses before any request; no CORS needed (server sends none).
//  3. icon-token-set / -status / -adopt and pruning when a source goes.
//  4. a hidden instance (`--background`, background.ts) looks tokens up in
//     the USER's icon-tokens.bin (next to BEESLIDES_USER_SETTINGS), at every
//     request, and never writes it; a token it cannot decrypt (another
//     app's key) means no header, so the server's 401 reads as before.

import { mock } from 'node:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const KEY = 'slidomingo-icon-sources'
const main = new URL('../desktop/src/main/', import.meta.url)
const userData = mkdtempSync(join(tmpdir(), 'slidomingo-icontokens-'))

// ---- stand-ins -----------------------------------------------------------------
const handlers = new Map<string, (ev: unknown, ...args: unknown[]) => unknown>()
const sentTo: Record<string, Array<[string, string, string | null]>> = { sender: [], other: [] }
const fakeWc = (name: string) => ({ id: name === 'sender' ? 1 : 2, send: (ch: string, k: string, v: string | null) => sentTo[name].push([ch, k, v]) })
const sender = fakeWc('sender')
const other = fakeWc('other')
// mocked where main's own imports resolve it (desktop/node_modules)
const electronUrl = pathToFileURL(createRequire(new URL('../desktop/package.json', import.meta.url)).resolve('electron')).href
mock.module(electronUrl, {
  namedExports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
      // what another key's ciphertext does: decryption throws
      decryptString: (b: Buffer) => { if (!b.toString().startsWith('ENC:')) throw new Error('bad key'); return [...b.toString().replace(/^ENC:/, '')].reverse().join('') },
    },
    BrowserWindow: { getAllWindows: () => [{ w: 'sender' }, { w: 'other' }], fromWebContents: () => null },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  },
})
const capture = (_who: string, channel: string, fn: (ev: unknown, ...a: unknown[]) => unknown) => { handlers.set(channel, fn) }
mock.module(new URL('ipcguard.ts', main).href, { namedExports: { handleFrom: capture, onFrom: capture } })
mock.module(new URL('windows.ts', main).href, {
  namedExports: { docWebContentsFor: (w: { w: string }) => (w.w === 'sender' ? sender : other) },
})

const { registerIconTokenIpc } = await import(new URL('icontokens.ts', main).href)
const { registerViewerPrefIpc } = await import(new URL('viewerprefs.ts', main).href)
const { updateSettings, readSettings } = await import(new URL('settings.ts', main).href)
registerIconTokenIpc()
registerViewerPrefIpc()

let failed = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}`, detail ?? '') }
}
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args)
const setPref = (key: string, value: string | null) => {
  const ev: { sender: typeof sender; returnValue?: unknown } = { sender }
  handlers.get('slidomingo:set-viewer-pref')!(ev, key, value)
}
const tokenFile = () => (existsSync(join(userData, 'icon-tokens.bin')) ? readFileSync(join(userData, 'icon-tokens.bin'), 'utf8') : '')
const storedList = () => JSON.parse(readSettings().viewerPrefs?.[KEY] ?? 'null')

// ---- mock servers ----------------------------------------------------------------
const hits: { s1: Array<{ path: string; auth: string | null }>; s2: Array<{ path: string; auth: string | null }> } = { s1: [], s2: [] }
let s2Port = 0
const s1 = createServer((req, res) => {
  const path = new URL(req.url!, 'http://x').pathname
  hits.s1.push({ path, auth: req.headers.authorization ?? null })
  if (path === '/lib/redir') { res.writeHead(302, { location: `http://127.0.0.1:${s2Port}/steal` }).end(); return }
  if (path === '/lib/hop') { res.writeHead(302, { location: '/lib/api/search?q=hop' }).end(); return }
  if (req.headers.authorization !== 'Bearer t-good') { res.writeHead(401).end(); return }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"results":[{"relative_path":"a.svg"}]}')
})
const s2 = createServer((req, res) => {
  hits.s2.push({ path: req.url!, auth: req.headers.authorization ?? null })
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"results":[]}')
})
await new Promise<void>((r) => s1.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r))
s2Port = (s2.address() as { port: number }).port
const s1Root = `http://127.0.0.1:${(s1.address() as { port: number }).port}/lib`
const s2Root = `http://127.0.0.1:${s2Port}`
const src = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'server', name: '', enabled: true, url, ...extra })
const fetchVia = async (id: string, url: string) => {
  const r = await call('slidomingo:icon-fetch', id, url) as { ok: boolean; status?: number; authed?: boolean; body?: Uint8Array; error?: string; offline?: boolean }
  return { ...r, text: r.body ? new TextDecoder().decode(r.body) : undefined }
}

try {
  console.log('viewer prefs keep the list token-free')
  updateSettings({ viewerPrefs: { 'slidomingo-theme': 'light' } })
  const snap = { returnValue: undefined as unknown, sender }
  handlers.get('slidomingo:viewer-prefs')!(snap)
  const sv = snap.returnValue as { keys: string[]; adoptIfMissing: string[] }
  check('the seed snapshot lists the key and marks it adopt-if-missing', sv.keys.includes(KEY) && sv.adoptIfMissing.includes(KEY))
  const withToken = JSON.stringify([src('src_a', s1Root, { token: 't-good' }), { id: 'dir', kind: 'folder', name: 'F', enabled: true }])
  setPref(KEY, withToken)
  check('app-settings.json has the list…', storedList()?.length === 2 && storedList()[0].url === s1Root)
  check('…without the token', !readFileSync(join(userData, 'app-settings.json'), 'utf8').includes('t-good'))
  check('icon-tokens.bin has it for src_a, bound to its root, not in clear', /"src_a"/.test(tokenFile()) && tokenFile().includes(JSON.stringify(s1Root)) && !tokenFile().includes('t-good'))
  const echo = sentTo.sender.at(-1)
  check('the sender gets the clean value back', !!echo && echo[1] === KEY && !String(echo[2]).includes('t-good'))
  check('the other window gets the clean value', sentTo.other.some(([, k, v]) => k === KEY && !String(v).includes('t-good') && String(v).includes('src_a')))
  const n = sentTo.sender.length
  setPref(KEY, readSettings().viewerPrefs[KEY])
  check('an already-clean value is not echoed back', sentTo.sender.length === n)
  setPref(KEY, JSON.stringify([src('src_a', s1Root, { token: 't-other' })]))
  const a1 = await fetchVia('src_a', `${s1Root}/api/search?q=`)
  check('an inline token never overrides the stored one', a1.ok && a1.authed === true && hits.s1.at(-1)?.auth === 'Bearer t-good')

  console.log('icon-fetch')
  hits.s1.length = 0
  const ok1 = await fetchVia('src_a', `${s1Root}/api/search?q=x`)
  check('search under the root: 200 with Bearer, no CORS needed', ok1.ok && ok1.status === 200 && ok1.authed === true && ok1.text?.includes('a.svg') && hits.s1[0]?.auth === 'Bearer t-good', ok1)
  const same = await fetchVia('src_a', `${s1Root}/hop`)
  check('a redirect within the root keeps it', same.ok && same.status === 200 && hits.s1.at(-1)?.auth === 'Bearer t-good')
  hits.s2.length = 0
  const out = await fetchVia('src_a', `${s2Root}/lib/api/search`)
  check('a URL on another server is refused, nothing sent', !out.ok && hits.s2.length === 0, out)
  const sib = await fetchVia('src_a', `${s1Root}-evil/api/search`)
  check('a sibling prefix is refused', !sib.ok)
  const up = await fetchVia('src_a', `${s1Root}/../admin`)
  check('a dot-segment escape is refused', !up.ok)
  const red = await fetchVia('src_a', `${s1Root}/redir`)
  check('a redirect to another server is followed without the token', red.ok && hits.s2.length === 1 && hits.s2[0].auth === null, hits.s2)
  check('an unknown source is refused', !(await fetchVia('nope', `${s1Root}/api/search`)).ok)
  check('a folder source is refused', !(await fetchVia('dir', `${s1Root}/api/search`)).ok)

  console.log('a changed URL loses the token')
  setPref(KEY, JSON.stringify([src('src_a', s2Root)]))
  const st = await call('slidomingo:icon-token-status', [{ id: 'src_a', url: s2Root }]) as Record<string, boolean>
  check('status: no token for the new URL', st.src_a === false)
  hits.s2.length = 0
  const moved = await fetchVia('src_a', `${s2Root}/api/search?q=`)
  check('the new server gets no Authorization', moved.ok && moved.authed === false && hits.s2[0]?.auth === null)
  check('the token itself is kept (the source still exists)', /"src_a"/.test(tokenFile()))
  setPref(KEY, JSON.stringify([src('src_a', s1Root)]))
  check('back on the original URL it applies again', (await call('slidomingo:icon-token-status', [{ id: 'src_a', url: s1Root }]) as Record<string, boolean>).src_a === true)

  console.log('offline')
  setPref('slidomingo-offline', 'on')
  hits.s1.length = 0
  const off = await fetchVia('src_a', `${s1Root}/api/search?q=`)
  check('offline: refused before any request', !off.ok && off.offline === true && hits.s1.length === 0)
  setPref('slidomingo-offline', 'off')

  console.log('set / remove / adopt / prune')
  check('a bad id is refused', !(await call('slidomingo:icon-token-set', '../x', s1Root, 'z') as { ok: boolean }).ok)
  check('a token needs an http(s) URL', !(await call('slidomingo:icon-token-set', 'src_a', 'file:///x', 'z') as { ok: boolean }).ok)
  check('replace', (await call('slidomingo:icon-token-set', 'src_a', s1Root, ' t-new ') as { ok: boolean }).ok)
  await fetchVia('src_a', `${s1Root}/api/search?q=`)
  check('the replaced (trimmed) token is the one sent', hits.s1.at(-1)?.auth === 'Bearer t-new')
  check('remove', (await call('slidomingo:icon-token-set', 'src_a', s1Root, null) as { ok: boolean }).ok && !/"src_a"/.test(tokenFile()))
  const plain = await fetchVia('src_a', `${s1Root}/api/search?q=`)
  check('without a token nothing is sent (the server answers 401)', plain.ok && plain.status === 401 && plain.authed === false && hits.s1.at(-1)?.auth === null)
  await call('slidomingo:icon-tokens-adopt', [{ id: 'src_a', url: s1Root, token: 't-good' }, { id: 'bad id', url: s1Root, token: 'x' }])
  check('adopt stores a carried token when none is stored', /"src_a"/.test(tokenFile()) && !/"bad id"/.test(tokenFile()))
  await call('slidomingo:icon-tokens-adopt', [{ id: 'src_a', url: s1Root, token: 't-older' }])
  await fetchVia('src_a', `${s1Root}/api/search?q=`)
  check('…and never overwrites one', hits.s1.at(-1)?.auth === 'Bearer t-good')
  const status = await call('slidomingo:icon-token-status', [{ id: 'src_a', url: s1Root }]) as Record<string, unknown>
  check('status carries booleans only', JSON.stringify(status) === '{"src_a":true}')
  setPref(KEY, JSON.stringify([]))
  check('removing the source prunes its token', !/"src_a"/.test(tokenFile()))

  console.log('first-run adoption cleans too')
  updateSettings({ viewerPrefs: undefined })
  handlers.get('slidomingo:viewer-prefs-adopt')!({ sender }, { [KEY]: JSON.stringify([src('src_b', s1Root, { token: 't-good' })]), 'slidomingo-theme': 'dark' })
  check('the adopted list has no token', !!storedList() && !JSON.stringify(readSettings()).includes('t-good') && /"src_b"/.test(tokenFile()))

  console.log('a hidden instance reads the user\'s tokens, read-only')
  // the user's own userData: their settings and their encrypted tokens
  const userDir = mkdtempSync(join(tmpdir(), 'slidomingo-icontokens-user-'))
  process.env.BEESLIDES_USER_SETTINGS = join(userDir, 'app-settings.json')
  const enc = (s: string) => Buffer.from(`ENC:${[...s].reverse().join('')}`).toString('base64')
  const userTokens = join(userDir, 'icon-tokens.bin')
  writeFileSync(userTokens, JSON.stringify({ src_u: { root: s1Root, enc: enc('t-good') } }))
  const userBefore = readFileSync(userTokens, 'utf8')
  process.argv.push('--background')
  // the source list as seedViewerPrefs copied it: no token of this instance's own
  setPref(KEY, JSON.stringify([src('src_u', s1Root)]))
  check('this instance has no token for it of its own', !/"src_u"/.test(tokenFile()))
  hits.s1.length = 0
  const bg = await fetchVia('src_u', `${s1Root}/api/search?q=x`)
  check('the request carries the user\'s token', bg.ok && bg.status === 200 && bg.authed === true && hits.s1[0]?.auth === 'Bearer t-good', bg)
  check('status reads the user\'s file too', (await call('slidomingo:icon-token-status', [{ id: 'src_u', url: s1Root }]) as Record<string, boolean>).src_u === true)
  hits.s2.length = 0
  const bgOut = await fetchVia('src_u', `${s2Root}/api/search`)
  check('the root binding holds: another server is refused', !bgOut.ok && hits.s2.length === 0)
  setPref(KEY, JSON.stringify([src('src_u', s2Root)]))
  const bgMoved = await fetchVia('src_u', `${s2Root}/api/search?q=`)
  check('…and a source pointed elsewhere gets no token', bgMoved.ok && bgMoved.authed === false && hits.s2.at(-1)?.auth === null)
  setPref(KEY, JSON.stringify([src('src_u', s1Root)]))
  // a token the user stores later applies at once (read per request, not copied at start)
  writeFileSync(userTokens, JSON.stringify({ src_u: { root: s1Root, enc: enc('t-later') } }))
  await fetchVia('src_u', `${s1Root}/api/search?q=`)
  check('a token the user stores later is used at the next request', hits.s1.at(-1)?.auth === 'Bearer t-later')
  writeFileSync(userTokens, userBefore)
  // ciphertext this app's key cannot open (Windows keeps the key per userData)
  writeFileSync(userTokens, JSON.stringify({ src_u: { root: s1Root, enc: Buffer.from('other-key').toString('base64') } }))
  hits.s1.length = 0
  const undecryptable = await fetchVia('src_u', `${s1Root}/api/search?q=`)
  check('an undecryptable token: no header, the server\'s 401 comes back as before', undecryptable.ok && undecryptable.status === 401 && undecryptable.authed === false && hits.s1[0]?.auth === null, undecryptable)
  writeFileSync(userTokens, userBefore)
  // writes stay in this instance's own folder
  await call('slidomingo:icon-token-set', 'src_u', s1Root, 't-mine')
  await call('slidomingo:icon-tokens-adopt', [{ id: 'src_v', url: s1Root, token: 't-v' }])
  setPref(KEY, JSON.stringify([]))
  check('set / adopt / prune never touch the user\'s file', readFileSync(userTokens, 'utf8') === userBefore)
  process.argv.splice(process.argv.indexOf('--background'), 1)
  delete process.env.BEESLIDES_USER_SETTINGS
} finally {
  s1.close(); s2.close()
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall main-side icon-token checks passed')
