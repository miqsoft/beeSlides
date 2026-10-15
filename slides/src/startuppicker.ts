// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: a PowerPoint-style start screen shown before ANY
// document loads — New deck (Blank or a saved layout, one click each) side
// by side with Continue (the latest deck, Pinned, Recent & drafts); imports
// and layout tools sit on their own lines under the New deck tiles.
// Structurally the same idiom as main.ts's passwordGate(): a full-screen
// overlay appended to document.body, removed once a choice is made, resolved
// AFTER capturePristine()/BEFORE the first paint — see main.ts's boot-gate
// comment for why that ordering needs no `data-slidomingo-transient` marker.
//
// A LAYOUT here is what the code and the format call a template: a DECK-level
// concept (a whole reusable document: slide types + theme + assets) —
// distinct from per-slide slide types (editor.ts's openLayoutPicker,
// unaffected by this file). docs/DECISIONS.md 2026-09-30: the UI says
// "layout", the format keeps `template`. The templates folder itself is the
// registry (desktop's templates.ts); this module only renders it and
// instantiates every entry as a fresh deck (instantiateTemplate) regardless
// of the source file's own flag, since a manually dropped or Claude-authored
// file can't be trusted to have set it.
import { stripDocExt } from '../../kernel/src/docext.ts'
import {
  FIGURE_PRESETS, FORMAT_VERSION, newFigureDoc, newIconsetDoc, ancestorChain, builtinLayouts, defaultSlideType, deriveChartPalette, effectiveLayout, instantiateLayout, instantiateTemplate, newDoc, newDocId, parseDoc,
  pickableSlideTypes, slideTypeRows, stampAsTemplate, starterSlide, templateNameFromPath, type SlidomingoDoc, type Slide,
} from './model'
import { refuseNewerDoc } from './formatgate'
import { renderThumbnail } from './render'
import { resolveDocText, serializeAuto } from './save'
import { t } from './i18n'
import { ICONS } from './icons'
import { BRAND, WORDMARK_HTML, logoSvg, showLoading } from './brand'
import { canCreateTemplateFiles, createNewTemplate, createTemplateFrom } from './editor/templatewindow'
import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { convertMarkdown } from '../../kernel/src/convert/qmd.ts'
import type { FidelityReport } from '../../kernel/src/convert/report.ts'

export interface StartupChoice {
  doc: SlidomingoDoc
  isFresh: boolean
  /** A whole deck imported from PowerPoint or Markdown: main.ts hands it to
   *  the editor, which shows it once the deck is up (and writes the draft at
   *  once, like any other import). */
  report?: ImportReport
  /** A new icon set's "what icons do you need" (desktop): the editor sends it
   *  to Claude as "Plan with AI" once it is up. */
  planRequest?: string
}

/** = editor/importfix.ts ImportContext: a PowerPoint also carries its kind
 *  and (desktop) the picked file's path, for "Fix with Claude". */
export interface ImportReport { name: string; report: FidelityReport; kind?: 'pptx'; sourcePath?: string }

/** What a PowerPoint/Markdown conversion hands back, normalized to a deck. */
interface Imported { doc: SlidomingoDoc; report: ImportReport }

const PPTX_RE = /\.(pptx|potx)$/i
const MD_RE = /\.(qmd|md|markdown|rmd)$/i
const DECK_RE = /\.html?$/i

/** The converter's OutDoc carries '1.0.0' (a string) and no docId — the same
 *  normalization as editor.ts's applyPptxImport/finishMarkdownImport. */
function asDeck(doc: unknown): SlidomingoDoc {
  return { ...(doc as object), version: FORMAT_VERSION, docId: newDocId(), modified: new Date().toISOString() } as unknown as SlidomingoDoc
}

/** A whole PowerPoint deck, slides and all. Throws on a bad file. */
async function importPptxFile(file: File): Promise<Imported> {
  const result = await convertPptx(new Uint8Array(await file.arrayBuffer()))
  if (!result.doc.slides.length) throw new Error(t('{name} has no slides to import', { name: file.name }))
  let sourcePath: string | undefined
  try { sourcePath = window.slidomingoDesktop?.getPathForFile?.(file) || undefined } catch { /* not desktop */ }
  return { doc: asDeck(result.doc), report: { name: file.name, report: result.report, kind: 'pptx', sourcePath } }
}

/** A Markdown/Quarto deck from a pick or a drop: the source plus any figures
 *  that came with it (resolved by basename when the folder was flattened).
 *  Throws when there is no source among `files`. */
async function importMarkdownFiles(files: File[]): Promise<Imported> {
  const src = files.find((f) => MD_RE.test(f.name)) ?? (files.length === 1 ? files[0] : undefined)
  if (!src) throw new Error(t('Pick a .qmd or .md file (its figures can come along too)'))
  const assets: Record<string, Uint8Array> = {}
  for (const f of files) {
    if (f === src) continue
    const key = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    assets[key] = new Uint8Array(await f.arrayBuffer())
  }
  const result = convertMarkdown(await src.text(), { assets, name: src.name })
  return { doc: asDeck(result.doc), report: { name: src.name, report: result.report } }
}

/** A layout's name from the file it came from: "Brand.potx" → "Brand". */
function layoutNameFor(fileName: string): string {
  return templateNameFromPath(fileName).replace(/\.(pptx|potx)$/i, '') || fileName
}

/** A BeeSlides file (a deck or a layout) read for use as a layout: the same
 *  "arbitrary picked file → SlidomingoDoc" idiom as editor.ts's
 *  openFileLike, resolved against the file's own asset store and behind the
 *  reader gate. Returns it already stamped — a layout file keeps its own
 *  identity (templateId) and sample-slides choice. Throws on a bad file. */
async function layoutDocFromSlidomingoFile(file: File): Promise<SlidomingoDoc> {
  const named = file.name
  const notOurs = () => new Error(t('{name} isn’t a BeeSlides document.', { name: named }))
  const html = await file.text()
  const el = new DOMParser().parseFromString(html, 'text/html').querySelector('#slidomingo-doc')
  if (!el) throw notOurs()
  // resolved against the file's own asset store (kernel/src/assetstore.ts)
  const block = resolveDocText(el.textContent?.trim() ?? '', html)
  if (!block) throw new Error(t('{name} is an empty copy of BeeSlides, not a saved deck.', { name: named }))
  let parsed: unknown
  try { parsed = JSON.parse(block) } catch { throw notOurs() }
  const doc = parseDoc(JSON.stringify(parsed))
  if (!doc) throw notOurs()
  let refused = ''
  if (refuseNewerDoc(doc, named, (m) => { refused = m })) throw new Error(refused)
  // parseDoc moves a template's own id into basedOn — re-importing a
  // layout keeps its identity instead of minting a new one.
  const raw = parsed as { template?: unknown; templateId?: unknown; templateSamples?: unknown }
  return stampAsTemplate(doc, {
    templateId: raw.template === true && typeof raw.templateId === 'string' ? raw.templateId : undefined,
    samples: raw.templateSamples === false ? false : undefined,
  })
}

/** Writes an already-stamped layout doc into the layouts (templates) folder
 *  as `name` (desktop templates.ts de-duplicates the file name). */
async function storeLayoutFile(stamped: SlidomingoDoc, name: string): Promise<void> {
  const path = await window.slidomingoDesktop?.saveTemplate?.(await serializeAuto(stamped), name)
  if (!path) throw new Error(t('Couldn’t save the layout “{name}”', { name }))
}

/** Saves `doc` as a layout named `name`: its slide types and theme, and one
 *  starter slide of its default slide type (no sample slides) — the model
 *  is editor.ts's saveAsTemplate. */
async function saveLayoutFile(doc: SlidomingoDoc, name: string): Promise<void> {
  const clone = stampAsTemplate(doc, { samples: false })
  clone.title = name
  await storeLayoutFile(clone, name)
}

/** The open picker's input, held until it settles: nothing else references a
 *  detached <input>, and a garbage-collected one never fires `change`. */
let pendingPick: HTMLInputElement | null = null

/** A plain <input type=file>, clicked; resolves with the pick (empty when
 *  cancelled — Chromium fires `cancel`). */
function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    const done = (files: File[]) => { if (pendingPick === input) pendingPick = null; resolve(files) }
    input.addEventListener('change', () => done(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => done([]))
    pendingPick = input
    input.click()
  })
}

/** Epoch-ms sibling of comments.ts's private relTime (that one takes an ISO
 *  string; recent.ts's openedAt is a bare number) — kept local rather than
 *  exported/shared to avoid a src/ -> src/editor/ reverse import for one
 *  three-line helper. Reuses the same already-translated t() keys. */
function relTimeMs(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (!Number.isFinite(s) || s < 45) return t('just now')
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) })
  if (s < 86400 * 30) return t('{n}d ago', { n: Math.round(s / 86400) })
  return new Date(ms).toLocaleDateString()
}

/** Splits an absolute path into a filename and its containing folder, for
 *  display only — same forward/back-slash tolerance as the native Open Recent menu. */
function splitPath(path: string): { name: string; folder: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? { name: path, folder: '' } : { name: path.slice(i + 1), folder: path.slice(0, i) }
}

// ---- The start page ----------------------------------------------------------
//
// Shown only in FRESH windows (desktop windows.ts: New, a cold launch, the
// Dock), so there is never unsaved work under it. Two cards of the same size,
// side by side, filling the window (stacked at their natural height,
// Continue first, in a narrow window):
//   - New deck: Blank and one tile per LAYOUT (a template file: slide types +
//     theme + assets — docs/DECISIONS.md 2026-09-24). A click starts the
//     deck at once: one slide of the layout's default slide type. Its ⋯ (or
//     right-click › Options…) opens a side panel for the rest: another first
//     slide type, sample slides, Rename / Default / Delete. Below the tiles,
//     two lines of actions that are not decks: Import (PowerPoint with AI…,
//     From a file…) and Layouts (the same two, Create layout…, the folder).
//     "With AI" = Claude Code in the terminal panel rebuilds the .pptx
//     natively (startGenerate, kind 'pptx'); "from a file" = our converters.
//   - Continue: the latest deck as a big tile, then Pinned and Recent &
//     drafts — real files from Recent plus the auto-kept drafts, each with the
//     first-page thumbnail desktop thumbs.ts renders from the preview every
//     save embeds. It scrolls inside its card. A first launch has none, so it
//     shows the welcome instead.
// docs/DECISIONS.md 2026-09-30 ("a template click starts the deck"; "no
// example deck").

type Desktop = NonNullable<Window['slidomingoDesktop']>
type TemplateMeta = NonNullable<Awaited<ReturnType<NonNullable<Desktop['listTemplateMeta']>>>>[number]

interface RecentItem {
  path: string
  name: string
  folder: string
  at: number
  draft: boolean
  pinned: boolean
}

/** Today / Yesterday / This week / Older, by calendar day — the same
 *  "how long ago" idea as relTimeMs, as headings over the Recent grid. */
function dayBucket(ms: number, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (ms >= today) return t('Today')
  if (ms >= today - day) return t('Yesterday')
  if (ms >= today - 6 * day) return t('This week')
  return t('Older')
}

/** Start-page thumbnails, one request at a time (main renders one at a
 *  time anyway), in the order the tiles were built. */
const thumbQueue: Array<() => Promise<void>> = []
let thumbBusy = false
function queueThumb(path: string, box: HTMLElement) {
  const api = window.slidomingoDesktop
  if (!api?.getThumbnail) { box.classList.add('is-doc'); box.innerHTML = ICONS.notes; return }
  thumbQueue.push(async () => {
    if (!box.isConnected) return
    const r = await api.getThumbnail!(path).catch(() => ({ placeholder: 'doc' as const }))
    if ('dataUrl' in r) {
      const img = document.createElement('img')
      img.src = r.dataUrl
      img.alt = ''
      box.replaceChildren(img)
    } else {
      box.classList.add(r.placeholder === 'lock' ? 'is-lock' : 'is-doc')
      box.innerHTML = r.placeholder === 'lock' ? ICONS.lock : ICONS.notes
    }
  })
  // Not synchronously: callers put `box` in the DOM right after this returns,
  // and an idle queue would otherwise run the job at once and skip it as
  // disconnected (a fresh profile's first template tile never got a picture).
  queueMicrotask(() => void pumpThumbs())
}
async function pumpThumbs() {
  if (thumbBusy) return
  thumbBusy = true
  while (thumbQueue.length) await thumbQueue.shift()!().catch(() => undefined)
  thumbBusy = false
}

/** A new deck from the default template (desktop settings.ts), or null when
 *  none is set, it is gone, or it can't be read. Starts with the template's
 *  default slide type, no samples — what the start page's default tile does. */
async function deckFromDefaultTemplate(): Promise<SlidomingoDoc | null> {
  const api = window.slidomingoDesktop
  const meta = await api?.getDefaultTemplate?.().catch(() => null)
  if (!meta) return null
  const raw = await api?.loadTemplate?.(meta.path).catch(() => null)
  return raw ? instantiateTemplate(raw, { includeSamples: false, name: meta.name }) : null
}

export interface StartupOpts {
  /** File ▸ New from Default Layout: straight into a deck, no page shown
   *  (the page, with a note, when there is no default layout).
   *  File ▸ New Layout…: the page, with the Create layout chooser open over
   *  it (its Back lands on the page). */
  startIntent?: 'default-template' | 'new-template' | 'new-figure' | 'new-iconset' | null
}

/** Resolves once the user starts a deck here. Picking a recent deck or a
 *  draft replaces this window's deck from main instead (windows.ts), so the
 *  promise simply never resolves for those. */
export async function showStartupPicker(opts: StartupOpts = {}): Promise<StartupChoice> {
  if (opts.startIntent === 'default-template') {
    const doc = await deckFromDefaultTemplate()
    if (doc) return { doc, isFresh: true }
  }
  const choice = startPage({
    openCreate: opts.startIntent === 'new-template', openFigure: opts.startIntent === 'new-figure', openIconset: opts.startIntent === 'new-iconset',
  })
  if (opts.startIntent === 'default-template') {
    queueMicrotask(() => {
      const ov = document.querySelector<HTMLElement>('.ed-startpick')
      if (ov) spToast(ov, t('No default layout yet — open a layout and choose “Use as default” under ⋯'))
    })
  }
  return choice
}

function startPage(o: { openCreate?: boolean; openFigure?: boolean; openIconset?: boolean } = {}): Promise<StartupChoice> {
  return new Promise((resolve) => {
    const api = window.slidomingoDesktop
    const overlay = div('ed-startpick')
    // focusable, so its keys (Enter, Escape) work before any tile has focus
    overlay.tabIndex = -1
    document.body.appendChild(overlay)
    overlay.focus()
    document.getElementById('slidomingo-splash')?.remove()

    const card = div('ed-startpick-card ed-sp-page')
    overlay.appendChild(card)

    const finish = (choice: StartupChoice) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      document.querySelector('.ed-sp-ctx')?.remove()
      resolve(choice)
    }

    // header
    const head = div('ed-sp-head')
    const mark = document.createElement('h1')
    mark.className = 'ed-sp-mark'
    mark.innerHTML = `${logoSvg(28, { className: 'ed-sp-logo' })}<span>${WORDMARK_HTML}</span>`
    const headActions = div('ed-sp-head-actions')
    if (api?.openDialog) {
      // ⌘/⌥-click: in a new window, like the in-app Recent list
      headActions.appendChild(spButton(ICONS.upload, t('Open…'), (ev) => void api.openDialog!({ newWindow: ev.metaKey || ev.altKey }), t('Open a deck from disk')))
    }
    // One search over everything on the page (recents, drafts, layouts),
    // shown once there is anything to search. Typing anywhere or ⌘F lands here.
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'ed-sp-search'
    search.placeholder = t('Search decks, figures and layouts')
    search.setAttribute('aria-label', t('Search decks, figures and layouts'))
    search.hidden = true
    search.addEventListener('input', () => applyFilter())
    head.append(mark, search, headActions)
    card.appendChild(head)

    // New deck | Continue, side by side and always the same size (styles.css
    // stacks them when narrow). Each says "No matches" for itself.
    const newCol = column('is-new', t('New deck'))
    const startRow = div('ed-sp-row')
    newCol.appendChild(startRow)
    const newNoMatch = noMatchNote()
    newCol.appendChild(newNoMatch)
    const contCol = column('is-continue', t('Continue'))
    const contSlot = div('ed-sp-contslot')
    const pinnedSection = section(t('Pinned'))
    pinnedSection.hidden = true
    const recentSection = section(t('Recent & drafts'))
    recentSection.hidden = true
    // First launch only (no recents, no drafts): the welcome, in the card.
    const contEmpty = div('ed-sp-empty')
    const wTitle = document.createElement('h3')
    wTitle.textContent = t('Welcome to BeeSlides')
    const wSub = document.createElement('p')
    wSub.textContent = t('Start a new deck — or drop a deck, a PowerPoint or a Markdown file anywhere on this page.')
    contEmpty.append(wTitle, wSub)
    if (api?.openDialog) {
      contEmpty.appendChild(spButton(ICONS.upload, t('Open…'), (ev) => void api.openDialog!({ newWindow: ev.metaKey || ev.altKey }), t('Open a deck from disk')))
    }
    contEmpty.hidden = true // until Recent is known to be empty
    const contNoMatch = noMatchNote()
    contCol.append(contEmpty, contSlot, pinnedSection, recentSection, contNoMatch)
    // Figure: its own column — New figure, then the figures to continue.
    const figCol = column('is-figure', t('Figure'))
    const figRow = div('ed-sp-row is-figure-sizes')
    const figContSlot = div('ed-sp-contslot')
    const figRecentSection = section(t('Recent figures'))
    figRecentSection.hidden = true
    const figEmpty = div('ed-sp-muted')
    figEmpty.textContent = t('No figures yet — saved and unsaved figures show up here.')
    figEmpty.hidden = true
    const figNoMatch = noMatchNote()
    // Icons: an icon set (one icon per slide, one style) or a single icon
    const iconSection = section(t('Icons'))
    const iconRow = div('ed-sp-row is-figure-sizes')
    iconSection.appendChild(iconRow)
    figCol.append(figRow, iconSection, figContSlot, figRecentSection, figEmpty, figNoMatch)
    const cols = div('ed-sp-cols')
    cols.append(newCol, contCol, figCol)
    card.append(cols)

    // --- New deck ----------------------------------------------------------
    // Only things a click turns into a deck. The default layout leads,
    // ahead of Blank (renderTemplates fills it).
    const defaultSlot = div('ed-sp-tmplslot')
    startRow.appendChild(defaultSlot)
    // A blank slide is a white page: a plain box fills any tile width, where a
    // fixed-width render would not once the grid stretches the column.
    const blankBox = thumbBox()
    blankBox.classList.add('is-blank')
    startRow.appendChild(startTile(blankBox, t('Blank'), t('One empty slide'), () => finish({ doc: newDoc(), isFresh: true })))
    const templateSlot = div('ed-sp-tmplslot')
    startRow.appendChild(templateSlot)
    // Shown when the layout list fails (renderTemplates) — Blank and the
    // imports still work, but "only Blank" should not look like "no layouts".
    const templateError = div('ed-sp-muted')
    templateError.textContent = t('Couldn’t load your layouts — restart the app')
    templateError.hidden = true
    newCol.appendChild(templateError)

    // Whole decks, slides and all. Each source two ways: Claude Code rebuilds
    // it natively (the AI flow card), or our converters bring it in at once.
    const canAi = !!api?.requestGenerate && !!api.getPathForFile
    const { line: importLine, items: importItems } = actionLine(t('Import'))
    const aiDeckBtn = spButton(ICONS.sparkle, t('PowerPoint with AI…'), () => void rebuildWithAi('deck'), t('Claude Code rebuilds a .pptx as a native, editable deck'))
    const deckFileBtn = spButton(ICONS.upload, t('From a file…'), () => void pickDeckFile(), t('Import a PowerPoint, Markdown or Quarto deck'))
    if (canAi) importItems.appendChild(aiDeckBtn)
    importItems.appendChild(deckFileBtn)
    // Layouts: making and managing them — not decks, so not tiles.
    const { line: layoutsLine, items: layoutsItems } = actionLine(t('Layouts'))
    const aiLayoutBtn = spButton(ICONS.sparkle, t('PowerPoint with AI…'), () => void rebuildWithAi('layout'), t('Claude Code rebuilds a PowerPoint’s design as a layout'))
    const layoutFileBtn = spButton(ICONS.upload, t('From a file…'), () => void pickLayoutFile(), t('Add a layout from a PowerPoint (.pptx, .potx) or a BeeSlides file'))
    if (api?.saveTemplate) {
      if (canAi) layoutsItems.appendChild(aiLayoutBtn)
      layoutsItems.appendChild(layoutFileBtn)
    }
    const createLink = linkButton('＋ ' + t('Create layout…'), () => openCreateFlow(overlay, card, finish))
    createLink.title = t('Empty, from a built-in slide type, or from a description')
    layoutsItems.appendChild(createLink)
    if (api?.openTemplatesFolder) layoutsItems.appendChild(linkButton(t('Layouts folder'), () => api.openTemplatesFolder()))
    // A finished deck to look at and take apart, bundled with the desktop app
    // (DECISIONS 2026-10-14). Every click opens a new, untitled copy.
    const { line: exampleLine, items: exampleItems } = actionLine(t('Example'))
    if (api?.getExampleDeck) {
      const exampleBtn = spButton(ICONS.slideshow, t('Example deck'), () => void openExample(), t('A finished deck to explore — opens as a new, untitled copy'))
      exampleItems.appendChild(exampleBtn)
      newCol.append(exampleLine)
    }
    newCol.append(importLine, layoutsLine)
    async function openExample() {
      if (busy) return
      const text = await api?.getExampleDeck?.()
      const doc = text ? parseDoc(text) : null
      if (!doc) { spToast(overlay, t('Couldn’t open the example deck')); return }
      finish({ doc, isFresh: true })
    }

    let busy = false
    /** Converting: the button says so and ignores clicks; a failure is a
     *  message on the page. */
    async function whileBusy(btn: HTMLElement | null, label: string, work: () => Promise<void>) {
      if (busy) return
      busy = true
      const span = btn?.querySelector(':scope > span')
      const prevLabel = span?.textContent ?? ''
      btn?.classList.add('is-busy')
      if (span) showLoading(span, label, 14)
      try {
        await work()
      } catch (err) {
        spToast(overlay, t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
      } finally {
        busy = false
        btn?.classList.remove('is-busy')
        if (span) span.textContent = prevLabel
      }
    }
    /** A deck import: it opens once converted. */
    const runImport = (btn: HTMLElement | null, work: () => Promise<Imported>) => whileBusy(btn, t('Importing…'), async () => {
      const { doc, report } = await work()
      finish({ doc, isFresh: true, report })
    })
    /** A PowerPoint, or a Markdown / Quarto source with its figures — from
     *  Import › From a file… or a drop. False when there is neither. */
    async function importDeckFiles(files: File[]): Promise<boolean> {
      const pptx = files.find((f) => PPTX_RE.test(f.name))
      if (pptx) { await runImport(deckFileBtn, () => importPptxFile(pptx)); return true }
      if (files.some((f) => MD_RE.test(f.name))) { await runImport(deckFileBtn, () => importMarkdownFiles(files)); return true }
      return false
    }
    async function pickDeckFile() {
      if (busy) return
      const files = await pickFiles('.pptx,.potx,.qmd,.md,.markdown,.rmd,image/*', true)
      if (files.length && !await importDeckFiles(files)) spToast(overlay, t('Pick a PowerPoint, Markdown or Quarto file'))
    }

    /** Layouts › From a file…: a PowerPoint's design, or a BeeSlides file
     *  (a layout or a deck) — added to the folder, named after the file. */
    async function pickLayoutFile() {
      if (busy) return
      const [file] = await pickFiles('.pptx,.potx,.html,.htm')
      if (!file) return
      const name = layoutNameFor(file.name)
      if (PPTX_RE.test(file.name)) {
        // what the file holds first: its masters and slide types, all or
        // only the used ones, and its slides as samples (buildPptxView)
        const { showStep, closeFlow } = openFlowCard(overlay, card)
        const end: CreateEnd = {
          file: true,
          label: t('Add layout'),
          done: async (doc, o) => {
            try {
              const stamped = stampAsTemplate(doc, { samples: o.samples })
              stamped.title = name
              await storeLayoutFile(stamped, name)
            } catch (err) {
              spToast(overlay, t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
              return false
            }
            closeFlow()
            layoutAdded(name)
            return true
          },
        }
        showStep(buildPptxView(file, closeFlow, end))
        return
      }
      await whileBusy(layoutFileBtn, t('Importing…'), async () => {
        await storeLayoutFile(await layoutDocFromSlidomingoFile(file), name)
        layoutAdded(name)
      })
    }
    function layoutAdded(name: string) {
      void renderTemplates()
      spToast(overlay, t('Added layout “{name}”', { name }))
    }

    /** PowerPoint with AI…: Claude Code rebuilds the file in the terminal
     *  panel — as a deck (Import) or as a layout (Layouts). Our own
     *  converter's draft goes along as its starting point; a file that one
     *  can't read still goes (Claude Code reads the .pptx itself). */
    async function rebuildWithAi(target: 'deck' | 'layout') {
      if (busy || !api?.requestGenerate || !api.getPathForFile) return
      const [file] = await pickFiles('.pptx,.potx')
      if (!file) return
      const sourcePath = api.getPathForFile(file)
      if (!sourcePath) { spToast(overlay, t('Couldn’t read {name}', { name: file.name })); return }
      let baseline: unknown
      await whileBusy(target === 'deck' ? aiDeckBtn : aiLayoutBtn, t('Reading…'), async () => {
        try {
          const result = await convertPptx(new Uint8Array(await file.arrayBuffer()), target === 'layout' ? { mode: 'template' } : undefined)
          if (target === 'layout') markMasters(result.doc as unknown as SlidomingoDoc)
          baseline = { doc: result.doc, report: result.report }
        } catch (err) {
          console.warn('[start page] no converter draft for the AI rebuild', err)
        }
      })
      const { showStep, closeFlow } = openFlowCard(overlay, card)
      const wrap = div('ed-startpick-flow-inner')
      showStep(wrap)
      const request: GenerateRequest = { kind: 'pptx', target, sourcePath, name: file.name, baseline }
      if (target === 'deck') {
        void startGenerate(request, wrap, closeFlow, {
          heading: t('Rebuilding your deck…'),
          working: t('Claude Code is rebuilding your deck in the terminal panel.'),
          use: t('Use this deck'),
          onUse: (doc) => finish({ doc, isFresh: true }),
        })
      } else {
        void startGenerate(request, wrap, closeFlow, {
          heading: t('Rebuilding your layout…'),
          working: t('Claude Code is rebuilding your layout in the terminal panel.'),
          use: t('Save this layout'),
          startOn: 'layouts',
          onUse: async (doc) => {
            const name = layoutNameFor(file.name)
            await saveLayoutFile(doc, name)
            closeFlow()
            layoutAdded(name)
          },
        })
      }
    }

    // --- drop a file anywhere on the page ------------------------------------
    // A deck opens (⌘/⌥ held: in a new window); a PowerPoint or Markdown
    // file is imported as a deck, like Import › From a file…. preventDefault
    // throughout, so the window never navigates to the dropped file.
    let dragDepth = 0
    const hasFiles = (ev: DragEvent) => !!ev.dataTransfer?.types.includes('Files')
    overlay.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return
      ev.preventDefault()
      dragDepth++
      overlay.classList.add('is-drop')
    })
    overlay.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    })
    overlay.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('is-drop') }
    })
    overlay.addEventListener('drop', (ev) => {
      ev.preventDefault()
      dragDepth = 0
      overlay.classList.remove('is-drop')
      const files = Array.from(ev.dataTransfer?.files ?? [])
      if (files.length) void onDropFiles(files, ev.metaKey || ev.altKey)
    })
    async function onDropFiles(files: File[], newWindow: boolean) {
      if (await importDeckFiles(files)) return
      const deck = files.find((f) => DECK_RE.test(f.name))
      const path = deck && api?.getPathForFile ? api.getPathForFile(deck) : ''
      if (path && api?.openDocument) { void api.openDocument(path, { newWindow }); return }
      spToast(overlay, t('Drop a BeeSlides deck, a PowerPoint or a Markdown file'))
    }

    const panel = div('ed-sp-panel')
    panel.hidden = true
    overlay.appendChild(panel)

    /** The default layout (desktop settings.ts), once renderTemplates ran. */
    let defaultMeta: TemplateMeta | null = null
    const isDefault = (meta: TemplateMeta) => defaultMeta?.path === meta.path

    async function renderTemplates() {
      if (!api?.listTemplateMeta) return
      let metas: TemplateMeta[] = []
      // A rejection here is usually a stale desktop main process that
      // predates the IPC handler (electron-vite dev does not reload main) —
      // say so, rather than silently leaving only Blank.
      const noDefault = (err: unknown) => { console.warn('[start page] default layout lookup failed', err); return null }
      try {
        ;[metas, defaultMeta] = await Promise.all([api.listTemplateMeta(), api.getDefaultTemplate?.().catch(noDefault) ?? Promise.resolve(null)])
        templateError.hidden = true
      } catch (err) {
        console.warn('[start page] layout list failed', err)
        templateError.hidden = false
      }
      templateSlot.replaceChildren()
      defaultSlot.replaceChildren()
      for (const meta of metas.sort((a, b) => a.name.localeCompare(b.name))) {
        const box = thumbBox()
        queueThumb(meta.path, box)
        const sub = t('{n} slide types', { n: String(meta.layoutCount) })
        // A click starts the deck (one slide of its default slide type); the
        // rest — another first slide type, samples, Rename… — is in Options…,
        // from the ⋯ or a right-click.
        const tile = startTile(box, meta.name, sub, () => void createFrom(meta, { includeSamples: false }))
        tile.title = meta.path
        tile.dataset.search = meta.name.toLowerCase()
        tile.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          showContextMenu(ev.clientX, ev.clientY, [
            [t('Options…'), () => void openTemplatePanel(meta)] as const,
            ...(api.editTemplate ? [[t('Edit layout'), () => editTemplate(meta, ev.metaKey || ev.altKey)] as const] : []),
            defaultToggle(meta),
          ])
        })
        // A sibling, not a child: a button can't hold a button.
        const wrap = div('ed-sp-tmpl')
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'ed-sp-tile-opts'
        more.textContent = '⋯'
        more.title = t('More options')
        more.setAttribute('aria-label', `${t('More options')}: ${meta.name}`)
        more.addEventListener('click', () => void openTemplatePanel(meta))
        wrap.append(tile, more)
        if (isDefault(meta)) {
          tile.classList.add('is-default')
          const badge = document.createElement('span')
          badge.className = 'ed-sp-badge'
          badge.textContent = t('Default')
          tile.querySelector('.ed-sp-tile-name')!.prepend(badge)
          defaultSlot.appendChild(wrap)
        } else {
          templateSlot.appendChild(wrap)
        }
      }
      if (metas.length) search.hidden = false
      applyFilter()
    }
    const templatesReady = renderTemplates()

    /** Edit layout: the layout (template) file itself in a template window —
     *  in place of this page, like every other pick here (⌘/⌥: a new window). */
    function editTemplate(meta: TemplateMeta, newWindow = false) {
      void api?.editTemplate?.(meta.path, { replace: !newWindow }).then((ok) => {
        if (!ok) spToast(overlay, t('Couldn’t read the layout “{name}”', { name: meta.name }))
      })
    }

    /** "Use as default" / "Stop using as default" for `meta`. */
    function defaultToggle(meta: TemplateMeta): readonly [string, () => void] {
      return isDefault(meta)
        ? [t('Stop using as default'), () => void api?.setDefaultTemplate?.(null).then(() => renderTemplates())] as const
        : [t('Use as default'), () => void api?.setDefaultTemplate?.(meta.path).then(() => renderTemplates())] as const
    }

    /** A new deck from a layout file; `firstLayoutId` = its first slide's type. */
    async function createFrom(meta: TemplateMeta, o: { includeSamples: boolean; firstLayoutId?: string; raw?: string }) {
      const raw = o.raw ?? await api?.loadTemplate?.(meta.path).catch(() => null)
      const deck = raw ? instantiateTemplate(raw, { includeSamples: o.includeSamples, name: meta.name, firstLayoutId: o.firstLayoutId }) : null
      if (deck) finish({ doc: deck, isFresh: true })
      else spToast(overlay, t('Couldn’t read the layout “{name}”', { name: meta.name }))
    }

    async function openTemplatePanel(meta: TemplateMeta) {
      panel.replaceChildren()
      panel.hidden = false
      overlay.classList.add('has-panel')
      panelOpener = document.activeElement instanceof HTMLElement && card.contains(document.activeElement) ? document.activeElement : null
      const close = closePanel
      // A click on the tile already made a deck; this panel is for the rest.
      const top = div('ed-sp-panel-head')
      const titles = div('ed-sp-panel-titles')
      const kicker = div('ed-sp-kicker')
      kicker.textContent = t('Layout options')
      const h = document.createElement('h2')
      h.textContent = meta.name
      titles.append(kicker, h)
      const x = spButton('', '✕', close, t('Close'))
      x.classList.add('ed-sp-x')
      top.append(titles, x)
      panel.appendChild(top)
      const loading = div('ed-sp-muted')
      showLoading(loading, t('Loading…'))
      panel.appendChild(loading)

      const raw = await api?.loadTemplate?.(meta.path)
      const doc = raw ? parseDoc(raw) : null
      loading.remove()
      if (!raw || !doc) {
        const err = div('ed-sp-muted')
        err.textContent = t('Couldn’t read the layout “{name}”', { name: meta.name })
        panel.appendChild(err)
        return
      }
      // A master (parentOnly) is never a slide's type, so it is not offered.
      const pickable = pickableSlideTypes(doc)
      const kinds = div('ed-sp-muted')
      kinds.textContent = t('{n} slide types', { n: String(pickable.length) })
      panel.appendChild(kinds)
      const strip = div('ed-sp-filmstrip')
      // Pick the first slide's type: the layout's default, pre-selected.
      let firstLayoutId: string | undefined = pickable.length ? defaultSlideType(doc).id : undefined
      const items: HTMLElement[] = []
      for (const ly of pickable) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'ed-sp-film-item'
        item.setAttribute('aria-pressed', String(ly.id === firstLayoutId))
        item.title = t('Start with this slide type')
        item.appendChild(renderThumbnail(effectiveLayout(doc, ly), doc, 148))
        const name = div('ed-sp-film-name')
        name.textContent = ly.name ?? t('Untitled')
        item.appendChild(name)
        item.addEventListener('click', () => {
          firstLayoutId = ly.id
          for (const it of items) it.setAttribute('aria-pressed', String(it === item))
        })
        item.addEventListener('dblclick', () => void createFrom(meta, { includeSamples, firstLayoutId: ly.id, raw }))
        items.push(item)
        strip.appendChild(item)
      }
      if (!pickable.length) {
        const item = div('ed-sp-film-item')
        item.appendChild(renderThumbnail(doc.slides[0], doc, 148))
        strip.appendChild(item)
      }
      panel.appendChild(strip)

      let includeSamples = false
      if (meta.samples && meta.slideCount > 0) {
        const lab = document.createElement('label')
        lab.className = 'ed-sp-check'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        // the sample slides replace the one starter slide, so its type is moot
        cb.addEventListener('change', () => { includeSamples = cb.checked; strip.classList.toggle('is-moot', includeSamples) })
        lab.append(cb, document.createTextNode(' ' + t('Include {n} sample slides', { n: String(meta.slideCount) })))
        panel.appendChild(lab)
      }
      const actions = div('ed-sp-panel-actions')
      const create = document.createElement('button')
      create.type = 'button'
      create.className = 'ed-startpick-btn'
      create.textContent = t('Create')
      create.addEventListener('click', () => void createFrom(meta, { includeSamples, firstLayoutId, raw }))
      const more = document.createElement('div')
      more.className = 'ed-sp-more'
      const moreB = spButton('', '⋯', () => moreMenu.classList.toggle('open'), t('More'))
      const moreMenu = div('ed-sp-menu')
      moreMenu.append(
        ...(api?.editTemplate ? [menuItem(t('Edit layout'), () => { moreMenu.classList.remove('open'); editTemplate(meta) })] : []),
        menuItem(t('Rename…'), async () => {
          const next = prompt(t('New name for the layout'), meta.name)?.trim()
          if (!next || next === meta.name) return
          const path = await api?.renameTemplate?.(meta.path, next)
          if (!path) { alert(t('Couldn’t rename — a layout with that name may already exist.')); return }
          close()
          void renderTemplates()
        }),
        ...(api?.setDefaultTemplate ? [menuItem(defaultToggle(meta)[0], () => { close(); defaultToggle(meta)[1]() })] : []),
        menuItem(t('Reveal in Finder'), () => void api?.revealTemplate?.(meta.path)),
        menuItem(t('Delete…'), async () => {
          // main asks for confirmation (and moves the file to the Trash)
          if (await api?.deleteTemplate(meta.path)) { close(); void renderTemplates() }
        }),
      )
      more.append(moreB, moreMenu)
      actions.append(more, create)
      panel.appendChild(actions)
      create.focus()
    }

    let panelOpener: HTMLElement | null = null
    function closePanel() {
      panel.hidden = true
      overlay.classList.remove('has-panel')
      if (panelOpener?.isConnected) panelOpener.focus()
      else overlay.focus()
      panelOpener = null
    }

    // A paper figure: one canvas at a physical size, exported as vector PDF/SVG.
    const figBox = thumbBox()
    figBox.classList.add('is-blank')
    figBox.innerHTML = '<svg viewBox="0 0 80 50" width="70%" height="70%" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="8" width="22" height="14" rx="2"/><circle cx="58" cy="30" r="10"/><path d="M30 15h14a8 8 0 0 1 8 8v0" marker-end="none"/><path d="M52 21l0 0M47 24l5-1.5-1.5 5"/></svg>'
    figBox.style.color = 'var(--muted, #888)'
    // One click per journal column width (its own default height); Custom
    // opens the full chooser (width + height).
    for (const p of FIGURE_PRESETS) {
      const box = thumbBox()
      box.classList.add('is-blank')
      figRow.appendChild(startTile(box, t(p.label), p.hint, () => finish({ doc: newFigureDoc(p.width, p.height, 'mm'), isFresh: true })))
    }
    figRow.appendChild(startTile(figBox, t('Custom size…'), t('Vector PDF/SVG for papers'), () => openFigureFlow(overlay, card, finish)))
    const iconThumb = (markup: string) => {
      const box = thumbBox()
      box.classList.add('is-blank')
      box.innerHTML = markup
      box.style.color = 'var(--muted, #888)'
      return box
    }
    iconRow.appendChild(startTile(
      iconThumb('<svg viewBox="0 0 80 50" width="70%" height="70%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="7"/><path d="M23 23l5 5"/><rect x="38" y="11" width="14" height="14" rx="3"/><path d="M62 12v12M56 18h12"/><path d="M12 34h14v9H12zM45 32l7 11h-14zM62 33a5 5 0 1 0 0 10a5 5 0 1 0 0-10"/></svg>'),
      t('Icon set…'), t('Many icons, one style — drawn with AI'), () => openIconsetFlow(overlay, card, finish)))
    iconRow.appendChild(startTile(
      iconThumb('<svg viewBox="0 0 80 50" width="70%" height="70%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="27" y="12" width="26" height="26" rx="4" stroke-dasharray="2 3"/><circle cx="40" cy="25" r="7"/></svg>'),
      t('Single icon'), t('One 24 × 24 icon, exported as SVG'), () => finish({ doc: titled(newIconsetDoc(), t('Untitled icon')), isFresh: true })))
    // --- Continue: the latest deck, Pinned, Recent & drafts -------------------
    // The latest unpinned deck or draft is the big tile; pinned decks get
    // their own row under it (they never age out of Recent); the rest follow
    // as Today / Yesterday / This week / Older. Re-run after Pin/Unpin.
    let hasRecents = false
    let recentsKnown = !api // (no desktop API: nothing to wait for)
    async function renderRecents() {
      if (!api) return
      let [recent, drafts] = await Promise.all([
        api.listRecent().catch(() => []),
        api.listDrafts?.().catch(() => []) ?? Promise.resolve([]),
      ])
      const toItem = (r: { path: string; openedAt: number; pinned?: boolean; figure?: boolean }): RecentItem => {
        const { name, folder } = splitPath(r.path)
        return { path: r.path, name: fileLabel(name), folder, at: r.openedAt, draft: false, pinned: !!r.pinned }
      }
      const draftItem = (d: { path: string; title: string | null; mtimeMs: number }): RecentItem =>
        ({ path: d.path, name: d.title || t('Untitled'), folder: '', at: d.mtimeMs, draft: true, pinned: false })
      const closedDrafts = drafts.filter((d) => !d.open)
      // icon sets are drawings too: they continue in the Figure column
      const drawing = (r: { figure?: boolean; iconset?: boolean }) => !!(r.figure || r.iconset)
      const figures = [
        ...recent.filter(drawing).map(toItem),
        ...closedDrafts.filter(drawing).map(draftItem),
      ].sort((a, b) => b.at - a.at)
      recent = recent.filter((r) => !drawing(r))
      const pinned = recent.filter((r) => r.pinned).map(toItem)
      const items: RecentItem[] = [
        ...recent.filter((r) => !r.pinned).map(toItem),
        ...closedDrafts.filter((d) => !drawing(d)).map(draftItem),
      ].sort((a, b) => b.at - a.at)
      contSlot.replaceChildren()
      for (const sec of [pinnedSection, recentSection]) {
        for (const el of Array.from(sec.children)) if (!el.classList.contains('ed-sp-section-head')) el.remove()
      }
      for (const el of Array.from(figRecentSection.children)) if (!el.classList.contains('ed-sp-section-head')) el.remove()
      figContSlot.replaceChildren()
      figEmpty.hidden = figures.length > 0
      const [figFirst, ...figRest] = figures
      if (figFirst) figContSlot.appendChild(recentTile(figFirst, true))
      if (figRest.length) {
        const grid = div('ed-sp-grid')
        for (const it of figRest) grid.appendChild(recentTile(it, false))
        figRecentSection.appendChild(grid)
      }
      hasRecents = pinned.length + items.length > 0
      recentsKnown = true
      if (!hasRecents && !figures.length) { applyFilter(); return }
      search.hidden = false

      if (pinned.length) {
        const grid = div('ed-sp-grid')
        for (const it of pinned) grid.appendChild(recentTile(it, false))
        pinnedSection.appendChild(grid)
      }
      const [first, ...rest] = items
      if (first) contSlot.appendChild(recentTile(first, true))
      if (rest.length) {
        const grid = div('ed-sp-grid')
        let bucket = ''
        for (const it of rest) {
          const b = dayBucket(it.at)
          if (b !== bucket) {
            bucket = b
            const h = div('ed-sp-group')
            h.textContent = b
            grid.appendChild(h)
          }
          grid.appendChild(recentTile(it, false))
        }
        recentSection.appendChild(grid)
      }
      applyFilter()
    }
    const recentsReady = renderRecents()

    /** Shows only what matches the search (name + folder, `data-search`);
     *  Blank and the Import / Layouts lines, with nothing to match, hide
     *  while searching. Day headings and subsections left empty go with
     *  them; a card never hides — it says "No matches" instead. */
    function applyFilter() {
      const q = search.value.trim().toLowerCase()
      /** Hides the non-matching tiles in `root`; how many are left. A
       *  layout tile hides with its wrapper (the ⋯ beside it). */
      const filter = (root: HTMLElement) => {
        let visible = 0
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('.ed-sp-tile, .ed-sp-recent'))) {
          const item = el.closest<HTMLElement>('.ed-sp-tmpl') ?? el
          item.hidden = !!q && !(el.dataset.search ?? '').includes(q)
          if (!item.hidden) visible++
        }
        for (const h of Array.from(root.querySelectorAll<HTMLElement>('.ed-sp-group'))) {
          let n = h.nextElementSibling as HTMLElement | null
          let shown = false
          while (n && !n.classList.contains('ed-sp-group')) { if (!n.hidden) shown = true; n = n.nextElementSibling as HTMLElement | null }
          h.hidden = !shown
        }
        return visible
      }
      let continuing = 0
      for (const sec of [contSlot, pinnedSection, recentSection]) {
        const n = filter(sec)
        sec.hidden = n === 0
        continuing += n
      }
      const starting = filter(startRow)
      const figRest = filter(figRecentSection)
      const figBig = filter(figContSlot)
      const iconTiles = filter(iconRow)
      iconSection.hidden = iconTiles === 0
      const figs = filter(figRow) + iconTiles + figRest + figBig
      figRecentSection.hidden = figRest === 0
      figContSlot.hidden = figBig === 0
      figNoMatch.hidden = !q || figs > 0
      importLine.hidden = layoutsLine.hidden = !!q
      contEmpty.hidden = !!q || !recentsKnown || hasRecents
      contNoMatch.hidden = !q || continuing > 0
      newNoMatch.hidden = !q || starting > 0
    }

    function recentTile(it: RecentItem, big: boolean): HTMLElement {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = big ? 'ed-sp-recent ed-sp-continue' : 'ed-sp-recent'
      tile.title = it.draft ? t('Draft — kept automatically') : it.path
      tile.dataset.search = `${it.name} ${it.folder}`.toLowerCase()
      const box = thumbBox()
      queueThumb(it.path, box)
      // (no "Continue" kicker on the big tile: the column is already titled so)
      const info = div('ed-sp-recent-info')
      if (it.pinned) tile.classList.add('is-pinned')
      const name = div('ed-sp-recent-name')
      name.textContent = it.name
      const meta = div('ed-sp-recent-meta')
      meta.textContent = [relTimeMs(it.at), it.draft ? '' : shortFolder(it.folder)].filter(Boolean).join(' · ')
      info.append(name, meta)
      if (it.draft) {
        const badge = document.createElement('span')
        badge.className = 'ed-sp-badge'
        badge.textContent = t('Draft')
        name.prepend(badge)
      }
      tile.append(box, info)
      tile.addEventListener('click', (ev) => void api?.openDocument?.(it.path, { newWindow: ev.metaKey || ev.altKey }))
      tile.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        showContextMenu(ev.clientX, ev.clientY, [
          ...(it.draft || !api?.pinRecent ? [] : [[it.pinned ? t('Unpin') : t('Pin'), () => {
            api.pinRecent!(it.path, !it.pinned)
            void renderRecents()
          }] as const]),
          ...(it.draft ? [] : [[t('Reveal in Finder'), () => api?.revealPath?.(it.path)] as const]),
          ...(it.draft ? [] : [[t('Remove from list'), () => { api?.removeRecent?.(it.path); void renderRecents() }] as const]),
          ...(it.draft ? [[t('Delete draft…'), async () => {
            if (!confirm(t('Delete the draft “{name}”? This can’t be undone.', { name: it.name }))) return
            if (await api?.deleteDraft?.(it.path)) void renderRecents()
          }] as const] : []),
        ])
      })
      return tile
    }

    // --- keyboard ---------------------------------------------------------------
    // On the document (capture), so it works whatever has focus: the overlay
    // itself (tabindex -1), a tile, or nothing after a tile went away.
    const tiles = () => Array.from(card.querySelectorAll<HTMLElement>('.ed-sp-tile, .ed-sp-recent'))
      .filter((el) => el.offsetParent !== null)
    function onKey(ev: KeyboardEvent) {
      if (!overlay.isConnected) return
      const active = document.activeElement as HTMLElement | null
      const typing = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)
      const onPage = card.style.display !== 'none' && panel.hidden
      if (ev.key === 'Escape') {
        // innermost first: context menu, layout panel, a flow card, search
        const ctx = document.querySelector('.ed-sp-ctx')
        const flowBack = overlay.querySelector<HTMLElement>('.ed-startpick-flowcard .ed-startpick-back')
        if (ctx) ctx.remove()
        else if (!panel.hidden) closePanel()
        else if (card.style.display === 'none' && flowBack) flowBack.click()
        else if (search.value) { search.value = ''; applyFilter(); if (active === search) overlay.focus() }
        else return
        ev.preventDefault()
        ev.stopPropagation()
        return
      }
      if (!onPage) return
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f' && !search.hidden) {
        ev.preventDefault()
        search.focus()
        search.select()
        return
      }
      if (typing) {
        if (active === search && ev.key === 'ArrowDown') { ev.preventDefault(); tiles()[0]?.focus() }
        if (active === search && ev.key === 'Enter') { ev.preventDefault(); tiles()[0]?.click() }
        return
      }
      // a letter or digit: straight into the search (the key lands in it)
      if (ev.key.length === 1 && ev.key !== ' ' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !search.hidden) {
        search.focus()
        return
      }
      const all = tiles()
      // a template's ⋯ steps as its tile does
      const at = active ? all.indexOf(active.closest('.ed-sp-tmpl')?.querySelector<HTMLElement>('.ed-sp-tile') ?? active) : -1
      const nothingFocused = !active || active === overlay || active === document.body
      if (ev.key === 'Enter' && nothingFocused && defaultMeta) {
        // nothing focused: a deck from the default layout
        ev.preventDefault()
        void createFrom(defaultMeta, { includeSamples: false })
        return
      }
      const next = arrowTarget(all, at, ev.key)
      if (next) { ev.preventDefault(); next.focus() }
    }
    document.addEventListener('keydown', onKey, true)

    // Focus where a keyboard user would start: Continue for a returning user,
    // else the default layout (or the first New deck tile) — unless the user
    // already moved.
    void Promise.all([recentsReady, templatesReady]).then(() => {
      if (!overlay.isConnected || document.activeElement !== overlay) return
      const first = card.querySelector<HTMLElement>('.ed-sp-continue:not([hidden])')
        ?? card.querySelector<HTMLElement>('.ed-sp-recent:not([hidden])')
        ?? tiles().find((el) => startRow.contains(el))
      first?.focus({ preventScroll: true })
    })

    if (o.openCreate) openCreateFlow(overlay, card, finish)
    if (o.openFigure) openFigureFlow(overlay, card, finish)
    if (o.openIconset) openIconsetFlow(overlay, card, finish)
  })
}

/** ←/→ step through the tiles in on-screen (DOM) order; ↑/↓ jump to the
 *  nearest tile in the row above/below, by position. `at` < 0 = none focused
 *  yet: any arrow starts at the first tile. */
function arrowTarget(all: HTMLElement[], at: number, key: string): HTMLElement | null {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key) || !all.length) return null
  if (at < 0) return all[0]
  if (key === 'ArrowLeft') return all[at - 1] ?? null
  if (key === 'ArrowRight') return all[at + 1] ?? null
  const cur = all[at].getBoundingClientRect()
  const cx = cur.left + cur.width / 2
  const down = key === 'ArrowDown'
  const beyond = all.filter((el, i) => {
    if (i === at) return false
    const r = el.getBoundingClientRect()
    return down ? r.top >= cur.bottom - 2 : r.bottom <= cur.top + 2
  })
  // within the same column (New deck / Continue) while there is a row to go
  // to; past its end, into the other one (stacked, in a narrow window)
  const col = all[at].closest('.ed-sp-col')
  const same = beyond.filter((el) => el.closest('.ed-sp-col') === col)
  const rows = same.length ? same : beyond
  if (!rows.length) return null
  // the nearest row, then the tile in it closest to this one's centre
  const edge = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return down ? r.top : -r.bottom }
  const rowEdge = Math.min(...rows.map(edge))
  const row = rows.filter((el) => edge(el) - rowEdge < 8)
  const dist = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - cx) }
  return row.reduce((a, b) => (dist(b) < dist(a) ? b : a))
}

/** One side of the page (New deck, Continue): a card with its own heading. */
function column(kind: string, title: string): HTMLElement {
  const s = document.createElement('section')
  s.className = `ed-sp-col ${kind}`
  const h = document.createElement('h2')
  h.className = 'ed-sp-col-head'
  h.textContent = title
  s.appendChild(h)
  return s
}

/** A labelled line of actions under the New deck tiles (Import, Layouts):
 *  the actions go in `items`, which wraps beside the label. */
function actionLine(label: string): { line: HTMLElement; items: HTMLElement } {
  const line = div('ed-sp-line')
  const l = div('ed-sp-line-label')
  l.textContent = label
  const items = div('ed-sp-line-items')
  line.append(l, items)
  return { line, items }
}

/** A card's own "No matches" while searching. */
function noMatchNote(): HTMLElement {
  const el = div('ed-sp-muted ed-sp-nomatch')
  el.textContent = t('No matches')
  el.hidden = true
  return el
}

function section(title: string): HTMLElement {
  const s = document.createElement('section')
  s.className = 'ed-sp-section'
  const head = div('ed-sp-section-head')
  const h = document.createElement('h2')
  h.textContent = title
  head.appendChild(h)
  s.appendChild(head)
  return s
}

function thumbBox(): HTMLElement {
  return div('ed-sp-thumb')
}

function startTile(thumb: HTMLElement, label: string, sub: string, onClick: () => void): HTMLElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'ed-sp-tile'
  let frame = thumb
  if (!thumb.classList.contains('ed-sp-thumb')) { frame = thumbBox(); frame.appendChild(thumb) }
  const name = div('ed-sp-tile-name')
  name.textContent = label
  const subEl = div('ed-sp-tile-sub')
  subEl.textContent = sub
  item.append(frame, name, subEl)
  item.addEventListener('click', onClick)
  return item
}

function spButton(icon: string, label: string, onClick: (ev: MouseEvent) => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-sp-btn'
  b.innerHTML = icon
  if (label) b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

function linkButton(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-startpick-folderlink'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function menuItem(label: string, run: () => void): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', () => { (b.parentElement as HTMLElement | null)?.classList.remove('open'); run() })
  return b
}

function showContextMenu(x: number, y: number, entries: ReadonlyArray<readonly [string, () => void]>) {
  document.querySelector('.ed-sp-ctx')?.remove()
  if (!entries.length) return
  const m = div('ed-sp-menu ed-sp-ctx open')
  for (const [label, run] of entries) m.appendChild(menuItem(label, () => { m.remove(); run() }))
  m.style.left = `${Math.min(x, window.innerWidth - 200)}px`
  m.style.top = `${Math.min(y, window.innerHeight - 40 * entries.length)}px`
  document.body.appendChild(m)
  const off = (ev: Event) => { if (!m.contains(ev.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off, true) } }
  document.addEventListener('pointerdown', off, true)
}

/** "Q3 review.beeslides.html" → "Q3 review". */
function fileLabel(name: string): string {
  return stripDocExt(name)
}

/** "~/Documents/Talks" rather than the full absolute path. */
function shortFolder(folder: string): string {
  const m = folder.match(/^\/Users\/[^/]+(\/.*)?$/)
  return m ? '~' + (m[1] ?? '') : folder
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function backButton(onClick: () => void): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-startpick-back'
  b.textContent = t('← Back')
  b.addEventListener('click', onClick)
  return b
}

/** How a Create layout option ends. `file`: in a layout (template) file in
 *  the templates folder (desktop) — the final button says `label`, or
 *  "Create layout". `done` resolves false when nothing happened (the name
 *  prompt was cancelled or the write failed), so the step stays up. */
interface CreateEnd {
  file: boolean
  label?: string
  done: (doc: SlidomingoDoc, o: CreateOpts) => Promise<boolean>
}
interface CreateOpts {
  /** Pre-fills the layout name (a picked file's stem, a designed deck's title). */
  name?: string
  /** Keep the doc's slides as the layout's sample slides. */
  samples: boolean
}

/**
 * The "Create a layout" chooser: replaces the main picker card in place
 * (hidden, not removed, so cancelling restores it untouched) with a small
 * stack of steps — the chooser, then whichever path was picked. Both "new
 * layout" entry points open it (＋ Create layout…, File ▸ New Layout…).
 *
 * On desktop every option ends in a layout FILE, like Empty: the doc it
 * built goes through templatewindow.ts's createTemplateFrom (name prompt,
 * templates folder, this window becomes the layout's template window). A
 * built-in-slide-type layout keeps its slide types only; a described one
 * keeps its slides as samples. Without template files (no desktop API) the
 * options hand off a normal fresh deck, same as the "Blank" tile. Importing
 * a layout from a PowerPoint is the Layouts line's own buttons.
 */
function openCreateFlow(overlay: HTMLElement, card: HTMLElement, finish: (choice: StartupChoice) => void): void {
  const end: CreateEnd = canCreateTemplateFiles()
    ? { file: true, done: (doc, o) => createTemplateFrom(doc, { name: o.name, samples: o.samples, onError: (m) => spToast(overlay, m) }) }
    : { file: false, done: async (doc) => { finish({ doc, isFresh: true }); return true } }
  const { showStep, closeFlow } = openFlowCard(overlay, card)
  const showChooser = () => {
    const h1 = document.createElement('h1')
    h1.textContent = t('Create a layout')
    const sub = document.createElement('p')
    sub.textContent = t('Choose how you want to start.')
    const wrap = div('ed-startpick-flow-inner')
    wrap.append(h1, sub, buildChoiceGrid((kind) => {
      if (kind === 'empty') void createNewTemplate({ onError: (m) => spToast(overlay, m) })
      else if (kind === 'layout') showStep(buildLayoutAccentView(showChooser, end))
      else showStep(buildDescribeView(showChooser, end))
    }), backButton(closeFlow))
    showStep(wrap)
  }
  showChooser()
}

/** New Figure: pick a journal column width (or a custom size in mm); the
 *  height is editable for every preset. Ends in a figure doc (model.ts newFigureDoc). */
function openFigureFlow(overlay: HTMLElement, card: HTMLElement, finish: (choice: StartupChoice) => void): void {
  const { showStep, closeFlow } = openFlowCard(overlay, card)
  const h1 = document.createElement('h1')
  h1.textContent = t('New figure')
  const sub = document.createElement('p')
  sub.textContent = t('Pick the width it will have on the page. Everything you draw exports as vector PDF or SVG at exactly this size.')
  const wrap = div('ed-startpick-flow-inner')
  const hRow = document.createElement('label')
  hRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:13px'
  const hIn = document.createElement('input')
  hIn.type = 'number'
  hIn.min = '10'
  hIn.max = '600'
  hIn.value = '60'
  hIn.style.width = '72px'
  hRow.append(Object.assign(document.createElement('span'), { textContent: t('Height (mm)') }), hIn)
  const create = (width: number, height: number) => {
    const doc = newFigureDoc(width, height, 'mm')
    finish({ doc, isFresh: true })
  }
  const height = () => Math.max(10, Math.min(600, Number(hIn.value) || 60))
  const grid = div('ed-startpick-choice-grid')
  const choice = (label: string, desc: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-startpick-choice'
    const name = div('ed-startpick-choice-name')
    name.textContent = label
    const d = div('ed-startpick-choice-desc')
    d.textContent = desc
    b.append(name, d)
    b.addEventListener('click', onClick)
    grid.appendChild(b)
  }
  for (const p of FIGURE_PRESETS) choice(t(p.label), p.hint, () => create(p.width, height()))
  const cw = document.createElement('input')
  cw.type = 'number'
  cw.min = '10'
  cw.max = '600'
  cw.value = '100'
  cw.style.cssText = 'width:72px;margin-left:8px'
  const custom = document.createElement('div')
  custom.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:14px'
  const go = spButton(ICONS.plus, t('Create custom size'), () => create(Math.max(10, Math.min(600, Number(cw.value) || 100)), height()))
  custom.append(Object.assign(document.createElement('span'), { textContent: t('Custom width (mm)') }), cw, go)
  wrap.append(h1, sub, hRow, grid, custom, backButton(closeFlow))
  showStep(wrap)
}

const titled = (doc: SlidomingoDoc, title: string): SlidomingoDoc => { doc.title = title; return doc }

/** New icon set: a name, what the set is for (the brief Claude draws from)
 *  and the icons to start with. Ends in an icon-set doc (model.ts newIconsetDoc). */
function openIconsetFlow(overlay: HTMLElement, card: HTMLElement, finish: (choice: StartupChoice) => void): void {
  const { showStep, closeFlow } = openFlowCard(overlay, card)
  const h1 = document.createElement('h1')
  h1.textContent = t('New icon set')
  const sub = document.createElement('p')
  sub.textContent = t('One icon per slide, all in one style. Say what you need in your own words: Claude plans the icons, you check the plan, then Claude draws them — or draw them yourself.')
  const wrap = div('ed-startpick-flow-inner')
  const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement) => {
    const l = document.createElement('label')
    l.style.cssText = 'display:flex;flex-direction:column;gap:6px;font-size:13px'
    input.className = 'ed-startpick-textarea'
    input.style.cssText = 'min-height:0;margin-bottom:14px'
    l.append(Object.assign(document.createElement('span'), { textContent: label }), input)
    return l
  }
  const name = document.createElement('input')
  name.placeholder = t('e.g. Forensics')
  const brief = document.createElement('textarea')
  brief.rows = 2
  brief.placeholder = t('e.g. Digital forensics for a training course: clean outline icons, friendly, not scary')
  const ai = !!window.slidomingoDesktop?.sendAgentPrompt
  const request = document.createElement('textarea')
  request.rows = 4
  request.placeholder = t('e.g. think about 12 icons for a digital forensics course: evidence handling, analysis tools, reporting')
  const go = spButton(ICONS.plus, t('Create icon set'), () => {
    const doc = titled(newIconsetDoc({ brief: brief.value.trim() || undefined }), name.value.trim() || t('Untitled icon set'))
    const ask = request.value.trim()
    finish({ doc, isFresh: true, ...(ai && ask ? { planRequest: ask } : {}) })
  })
  wrap.append(h1, sub, field(t('Name'), name), field(t('What is the set for, and how should it look?'), brief),
    ...(ai ? [field(t('Which icons do you need? (Claude plans them; optional)'), request)] : []), go, backButton(closeFlow))
  showStep(wrap)
  name.focus()
}

/** A flow card in place of the start page (hidden, not removed, so leaving
 *  restores it untouched). `closeFlow` goes back to the start page. */
function openFlowCard(overlay: HTMLElement, card: HTMLElement): { showStep: (el: HTMLElement) => void; closeFlow: () => void } {
  const flow = div('ed-startpick-card ed-startpick-flowcard')
  card.style.display = 'none'
  overlay.appendChild(flow)
  return {
    showStep: (el) => { flow.innerHTML = ''; flow.appendChild(el) },
    closeFlow: () => { flow.remove(); card.style.display = '' },
  }
}

/** A short message at the bottom of the start page. */
function spToast(overlay: HTMLElement, text: string): void {
  overlay.querySelector('.ed-sp-toast')?.remove()
  const el = div('ed-sp-toast')
  el.setAttribute('role', 'status')
  el.textContent = text
  overlay.appendChild(el)
  setTimeout(() => el.remove(), 5000)
}

/** The "Create a layout" sub-paths. */
type Path = 'empty' | 'layout' | 'describe'

function buildChoiceGrid(onPick: (kind: Path) => void): HTMLElement {
  const grid = div('ed-startpick-choice-grid')
  const choices: Array<[string, string, Path]> = [
    // desktop only: every path makes a layout file there, and without
    // template files there is no empty-deck option of its own (that is Blank)
    ...(canCreateTemplateFiles()
      ? [[t('Empty layout'), t('Saved straight into your layouts folder — design its slide types in the Layout Manager.'), 'empty'] as [string, string, Path]]
      : []),
    [t('Start from a built-in slide type'), t('Choose a built-in slide type and an accent color, then adjust it in the editor.'), 'layout'],
    [t('Describe it'), t('Tell Claude Code what you want in the terminal panel — it designs a starting deck for you.'), 'describe'],
  ]
  for (const [label, desc, kind] of choices) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-startpick-choice'
    const name = div('ed-startpick-choice-name')
    name.textContent = label
    const d = div('ed-startpick-choice-desc')
    d.textContent = desc
    b.append(name, d)
    b.addEventListener('click', () => onPick(kind))
    grid.appendChild(b)
  }
  return grid
}

/** The built-in default accent literal every builtinLayouts() bar/kicker is
 *  drawn with — see recolorLayoutAccent. */
const DEFAULT_LAYOUT_ACCENT: string = BRAND.honeyOnLight

/**
 * Recolors a freshly-instantiated built-in layout's accent bits (the title/
 * section bars, the section-divider's kicker text) to the user's chosen
 * accent. Deliberately narrow: only a fill/color EXACTLY equal to the
 * built-in default accent literal is touched — never the `#FFFFFF`/`#1D1119`
 * background or text literals, since `#1D1119` is simultaneously "default
 * text color" AND the section-divider layout's own background; a broader
 * literal-swap would conflate the two and wrongly recolor that layout's dark
 * background.
 */
function recolorLayoutAccent(slide: Slide, accent: string): void {
  for (const el of slide.elements) {
    if (el.type === 'shape' && el.fill === DEFAULT_LAYOUT_ACCENT) el.fill = accent
    else if (el.type === 'text' && el.color === DEFAULT_LAYOUT_ACCENT) el.color = accent
  }
}

const ACCENT_PRESETS = [DEFAULT_LAYOUT_ACCENT, '#E23D72', '#2F6FED', '#16A34A', '#DC2626', '#9333EA', '#0EA5E9']

/** Path A: pick a built-in slide type + an accent color, no AI involved.
 *  Mirrors editor.ts's openLayoutPicker idiom (a grid of renderThumbnail
 *  cards over builtinLayouts) but at the whole-deck level. */
function buildLayoutAccentView(back: () => void, end: CreateEnd): HTMLElement {
  const wrap = div('ed-startpick-flow-inner')
  const h1 = document.createElement('h1')
  h1.textContent = t('Start from a built-in slide type')
  wrap.appendChild(h1)

  const sizeDoc = newDoc()
  const layouts = builtinLayouts(sizeDoc.size)
  const grid = div('ed-startpick-layout-grid')
  wrap.appendChild(grid)

  let selectedLayout: Slide | null = null
  const items: HTMLElement[] = []
  for (const ly of layouts) {
    const item = div('ed-startpick-layout-item')
    item.appendChild(renderThumbnail(ly, sizeDoc, 150 - 2 * (2 + 6)))
    const name = div('ed-startpick-layout-name')
    name.textContent = ly.name ?? t('Untitled')
    item.appendChild(name)
    item.addEventListener('click', () => {
      selectedLayout = ly
      for (const it of items) it.classList.remove('is-selected')
      item.classList.add('is-selected')
      useBtn.disabled = false
    })
    grid.appendChild(item)
    items.push(item)
  }

  const accentLabel = div('ed-startpick-flow-label')
  accentLabel.textContent = t('Accent color (optional)')
  wrap.appendChild(accentLabel)
  const swatchRow = div('ed-startpick-swatches')
  wrap.appendChild(swatchRow)

  let selectedAccent: string | null = null
  const swatchButtons: HTMLElement[] = []
  const selectAccent = (color: string, btn: HTMLElement | null) => {
    selectedAccent = color
    for (const b of swatchButtons) b.classList.remove('is-on')
    btn?.classList.add('is-on')
  }
  for (const c of ACCENT_PRESETS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-startpick-swatch'
    b.style.background = c
    b.title = c
    b.addEventListener('click', () => selectAccent(c, b))
    swatchRow.appendChild(b)
    swatchButtons.push(b)
  }
  const custom = document.createElement('input')
  custom.type = 'color'
  custom.className = 'ed-startpick-customcolor'
  custom.value = DEFAULT_LAYOUT_ACCENT
  custom.title = t('Custom accent color')
  custom.addEventListener('input', () => selectAccent(custom.value, null))
  swatchRow.appendChild(custom)

  const actions = div('ed-startpick-flow-actions')
  actions.appendChild(backButton(back))
  const useBtn = createButton(end, t('Use this slide type'), () => {
    if (!selectedLayout) return
    const doc = newDoc()
    if (selectedAccent) {
      doc.theme.accent = selectedAccent
      doc.theme.chartPalette = deriveChartPalette(selectedAccent)
    }
    if (end.file) {
      // a layout: every built-in slide type, in the accent, the picked one
      // as its default
      doc.layouts = builtinLayouts(doc.size)
      if (selectedAccent) for (const ly of doc.layouts) recolorLayoutAccent(ly, selectedAccent)
      doc.defaultLayoutId = selectedLayout.id
      return end.done(doc, { samples: false })
    }
    const slide = instantiateLayout(selectedLayout)
    if (selectedAccent) recolorLayoutAccent(slide, selectedAccent)
    doc.slides = [slide]
    return end.done(doc, { samples: false })
  })
  actions.appendChild(useBtn)
  wrap.appendChild(actions)
  return wrap
}

/** A generate request sent to the main process — kept structural (no shared
 *  import) since preload/main only pass it through as plain JSON; main
 *  (terminalPanel.ts isValidGenerateRequest) checks it. `sourcePath` is the
 *  picked .pptx's own path (webUtils.getPathForFile); `baseline` is our
 *  converter's `{ doc, report }` for it, Claude Code's starting point. */
type GenerateRequest =
  | { kind: 'describe'; description: string }
  | { kind: 'pptx'; target: 'deck' | 'layout'; sourcePath: string; name: string; baseline?: unknown }

/** What one generate flow says and does: its heading, the status once
 *  Claude Code is on it, the button that takes the result, and what taking
 *  it means (open a deck, save a layout). `startOn` = the list shown first. */
interface GenerateLabels {
  heading: string
  working: string
  use: string
  startOn?: 'slides' | 'layouts'
  onUse: (doc: SlidomingoDoc) => void | Promise<void>
}

/**
 * Looser sibling of model.ts's `parseDoc`, used ONLY to drive the live
 * generating-view preview — never the finalize gate (that stays on the
 * strict parser, unchanged). Claude writes generate-result.json repeatedly
 * while still designing, so a snapshot can legitimately have a theme and no
 * slides yet (Slide Master first), or a slide mid-write missing fields
 * `renderSlide`/`renderThumbnail` will later dereference. This accepts
 * anything with a usable `size`/`theme` and coerces `slides`/`layouts` to
 * `[]` instead of rejecting the whole object, so the stage/filmstrip can
 * render whatever is already valid even while the rest is still in flux. */
function asPreviewableDoc(raw: unknown): SlidomingoDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  const size = doc.size as { width?: unknown; height?: unknown } | undefined
  if (!size || typeof size.width !== 'number' || typeof size.height !== 'number' || size.width <= 0 || size.height <= 0) return null
  const theme = doc.theme as { background?: unknown; color?: unknown } | undefined
  if (!theme || typeof theme.background !== 'string' || typeof theme.color !== 'string') return null
  return {
    ...doc,
    slides: Array.isArray(doc.slides) ? doc.slides : [],
    layouts: Array.isArray(doc.layouts) ? doc.layouts : undefined,
  } as unknown as SlidomingoDoc
}

/**
 * The AI flows' shared tail (Describe it; PowerPoint with AI… as a deck or a
 * layout): fires the request, then shows a live, read-only preview of the
 * deck as Claude Code writes it — a Slides/Slide Master tab pair, a big
 * stage render of the selected one, and a filmstrip of the rest — plus a
 * `labels.use` button that only enables once generate-result.json holds a
 * strictly valid document. Re-arms on every later result (the user can keep
 * iterating with Claude Code before deciding).
 */
async function startGenerate(
  request: GenerateRequest,
  container: HTMLElement,
  back: () => void,
  labels: GenerateLabels,
): Promise<void> {
  const flowcard = container.closest('.ed-startpick-flowcard')
  flowcard?.classList.add('ed-startpick-flowcard-gen')
  // showStep() only ever clears flow.innerHTML, never its class list — so
  // this widening modifier must be stripped by hand before handing control
  // back to a step that isn't this one, or the chooser/layout/pptx views
  // would stay widened after "← Back".
  const backToChooser = () => {
    flowcard?.classList.remove('ed-startpick-flowcard-gen')
    back()
  }

  container.innerHTML = ''
  const h1 = document.createElement('h1')
  h1.textContent = labels.heading
  container.appendChild(h1)
  const status = document.createElement('p')
  status.className = 'ed-startpick-flow-hint'
  status.textContent = t('Starting Claude Code…')
  container.appendChild(status)

  const tabs = div('ed-startpick-gen-tabs')
  container.appendChild(tabs)
  const stage = div('ed-startpick-gen-stage')
  container.appendChild(stage)
  const filmstrip = div('ed-startpick-gen-filmstrip')
  container.appendChild(filmstrip)

  const actions = div('ed-startpick-flow-actions')
  actions.appendChild(backButton(backToChooser))
  const loadBtn = document.createElement('button')
  loadBtn.type = 'button'
  loadBtn.className = 'ed-startpick-btn'
  loadBtn.textContent = labels.use
  loadBtn.disabled = true
  actions.appendChild(loadBtn)
  container.appendChild(actions)

  let pendingDoc: SlidomingoDoc | null = null
  loadBtn.addEventListener('click', () => {
    if (!pendingDoc || loadBtn.disabled) return
    loadBtn.disabled = true
    Promise.resolve(labels.onUse(pendingDoc)).catch((err: unknown) => {
      status.textContent = t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) })
    }).finally(() => { if (loadBtn.isConnected) loadBtn.disabled = false })
  })

  const view: GenView = { list: labels.startOn ?? 'slides', index: 0 }
  let lastGoodDoc: SlidomingoDoc | null = null

  const rerenderTabs = () => renderGenTabs(tabs, lastGoodDoc?.layouts?.length ?? 0, view, () => {
    if (lastGoodDoc) renderGenAll(lastGoodDoc, view, stage, filmstrip)
  })
  rerenderTabs()
  for (const el of [stage, filmstrip]) {
    const empty = div('ed-startpick-gen-empty')
    empty.textContent = t('Waiting for Claude Code to start designing…')
    el.appendChild(empty)
  }

  window.slidomingoDesktop?.onGenerateResult?.((raw) => {
    let doc: SlidomingoDoc | null
    try {
      doc = parseDoc(JSON.stringify(raw))
    } catch {
      doc = null
    }
    if (doc) {
      pendingDoc = doc
      loadBtn.disabled = false
      status.textContent = t('A new version is ready.')
    } else {
      status.textContent = t('Still designing — the terminal panel has the details.')
    }

    const preview = asPreviewableDoc(raw)
    if (!preview) return
    const prevSlideCount = lastGoodDoc?.slides.length ?? 0
    const prevLayoutCount = lastGoodDoc?.layouts?.length ?? 0
    lastGoodDoc = preview
    if (view.list === 'slides' && preview.slides.length > prevSlideCount) view.index = preview.slides.length - 1
    if (view.list === 'layouts' && (preview.layouts?.length ?? 0) > prevLayoutCount) view.index = (preview.layouts?.length ?? 1) - 1
    rerenderTabs()
    renderGenAll(preview, view, stage, filmstrip)
  })

  if (!window.slidomingoDesktop?.requestGenerate) return
  try {
    const result = await window.slidomingoDesktop.requestGenerate(request)
    status.textContent = result.status === 'launched'
      ? labels.working
      : t('Your request is saved — ask Claude Code (already open in the terminal panel) to check generate-request.json.')
  } catch (err) {
    status.textContent = t('Couldn’t start Claude Code: {m}', { m: err instanceof Error ? err.message : String(err) })
  }
}

/** Which list the generating-view stage/filmstrip currently shows. */
type GenView = { list: 'slides' | 'layouts'; index: number }

/** Same reasoning as TILE_THUMB_WIDTH above: `.ed-startpick-gen-film-item`'s
 *  own border+padding (1px + 4px, each side) eats into its 140px box before
 *  the thumbnail starts. */
const FILM_THUMB_WIDTH = 140 - 2 * (1 + 4)

/** Label for one item in the generating-view Slides/Slide-Master list —
 *  follows the same dual convention already used elsewhere in this app
 *  (real sidebar 1-based numbers for slides, `.ed-startpick-layout-name`'s
 *  `name ?? Untitled` for layouts) rather than inventing a third style. */
function genItemLabel(list: GenView['list'], item: Slide, index: number): string {
  return list === 'slides' ? t('Slide {n}', { n: index + 1 }) : (item.name ?? t('Untitled'))
}

function genList(doc: SlidomingoDoc, view: GenView): Slide[] {
  return view.list === 'slides' ? doc.slides : (doc.layouts ?? [])
}

function renderGenAll(doc: SlidomingoDoc, view: GenView, stage: HTMLElement, filmstrip: HTMLElement): void {
  renderGenStage(stage, doc, view)
  renderGenFilmstrip(filmstrip, doc, view, () => renderGenStage(stage, doc, view))
}

/** Segmented Slides / Slide Master toggle. Slide Master stays `disabled`
 *  (not hidden) while `doc.layouts` is empty so it doesn't reflow into place
 *  the moment layouts appear. */
function renderGenTabs(tabs: HTMLElement, layoutsCount: number, view: GenView, onSwitch: () => void): void {
  tabs.innerHTML = ''
  const entries: Array<[GenView['list'], string]> = [
    ['slides', t('Slides')],
    ['layouts', t('Slide Master')],
  ]
  for (const [list, label] of entries) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-startpick-gen-tab' + (view.list === list ? ' is-active' : '')
    b.textContent = label
    b.disabled = list === 'layouts' && layoutsCount === 0
    b.addEventListener('click', () => {
      if (view.list === list) return
      view.list = list
      view.index = 0
      onSwitch()
    })
    tabs.appendChild(b)
  }
}

/** Big live render of the selected slide/layout, with a caption naming it
 *  (same text as its filmstrip cell) inserted just above the stage box —
 *  answers "which one am I looking at" without needing the filmstrip
 *  visible below the fold. Wrapped in try/catch: this is the first caller
 *  fed continuously-in-flux, not-yet-complete AI-authored JSON (e.g. an
 *  element with a `type` but not yet its type-specific fields mid-write) —
 *  on a throw, leave whatever was already on the stage in place rather than
 *  flashing it blank. */
function renderGenStage(stage: HTMLElement, doc: SlidomingoDoc, view: GenView): void {
  const list = genList(doc, view)
  const effectiveIndex = view.index < list.length ? view.index : list.length - 1
  const item = list[effectiveIndex]
  let label = stage.previousElementSibling as HTMLElement | null
  if (!label?.classList.contains('ed-startpick-gen-stage-label')) {
    label = div('ed-startpick-gen-stage-label')
    stage.before(label)
  }
  if (!item) {
    label.textContent = ''
    stage.innerHTML = ''
    const empty = div('ed-startpick-gen-empty')
    empty.textContent = view.list === 'slides'
      ? t('Waiting for the first slide…')
      : t('Waiting for the slide master…')
    stage.appendChild(empty)
    return
  }
  label.textContent = genItemLabel(view.list, item, effectiveIndex)
  try {
    const rendered = renderThumbnail(item, doc, stage.clientWidth || 640)
    stage.innerHTML = ''
    stage.appendChild(rendered)
  } catch {
    // Mid-write snapshot — keep showing the last successful render.
  }
}

/** One small thumbnail per item in the active list. Each render is wrapped
 *  individually so one malformed mid-write slide can't blank the rest of an
 *  otherwise-fine filmstrip. */
function renderGenFilmstrip(filmstrip: HTMLElement, doc: SlidomingoDoc, view: GenView, onSelect: () => void): void {
  const list = genList(doc, view)
  filmstrip.innerHTML = ''
  if (list.length === 0) {
    const empty = div('ed-startpick-gen-empty')
    empty.textContent = view.list === 'slides' ? t('No slides yet') : t('No slide types yet')
    filmstrip.appendChild(empty)
    return
  }
  list.forEach((item, i) => {
    const cell = div('ed-startpick-gen-film-item' + (i === view.index ? ' is-selected' : ''))
    try {
      cell.appendChild(renderThumbnail(item, doc, FILM_THUMB_WIDTH))
      const name = div('ed-startpick-gen-film-name')
      name.textContent = genItemLabel(view.list, item, i)
      cell.appendChild(name)
    } catch {
      cell.classList.add('ed-startpick-gen-empty')
      cell.textContent = '…'
    }
    cell.addEventListener('click', () => {
      view.index = i
      onSelect()
      for (const sib of Array.from(filmstrip.children)) sib.classList.remove('is-selected')
      cell.classList.add('is-selected')
    })
    filmstrip.appendChild(cell)
  })
}

/** Path B: describe it, Claude Code designs it — the terminal panel + `claude`
 *  CLI mechanism, not a direct API call. */
function buildDescribeView(back: () => void, end: CreateEnd): HTMLElement {
  const wrap = div('ed-startpick-flow-inner')
  const h1 = document.createElement('h1')
  h1.textContent = t('Describe your layout')
  wrap.appendChild(h1)
  const hint = document.createElement('p')
  hint.className = 'ed-startpick-flow-hint'
  hint.textContent = t('Claude Code designs a starting deck for you in the terminal panel. You decide when it’s ready to load.')
  wrap.appendChild(hint)

  const textarea = document.createElement('textarea')
  textarea.className = 'ed-startpick-textarea'
  textarea.placeholder = t('e.g. A clean, minimal deck for a quarterly sales review, blue and white, with a title slide and a two-column layout for comparisons.')
  wrap.appendChild(textarea)

  const actions = div('ed-startpick-flow-actions')
  actions.appendChild(backButton(back))
  const genBtn = document.createElement('button')
  genBtn.type = 'button'
  genBtn.className = 'ed-startpick-btn'
  genBtn.textContent = t('Generate with Claude Code')
  genBtn.addEventListener('click', () => {
    const description = textarea.value.trim()
    if (!description) return
    void startGenerate({ kind: 'describe', description }, wrap, back, {
      heading: t('Designing your layout…'),
      working: t('Claude Code is designing your layout in the terminal panel.'),
      use: end.file ? (end.label ?? t('Create layout')) : t('Use this design'),
      // a layout keeps the designed slides as samples (the template
      // window's "Save these slides as samples" switch turns them off)
      onUse: async (doc) => {
        const title = doc.title?.trim()
        await end.done(doc, { samples: true, name: title && title !== 'Untitled' ? title : undefined })
      },
    })
  })
  actions.appendChild(genBtn)
  wrap.appendChild(actions)
  return wrap
}

/** A step's final button: the end's label, disabled while `run` is busy
 *  (the name prompt is open, the file is being written). */
function createButton(end: CreateEnd, deckLabel: string, run: () => Promise<unknown> | void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-startpick-btn'
  b.textContent = end.label ?? (end.file ? t('Create layout') : deckLabel)
  b.disabled = true
  let busy = false
  b.addEventListener('click', async () => {
    if (busy) return
    busy = true
    try { await run() } finally { busy = false }
  })
  return b
}

/** "Q3 review.pptx" → "Q3 review" — a layout name pre-fill. */
function fileStem(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

/** Layouts › From a file… with a PowerPoint: what the file holds (its
 *  masters and slide types, the example slides), then what to take — all
 *  slide types or only the used ones, the slides as samples or one starter
 *  slide. The same structural convertPptx as editor.ts's importPowerPoint. */
function buildPptxView(file: File, back: () => void, end: CreateEnd): HTMLElement {
  const wrap = div('ed-startpick-flow-inner')
  const h1 = document.createElement('h1')
  h1.textContent = t('Add a layout from {name}', { name: file.name })
  wrap.appendChild(h1)
  const hint = document.createElement('p')
  hint.className = 'ed-startpick-flow-hint'
  hint.textContent = t('Choose what to take from it. Masters stay parents of their slide types.')
  wrap.appendChild(hint)

  const status = document.createElement('p')
  status.className = 'ed-startpick-flow-hint'
  wrap.appendChild(status)

  const preview = div('ed-startpick-pptx-preview')
  preview.hidden = true
  const thumbSlot = div('ed-startpick-pptx-thumb')
  preview.appendChild(thumbSlot)
  // What is in the file, and what to take: PowerPoint's own structure
  // (masters heading their slide types), all types or only the used ones,
  // and the file's slides as samples.
  const summary = div('ed-startpick-pptx-summary')
  preview.appendChild(summary)
  wrap.appendChild(preview)

  const actions = div('ed-startpick-flow-actions')
  actions.appendChild(backButton(back))
  let converted: { tpl: SlidomingoDoc; deck: SlidomingoDoc } | null = null
  let convertedName = ''
  let onlyUsed = false
  let keepSamples = false
  const useBtn = createButton(end, t('Add layout'), () => {
    if (!converted) return undefined
    const doc = pptxTemplateDoc(converted.tpl, converted.deck, { onlyUsed, samples: keepSamples })
    return end.done(doc, { samples: keepSamples, name: convertedName })
  })
  actions.appendChild(useBtn)
  wrap.appendChild(actions)

  /** The summary line, the two choices and the master → types tree. */
  function renderSummary() {
    summary.replaceChildren()
    if (!converted) return
    const { tpl, deck } = converted
    const used = usedLayoutIds(deck)
    const all = pickableSlideTypes(tpl)
    const usedTypes = all.filter((l) => used.has(l.id))
    const masters = (tpl.layouts ?? []).filter((l) => l.parentOnly)
    const n = deck.slides.length
    const line = document.createElement('p')
    line.className = 'ed-startpick-pptx-counts'
    const parts = [
      masters.length === 1 ? t('1 master') : t('{n} masters', { n: masters.length }),
      t('{n} slide types', { n: String(all.length) }),
    ]
    if (n) parts.push(t('{n} example slides (they use {m} types)', { n, m: usedTypes.length }))
    line.textContent = parts.join(' · ')
    summary.appendChild(line)

    if (n && usedTypes.length && usedTypes.length < all.length) {
      const group = div('ed-startpick-pptx-choice')
      const radio = (label: string, value: boolean) => {
        const l = document.createElement('label')
        l.className = 'ed-sp-check'
        const r = document.createElement('input')
        r.type = 'radio'
        r.name = 'pptx-types'
        r.checked = onlyUsed === value
        r.addEventListener('change', () => { if (r.checked) { onlyUsed = value; renderSummary() } })
        l.append(r, document.createTextNode(' ' + label))
        return l
      }
      group.append(
        radio(t('All {n} slide types', { n: all.length }), false),
        radio(t('Only the {n} the example slides use', { n: usedTypes.length }), true),
      )
      summary.appendChild(group)
    }
    if (n) {
      const l = document.createElement('label')
      l.className = 'ed-sp-check'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = keepSamples
      cb.addEventListener('change', () => { keepSamples = cb.checked })
      l.append(cb, document.createTextNode(' ' + t('Keep the {n} example slides as samples', { n })))
      summary.appendChild(l)
    }

    // Each master heads the types it holds, as in PowerPoint's master view.
    const taken = onlyUsed ? new Set(usedTypes.map((l) => l.id)) : null
    const groups: Array<{ name: string; types: Slide[] }> = []
    const other: Slide[] = []
    let cur: { name: string; types: Slide[] } | null = null
    for (const { layout: l, depth } of slideTypeRows(tpl)) {
      if (depth === 0) {
        cur = null
        if (l.parentOnly) { cur = { name: l.name || t('Untitled'), types: [] }; groups.push(cur); continue }
      }
      if (l.parentOnly || (taken && !taken.has(l.id))) continue
      ;(cur ? cur.types : other).push(l)
    }
    if (other.length) groups.push({ name: t('Other slide types'), types: other })
    const tree = div('ed-startpick-pptx-tree')
    for (const g of groups) {
      if (!g.types.length) continue
      const box = div('ed-startpick-pptx-master')
      const h = div('ed-startpick-pptx-mastername')
      h.textContent = `${g.name} — ${g.types.length === 1 ? t('1 slide type') : t('{n} slide types', { n: String(g.types.length) })}`
      const p = div('ed-startpick-pptx-types')
      p.textContent = g.types.map((l) => l.name || t('Untitled')).join(' · ')
      box.append(h, p)
      tree.appendChild(box)
    }
    summary.appendChild(tree)
  }

  async function handlePick(file: File) {
    showLoading(status, t('Importing {name}…', { name: file.name }))
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // template mode: EVERY layout under every master comes in (a .potx
      // usually has no slides at all). Deck mode alongside says which of
      // them the file's slides use, and gives those slides for samples:
      // both modes mint the same `pptx-master-<m>`/`pptx-layout-<k>` ids and
      // content-hashed asset keys, so the two docs line up without a remap.
      const [result, deckResult] = await Promise.all([
        convertPptx(bytes, { mode: 'template' }),
        convertPptx(bytes, { mode: 'deck' }).catch(() => null),
      ])
      if (!result.doc.layouts?.length) {
        status.textContent = t('{name} has no slide designs to import', { name: file.name })
        return
      }
      // The extracted designs land in doc.layouts as a master → layout tree;
      // without samples the layout gets one fresh slide of its default slide
      // type, re-minted with the editor's own starterSlide rather than
      // trusting the converter's placeholder slide id.
      const doc = {
        ...result.doc,
        version: FORMAT_VERSION, // the converter's OutDoc carries '1.0.0' (a string) — normalize to the format's numeric version
        docId: newDocId(),
        modified: new Date().toISOString(),
      } as unknown as SlidomingoDoc
      markMasters(doc)
      doc.slides = [starterSlide(doc)]
      const deck = (deckResult?.doc ?? { slides: [], layouts: [] }) as unknown as SlidomingoDoc
      converted = { tpl: doc, deck }
      convertedName = fileStem(file.name)
      onlyUsed = false
      keepSamples = false
      renderSummary()
      status.textContent = ''
      thumbSlot.innerHTML = ''
      // Preview the default DESIGN with its whole master chain composited,
      // mirroring how the Layout Manager's own "Slide types" grid renders
      // each card (layoutmanager.ts renderTypesGrid).
      thumbSlot.appendChild(renderThumbnail(effectiveLayout(doc, defaultSlideType(doc)), doc, 220))
      preview.hidden = false
      useBtn.disabled = false
    } catch (err) {
      status.textContent = t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) })
    }
  }

  void handlePick(file)
  return wrap
}

/** Mark every slide type that others descend from as a master
 *  (`parentOnly`): a .pptx master is where the chrome is designed, never a
 *  slide's own type — PowerPoint's New Slide gallery does not offer it. */
function markMasters(doc: SlidomingoDoc): void {
  const parents = new Set((doc.layouts ?? []).map((l) => l.parentId).filter(Boolean))
  for (const l of doc.layouts ?? []) if (parents.has(l.id)) l.parentOnly = true
}

/** The slide types a deck-mode conversion kept: the ones its slides use
 *  (deck mode drops the rest), masters aside. */
function usedLayoutIds(deck: SlidomingoDoc): Set<string> {
  const parents = new Set((deck.layouts ?? []).map((l) => l.parentId).filter(Boolean))
  return new Set((deck.layouts ?? []).filter((l) => !parents.has(l.id)).map((l) => l.id))
}

/** The template the import makes: the template-mode designs — all of them,
 *  or only the used ones and their masters — and one starter slide, or the
 *  file's own slides as samples (the deck-mode slides, whose `layoutId`s
 *  already name the template's types; their pictures merged in). */
function pptxTemplateDoc(tpl: SlidomingoDoc, deck: SlidomingoDoc, o: { onlyUsed: boolean; samples: boolean }): SlidomingoDoc {
  const doc: SlidomingoDoc = JSON.parse(JSON.stringify(tpl))
  if (o.onlyUsed) {
    const keep = new Set<string>()
    const used = usedLayoutIds(deck)
    for (const l of doc.layouts ?? []) if (used.has(l.id)) for (const a of ancestorChain(doc, l)) keep.add(a.id)
    doc.layouts = (doc.layouts ?? []).filter((l) => keep.has(l.id))
    if (doc.defaultLayoutId && !keep.has(doc.defaultLayoutId)) doc.defaultLayoutId = defaultSlideType(doc).id
  }
  const ids = new Set((doc.layouts ?? []).map((l) => l.id))
  if (o.samples && deck.slides.length) {
    doc.slides = JSON.parse(JSON.stringify(deck.slides)) as Slide[]
    for (const s of doc.slides) if (s.layoutId && !ids.has(s.layoutId)) delete s.layoutId
    doc.assets = { ...(deck.assets ?? {}), ...(doc.assets ?? {}) }
  } else {
    doc.slides = [starterSlide(doc)]
  }
  return doc
}
