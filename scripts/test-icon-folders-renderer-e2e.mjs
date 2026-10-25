#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-library folders, the EDITOR's desktop path, in a real browser: the
// built editor with a stub `slidomingoDesktop` whose folder calls are
// answered by this node process standing in for main — with main's REAL walk
// and file reads (desktop/src/main/iconfolderscore.ts, validateFolder) over a
// temp folder. Main's IPC half is scripts/test-icon-folders-main.ts.
//
//   node scripts/test-icon-folders-renderer-e2e.mjs [url]
//
// url defaults to slides/dist-single/BeeSlides.beeslides.html. Needs
// playwright-core (same lookup as test-icons-e2e.mjs); SKIPS with exit 0
// without it or a build.
//
// Checks: a folder source main has no folder for (one picked as a handle
// before) — the agent's search says to pick it again, the card says so;
// "Choose folder…" goes through main and names the folder; the agent's
// search uses the icons.json names, keywords and licence, inserts an svg
// and a png; a repeated search reuses the listing (stamp); the Icons popover
// shows blob: thumbnails; "Add local folder…" adds a source through main; a
// folder that went away says so; no absolute path ever reaches the page,
// its storage or what is mirrored to main's prefs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { listIconFolder, readIconFile } from '../desktop/src/main/iconfolderscore.ts'
import { validateFolder } from '../desktop/src/main/attachedfolders.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) tries.push(pathToFileURL(p).href)
    }
  }
  for (const spec of tries) {
    try { return (await import(spec)).chromium } catch { /* next */ }
  }
  return null
}

const skip = (why) => { console.log(`test-icon-folders-renderer-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

// ---- the folders on "disk" ----
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bs-iconfolders-e2e-')))
const icons = join(tmp, 'Team Icons')
const second = join(tmp, 'Second Set')
for (const d of [join(icons, 'weather'), second]) mkdirSync(d, { recursive: true })
const SVG = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${c}"/></svg>`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
writeFileSync(join(icons, 'weather/sun.svg'), SVG('#fa0'))
writeFileSync(join(icons, 'weather/icons.json'), JSON.stringify({ license: 'CC-BY-4.0', author: 'Team', icons: [{ file: 'sun.svg', name: 'Sunshine', keywords: ['bright'] }] }))
writeFileSync(join(icons, 'badge.png'), PNG)
writeFileSync(join(second, 'star.svg'), SVG('#00f'))

// ---- "main": the folders it keeps and serves ----
const folders = new Map() // source id → path
const calls = { list: [], prefs: [] }
let pickAnswer = null

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('pageerror', e.message) })
const locate = (id) => {
  const p = folders.get(id)
  if (!p) return { ok: false, reason: 'unset', error: 'no folder is stored for this source' }
  const v = validateFolder(p)
  return v.ok ? { ok: true, root: v.path } : { ok: false, reason: 'gone', error: v.error }
}
await page.exposeFunction('__mainPick', (id) => {
  if (!pickAnswer) return { ok: false, cancelled: true }
  const v = validateFolder(pickAnswer)
  if (!v.ok) return { ok: false, error: v.error }
  folders.set(id, v.path)
  return { ok: true, name: basename(v.path) }
})
await page.exposeFunction('__mainStatus', (ids) => Object.fromEntries(ids.map((id) => [id, folders.has(id) ? { name: basename(folders.get(id)), missing: !validateFolder(folders.get(id)).ok } : null])))
await page.exposeFunction('__mainList', async (id, stamp) => {
  calls.list.push([id, stamp ?? null])
  const at = locate(id)
  if (!at.ok) return at
  const now = `s-${Buffer.from(at.root).toString('hex').slice(-12)}`
  if (stamp === now) return { ok: true, stamp: now, unchanged: true }
  return { ok: true, stamp: now, ...await listIconFolder(at.root) }
})
await page.exposeFunction('__mainRead', async (id, rel) => {
  const at = locate(id)
  if (!at.ok) return at
  const r = await readIconFile(at.root, rel)
  return r.ok ? { ok: true, body: Buffer.from(r.body).toString('base64') } : r
})
await page.exposeFunction('__mainPref', (k, v) => { calls.prefs.push([k, v]) })

await page.addInitScript(() => {
  // a folder source from before main kept folders: its handle sat in one deck's storage
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('slidomingo-icon-sources', JSON.stringify([{ id: 'dir', kind: 'folder', name: '', enabled: true }]))
  }
  window.__results = {}
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const impl = {
    setViewerPref: (k, v) => { void window.__mainPref(k, v) },
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
    pickIconFolder: (id) => window.__mainPick(id),
    iconFolderStatus: (ids) => window.__mainStatus(ids),
    iconFolderList: (id, stamp) => window.__mainList(id, stamp),
    iconFolderRead: async (id, p) => { const r = await window.__mainRead(id, p); return r.ok ? { ok: true, body: b64(r.body) } : r },
  }
  // no icon-server bridge here (no server source in this test)
  const absent = new Set(['iconFetch', 'setIconToken', 'iconTokenStatus', 'adoptIconTokens'])
  const thenable = () => Promise.resolve(undefined)
  window.slidomingoDesktop = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !absent.has(k) ? () => thenable() : undefined)) })
})
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.beeslides?.doc && !!document.querySelector('.ed-root'), null, { timeout: 15000 })
pageErrors.length = 0

let n = 0
async function act(verb, args) {
  const id = `r${++n}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 15000 })
  return page.evaluate((id) => window.__results[id], id)
}
const pageHas = (s) => page.evaluate((s) => JSON.stringify({ ...localStorage }).includes(s) || document.documentElement.outerHTML.includes(s), s)
const openSettings = async () => {
  await page.evaluate(() => window.beeslides.menu.run('app.settings'))
  await page.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
  await page.waitForSelector('.ed-isrc[data-source-id="dir"]')
}
const card = (id) => page.locator(`.ed-isrc[data-source-id="${id}"]`)
const folderLine = async (id, re) => {
  await page.waitForFunction(([id, re]) => new RegExp(re).test(document.querySelector(`.ed-isrc[data-source-id="${id}"] .ed-isrc-folder`)?.textContent ?? ''), [id, re.source], { timeout: 5000 }).catch(() => {})
  return card(id).locator('.ed-isrc-folder').innerText()
}

try {
  const slideId = await page.evaluate(() => window.beeslides.doc.slides[0].id)

  // ---- a folder main has no path for
  const none = await act('icons', { op: 'search', query: 'sun' })
  ok(!none.ok && /Pick this folder again in Settings ▸ Icon library/.test(none.error), `the agent hears to pick the folder again (${String(none.error).slice(0, 120)}…)`)
  await openSettings()
  const legacy = await folderLine('dir', /again/)
  ok(/Choose this folder again/.test(legacy) && (await card('dir').locator('.ed-isrc-body button', { hasText: 'Choose folder…' }).count()) === 1, `the card asks for it again ("${legacy}")`)

  // ---- choose it through main
  pickAnswer = icons
  await card('dir').locator('.ed-isrc-body button', { hasText: 'Choose folder…' }).click()
  const named = await folderLine('dir', /Folder:/)
  ok(named === 'Folder: Team Icons' && (await card('dir').locator('.ed-isrc-name').inputValue()) === 'Team Icons', `main's dialog picked it; the card names it ("${named}")`)
  ok(folders.get('dir') === icons, 'main keeps the path')
  await page.locator('.ed-settings-close').click()

  // ---- the agent searches and inserts through main
  const found = await act('icons', { op: 'search', query: 'bright' })
  ok(found.ok && found.refs.length === 1 && /"Sunshine"/.test(found.summary) && /license: CC-BY-4\.0/.test(found.summary), `icons.json keywords, name and licence apply (${JSON.stringify(found.summary?.split('\n')[1])})`)
  const put = await act('icons', { op: 'insert', slideId, ref: found.refs[0], x: 100, y: 100, size: 80 })
  const el = await page.evaluate((id) => window.beeslides.doc.slides[0].elements.find((e) => e.id === id), put.elementId)
  const markup = await page.evaluate((k) => window.beeslides.doc.assets?.[k], el?.asset)
  ok(put.ok && el?.type === 'svg' && typeof markup === 'string' && markup.includes('#fa0') && el.provenance?.license === 'CC-BY-4.0' && el.provenance.author === 'Team', `insert: the svg, read through main, with its provenance (${JSON.stringify(el?.provenance)})`)
  const all = await act('icons', { op: 'search', query: '' })
  ok(all.ok && all.refs.length === 2, `an empty query lists the folder (${all.refs?.length})`)
  ok(calls.list.at(-1)?.[1] !== null, 'a repeated search hands main its stamp (the listing is reused)')
  const badgeRef = all.refs[all.summary.split('\n').slice(1).findIndex((l) => l.includes('"badge"'))]
  const png = await act('icons', { op: 'insert', slideId, ref: badgeRef })
  const img = await page.evaluate((id) => window.beeslides.doc.slides[0].elements.find((e) => e.id === id), png.elementId)
  ok(png.ok && img?.type === 'image' && /^(data:image\/png|asset:)/.test(img.src ?? ''), `a png becomes an image element (${img?.type} ${String(img?.src).slice(0, 22)})`)

  // ---- the popover
  await page.evaluate(() => window.beeslides.menu.run('insert.icons'))
  await page.waitForSelector('.ed-icon-pop')
  await page.waitForFunction(() => document.querySelectorAll('.ed-icon-pop .ed-icon-grid img[src^="blob:"]').length === 2, null, { timeout: 10000 }).catch(() => {})
  ok(await page.locator('.ed-icon-pop .ed-icon-grid img[src^="blob:"]').count() === 2, 'the Icons popover shows both, thumbnails as blob: URLs')
  await page.keyboard.press('Escape')

  // ---- add another folder through main
  pickAnswer = second
  await openSettings()
  const ids = () => page.evaluate(() => JSON.parse(localStorage.getItem('slidomingo-icon-sources')).map((s) => s.id))
  const before = await ids()
  await page.locator('.ed-isrc-add button', { hasText: 'Add local folder…' }).click()
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem('slidomingo-icon-sources')).length > n, before.length, { timeout: 5000 }).catch(() => {})
  const added = (await ids()).find((id) => !before.includes(id))
  ok(!!added && folders.get(added) === second && /Folder: Second Set/.test(await folderLine(added, /Folder:/)), `"Add local folder…" adds a source through main (${added})`)
  pickAnswer = null
  await page.locator('.ed-settings-close').click()
  const both = await act('icons', { op: 'search', query: 'star' })
  ok(both.ok && both.refs.length === 1 && /"star"/.test(both.summary), `the new folder is searched too (${JSON.stringify(both.summary?.split('\n')[1])})`)

  // ---- a folder that went away
  rmSync(second, { recursive: true })
  const gone = await act('icons', { op: 'search', query: '' })
  ok(gone.ok && /Not searched: Second Set: This folder is not there any more/.test(gone.summary), `a vanished folder is a note beside the other's results (${JSON.stringify(gone.summary?.split('\n').pop())})`)
  await openSettings()
  ok(/is not there any more/.test(await folderLine(added, /not there/)), 'its card says so')
  await page.locator('.ed-settings-close').click()

  ok(!(await pageHas(tmp)), 'no absolute path anywhere in the page or its storage')
  ok(calls.prefs.filter(([k]) => k === 'slidomingo-icon-sources').every(([, v]) => !String(v).includes(tmp)), 'nor in what is mirrored to main\'s prefs')
  ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`\ntest-icon-folders-renderer-e2e: ${checks - failures} passed, ${failures} failed`)
if (failures) process.exit(1)
