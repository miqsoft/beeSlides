#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Icon-library folders in the desktop app — main's half, run for real in
// node with Electron mocked (the pattern of test-icon-tokens-main.ts).
//
//   node --experimental-test-module-mocks scripts/test-icon-folders-main.ts
//
// The REAL desktop/src/main/iconfolders.ts + iconfolderscore.ts +
// icontokens.ts + viewerprefs.ts + settings.ts + background.ts run against a
// temp userData and a temp icon folder; only `electron` (app.getPath, the
// folder dialog, BrowserWindow), ipcguard.ts (handlers captured) and
// windows.ts are stand-ins.
//  1. pick: the dialog's folder is validated (realpath'd, a directory, not
//     the root) and kept in userData/icon-folders.json; the page gets the
//     name only; a cancelled dialog or a file changes nothing.
//  2. list: the renderer's walk — icon files by relative path, every
//     icons.json with its folder — sorted, depth-capped; a symlink inside is
//     followed, one leading out is not; a current stamp answers `unchanged`.
//  3. read: only icon files of that folder: no `..`, no absolute path, no
//     other extension, no symlink out (nor one named .svg pointing at
//     something else), nothing over the size cap.
//  4. the pref never keeps a folder path; removing a source drops its folder.
//  5. status: name and missing; a folder that went away is "gone".
//  6. a hidden instance (`--background`) reads the USER's icon-folders.json,
//     at every request, never writes it, and refuses to pick.

import { mock } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const KEY = 'slidomingo-icon-sources'
const main = new URL('../desktop/src/main/', import.meta.url)
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'slidomingo-iconfolders-')))
const userData = join(tmp, 'ud')
mkdirSync(userData)

// ---- the icon folder ---------------------------------------------------------------
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
const icons = join(tmp, 'My Icons')
const outside = join(tmp, 'outside')
for (const d of [icons, outside, join(icons, 'set'), join(icons, 'a/b/c/d/e/f')]) mkdirSync(d, { recursive: true })
writeFileSync(join(icons, 'rocket.svg'), SVG)
writeFileSync(join(icons, 'photo.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
writeFileSync(join(icons, 'notes.txt'), 'not an icon')
writeFileSync(join(icons, 'set/cloud.svg'), SVG)
writeFileSync(join(icons, 'set/icons.json'), JSON.stringify({ license: 'CC0-1.0', icons: [{ file: 'cloud.svg', name: 'Cloud', keywords: ['weather'] }] }))
writeFileSync(join(icons, 'a/b/c/d/deep.svg'), SVG) // depth 4: found
writeFileSync(join(icons, 'a/b/c/d/e/too-deep.svg'), SVG) // depth 5: not
writeFileSync(join(icons, 'big.svg'), Buffer.alloc(10 * 1024 * 1024 + 1, 32))
writeFileSync(join(outside, 'secret.svg'), SVG)
writeFileSync(join(outside, 'passwd'), 'root:x')
symlinkSync(join(outside, 'secret.svg'), join(icons, 'leak.svg'))
symlinkSync(outside, join(icons, 'leakdir'))
symlinkSync(join(outside, 'passwd'), join(icons, 'disguised.svg'))
symlinkSync(join(icons, 'rocket.svg'), join(icons, 'alias.svg'))
symlinkSync(join(icons, 'set'), join(icons, 'linked-set'))

// ---- stand-ins -------------------------------------------------------------------
const handlers = new Map<string, (ev: unknown, ...args: unknown[]) => unknown>()
const sender = { id: 1, send: () => {} }
let dialogAnswer: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
let dialogs = 0
const electronUrl = pathToFileURL(createRequire(new URL('../desktop/package.json', import.meta.url)).resolve('electron')).href
mock.module(electronUrl, {
  namedExports: {
    app: { getPath: () => userData, isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    dialog: { showOpenDialog: async () => { dialogs++; return dialogAnswer } },
  },
})
const capture = (_who: string, channel: string, fn: (ev: unknown, ...a: unknown[]) => unknown) => { handlers.set(channel, fn) }
mock.module(new URL('ipcguard.ts', main).href, { namedExports: { handleFrom: capture, onFrom: capture } })
mock.module(new URL('windows.ts', main).href, { namedExports: { docWebContentsFor: () => sender } })

const { registerIconFolderIpc } = await import(new URL('iconfolders.ts', main).href)
const { registerViewerPrefIpc } = await import(new URL('viewerprefs.ts', main).href)
const { readSettings } = await import(new URL('settings.ts', main).href)
registerIconFolderIpc()
registerViewerPrefIpc()

let failed = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}`, detail ?? '') }
}
type Any = Record<string, any>
const call = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!({ sender }, ...args) as Any
const setPref = (key: string, value: string | null) => handlers.get('slidomingo:set-viewer-pref')!({ sender }, key, value)
const store = () => (existsSync(join(userData, 'icon-folders.json')) ? JSON.parse(readFileSync(join(userData, 'icon-folders.json'), 'utf8')) : {})
const folderSrc = (id: string, extra: Any = {}) => ({ id, kind: 'folder', name: '', enabled: true, ...extra })

try {
  console.log('pick')
  dialogAnswer = { canceled: true, filePaths: [] }
  check('a cancelled dialog changes nothing', (await call('slidomingo:icon-folder-pick', 'src_f')).cancelled === true && !store().src_f)
  check('a bad id never opens a dialog', (await call('slidomingo:icon-folder-pick', '../x')).ok === false && dialogs === 1)
  dialogAnswer = { canceled: false, filePaths: [join(icons, 'rocket.svg')] }
  check('a file is not a folder', (await call('slidomingo:icon-folder-pick', 'src_f')).ok === false && !store().src_f)
  dialogAnswer = { canceled: false, filePaths: ['/'] }
  check('the whole disk is refused', (await call('slidomingo:icon-folder-pick', 'src_f')).ok === false && !store().src_f)
  // picked through a symlink: the real path is kept
  symlinkSync(icons, join(tmp, 'via-link'))
  dialogAnswer = { canceled: false, filePaths: [join(tmp, 'via-link')] }
  const picked = await call('slidomingo:icon-folder-pick', 'src_f')
  check('a folder: the page gets its name only', picked.ok === true && picked.name === 'My Icons' && Object.keys(picked).sort().join() === 'name,ok', picked)
  check('main keeps its real path, keyed by source id', store().src_f === icons, store())

  console.log('list')
  const l = await call('slidomingo:icon-folder-list', 'src_f')
  const files: string[] = l.files ?? []
  check('icon files by relative path, sorted, any case of extension', l.ok && files.includes('rocket.svg') && files.includes('photo.PNG') && files.includes('set/cloud.svg') && files.indexOf('alias.svg') < files.indexOf('rocket.svg'), files)
  check('no other files', !files.some((f) => /\.txt$|icons\.json$/.test(f)))
  check('depth capped as in the browser (4 below the root)', files.includes('a/b/c/d/deep.svg') && !files.some((f) => f.includes('too-deep')))
  check('a symlink inside the folder is followed', files.includes('alias.svg') && files.includes('linked-set/cloud.svg'))
  check('a symlink leading out is not (file or folder)', !files.includes('leak.svg') && !files.some((f) => f.startsWith('leakdir/')) && !files.includes('disguised.svg'), files)
  const man = (l.manifests ?? []) as Array<{ prefix: string; text: string }>
  check('every icons.json comes with its folder and text', man.some((m) => m.prefix === 'set/' && m.text.includes('weather')) && man.some((m) => m.prefix === 'linked-set/'), man.map((m) => m.prefix))
  check('the reply never names the path', !JSON.stringify(l).includes(tmp))
  const again = await call('slidomingo:icon-folder-list', 'src_f', l.stamp)
  check('a current stamp: unchanged, no listing sent', again.ok && again.unchanged === true && !again.files)
  check('an unknown source: unset', (await call('slidomingo:icon-folder-list', 'nope')).reason === 'unset')

  console.log('read')
  const read = async (rel: unknown) => call('slidomingo:icon-folder-read', 'src_f', rel)
  const r1 = await read('set/cloud.svg')
  check('an icon file of the folder', r1.ok && new TextDecoder().decode(r1.body) === SVG)
  check('through an inner symlink too', (await read('alias.svg')).ok && (await read('linked-set/cloud.svg')).ok)
  check('`..` is refused', !(await read('../outside/secret.svg')).ok && !(await read('set/../../outside/secret.svg')).ok)
  check('an absolute path is refused', !(await read(join(outside, 'secret.svg'))).ok)
  check('a symlink out is refused', !(await read('leak.svg')).ok && !(await read('leakdir/secret.svg')).ok)
  check('a .svg link to a non-icon file is refused', !(await read('disguised.svg')).ok)
  check('other extensions are refused (icons.json, .txt)', !(await read('set/icons.json')).ok && !(await read('notes.txt')).ok)
  check('a file over the size cap is refused', (await read('big.svg')).ok === false)
  check('junk is refused', !(await read(42)).ok && !(await read('')).ok && !(await read('a\0.svg')).ok)

  console.log('the pref')
  setPref(KEY, JSON.stringify([folderSrc('src_f', { path: icons }), folderSrc('src_g')]))
  check('a folder path never stays in the stored list', !JSON.stringify(readSettings()).includes(tmp))
  check('…and the folder is still main\'s', store().src_f === icons)
  setPref(KEY, JSON.stringify([folderSrc('src_g')]))
  check('removing the source drops its folder', !store().src_f)

  console.log('status')
  dialogAnswer = { canceled: false, filePaths: [icons] }
  await call('slidomingo:icon-folder-pick', 'src_g')
  const st = await call('slidomingo:icon-folder-status', ['src_g', 'src_none', 'bad id!'])
  check('name and presence; null when none is stored; bad ids skipped', JSON.stringify(st) === JSON.stringify({ src_g: { name: 'My Icons', missing: false }, src_none: null }), st)
  const moved = join(tmp, 'gone')
  mkdirSync(moved)
  dialogAnswer = { canceled: false, filePaths: [moved] }
  await call('slidomingo:icon-folder-pick', 'src_h')
  rmSync(moved, { recursive: true })
  check('a folder that went away: missing', (await call('slidomingo:icon-folder-status', ['src_h'])).src_h?.missing === true)
  check('…and listing it says gone', (await call('slidomingo:icon-folder-list', 'src_h')).reason === 'gone')

  console.log('a hidden instance reads the user\'s folders, read-only')
  const userDir = join(tmp, 'user')
  mkdirSync(userDir)
  process.env.BEESLIDES_USER_SETTINGS = join(userDir, 'app-settings.json')
  const userFolders = join(userDir, 'icon-folders.json')
  writeFileSync(userFolders, JSON.stringify({ src_u: icons }))
  const userBefore = readFileSync(userFolders, 'utf8')
  process.argv.push('--background')
  const bl = await call('slidomingo:icon-folder-list', 'src_u')
  check('it lists the user\'s folder', bl.ok && bl.files.includes('rocket.svg'))
  check('…and reads its files', (await call('slidomingo:icon-folder-read', 'src_u', 'rocket.svg')).ok)
  check('its own folders are not consulted', (await call('slidomingo:icon-folder-list', 'src_g')).reason === 'unset')
  writeFileSync(userFolders, JSON.stringify({ src_u: icons, src_later: join(icons, 'set') }))
  check('a folder the user adds later is there at the next request', (await call('slidomingo:icon-folder-list', 'src_later')).files?.join() === 'cloud.svg')
  writeFileSync(userFolders, userBefore)
  const n = dialogs
  check('picking is refused, no dialog', (await call('slidomingo:icon-folder-pick', 'src_u')).ok === false && dialogs === n)
  setPref(KEY, JSON.stringify([]))
  check('a pruning list write leaves the user\'s file alone', readFileSync(userFolders, 'utf8') === userBefore)
  process.argv.splice(process.argv.indexOf('--background'), 1)
  delete process.env.BEESLIDES_USER_SETTINGS
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall main-side icon-folder checks passed')
