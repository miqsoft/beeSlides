// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

import './styles.css'
import { anim } from './anim'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import { startTheme } from '../../kernel/src/theme.ts'
import { startNetGuard } from '../../kernel/src/net.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, parseEnvelope,
  registerPreview, registerStaticLayer, canWriteInPlace, hostCan, adoptPristineHtml,
  registerKnownFeatures, registerAssetStore,
} from './save'
import { maybeShowReturnGate } from './editor/returngate'
import { buildSlidePreview } from './preview'
import { assetStoreSpec, buildStaticLayer } from './staticlayer'
import { i18nApi, t, applyDirection } from './i18n'
import { KNOWN_FEATURES, commentEntries, newDoc, parseDoc, parseTemplateForEditing, resolveStoreRefs, templateFileDoc, unsupportedFeatures, type SlidomingoDoc, type CommentFilter, type TextElement } from './model'
import { engageFormatGate, formatGate, formatGateNotice, refuseNewerDoc, showFormatGateBanner } from './formatgate'
import { validateDoc, type ValidateOpts } from './validate'
import { resolveThemeRefs } from './palette'
import { measureText, measureElement, type TextMeasureSpec } from './measure'
import { showStartupPicker } from './startuppicker'
import { injectFonts } from './fonts'
import { Store } from './store'
import { Editor, docForAgent } from './editor/editor'
import { isDesktopShell } from './editor/ribbon'
import { disableDesktopWrites, initDesktopDoc, wireDesktopFlush } from './editor/desktopdoc'
import { passwordGate, playerMode } from './player'

// Tell the kernel who this app is — must precede any kernel module use
// (window title suffix, save-picker label).
configureApp({
  appId: 'slidomingo-slides',
  appName: 'BeeSlides',
})

// Every save writes a static rendering of page one into the shell, so file
// managers thumbnail the deck instead of the boot splash (src/preview.ts).
// Registered before capturePristine only for tidiness — nothing serializes
// this early — but it must be registered before the first save.
registerPreview((doc) => buildSlidePreview(doc as SlidomingoDoc))

// Every save also writes a full-deck declarative rendering of every slide
// ("slidomingo/deck", src/staticlayer.ts) — a JS-off reader's real first paint,
// not just a thumbnail. Same registration timing rule as the preview above.
registerStaticLayer((doc) => buildStaticLayer(doc as SlidomingoDoc))

// Every embedded picture and font is written ONCE per file, in the asset
// store (kernel/src/assetstore.ts); the doc JSON refers to it.
registerAssetStore((doc) => assetStoreSpec(doc as SlidomingoDoc))

// The reader gate (kernel/src/doc.ts): the kernel refuses to serialize any
// document whose `requires` names something not registered here.
registerKnownFeatures(KNOWN_FEATURES)

capturePristine()

// Whether the page we just cloned is a real built shell. The desktop app in
// dev mode runs Vite's index.html, which carries no runtime payload and must
// never be spliced into a user's deck (main.ts → adoptPristineHtml below).
const liveIsBuiltShell = !!document.getElementById('slidomingo-rt')

// Theme: after capturePristine, before the first paint.
//
// AFTER, because capturePristine clones the LIVE document and saves
// re-serialize that clone — so `data-theme` and `color-scheme` on <html> must
// not exist yet, or a viewer's preference would travel inside every file they
// save. Same rule applyDirection follows two lines below for dir/lang.
//
// BEFORE the paint, because applying it later renders the interface light and
// then flips it, which reads as a bug rather than a preference. Nothing here
// lays anything out — it sets two attributes on the root element.
startTheme()

// slidomingo/desktop chrome marker — same AFTER-capturePristine, BEFORE-paint
// rule as startTheme() above (an attribute set any earlier would travel into
// every saved file). Pure CSS-scoping signal for the native title
// bar/ribbon (editor/titlebar.ts, editor/ribbon.ts); JS branches on
// isDesktopShell() directly, not this attribute. No-op in a browser tab.
if (isDesktopShell()) document.documentElement.dataset.desktopShell = '1'

// Watch the offline switch in OTHER tabs. `storage` fires only in the tabs
// that did not make the change — which is precisely the set that has an open
// socket it does not yet know to close (GHSA-5c3x-xqp6-g94r).
startNetGuard()

// Chrome direction follows the VIEWER's language (Arabic/Hebrew/… get an RTL
// interface). Deliberately AFTER capturePristine: saves re-serialize the
// pristine clone, so the dir/lang attributes never reach a saved file — the
// same viewer-scoped rule as 'slidomingo-lang' and reduced motion. The DOCUMENT
// never mirrors; styles.css pins every slide surface back to direction: ltr.
applyDirection()

// --- boot gates: password-encrypted files, read-only player files -----------

void boot()

async function boot() {
// slidomingo/desktop: every window boots the CURRENT app shell and asks main
// for its deck (editor/desktopdoc.ts, docs/DECISIONS.md 2026-09-24). The flush
// handler goes up first: a window closed on the start page or the password
// gate must still answer main's close request ("clean").
let embedded: string | null = null
let bound = false
let startIntent: 'default-template' | 'new-template' | 'new-figure' | 'new-iconset' | null = null
// A template window (Edit Template, editor/templatewindow.ts): the bound file
// is a template, edited as one.
let templateMode = false
if (isDesktopShell()) {
  wireDesktopFlush()
  const launch = await initDesktopDoc()
  if (launch) {
    bound = true
    startIntent = launch.startIntent ?? null
    templateMode = launch.role === 'template'
    embedded = launch.text?.trim() || null
    // Files this window writes are EDITABLE files again (DECISIONS 2026-10-09,
    // superseding the 2026-10-07 viewer-only saves): a saved deck opens in
    // the editor anywhere, and presenting is a mode chosen on its start card.
    // The viewer-only shell is what File ▸ Export
    // writes (editor.savePresentationPackage). A dev window has no built
    // shell of its own, so splice saves into the BUILT one, or refuse to
    // write at all.
    if (!liveIsBuiltShell) {
      const shell = await window.slidomingoDesktop?.getAppShell?.()
      if (!shell || !adoptPristineHtml(shell)) {
        disableDesktopWrites(t('Saving is off: build slides first (npm run build:single) — this dev window has no app shell to save into.'))
      }
    }
    if (liveIsBuiltShell && launch.dir) {
      // The deck's own folder, for relative media — added AFTER the pristine
      // capture, so it never reaches a saved file.
      const base = document.createElement('base')
      base.href = fileUrlForDir(launch.dir)
      document.head.prepend(base)
    }
  }
}
if (!bound) embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null
if (envelope) {
  passwordGate(envelope, (doc) => bootWith(doc))
} else if (isDesktopShell() && !embedded) {
  // A desktop user deliberately launched their editor (⌘N, a fresh
  // app.on('activate') window, a cold launch with no file arg) — offer the
  // start page instead of a bare blank deck. A real file path
  // (embedded !== null) bypasses this entirely. The web app opens one blank
  // slide below (there is no example deck any more — DECISIONS 2026-09-30).
  // File ▸ New from Default Layout skips the page (startIntent); File ▸
  // New Layout… opens the page with the Create layout chooser over it —
  // each option writes a layout file and main turns this window into its
  // template window, so the picker never resolves for those.
  void (async () => {
    const { doc, isFresh, report } = await showStartupPicker({ startIntent })
    // an imported deck: the editor shows its report once it is up
    // (editor.ts wireDesktopDoc, the same hand-off as a seeded import)
    if (report) Object.assign(doc, { __importReport: report })
    bootWith(doc, isFresh)
  })()
} else {
  const parsed = embedded ? (templateMode ? parseTemplateForEditing(embedded) : parseDoc(embedded)) : null
  // A bound file we could not read must never have the blank deck
  // autosaved over it.
  if (bound && embedded && !parsed) disableDesktopWrites(t('This file could not be read, so BeeSlides will not save over it.'))
  // Whether this is OUR fresh blank deck or someone's document is knowable
  // only here — downstream the two are indistinguishable, and the difference
  // is what stops the return gate appearing over real work.
  if (!parsed && !isDesktopShell() && (location.hash === '#new-figure' || location.hash === '#new-iconset')) {
    // web entry to Figure mode / icon sets: the start page's chooser, then the editor
    const intent = location.hash === '#new-figure' ? 'new-figure' : 'new-iconset'
    void showStartupPicker({ startIntent: intent }).then(({ doc, isFresh }) => bootWith(doc, isFresh))
  } else {
    bootWith(parsed || newDoc(), !parsed, templateMode && parsed ? 'template' : undefined)
  }
}
} // boot

/** `file:///…/dir/` for a folder path (POSIX or Windows). */
function fileUrlForDir(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').map((seg, i) =>
    i <= 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))
  const joined = parts.join('/').replace(/\/+$/, '')
  return (joined.startsWith('/') ? 'file://' : 'file:///') + joined + '/'
}

/** `template`: a template window — the editor in template mode, opened on
 *  the Layout Manager. */
type BootIntent = 'template'

function bootWith(doc: SlidomingoDoc, docIsFresh = false, intent?: BootIntent) {
  // The reader gate: a document from a NEWER BeeSlides opens read-only
  // (src/formatgate.ts). Engaged before anything can write — the desktop
  // binding refuses from here on, and the kernel would refuse regardless.
  const missing = unsupportedFeatures(doc)
  if (missing.length) {
    engageFormatGate(missing)
    if (isDesktopShell()) disableDesktopWrites(formatGateNotice())
    console.warn('slidomingo: opened read-only, this build does not know', missing)
  }

  // The full-deck static layer (src/staticlayer.ts) exists for a reader who
  // never runs this script — reaching this line means script IS running, so
  // its job is already done for THIS load. Unconditional removal, same
  // replace-never-append spirit as the preview: a smarter swap timed to the
  // live app's own first frame (avoiding even a brief static→live flash) is
  // a later phase, not this one.
  document.getElementById('slidomingo-static')?.remove()

  // Derive palette-referenced colours once before anything renders. A file
  // saved by this app already carries correct literals, so this is normally a
  // no-op — it matters for a document whose JSON was written by hand or by an
  // agent, where the refs may be right and the literals stale. Editing later
  // re-derives through the editor's `doc` hook; nothing else would visit a
  // player file at all.
  resolveThemeRefs(doc)
  if (doc.readonly) playerMode(doc)
  else editorMode(doc, docIsFresh, intent)
}

function editorMode(doc: SlidomingoDoc, docIsFresh = false, intent?: BootIntent) {

document.title = `${doc.title} — ${appConfig().appName}`

// Embedded fonts: register @font-face rules from the asset table so text
// elements can use bundled families in the editor, presenter and thumbnails.
if (doc.fonts?.length) injectFonts(doc)

const store = new Store(doc)
// read-only behind the reader gate: user edits are inert (store.commit)
if (formatGate()) store.readOnly = true
const templateMode = intent === 'template'
const editor = new Editor(document.getElementById('app')!, store, { templateMode })
showFormatGateBanner()

// A template window opens on the Layout Manager's "Slide types".
if (templateMode) editor.openLayoutManager('types')

// slidomingo/desktop's native menu bar: every renderer command chosen there
// arrives as an id and runs through the editor's command registry
// (editor/commands.ts) — the same handlers the ribbon and Save ▾ call.
window.slidomingoDesktop?.onMenuCommand?.((id) => { editor.commands.run(id) })

// A returning visitor who saved from this origin before is told so, rather
// than handed a silent blank starter that reads as lost work. No-ops off the
// web, for a first-time visitor, and over any real document.
maybeShowReturnGate({ docIsFresh, fsAccess: canWriteInPlace(), canWrite: hostCan('write') })

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
}

// Dismiss the boot splash (inline in index.html so it paints before this
// bundle parses). Hold it briefly so the bee intro (index.html, timed to
// land inside this hold) reads as a brand moment instead of a flicker; the pristine capture ran before this,
// so saved files keep the splash for their own next boot.
{
  const splash = document.getElementById('slidomingo-splash')
  if (splash) {
    const wait = Math.max(0, 1250 - performance.now())
    setTimeout(() => {
      splash.classList.add('done')
      setTimeout(() => splash.remove(), 550)
    }, wait)
  }
}

// Small scripting surface for tooling and automation: read/replace the
// document model and serialize the full .beeslides.html file.
;(window as any).slidomingo = {
  format: doc.format,
  get doc() {
    return store.doc
  },
  // a template window's file is the template (editor.ts serializeForDisk)
  serialize: () => serializeFile(templateMode ? templateFileDoc(store.doc, doc.templateId) : store.doc),
  undo: () => store.undo(),
  redo: () => store.redo(),
  get selection() {
    return store.selection.slice()
  },
  /** The native menu's source of truth — scripting/e2e handle (desktop e2e-menu.mjs). */
  menu: {
    model: () => editor.menuModel(),
    run: (id: string) => editor.commands.run(id),
    unresolved: () => editor.commands.unresolved(),
    has: (id: string) => editor.commands.has(id),
  },
  /** animation engine, exposed for scripting/diagnostics */
  anim,
  /** the per-install UI profile (editor/customize/) — scripting/e2e */
  uiProfile: editor.uiProfileApi(),
  /** i18n: t/locale/setLocale/choices — setLocale('x-pseudo') audits the sweep */
  i18n: i18nApi,
  /**
   * AI/tooling round-trip: replace the whole document from a JSON string
   * (the contents of #slidomingo-doc). Validates via parseDoc; returns false and
   * changes nothing on invalid input. Undoable in the editor.
   */
  loadDoc(json: string): boolean {
    const parsed = parseDoc(json)
    if (!parsed) return false
    if (refuseNewerDoc(parsed, null, (m) => console.warn('slidomingo.loadDoc:', m))) return false
    // asset-store refs (a light copy, a file's own block) resolve from the
    // open document; any it does not hold are kept and reported
    const { doc: next, missing } = resolveStoreRefs(parsed, store.doc)
    if (missing.length) console.warn(`slidomingo.loadDoc: ${missing.length} stored asset(s) not in this document, kept as references`, missing)
    store.replaceDoc(next)
    return true
  },
  /**
   * Report what the runtime would otherwise swallow: unknown keys, text that
   * overflows its box, elements off the canvas, effects that can never run,
   * broken links and asset refs, chart options charts-lite ignores. Read-only
   * — it never changes the document. Pass a doc to check one you have not
   * loaded; defaults to the open one.
   */
  validate(target?: SlidomingoDoc, opts?: ValidateOpts) {
    return validateDoc(target ?? store.doc, opts)
  },
  /**
   * How tall does this text need to be? The format is absolute pixels, so
   * without a screen the height of a string is a guess — this answers it by
   * rendering through the real renderer.
   *
   * Pass an element id to measure one that exists, or a spec
   * ({html, w, fontSize, …}) to size text BEFORE creating the element, which
   * is the point: an agent can lay a slide out correctly the first time
   * instead of writing it, checking, and correcting.
   *
   * Returns {height, width, lines} — plus {fits, overflow} when you supply `h`.
   */
  measure(target: string | TextMeasureSpec, opts?: { doc?: SlidomingoDoc }) {
    const doc = opts?.doc ?? store.doc
    if (typeof target !== 'string') return measureText(target, doc)
    for (const s of doc.slides) {
      const el = s.elements.find((e) => e.id === target && e.type === 'text')
      if (el) return measureElement(el as TextElement, doc)
    }
    return null
  },
  /**
   * Flat list of every review comment thread — the entry point for tooling
   * and AI agents processing the deck ("fix everything people flagged"):
   * each item carries the slide, a typed anchor (element / point / slide),
   * author, text, replies, the `@ai`/`forAgent` flag and resolved state.
   * Optional filter narrows by resolved state, forAgent, or one slide; a
   * no-arg call keeps the full flat list. Same implementation the desktop
   * terminal integration's `comments` MCP verb calls (editor.ts
   * respondAgentQuery), so the two surfaces cannot disagree.
   */
  comments(filter?: CommentFilter) {
    return commentEntries(store.doc, filter)
  },
  /** The document as handed to an AI agent — a deep clone, kept separate
   *  from raw `.doc` for API stability (see editor.ts's docForAgent). */
  docForAgent(): SlidomingoDoc {
    return docForAgent(store.doc)
  },
}

} // editorMode
