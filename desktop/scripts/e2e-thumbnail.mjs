#!/usr/bin/env electron
// End-to-end check of slidomingo:get-thumbnail through the real preload.
//
//   cd desktop && npx electron-vite build && npx electron scripts/e2e-thumbnail.mjs [extra.beeslides.html …]
//
// Runs INSIDE Electron as its entry point: points SLIDOMINGO_USER_DATA at a
// throwaway dir, imports the built main (out/main/index.js — the real app,
// IPC and preload), opens a copy of slides/dist-single's shell in a document
// window, starts a Blank deck from the start page, loads a small titled deck into it and serializes it (→ a file WITH a
// first-page preview), then asks that window's
// `window.slidomingoDesktop.getThumbnail()` for:
//   - the saved deck             → a 640×360 PNG that is not the splash
//   - the same deck, encrypted   → { placeholder: 'lock' }
//   - the pristine shell         → { placeholder: 'doc' }
//   - a missing / relative path  → { placeholder: 'doc' }
// plus any extra decks given on the command line (copied first; must carry a
// preview), and the cache's mtime/encryption invalidation. PNGs are left in
// the temp dir for a visual check.
//
// Not playwright-core's _electron.launch: against this app it times out after
// both inspectors connect (a trivial app launches fine), cause not found.
import { app, BrowserWindow, nativeImage, webContents } from 'electron'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(desktopDir, 'out/main/index.js')
const shellSrc = resolve(desktopDir, '../slides/dist-single/BeeSlides.beeslides.html')
const extras = process.argv.slice(2).filter((a) => a.endsWith('.html') && existsSync(a))

function log(line) { try { console.log(line) } catch { /* pipe gone */ } }
function bail(msg) { log(msg); app.exit(2) }
if (!existsSync(mainEntry)) bail('run `npx electron-vite build` first')
if (!existsSync(shellSrc)) bail('run `npm run build:single` in slides/ first')

// realpath: macOS's tmpdir is a /var → /private/var symlink, and the loaded
// URL (matched below) carries the resolved path.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'slidomingo-e2e-thumbs-')))
const userData = join(work, 'userData')
const shell = join(work, 'shell.beeslides.html')
copyFileSync(shellSrc, shell)
process.env.SLIDOMINGO_USER_DATA = userData
// an empty templates folder: the start page must not thumbnail the user's own
process.env.SLIDOMINGO_TEMPLATES_DIR = join(work, 'templates')

let failures = 0
function ok(cond, msg) {
  if (!cond) failures++
  log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
}

// No top-level await below: Electron holds 'ready' until an ESM entry has
// finished evaluating, so awaiting whenReady() here would deadlock.
// Stay out of the way (no window, no Dock icon) unless E2E_SHOW=1 — same as
// e2e-autosave.mjs.
if (!process.env.E2E_SHOW) {
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.focus = function () {}
  app.dock?.hide()
}
void import(pathToFileURL(mainEntry).href).then(() => {
// The way a Finder double-click arrives on macOS: index.ts's 'open-file'
// listener queues it before ready, or opens a window straight away after.
app.emit('open-file', { preventDefault() {} }, shell)
return app.whenReady()
}).then(main, (err) => bail(`could not load the app: ${err && err.stack}`))

async function main() {

const hardStop = setTimeout(() => bail('e2e timed out'), 120000)
try {
  // The document lives in a WebContentsView; find it by URL.
  const run = async (code) => {
    const deadline = Date.now() + 30000
    for (;;) {
      // Every window runs the app's own built shell now (windows.ts), whatever
      // file it was opened for — so match the shell, not the copy.
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html$/.test(decodeURIComponent(w.getURL())))
      if (wc && !wc.isLoading()) {
        // A pristine shell opens as a new draft on the start page: start a
        // Blank deck (the content comes from loadDoc below).
        await wc.executeJavaScript(`(() => { const t = [...document.querySelectorAll('.ed-sp-row .ed-sp-tile')].find((b) => /Blank/.test(b.textContent)); if (t) t.click() })()`).catch(() => {})
        const ready = await wc.executeJavaScript('!!(window.beeslides && window.beeslides.doc && window.slidomingoDesktop)').catch(() => false)
        if (ready) return wc.executeJavaScript(code)
      }
      if (Date.now() > deadline) {
        const probe = wc ? await wc.executeJavaScript('JSON.stringify({s: typeof window.beeslides, d: !!(window.beeslides && window.beeslides.doc), b: typeof window.slidomingoDesktop, t: document.title, body: document.body.innerText.slice(0, 200)})').catch((e) => String(e)) : 'no window'
        throw new Error(`document window never booted: ${probe}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  // A small deck with real content — a coloured page and a big title — so a
  // thumbnail of it can't be mistaken for the dark boot splash.
  await run(`(() => {
    const d = JSON.parse(JSON.stringify(window.beeslides.doc))
    d.title = 'Thumbnail check'
    d.slides[0].background = '#FFE8B0'
    d.slides[0].elements = [{ id: 'tt', type: 'text', x: 96, y: 260, w: 1088, h: 160, rotation: 0, opacity: 1,
      html: 'Thumbnail check', fontSize: 88, fontFamily: 'system-ui, sans-serif', fontWeight: 800,
      color: '#1D1119', align: 'left', valign: 'top', lineHeight: 1.1 }]
    return window.beeslides.loadDoc(JSON.stringify(d))
  })()`)
  const saved = join(work, 'saved.beeslides.html')
  const html = await run('window.beeslides.serialize()')
  writeFileSync(saved, html)
  ok(html.includes('<div data-beeslides-preview="1">'), 'a serialized deck carries a preview host')

  const enc = join(work, 'enc.beeslides.html')
  writeFileSync(enc, html.replace(/(<script[^>]*id="beeslides-doc"[^>]*>)[\s\S]*?(<\/script>)/,
    '$1\n{"format":"beeslides/enc","v":1,"salt":"x","iv":"y","data":"z"}\n$2'))

  const thumb = (p) => run(`window.slidomingoDesktop.getThumbnail(${JSON.stringify(p)})`)

  // Luminance stats of a data-URL PNG.
  const stats = (dataUrl) => {
    const img = nativeImage.createFromDataURL(dataUrl)
    const { width, height } = img.getSize()
    const bmp = img.toBitmap() // BGRA
    let bright = 0, sum = 0, sum2 = 0
    const n = width * height
    for (let i = 0; i < bmp.length; i += 4) {
      const l = 0.0722 * bmp[i] + 0.7152 * bmp[i + 1] + 0.2126 * bmp[i + 2]
      sum += l; sum2 += l * l
      if (l > 200) bright++
    }
    const mean = sum / n
    return { width, height, brightFrac: bright / n, std: Math.sqrt(sum2 / n - mean * mean) }
  }

  const checkPreview = async (label, p) => {
    const t0 = Date.now()
    const r = await thumb(p)
    const ms = Date.now() - t0
    if (!r || !r.dataUrl) { ok(false, `${label}: expected a PNG, got ${JSON.stringify(r)}`); return }
    writeFileSync(join(work, `${basename(p, '.beeslides.html')}.thumb.png`), Buffer.from(r.dataUrl.split(',')[1], 'base64'))
    const s = stats(r.dataUrl)
    // The boot splash is a near-uniform dark field with a small grey logo: no
    // pixel above 200 and a tiny spread. Any real first page has one or both.
    ok(s.width === 640 && s.height === 360, `${label}: 640×360 (${s.width}×${s.height}), ${ms} ms`)
    ok(s.brightFrac > 0.01 || s.std > 30, `${label}: not the splash (bright ${(s.brightFrac * 100).toFixed(1)}%, σ ${s.std.toFixed(1)})`)
    const t1 = Date.now()
    const again = await thumb(p)
    ok(again && again.dataUrl === r.dataUrl, `${label}: second call served from cache (${Date.now() - t1} ms)`)
  }

  console.log('thumbnails')
  await checkPreview('saved deck', saved)
  ok(JSON.stringify(await thumb(enc)) === '{"placeholder":"lock"}', 'encrypted deck → lock placeholder')
  ok(JSON.stringify(await thumb(shell)) === '{"placeholder":"doc"}', 'pristine shell (splash only) → doc placeholder')
  ok(JSON.stringify(await thumb(join(work, 'missing.beeslides.html'))) === '{"placeholder":"doc"}', 'missing file → doc placeholder')
  ok(JSON.stringify(await thumb('relative.html')) === '{"placeholder":"doc"}', 'relative path → doc placeholder')
  for (const extra of extras) {
    const copy = join(work, basename(extra))
    copyFileSync(extra, copy)
    await checkPreview(basename(extra), copy)
  }

  const cached = readdirSync(join(userData, 'Thumbnails'))
  ok(cached.length === 1 + extras.length && cached.every((n) => /^[0-9a-f]{24}-\d+-v\d+\.png$/.test(n)),
    `cache holds one <hash>-<mtime>-v<N>.png per rendered deck (${cached.join(', ')})`)

  // A newer mtime replaces the old entry.
  writeFileSync(saved, html)
  await checkPreview('saved deck, re-saved', saved)
  const after = readdirSync(join(userData, 'Thumbnails'))
  ok(after.length === cached.length && !after.every((n) => cached.includes(n)), 'stale entry for the old mtime was deleted')

  // Gaining a password drops the plaintext picture too.
  writeFileSync(saved, readFileSync(enc, 'utf8'))
  ok(JSON.stringify(await thumb(saved)) === '{"placeholder":"lock"}', 'deck re-saved encrypted → lock')
  ok(readdirSync(join(userData, 'Thumbnails')).length === cached.length - 1, '…and its cached PNG was removed')
} catch (err) {
  ok(false, `crashed: ${err && err.stack}`)
}
clearTimeout(hardStop)
log(`\n${failures ? `${failures} FAILED` : 'all passed'} — artifacts in ${work}`)
app.exit(failures ? 1 : 0)
}
