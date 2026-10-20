// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Self-saving: a BeeSlides file writes itself back to disk with updated data.
//
// At boot (before the app mutates the DOM) we deep-clone the document. On save
// we swap the clone's data block content for the current model JSON and
// serialize the clone back to an HTML string — byte-for-byte the same app
// shell, new document inside. TiddlyWiki pioneered this trick.

import { type KernelDoc, canonicalJson, unsupportedFeatures, UnsupportedFeaturesError } from './doc.ts'
import { appConfig } from './app.ts'
import {
  assetId, externalizeAssets, fontRule, imageRule, parseStoreCss, pruneIdMemo, resolveAssets, storeClass,
  storeRefsIn, mayHoldStoreRefs, STORE_ATTR, STORE_ID, MEDIA_POSTER_ATTR, MEDIA_SRC_ATTR,
} from './assetstore.ts'
import { DOC_EXT, hasDocExt, stripDocExt } from './docext.ts'
import {
  LEGACY_DOC_BLOCK_ID, LEGACY_MEDIA_POSTER_ATTR, LEGACY_MEDIA_SRC_ATTR, LEGACY_PREVIEW_ATTR, LEGACY_STATIC_ATTR,
  LEGACY_STORE_ID, isEncFormat,
} from './legacynames.ts'

export { canonicalJson, registerKnownFeatures, UnsupportedFeaturesError } from './doc.ts'
export { resolveDocText } from './assetstore.ts'

const DATA_BLOCK_ID = 'beeslides-doc'

/** The doc block of a page or shell, under either name (legacynames.ts). */
const docBlockOf = (root: Document): HTMLElement | null =>
  root.getElementById(DATA_BLOCK_ID) ?? root.getElementById(LEGACY_DOC_BLOCK_ID)
// Split so the literal never appears in the bundle (it would terminate the
// inline <script> that carries this very code inside a built BeeSlides file).
const SCRIPT_CLOSE = '</scr' + 'ipt>'

/**
 * DOM the runtime injects at boot and that must NEVER reach a saved file.
 *
 * capturePristine() clones the live document, and the compressed shell's
 * loader has already inflated the app stylesheet into a <style> by then (see
 * scripts/postbuild-compress.mjs). Serializing the clone as-is wrote that
 * ~100KB of CSS back as PLAINTEXT — and the next boot inflated the payload and
 * appended another copy, so every save grew the file by another 100KB, forever.
 * The CSS ships deflated in the #beeslides-rt-css payload for a reason; the saved
 * file must carry it exactly once, compressed.
 *
 * So: anything injected before the pristine capture carries this attribute and
 * is stripped from every serialized shell. The kernel does not care what the
 * node is — only that the app declared it runtime-owned.
 */
const TRANSIENT_SELECTOR = '[data-beeslides-transient]'

let pristine: Document | null = null

/** Call first thing at boot, before any DOM mutation. */
export function capturePristine() {
  pristine = document.cloneNode(true) as Document
}

/**
 * Use `html` — a complete built app shell — as the pristine copy instead of
 * the live page. For hosts whose live page is NOT a shippable shell: the
 * desktop app in dev mode runs Vite's index.html, which must never be spliced
 * into a real deck, so it hands over the built single-file shell instead.
 * Returns false (pristine unchanged) when `html` doesn't parse to something
 * carrying the doc block, so a caller can refuse to write rather than save a
 * broken file.
 */
export function adoptPristineHtml(html: string): boolean {
  if (typeof DOMParser === 'undefined') return false
  let parsed: Document
  try { parsed = new DOMParser().parseFromString(html, 'text/html') } catch { return false }
  if (!docBlockOf(parsed)) return false
  pristine = parsed
  return true
}

/**
 * The document block's text, with store refs resolved against THIS page's
 * asset store (kernel/src/assetstore.ts). Must run before the app removes
 * the static layer: a video's bytes may live on the layer's own element.
 */
export function readEmbeddedDoc(): string | null {
  const block = docBlockOf(document)
  const text = block?.textContent?.trim()
  if (!text) return null
  if (!mayHoldStoreRefs(text)) return text
  let json: unknown
  try { json = JSON.parse(text) } catch { return text }
  if (isEncFormat((json as { format?: unknown } | null)?.format)) return text
  const { doc, dangling } = resolveAssets(json, readStore(document))
  if (dangling.length) console.warn(`slidomingo: ${dangling.length} stored asset(s) missing from this file`, dangling)
  return JSON.stringify(doc)
}

/** id → data: URI for every byte a parsed file (live page or shell clone)
 *  stores: the store <style>, and the static layer's self-carrying media. */
function readStore(root: Document): Map<string, string> {
  const store = new Map<string, string>()
  const style = root.getElementById(STORE_ID) ?? root.getElementById(LEGACY_STORE_ID)
  if (style) parseStoreCss(style.textContent ?? '', store)
  const media = `[${MEDIA_SRC_ATTR}],[${MEDIA_POSTER_ATTR}],[${LEGACY_MEDIA_SRC_ATTR}],[${LEGACY_MEDIA_POSTER_ATTR}]`
  for (const el of Array.from(root.querySelectorAll(media))) {
    const srcId = el.getAttribute(MEDIA_SRC_ATTR) ?? el.getAttribute(LEGACY_MEDIA_SRC_ATTR)
    const posterId = el.getAttribute(MEDIA_POSTER_ATTR) ?? el.getAttribute(LEGACY_MEDIA_POSTER_ATTR)
    const src = el.getAttribute('src')
    const poster = el.getAttribute('poster')
    if (srcId && src && !store.has(srcId)) store.set(srcId, src)
    if (posterId && poster && !store.has(posterId)) store.set(posterId, poster)
  }
  return store
}

/**
 * Extra plaintext blocks the app wants written into every saved shell —
 * language packs today (docs/i18n-packs.md), whatever else later. The kernel
 * stays ignorant of what they mean: it is told an id, a type and a JSON body,
 * and guarantees only that they survive a save the same way #beeslides-doc does.
 *
 * The full set is re-declared on every serialize, so dropping one from the
 * list removes it from the next saved file — that is how "remove from this
 * file" works without a second API.
 */
export interface ShellBlock {
  id: string
  type: string
  /** JSON text; `<` is escaped on write exactly as the doc block's is */
  body: string
  attrs?: Record<string, string>
}
let shellBlocks: () => ShellBlock[] = () => []
let managedTypes: string[] = []

/**
 * Register the provider consulted on every serialize, and the block types it
 * OWNS. Call once, at boot.
 *
 * The types are declared rather than inferred from what the provider returns,
 * because the empty list is meaningful: "this file should carry no language
 * pack" has to clear the blocks the file arrived with, and a set derived from
 * the blocks about to be written would be empty exactly then — leaving the
 * last removed pack in the file (it would come back on the next open).
 */
export function registerShellBlocks(fn: () => ShellBlock[], types: string[]): void {
  shellBlocks = fn
  managedTypes = types
}

/** Every extra block currently in THIS document (as loaded from disk). */
export function readShellBlocks(type: string): Array<{ id: string; body: string; el: Element }> {
  return Array.from(document.querySelectorAll(`script[type="${type}"]`)).map((el) => ({
    id: el.id,
    body: (el.textContent ?? '').trim(),
    el,
  }))
}

/**
 * Serialize into an app shell. `body` is the data block's text when the
 * caller already has it (an encryption envelope); null means "plaintext
 * `doc`", which is where the asset store applies: the JSON is written with
 * refs to the bytes the store and static layer carry.
 */
function serializeBody(shell: Document, envelope: string | null, doc: KernelDoc): string {
  // The reader gate's last line of defence (kernel/src/doc.ts): a document
  // this build does not fully understand is never written, whichever path
  // asked. The app refuses earlier and says why; this is the kernel refusing
  // to take its word for it, because a write here would silently drop
  // whatever the newer writer put in the file.
  const missing = unsupportedFeatures(doc)
  if (missing.length) throw new UnsupportedFeaturesError(missing)

  const clone = shell.cloneNode(true) as Document

  // Runtime-injected DOM is not part of the shell (see TRANSIENT_SELECTOR).
  for (const el of Array.from(clone.querySelectorAll(TRANSIENT_SELECTOR))) el.remove()

  // Re-declare the app's extra blocks: drop every one of a managed type, then
  // write the current set back. Removing a language from the file is therefore
  // just "stop listing it" — no deletion path to get wrong. The clear-set is
  // the DECLARED types, never the types about to be written: an empty write
  // set still has to clear (that is what removing the file's last pack looks
  // like).
  const wanted = shellBlocks()
  for (const type of new Set([...managedTypes, ...wanted.map((b) => b.type)])) {
    for (const stale of Array.from(clone.querySelectorAll(`script[type="${type}"]`))) stale.remove()
  }
  for (const b of wanted) {
    const el = clone.createElement('script')
    el.setAttribute('type', b.type)
    el.id = b.id
    for (const [k, v] of Object.entries(b.attrs ?? {})) el.setAttribute(k, v)
    // same <-escape as the doc block: these can never contain "</script>"
    el.textContent = '\n' + b.body.replace(/</g, '\\u003c') + '\n'
    clone.head.appendChild(el)
  }

  let block = docBlockOf(clone)
  if (!block) {
    block = clone.createElement('script')
    clone.head.appendChild(block)
  }
  // A shell from before the rename gets the new names on its first save.
  block.setAttribute('type', 'application/beeslides+json')
  block.id = DATA_BLOCK_ID

  // The store the shell arrived with (the last save's), read BEFORE it is
  // removed: a ref this document can no longer resolve keeps its bytes.
  const previous = readStore(clone)
  for (const stale of Array.from(clone.querySelectorAll(`#${STORE_ID},[${STORE_ATTR}],#${LEGACY_STORE_ID},[data-${LEGACY_STORE_ID}]`))) stale.remove()

  // `body` for the veto: the envelope, or '' for plaintext (which the veto
  // then judges by the password flag alone)
  const plain = envelope === null
  const body = envelope ?? ''
  const allowed = previewAllowed(body)
  const preview = writePreview(clone, allowed, doc)
  const layer = writeStaticLayer(clone, allowed, doc)

  // Plaintext is written READABLE (canonicalJson: indented, content-ordered
  // keys); an envelope is ciphertext and stays as it is.
  let text = envelope ?? canonicalJson(doc)
  if (plain && allowed) {
    const stored = writeAssetStore(clone, block, doc, [preview, layer], previous)
    if (stored) text = canonicalJson(externalizeAssets(doc, stored).doc)
  }
  // A preview or layer that draws from the store is meaningless without one
  // (no store: nothing to store, a failed store, or an encrypted save — the
  // last never gets either in the first place).
  if (!clone.getElementById(STORE_ID)) {
    for (const host of [preview, layer]) {
      if (host && layerPictures.get(host)?.size) removeHost(host)
    }
  }
  // <-escape so the JSON can never contain "</script>" and break the file.
  block.textContent = '\n' + text.replace(/</g, '\\u003c') + '\n'

  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = doc.title + ' — ' + appConfig().appName

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  // Belt-and-braces: an unescaped close tag anywhere in generated output would
  // corrupt the file; this should never trigger given the escaping above.
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('slidomingo: unexpected script-close count in serialized file')
  }
  return html
}

// --- static first-page preview (file-manager thumbnails) ---------------------
//
// THE PROBLEM. A BeeSlides file is one HTML document, and thumbnailers — iOS
// Files, macOS QuickLook/Finder, the slidomingo/home app — render HTML with
// JavaScript DISABLED (verified: `qlmanage -t` renders <noscript> content).
// Until our runtime boots, every deck genuinely IS the same bytes plus the
// boot splash, so every deck thumbnailed as the same dark box.
//
// THE FIX. At save time we write a STATIC rendering of page one into the file
// and park it inside a `<noscript>`. That element's contents are rendered only
// when scripting is off, which is exactly the population we are addressing:
// a real reader never sees it — not for a frame — so there is no flash to
// suppress, no interaction with the splash's `.done`/`bsAuto` dismissal, and
// nothing for print or present to exclude. When a thumbnailer runs scripts
// after all, the preview is simply never rendered and we are back to today's
// behaviour: a regression is not possible, only an improvement.
//
// It is shell FURNITURE, not document data: nothing here enters `#beeslides-doc`,
// no format field is added, and a file saved by an older build (which has no
// preview) opens identically.
//
// The kernel knows nothing about how any app draws a page. It owns the
// placement, the replace-don't-append rule, the encryption veto and the
// output-safety check; the app hands back a ready-made element.

const PREVIEW_ATTR = 'data-beeslides-preview'

/** Builds the app's static first-page rendering. Return null for "no preview". */
export type PreviewProvider = (doc: KernelDoc) => HTMLElement | null

let previewProvider: PreviewProvider | null = null

/** Register the app's first-page renderer. Call once, at boot. Optional — an
 *  app that registers nothing simply saves files without a preview. */
export function registerPreview(fn: PreviewProvider): void {
  previewProvider = fn
}

/**
 * May this saved file carry a plaintext preview of its first page?
 *
 * NO for an encrypted deck, and this is the single most important rule here.
 * The whole point of the `beeslides/enc` envelope is that the content is
 * unreadable on disk without the password; rendering page one in plaintext
 * beside the ciphertext would hand an attacker the title slide — usually the
 * most disclosive page in the deck — and would do it silently, because the
 * owner would never see the markup they were shipping. A missing thumbnail is
 * the correct, expected cost of encrypting a file.
 *
 * Two independent tests, because they fail independently: the in-memory
 * password flag covers the live session, and re-parsing the body covers any
 * path that hands us an already-encrypted block without the flag set.
 *
 * Pure and exported so `scripts/test-preview.ts` can exercise it directly —
 * the surrounding DOM work is not unit-testable in node, this decision is.
 */
export function previewAllowed(body: string, encrypted = isEncryptionActive()): boolean {
  return !encrypted && parseEnvelope(body) === null
}

// Built by concatenation for the usual reason (AGENTS.md #1): these literals
// must never appear in a BeeSlides bundle, which is itself inline script.
// Note the close forms carry no ">": an HTML parser ends a script element at
// `</script` followed by whitespace, `/` or `>`, so `</script foo>` closes it
// just as surely as the tidy form does.
const SCRIPT_OPEN = '<scr' + 'ipt'
const SCRIPT_CLOSE_START = '</scr' + 'ipt'
const NOSCRIPT_CLOSE = '</nosc' + 'ript'
const STYLE_OPEN = '<sty' + 'le'
const STYLE_CLOSE_START = '</sty' + 'le'

/**
 * The preview's one stylesheet, and nothing hiding inside it.
 *
 * `<style>` is a RAW TEXT element: its content is not escaped on the way out, so
 * whatever a provider puts in it is written to the file verbatim. Every app's
 * preview has one (slides and dash hoist repeated declarations into it, spaces
 * writes a sheet), and every one of them builds declarations out of AUTHOR
 * data — colours, fonts, sizes. A single `</style>` in one of those values ends
 * the element early and everything after it is live markup in the reader's DOM,
 * outside `#beeslides-doc`, at parse time, before the remover runs.
 *
 * A flat "refuse any `<style`" would be simpler and would refuse EVERY preview,
 * so the rule is shaped like the tokenizer instead: at most one style element,
 * no `<` anywhere in its text (the breakout attempt is itself a `<`), and no
 * second opener or stray closer anywhere around it. That last clause is what
 * catches the tidy version of the attack, which re-opens a style after the
 * markup it smuggled in and leaves the tag counts balanced.
 *
 * DELIBERATELY NOT generalized to "N style elements": an early attempt at that
 * (walk block-by-block, checking each one's own content for `<`) turned out to
 * be a real hole, not just a stricter-than-needed rule — a single attacker-
 * controlled declaration value can embed BOTH a premature `</style>` and a
 * matching `<style>` reopen, and a block-by-block string walk reads that as two
 * independently clean blocks with the smuggled markup sitting harmlessly "in
 * the gap" between them, because the gap check only looks for a stray closer,
 * not for arbitrary injected tags. The blunt one-style-only policy has no such
 * gap: ANY second style-related token anywhere after the first block refuses
 * the whole thing, full stop. The static layer's real need for several
 * independent `<style>` blocks (one per custom-css svg element) is served by a
 * SEPARATE, DOM-based check instead (staticLayerIsSafe, below) that inspects
 * the already-parsed tree rather than re-scanning its serialized string — which
 * has no such ambiguity to exploit, because it never re-interprets text as
 * element boundaries in the first place.
 */
function styleIsInert(lower: string): boolean {
  const open = lower.indexOf(STYLE_OPEN)
  if (open < 0) return !lower.includes(STYLE_CLOSE_START)
  if (lower.slice(0, open).includes(STYLE_CLOSE_START)) return false
  const gt = lower.indexOf('>', open)
  if (gt < 0) return false
  const end = lower.indexOf(STYLE_CLOSE_START, gt)
  if (end < 0) return false
  const rest = lower.slice(end + STYLE_CLOSE_START.length)
  return !lower.slice(gt + 1, end).includes('<') &&
    !rest.includes(STYLE_OPEN) && !rest.includes(STYLE_CLOSE_START)
}

/**
 * Refuse any preview markup that could unbalance the file.
 *
 * The preview is generated from user content, so it is not shaped by us. A
 * `<script>`/`</script>` in it would break the open/close balance the frozen
 * splice contract (and `scripts/shell-gate.mjs`) depends on. `</noscript>` is
 * still refused although the preview no longer lives in a `<noscript>`: it
 * costs nothing, and a document written by an older BeeSlides may still carry one.
 *
 * This check got MORE load-bearing when the preview left `<noscript>`. It is no
 * longer inert markup that only a scripting-less renderer ever parses — it now
 * lands in the live DOM of every reader's page until the remover runs.
 *
 * The app sanitizes its own output; this is the kernel refusing to take its
 * word for it. Dropping the preview costs a thumbnail. Emitting it anyway could
 * brick the file — or, through the preview's own stylesheet, put live markup in
 * the reader's DOM; see styleIsInert for the half escaping cannot reach.
 *
 * Exported for `scripts/test-preview.ts`, like previewAllowed.
 */
export function previewIsSafe(html: string): boolean {
  const lower = html.toLowerCase()
  if (lower.includes(SCRIPT_OPEN) || lower.includes(SCRIPT_CLOSE_START) || lower.includes(NOSCRIPT_CLOSE)) return false
  return styleIsInert(lower)
}

/**
 * Deletes the preview, and itself, the instant the parser reaches it.
 *
 * Parser-BLOCKING on purpose: a classic inline script placed immediately after
 * the preview runs before the parser continues, so the browser never paints a
 * frame containing it. That is what makes this free for readers.
 *
 * It is written as a string rather than built from a template because it must
 * stay one line and contain no `</script>`.
 */
const PREVIEW_REMOVER =
  `(function(){var a=document.querySelectorAll('[${PREVIEW_ATTR}]');` +
  `for(var i=a.length;i--;){var n=a[i];if(n.parentNode)n.parentNode.removeChild(n)}})()`

/** Writes the preview; returns its host (null = none) for the asset store. */
function writePreview(clone: Document, allowed: boolean, doc: KernelDoc): HTMLElement | null {
  // REPLACE, NEVER APPEND. `capturePristine()` snapshots the document as it
  // was loaded, so the shell we are cloning already carries the preview the
  // PREVIOUS save wrote; appending would stack a new one on every ⌘S until the
  // file was mostly stale previews. Removing unconditionally — before deciding
  // whether to write a new one — is also how a preview correctly DISAPPEARS
  // when a plaintext deck gains a password, or when an app stops providing
  // one. Both of those are silent leaks if the removal is conditional.
  // The selector is deliberately attribute-only: it must sweep the host AND the
  // remover script beside it, and it must still find previews written by an
  // older BeeSlides, which parked them in a <noscript>.
  for (const stale of Array.from(clone.querySelectorAll(`[${PREVIEW_ATTR}],[${LEGACY_PREVIEW_ATTR}]`))) stale.remove()

  if (!previewProvider || !allowed) return null

  let el: HTMLElement | null = null
  try {
    el = previewProvider(doc)
  } catch (err) {
    // A preview is a nicety; a failed save is not. Never let rendering page
    // one take the file down with it.
    console.warn('slidomingo: first-page preview failed, saving without one', err)
    return null
  }
  if (!el) return null

  // ORDINARY MARKUP, NOT <noscript>, AND A PARSER-BLOCKING REMOVER.
  //
  // `<noscript>` was the obvious home and it is wrong here. It renders only
  // where scripting is DISABLED, and iOS — the platform this feature exists for
  // — satisfies neither half of that: probed with a page whose inline script
  // repaints it, the iOS thumbnailer renders neither the script's result nor
  // the <noscript>, so a deck thumbnailed as its boot splash no matter what we
  // put in the noscript.
  //
  // Since that thumbnailer runs no script, plain markup survives for it. And
  // since every real reader DOES run script, a parser-blocking inline remover
  // placed immediately after deletes the preview before the browser paints a
  // frame containing it. Both audiences get the right answer with no flash and
  // no compromise — which the <noscript> version could not manage.
  //
  // A reader with scripting genuinely off keeps the preview on screen, exactly
  // as before: without scripts the deck cannot render at all, so a still of
  // page one is the best available answer rather than a regression.
  const host = clone.createElement('div')
  host.setAttribute(PREVIEW_ATTR, '1')
  host.appendChild(clone.importNode(el, true))
  // Its pictures draw from the asset store, exactly like the static layer's:
  // the thumbnail shows real photos without the preview carrying their bytes.
  storePictures(host)
  if (!previewIsSafe(host.innerHTML)) {
    console.warn('slidomingo: first-page preview rejected as unsafe, saving without one')
    return null
  }
  const remover = clone.createElement('script')
  remover.setAttribute(PREVIEW_ATTR, '1')
  remover.textContent = PREVIEW_REMOVER

  // Straight after the splash it replaces, so a thumbnailer reaches it before
  // the ~550KB of compressed payload at the end of the body. The remover goes
  // immediately after the host: any markup between them is markup the parser
  // could paint first.
  const splash = clone.getElementById('beeslides-splash')
  const parent = splash?.parentNode ?? clone.body ?? clone.documentElement
  const after = splash?.parentNode ? splash.nextSibling : null
  parent.insertBefore(host, after)
  parent.insertBefore(remover, host.nextSibling)
  return host
}

/** Take a preview or layer host back out of the file (with the preview's
 *  remover script beside it). */
function removeHost(host: HTMLElement): void {
  const next = host.nextElementSibling
  if (next?.tagName === 'SCRIPT' && next.hasAttribute(PREVIEW_ATTR)) next.remove()
  host.remove()
}

// --- static declarative layer (full-fidelity, every slide, "slidomingo/deck") ----
//
// Generalizes the first-page preview above to EVERY slide, at full fidelity,
// as PRIMARY saved content rather than a disposable thumbnail: a real reader's
// first paint comes from this markup, before any JS runs — free progressive
// enhancement — and it renders correctly with scripting off in any browser,
// forever. It is regenerated fresh on every save exactly like the preview
// (replace-never-append) and gated by the IDENTICAL encryption veto
// (previewAllowed) for the identical reason, at much higher stakes: this
// covers every slide, not just one, so an encrypted deck getting this layer
// by mistake would leak the entire deck in plaintext beside the ciphertext —
// not weakening the password, defeating it outright. An encrypted file simply
// carries no static layer, same as a file saved by a build that never had
// this feature: no regression, no partial leak, just no benefit for that file.
//
// UNLIKE the preview, this carries NO parser-blocking remover: it is meant to
// be seen. Ordinary app boot code (main.ts) removes it once the live app's own
// first frame is ready — see docs/DECISIONS.md for the full design.
//
// The kernel still owns exactly what it owned for the preview — placement,
// the replace-don't-append rule, the encryption veto, the output-safety
// check — and knows nothing about how any app draws a page.

const STATIC_ATTR = 'data-beeslides-static'

/** Builds the app's full declarative rendering of every slide. Return null
 *  for "no static layer" (the app itself may also decline, e.g. mid-render
 *  failure — the kernel's own veto is previewAllowed, applied regardless). */
export type StaticLayerProvider = (doc: KernelDoc) => HTMLElement | null

/**
 * DOM-level safety check for the (possibly multi-<style>) static layer —
 * inspects the already-parsed tree instead of a serialized string.
 *
 * `previewIsSafe`/`styleIsInert` work on TEXT precisely because the preview
 * is built, checked and discarded as a string in one pass; generalizing that
 * string walk to N independent style blocks turned out to be exploitable
 * (see styleIsInert's comment). A real DOM has none of that ambiguity: by the
 * time `host` exists, the browser has ALREADY decided, deterministically,
 * where every element starts and ends — the same way any other compliant
 * parser will when these exact bytes are re-parsed from the saved file later
 * — so asking the tree directly ("any script? any on* attribute? does any
 * style element's OWN textContent contain a literal `<`?") cannot be tricked
 * by text that merely LOOKS like a second block boundary to a string scanner.
 * A style element's `<`-free textContent, once re-serialized as raw text and
 * re-parsed anywhere else, reproduces the identical single element with no
 * possible early close — which is the actual property being verified.
 */
function staticLayerIsSafe(host: HTMLElement): boolean {
  if (host.querySelector('script,noscript')) return false
  for (const el of [host, ...Array.from(host.querySelectorAll<Element>('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) return false
    }
  }
  for (const style of Array.from(host.querySelectorAll('style'))) {
    if ((style.textContent ?? '').includes('<')) return false
  }
  return true
}

let staticLayerProvider: StaticLayerProvider | null = null

/** Register the app's full-deck static renderer. Call once, at boot. Optional
 *  — an app that registers nothing simply saves files without one. */
export function registerStaticLayer(fn: StaticLayerProvider): void {
  staticLayerProvider = fn
}

/** Writes the layer; returns its host (null = none) for the asset store. */
function writeStaticLayer(clone: Document, allowed: boolean, doc: KernelDoc): HTMLElement | null {
  // REPLACE, NEVER APPEND — identical reasoning to writePreview: the shell
  // being cloned already carries the PREVIOUS save's layer.
  for (const stale of Array.from(clone.querySelectorAll(`[${STATIC_ATTR}],[${LEGACY_STATIC_ATTR}]`))) stale.remove()

  if (!staticLayerProvider || !allowed) return null

  let el: HTMLElement | null = null
  try {
    el = staticLayerProvider(doc)
  } catch (err) {
    // A static layer is a nicety a JS-off reader benefits from; a failed save
    // is not. Never let rendering the whole deck take the file down with it.
    console.warn('slidomingo: static layer render failed, saving without one', err)
    return null
  }
  if (!el) return null

  const host = clone.createElement('div')
  host.id = 'beeslides-static'
  host.setAttribute(STATIC_ATTR, '1')
  host.appendChild(clone.importNode(el, true))
  storePictures(host)
  // Same posture as the preview — the app sanitizes its own output, this is
  // the kernel refusing to take its word for it — but via a DOM-level check
  // (staticLayerIsSafe), not previewIsSafe's string scan: this layer
  // legitimately carries several independent <style> elements (one per
  // custom-css svg element), which a string-level walk cannot verify safely
  // (see styleIsInert's comment for the exploit that ruled it out).
  if (!staticLayerIsSafe(host)) {
    console.warn('slidomingo: static layer rejected as unsafe, saving without one')
    return null
  }

  // Same placement rule as the preview — ahead of the compressed payload, so
  // a JS-off reader reaches real content before the ~550KB of runtime blocks
  // — but AFTER any preview host, so a thumbnailer scanning minimally still
  // meets the (much smaller, purpose-built) preview first, unchanged.
  const splash = clone.getElementById('beeslides-splash')
  const previewNodes = clone.querySelectorAll(`[${PREVIEW_ATTR}]`)
  const anchor = previewNodes.length ? previewNodes[previewNodes.length - 1] : splash
  const parent = anchor?.parentNode ?? clone.body ?? clone.documentElement
  const before = anchor?.parentNode ? anchor.nextSibling : null
  parent.insertBefore(host, before)
  return host
}

// --- the asset store (every embedded byte once) -----------------------------
//
// kernel/src/assetstore.ts explains the format. This half decides WHAT goes
// in: whatever the static layer draws, plus what the app declares
// (registerAssetStore) — every embedded picture and font the document owns,
// including ones only an unused slide type or a hidden slide shows, since a
// CSS rule nothing uses costs nothing. It is the ONLY place bytes are moved
// out of the JSON, and the JSON only ever refers to bytes this very save
// wrote somewhere else in the file: a layer that failed, the media-still
// tier, or a picture nothing declared simply keeps its bytes inline.
//
// Same veto as the preview and layer: an encrypted document gets no store —
// its bytes are part of what the password protects, so they stay inside the
// envelope.

/** Store attribute an app puts on an `<img>` in its static layer whose box
 *  it guarantees is drawn identically by CSS content replacement (explicit
 *  width/height, display:block, object-fit). The kernel turns each into a
 *  `div.sa-<id>[role=img]` carrying the img's own inline style (or
 *  `[aria-hidden=true]` for a decorative img, alt=""). */
export const STORABLE_ATTR = 'data-beeslides-storable'

/** What an app wants the store to hold for a document, beyond the layer. */
export interface AssetStoreSpec {
  /** picture `data:` URIs to store even when the layer draws none of them */
  images: string[]
  /** embedded fonts, one @font-face each (the no-JS layer's fonts too) */
  fonts: Array<{ uri: string; family: string; weight?: string; style?: string }>
}
let assetStoreProvider: ((doc: KernelDoc) => AssetStoreSpec) | null = null

/** Register the app's store declaration. Call once, at boot. Optional — an
 *  app that registers nothing stores only what its static layer draws. */
export function registerAssetStore(fn: (doc: KernelDoc) => AssetStoreSpec): void {
  assetStoreProvider = fn
}

/** What each preview/layer's pictures turned into: id → uri of every `.sa-` div. */
const layerPictures = new WeakMap<HTMLElement, Map<string, string>>()

/**
 * The layer half: every storable `<img>` becomes a `div.sa-<id>` drawing the
 * same bytes through CSS content replacement (pixel-identical — measured,
 * docs/DECISIONS.md 2026-09-28: `background-image` was not), and the first
 * `<video>`/`<audio>` per id keeps its `src` as the id's carrier. A poster
 * carries its bytes the same way unless a `.sa-` picture needs the same id.
 */
function storePictures(host: HTMLElement): void {
  const doc = host.ownerDocument
  const drawn = new Map<string, string>()
  for (const img of Array.from(host.querySelectorAll<HTMLImageElement>(`img[${STORABLE_ATTR}]`))) {
    img.removeAttribute(STORABLE_ATTR)
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith('data:')) continue
    const id = assetId(src)
    drawn.set(id, src)
    const div = doc.createElement('div')
    // keep any class the app gave it (the preview hoists repeated inline
    // declarations into classes); the store class draws the picture
    div.className = img.className ? `${img.className} ${storeClass(id)}` : storeClass(id)
    // alt="" is a decorative picture (HTML's own convention): hidden from
    // assistive tech, never an unlabelled role=img — so an app need not
    // repeat aria-hidden on a wrapper to survive this swap
    const alt = img.getAttribute('alt')
    if (alt === '') div.setAttribute('aria-hidden', 'true')
    else {
      div.setAttribute('role', 'img')
      if (alt) div.setAttribute('aria-label', alt)
    }
    div.style.cssText = img.style.cssText
    img.replaceWith(div)
  }
  layerPictures.set(host, drawn)
  // A <video>/<audio> cannot draw from CSS, so the FIRST element per id keeps
  // its bytes and says so; any later use of the same clip repeats them (rare,
  // and the alternative — a still — would change what a no-JS reader sees).
  const carried = new Set<string>()
  for (const m of Array.from(host.querySelectorAll<HTMLMediaElement>('video[src^="data:"],audio[src^="data:"]'))) {
    const id = assetId(m.getAttribute('src')!)
    if (carried.has(id) || drawn.has(id)) continue
    carried.add(id)
    m.setAttribute(MEDIA_SRC_ATTR, id)
  }
  for (const v of Array.from(host.querySelectorAll<HTMLVideoElement>('video[poster^="data:"]'))) {
    const id = assetId(v.getAttribute('poster')!)
    if (carried.has(id) || drawn.has(id)) continue
    carried.add(id)
    v.setAttribute(MEDIA_POSTER_ATTR, id)
  }
}

/**
 * Write `#beeslides-assets` right after the doc block and return every URI
 * the file now carries once (uri → id) — the set the JSON may refer to.
 * Null = no store (nothing to store, or it failed its own safety check).
 */
function writeAssetStore(
  clone: Document, block: Element, doc: KernelDoc, hosts: Array<HTMLElement | null>, previous: Map<string, string>,
): Map<string, string> | null {
  const stored = new Map<string, string>() // uri → id
  const ids = new Set<string>()
  const rules: string[] = []
  const carry = (uri: string, id: string) => { stored.set(uri, id); ids.add(id) }
  const addImage = (uri: string) => {
    if (stored.has(uri)) return
    const id = assetId(uri)
    carry(uri, id)
    rules.push(imageRule(id, uri))
  }

  for (const host of hosts) {
    if (!host) continue
    // what a layer's media elements carry themselves, then what it draws
    for (const el of Array.from(host.querySelectorAll(`[${MEDIA_SRC_ATTR}]`))) carry(el.getAttribute('src')!, el.getAttribute(MEDIA_SRC_ATTR)!)
    for (const el of Array.from(host.querySelectorAll(`[${MEDIA_POSTER_ATTR}]`))) carry(el.getAttribute('poster')!, el.getAttribute(MEDIA_POSTER_ATTR)!)
    for (const uri of layerPictures.get(host)?.values() ?? []) addImage(uri)
  }

  let spec: AssetStoreSpec = { images: [], fonts: [] }
  try { if (assetStoreProvider) spec = assetStoreProvider(doc) } catch (err) {
    console.warn('slidomingo: asset store declaration failed, storing only what the layer draws', err)
  }
  for (const uri of spec.images) if (uri.startsWith('data:')) addImage(uri)
  for (const f of spec.fonts) {
    if (!f.uri.startsWith('data:')) continue
    const id = assetId(f.uri)
    // One rule per @font-face. A font file two families share is written
    // twice (each rule needs its own src) — rare enough not to special-case.
    carry(f.uri, id)
    rules.push(fontRule(id, f.uri, f))
  }

  // A ref this document still holds but cannot resolve (its bytes never came
  // back into memory — a stripped or partial store) keeps whatever bytes the
  // previous save wrote for it. A dangling ref never loses bytes that exist.
  for (const id of storeRefsIn(doc)) {
    const uri = previous.get(id)
    if (uri !== undefined && !ids.has(id)) { ids.add(id); rules.push(imageRule(id, uri)) }
  }

  pruneIdMemo(new Set(stored.keys()))
  if (!rules.length) return stored.size ? stored : null
  const css = '\n' + rules.join('\n') + '\n'
  // The same DOM-level rule as staticLayerIsSafe: a raw-text element whose
  // text holds no `<` cannot end early. cssString escapes every `<`, so
  // this cannot fire; if it ever does, nothing leaves the JSON and the layer
  // (whose pictures now point at the store) goes with it.
  if (css.includes('<')) {
    console.warn('slidomingo: asset store rejected as unsafe, keeping every asset inline')
    return null
  }
  const style = clone.createElement('style')
  style.id = STORE_ID
  style.setAttribute(STORE_ATTR, '1')
  style.textContent = css
  block.after(style)
  return stored
}


/**
 * Serialize `doc` into an arbitrary app shell (a parsed BeeSlides HTML document).
 * Used with the boot-time pristine copy on every save, and by the self-update
 * flow with a freshly fetched NEWER shell — same document, new app around it.
 * PLAIN output — encryption-aware callers use serializeDocInto/serializeAuto.
 */
export function serializeWith(shell: Document, doc: KernelDoc): string {
  return serializeBody(shell, null, doc)
}

/** The full .beeslides.html file content with `doc` embedded (plain). */
export function serializeFile(doc: KernelDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeWith(pristine, doc)
}

// --- password encryption ----------------------------------------------------
//
// An encrypted file keeps the SAME plaintext #beeslides-doc block (the splice
// contract old updaters rely on) — but the block holds a beeslides/enc envelope
// instead of the document: AES-GCM-256 over the doc JSON, key derived from
// the password with PBKDF2-SHA-256. The password is held in memory for the
// session so ⌘S and self-update keep writing encrypted output.

export interface EncEnvelope {
  format: 'beeslides/enc' | 'slidomingo/enc'
  v: 1
  it: number
  salt: string
  iv: string
  data: string
}

/**
 * PBKDF2 rounds for NEW envelopes only.
 *
 * A .beeslides.html is offline at-rest storage: the ciphertext sits in a file that
 * gets mailed, synced and backed up, so an attacker guesses passwords at their
 * own pace with no rate limit anywhere. 300k was half of current guidance
 * (OWASP: 600k for PBKDF2-HMAC-SHA256), and it is the cheapest possible thing
 * to fix — one number, and the cost lands on a keypress the user already waits
 * through.
 *
 * READING IS UNAFFECTED, deliberately: the count travels in the envelope (`it`)
 * and `decryptEnvelope` derives with THAT number, never this one. Every deck
 * encrypted by an older build keeps opening with its own 300k, and re-saving it
 * re-encrypts at the new count. A file that stops opening would be far worse
 * than a weak KDF, so `scripts/test-preview.ts` pins a real 300k envelope.
 */
const ENC_ITERATIONS = 600_000

const eb64 = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  dec(s: string): Uint8Array {
    const b = atob(s)
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

let encPassword: string | null = null

/** Set (or clear with null) the password used for every subsequent save. */
export function setEncryptionPassword(p: string | null) {
  encPassword = p
}

export const isEncryptionActive = () => encPassword !== null

/** Parse a data-block body as an encryption envelope; null if it is not one. */
export function parseEnvelope(text: string): EncEnvelope | null {
  try {
    const env = JSON.parse(text)
    if (env && isEncFormat(env.format) && env.v === 1 && env.data && env.salt && env.iv) {
      return env as EncEnvelope
    }
  } catch {
    /* not an envelope */
  }
  return null
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptBody(json: string, password: string): Promise<string> {
  const salt = new Uint8Array(16)
  const iv = new Uint8Array(12)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveKey(password, salt, ENC_ITERATIONS)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(json))
  const env: EncEnvelope = {
    format: 'beeslides/enc', v: 1, it: ENC_ITERATIONS,
    salt: eb64.enc(salt), iv: eb64.enc(iv), data: eb64.enc(new Uint8Array(ct)),
  }
  return JSON.stringify(env)
}

/** Decrypt an envelope with a candidate password; null on wrong password. */
export async function decryptEnvelope(env: EncEnvelope, password: string): Promise<string | null> {
  try {
    const key = await deriveKey(password, eb64.dec(env.salt), env.it || ENC_ITERATIONS)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: eb64.dec(env.iv) as BufferSource }, key, eb64.dec(env.data) as BufferSource)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Encryption-aware serialization into an arbitrary shell — THE path for
 * saves and self-updates. Plain when no password is active.
 */
export async function serializeDocInto(shell: Document, doc: KernelDoc): Promise<string> {
  // Encrypted: the bytes stay inside the envelope, so no store is written
  // (serializeBody's veto sees the envelope as well as the password flag).
  const body = encPassword ? await encryptBody(JSON.stringify(doc), encPassword) : null
  return serializeBody(shell, body, doc)
}

/** Encryption-aware serializeFile. */
export async function serializeAuto(doc: KernelDoc): Promise<string> {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeDocInto(pristine, doc)
}

/**
 * The title as a file name. Strip only what a filesystem can't hold, so a
 * deck titled "My Talk" is offered as `My Talk.beeslides.html`: accepting
 * the default leaves title and file name equal, and no file chip shows.
 * (It used to underscore everything outside \w, so the two never matched.)
 */
export function suggestedFileName(doc: KernelDoc, suffix = ''): string {
  // Tabs and newlines (\t-\r) are left for the whitespace pass, so a line
  // break becomes a space instead of gluing two words together; that pass
  // runs second so stripping "a : b" doesn't leave a double space.
  const base = doc.title
    .replace(/[/\\:*?"<>|\u0000-\u0008\u000e-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '') || 'Untitled'
  return `${base}${suffix ? `-${suffix}` : ''}${DOC_EXT}`
}

// --- writing to disk --------------------------------------------------------

type SaveResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

interface FsFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  name: string
}

let fileHandle: FsFileHandle | null = null

const hasFsAccess = () => typeof (window as any).showSaveFilePicker === 'function'

/**
 * Can this browser rewrite the open file, or only hand back copies?
 *
 * The File System Access API is Chrome/Edge only: Safari and Firefox lack it,
 * and so does EVERY browser on iOS, because they are all WebKit underneath.
 * Without it there is no writable handle, which costs three things — in-place
 * save, silent autosave write-back, and in-place self-update.
 *
 * Exported because the UI must not promise what the browser cannot do. "⌘S
 * rewrites this file in place" is the product's central claim and it is simply
 * false here; saying it anyway and retracting it in a toast after the first
 * save is worse than saying the true thing up front.
 */
export const canWriteInPlace = () => hasFsAccess()

/**
 * What a save is FOR. The three cases want different files in different places,
 * and until now the picker could not tell them apart.
 *
 * · `in-place` — ⌘S. Overwrite the document being edited.
 * · `copy`     — "Save a copy…". A second file, chosen by the author.
 * · `share`    — a suffixed export: read-only copy, presentation package,
 *                template. Deliberately a new file, and never the ⌘S target.
 */
export type SavePurpose = 'in-place' | 'copy' | 'share'

/**
 * The picker `id` for a purpose — and, incidentally, the only signal a HOST has
 * about what it is being asked to do.
 *
 * Browsers remember the last directory used per `id`, so distinct ids are worth
 * having on their own: exports and working files usually live in different
 * places, and one shared id made the picker open wherever you last put a
 * view-only copy.
 *
 * The other reason is not incidental. A host that polyfills
 * `showSaveFilePicker` (home/ios over UIDocument, home/webext over a directory
 * grant) sees ONLY the options bag. `saveFile(doc, forcePicker)` used to reach
 * this function with byte-identical arguments for ⌘S and for "Save a copy…",
 * so a host could not distinguish them — and one that guessed wrong overwrote
 * the open document instead of copying it. Measured, in a browser extension,
 * 2026-08-02. Intent has to be explicit in the call, because it cannot be
 * recovered from anything else in it.
 */
// The ids stay `slidomingo-*` through the 2026-10-20 rename: hosts key on
// them and the browser files its remembered folder under them.
export const pickerIdFor = (purpose: SavePurpose): string =>
  purpose === 'in-place' ? 'slidomingo-doc'
    : purpose === 'copy' ? 'slidomingo-copy'
      : 'slidomingo-share'

/**
 * Is a HOST polyfilling the picker — home/ios, home/webext — rather than the
 * browser's own?
 *
 * The kernel cannot infer this. `showSaveFilePicker` exists either way, and a
 * host that declines a request is indistinguishable from one that is not there:
 * both end in the native dialog. So a host that can do more than the bare
 * contract announces itself, and this is the only thing the kernel reads.
 *
 * Every in-place path must keep working when it is false, because that is the
 * plain-browser case and it is the majority one.
 *
 * PRESENCE IS NOT ENOUGH, so this asks about a named capability: a host that
 * announced itself but does not know an op would pass the request through to
 * the native picker. Decks outlive host versions in both directions; neither
 * side may assume the other is current.
 */
export const hostCan = (op: string): boolean => {
  const host = (window as any).__slidomingoHost
  return !!host && Array.isArray(host.ops) && host.ops.includes(op)
    && typeof (window as any).showSaveFilePicker === 'function'
}

async function pickHandle(
  doc: KernelDoc, suffix = '', suggestedName?: string, purpose: SavePurpose = 'in-place',
): Promise<FsFileHandle | null> {
  try {
    // The name to offer is the file the user is ALREADY looking at, when we know
    // it. suggestedFileName() derives from doc.title, and the two drift apart
    // constantly — a deck called "BeeSlides Showcase" living in
    // Q3-board.beeslides.html offered to save as BeeSlides_Showcase.beeslides.html,
    // so an ordinary ⌘S silently proposed a SECOND file beside the real one.
    // A suffixed export (share copies) still names itself, hence the suffix
    // check: those are deliberately new files.
    const openedName = suffix ? null : openedFileName()
    return await (window as any).showSaveFilePicker({
      suggestedName: suggestedName ?? openedName ?? suggestedFileName(doc, suffix),
      // startIn takes a HANDLE, never a path — the API gives no way to point a
      // picker at an arbitrary directory, by design. With a handle we land in
      // the open file's own folder; without one, `id` is the fallback: the
      // browser remembers the last directory used under this id, so the second
      // update onwards opens where the first one saved.
      ...(fileHandle ? { startIn: fileHandle } : {}),
      id: pickerIdFor(purpose),
      // `.beeslides.html`, NOT `.html`, and the compound extension is the point.
      //
      // `suggestedFileName` has always produced `.beeslides.html`, but the picker
      // accepted `.html` — so an author who edited the name to "Q3" got
      // `Q3.html`, and a document named that is a second-class citizen
      // everywhere the convention is what identifies us: home/webext injects
      // its save bridge on `file:///*.beeslides.html`, so such a file opens fine
      // and then asks where to save, and home/ios matches the same way.
      //
      // BeeSlides was manufacturing the exception and then being asked to cope with
      // it. Accepting only the compound extension means the browser appends it
      // to a bare name, which is what everybody meant. Compound suffixes are
      // explicitly legal here (`.tar.gz` is the spec's own example) and the
      // limit is 16 characters against this one's 11.
      types: [{ description: appConfig().appName, accept: { 'text/html': [DOC_EXT] } }],
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    throw err
  }
}

async function writeHandle(handle: FsFileHandle, html: string) {
  const writable = await handle.createWritable()
  await writable.write(new Blob([html], { type: 'text/html' }))
  await writable.close()
}

export function downloadFile(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Save the document. Chrome/Edge: File System Access API (picker on first
 * save, silent rewrite after). Firefox/Safari: download a copy.
 */
export async function saveFile(doc: KernelDoc, forcePicker = false): Promise<SaveResult> {
  const html = await serializeAuto(doc)
  if (hasFsAccess()) {
    if (forcePicker || !fileHandle) {
      // forcePicker is only ever "Save a copy…"; a first save of an unsaved
      // document is in-place by intent even though it must also pick.
      const handle = await pickHandle(doc, '', undefined, forcePicker ? 'copy' : 'in-place')
      if (!handle) return 'cancelled'
      fileHandle = handle
      await writeHandle(handle, html)
      return 'saved-as'
    }
    await writeHandle(fileHandle, html)
    return 'saved'
  }
  downloadFile(html, suggestedFileName(doc))
  return 'downloaded'
}

export const currentFileName = () => fileHandle?.name ?? null

/**
 * The raw handle behind the currently-open file, or null. Typed loosely
 * (same "handle: any" posture used elsewhere for these) because the real
 * object also has `.getFile()`, which `FsFileHandle` doesn't declare — the
 * desktop shell uses this to resolve the OS path (webUtils.getPathForFile)
 * for Recent Files after a first save picks a brand-new handle. Purely
 * additive: no existing call site's behavior changes.
 */
export const currentFileHandle = (): unknown | null => fileHandle

/**
 * Adopt a handle obtained outside the save picker — today, a file dropped onto
 * the editor via `DataTransferItem.getAsFileSystemHandle()`.
 *
 * Why this exists: a deck double-clicked from disk opens on `file://` with NO
 * handle, so every ⌘S re-runs the picker and the user re-navigates to a file
 * they are already looking at. A drop yields a real handle, so adopting it
 * turns that document into one BeeSlides can rewrite in place.
 *
 * The caller MUST have obtained readwrite permission first — this only records
 * the handle. It is deliberately not exported through `window.beeslides`: adopting
 * a handle silently redirects where ⌘S writes, which is a user gesture, never
 * something a script should do behind their back.
 */
export function adoptFileHandle(handle: FsFileHandle): void {
  fileHandle = handle
}

/**
 * The name of the file this document is actually open AS, when knowable.
 *
 * Two sources, best first: a held FS Access handle, else this document's own
 * URL. The URL case is the one that matters — a `.beeslides.html` double-clicked
 * from disk grants no handle, which is exactly when a save picker appears with
 * nothing useful in it.
 *
 * Only a name ending in `.beeslides.html` counts. That deliberately excludes the
 * hosted demo (`/slides/`, `index.html`), so the anonymous try-it deck still
 * falls back to naming itself after its title instead of "index".
 */
export function openedFileName(): string | null {
  if (fileHandle?.name) return fileHandle.name
  try {
    const base = decodeURIComponent(new URL(location.href).pathname.split('/').pop() ?? '')
    return hasDocExt(base) ? base : null
  } catch {
    return null
  }
}

/** Strip the document extension: "Q3-board.beeslides.html" -> "Q3-board". */
export const fileBase = (name: string) => stripDocExt(name)

// --- writing a whole file ---------------------------------------------------

/** Whether we hold a writable handle to the file (in-place update possible). */
export const hasFileHandle = () => fileHandle !== null

/** Overwrite the held file with arbitrary html (the freshly updated shell). */
export async function writeUpdatedFile(html: string): Promise<void> {
  if (!fileHandle) throw new Error('no file handle')
  await writeHandle(fileHandle, html)
}

/**
 * Save updated html via a picker (user points it at the file they have open,
 * or anywhere else). Returns false if cancelled. Keeps the picked handle so
 * subsequent ⌘S saves go to the same place.
 */
export async function writeUpdatedFileAs(
  html: string,
  doc: KernelDoc,
  opts: { suffix?: string; keepHandle?: boolean; suggestedName?: string; purpose?: SavePurpose } = {},
): Promise<boolean> {
  if (!hasFsAccess()) {
    downloadFile(html, opts.suggestedName ?? suggestedFileName(doc, opts.suffix))
    return true
  }
  // `share` is the right default — the callers are exports. A caller that
  // overwrites the open document must say so: a host reads only the picker id,
  // and `slidomingo-share` tells it "a new file the author will choose".
  const handle = await pickHandle(doc, opts.suffix, opts.suggestedName, opts.purpose ?? 'share')
  if (!handle) return false
  // Share/export artifacts must NOT become the ⌘S target — otherwise the next
  // save would overwrite e.g. a read-only copy with the full, editable
  // document. Only an explicit keepHandle retargets in-place saving.
  if (opts.keepHandle) fileHandle = handle
  await writeHandle(handle, html)
  return true
}
