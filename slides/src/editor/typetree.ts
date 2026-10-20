// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The Layout Manager's slide-type sidebar — PowerPoint Slide Master–style:
// an always-visible column of slide-type thumbnails beside the canvas the
// selected type is open on (layoutmanager.ts owns that column). Rows are
// `doc.layouts` in true depth-first order (`model.ts`'s `slideTypeRows` —
// each parent immediately followed by its whole subtree), indented per
// depth with CSS tree guides (├ └ │) so parent → child reads at a glance.
//
// Drag-and-drop both REORDERS and REPARENTS (docs/DECISIONS.md 2026-09-23):
// the row's top quarter drops before it (as its sibling), the bottom quarter
// after it (or, when it has children showing below it, as its FIRST child —
// that is where the line visually sits), the middle makes the dragged type
// its child. A drop onto yourself or your own subtree is refused (no
// indicator, not-allowed cursor); the empty area below the last row makes
// the dragged type a root, placed last. Reparenting means "inherit from the
// new parent" — the look changes at once and the moved subtree's linked
// slides are resynced in the SAME commit (`resyncLinkedSlides` —
// editor.ts's `syncLayoutInstances` only watches the open surface, which a
// dragged row usually isn't), so one ⌘Z restores everything. "Detach from
// parent (keep look)" in the row menu is the alternative that keeps the
// look.
//
// LEAVES (docs/DECISIONS.md 2026-09-28): under each row, collapsed by
// default, the slides that follow that type DIRECTLY (`directlyLinked`);
// a "Not linked" group at the bottom holds every free slide
// (`unlinkedSlides` — flattened .pptx slides land there). The grouping is
// derived from `slide.layoutId` and is independent of deck order: dragging
// a leaf onto a type row RELINKS the slide (`relinkSlide`, the green/amber
// outline is its `relinkPreview` verdict) and never reorders the deck;
// dropping it on "Not linked" unlinks it.
//
// Same builder idiom as cardgrid.ts: a plain function over `Store` +
// callbacks. It never holds a `Slide` object across events — everything is
// looked up by id in `store.doc` at event time, because undo/redo REPLACE
// `store.doc` wholesale (store.ts `restore`) and a captured object would
// silently edit a detached copy. Re-rendering is the caller's job: every
// mutation here is a `store.commit`, whose 'doc' event layoutmanager.ts
// answers with `refresh()` (structure changed) or `scheduleThumbs()`.

import type { Store } from '../store'
import {
  createSlideTypeAsBasis, createSlideTypeAsParentChild, detachSlideType, directlyLinked, effectiveLayout,
  isDescendantOf, layoutElementIds, linkedSlides, moveSlideTypeInTree, relinkPreview, relinkSlide, removeLayout,
  resyncLinkedSlides, slideTypeRows, unlinkedSlides,
  type RelinkPreview, type Slide, type SlideElement, type SlidomingoDoc,
} from '../model'
import { renderThumbnail } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'

/** dataTransfer key for a dragged slide-type row — carries the layout ID
 *  (never an index), same idea as editor.ts's `text/beeslides-slide`. */
const DRAG_TYPE = 'text/slidomingo-slidetype'
/** dataTransfer key for a dragged slide LEAF — carries the slide id. */
const LEAF_DRAG_TYPE = 'text/slidomingo-slide-leaf'
/** The "Not linked" group's key in the open-state map (never a layout id —
 *  those are minted `layout-…`/`pptx-…`). */
const UNLINKED = ':unlinked'

const LEAF_THUMB = 64
const ROOT_THUMB = 168
const CHILD_THUMB = 136

export interface TypeTreeOptions {
  store: Store
  /** Currently selected slide type id (the one open on the canvas). */
  selectedId: () => string | null
  /** Nav-only: point the canvas at `id`. Caller re-renders. */
  onSelect: (id: string) => void
  /** "+ New slide type" — opens the creation dialog. */
  onNew: () => void
  /** "Import…" — layoutmanager.ts's `importLayoutFamily`. */
  onImport: () => void
  /** Element-id reminting for "Duplicate as independent copy" —
   *  layoutmanager.ts's `remintElements` (passed in rather than imported,
   *  to keep this module free of a cycle back into layoutmanager.ts). */
  remint: (elements: SlideElement[]) => SlideElement[]
  /** A leaf's "Go to slide": leave the Layout Manager and show `slideId`. */
  onGoToSlide: (slideId: string) => void
}

export interface TypeTree {
  root: HTMLElement
  /** Rebuild every row (structure changed) — keeps the list's scrollTop. */
  refresh(): void
  /** Debounced (~150ms) re-render of just the thumbnails that changed. */
  scheduleThumbs(): void
  /** Turn a row's name into an inline rename input. */
  startRename(id: string): void
}

type DropZone = 'before' | 'after' | 'child' | 'firstChild'

export function buildTypeTree(opts: TypeTreeOptions): TypeTree {
  const { store } = opts
  const doc = (): SlidomingoDoc => store.doc
  const find = (id: string): Slide | undefined => doc().layouts?.find((l) => l.id === id)

  const root = div('ed-typetree')
  const bar = div('ed-typetree-bar')
  bar.append(
    btn(ICONS.plus, t('New slide type'), () => opts.onNew(), t('Create a new slide type — blank, a child of another, or an independent copy')),
    btn(ICONS.template, t('Import…'), () => opts.onImport(),
      t('Bring another BeeSlides file’s slide types and their building blocks/fonts into this document')),
  )
  const list = div('ed-typetree-list')
  root.append(bar, list)

  /** Last-rendered thumbnail signature per row id — `scheduleThumbs` only
   *  re-renders a row whose effective content actually changed. */
  const thumbSig = new Map<string, string>()
  let dragId: string | null = null
  /** The slide leaf being dragged, and the verdict per target type id for
   *  this drag (dragover fires continuously; a preview is a full
   *  applyLayout pass, so compute it once per target). */
  let leafDragId: string | null = null
  const leafVerdicts = new Map<string, RelinkPreview | null>()

  // ---- rows ------------------------------------------------------------------

  function refresh() {
    const scroll = list.scrollTop
    closeMenu()
    thumbSig.clear()
    list.replaceChildren()
    const d = doc()
    const rows = slideTypeRows(d)
    const known = layoutElementIds(d)
    // Tree guides: a row is the LAST of its siblings when the next row at its
    // depth-or-shallower is shallower (or there is none). Guide column k of a
    // row continues (│) while its depth-k ancestor still has a later sibling.
    const isLast = rows.map((r, i) => {
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].depth < r.depth) return true
        if (rows[j].depth === r.depth) return false
      }
      return true
    })
    const ancestorAt: number[] = []
    rows.forEach((r, i) => {
      ancestorAt[r.depth] = i
      const guides: Array<'pipe' | 'blank' | 'tee' | 'elbow'> = []
      for (let k = 1; k < r.depth; k++) guides.push(isLast[ancestorAt[k]] ? 'blank' : 'pipe')
      if (r.depth > 0) guides.push(isLast[i] ? 'elbow' : 'tee')
      const hasKids = i + 1 < rows.length && rows[i + 1].depth > r.depth
      list.appendChild(buildRow(r.layout, r.depth, guides, hasKids))
      if (isOpen(r.layout.id)) {
        // Leaves sit between the row and its children: continue every guide
        // the row itself continues, its own connector while it has later
        // siblings, and the line down to its first child.
        const through: string[] = guides.map((g) => (g === 'tee' ? 'pipe' : g === 'elbow' ? 'blank' : g))
        through.push(hasKids ? 'pipe' : 'blank')
        for (const slide of directlyLinked(d, r.layout.id)) list.appendChild(buildLeaf(slide, through, known))
      }
    })
    const tail = div('ed-typetree-tail')
    wireTailDrop(tail)
    list.appendChild(tail)
    if (d.slides.length) {
      list.appendChild(buildUnlinkedHeader())
      if (isOpen(UNLINKED)) for (const slide of unlinkedSlides(d)) list.appendChild(buildLeaf(slide, [], known))
    }
    list.scrollTop = scroll
  }

  // ---- leaf open state -------------------------------------------------------

  /** Pure VIEW state, per document — same convention as editor.ts's
   *  section collapse state (`slidomingo-sections-open-<docId>`). */
  const openKey = () => `slidomingo-typetree-open-${doc().docId}`
  function isOpen(id: string): boolean {
    return lsJson<Record<string, boolean>>(openKey(), {})[id] ?? false
  }
  function setOpen(id: string, open: boolean) {
    const state = lsJson<Record<string, boolean>>(openKey(), {})
    if (open) state[id] = true
    else delete state[id]
    lsSet(openKey(), JSON.stringify(state))
    refresh()
  }

  /** "▸ 3 slides" — the leaf disclosure, plus the subtree total when it
   *  differs (the old single count covered the whole subtree unlabelled). */
  function buildSlidesLine(id: string, direct: number, total: number): HTMLElement | null {
    if (!direct && !total) return null
    const line = div('ed-typetree-slides')
    if (direct) {
      const open = isOpen(id)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'ed-typetree-disclose'
      toggle.setAttribute('aria-expanded', String(open))
      toggle.textContent = `${open ? '▾' : '▸'} ${direct === 1 ? t('1 slide') : t('{n} slides', { n: direct })}`
      toggle.title = open ? t('Hide the slides that use this slide type') : t('Show the slides that use this slide type')
      toggle.addEventListener('click', (ev) => { ev.stopPropagation(); setOpen(id, !open) })
      toggle.addEventListener('mousedown', (ev) => ev.stopPropagation())
      line.appendChild(toggle)
    }
    if (total !== direct) {
      const all = document.createElement('span')
      all.className = 'ed-typetree-count'
      all.textContent = total === 1 ? t('1 slide incl. subtypes') : t('{n} slides incl. subtypes', { n: total })
      all.title = t('Live on {n} slide(s)', { n: total })
      line.appendChild(all)
    }
    return line
  }

  /** What fields and footer switches resolve against — a thumbnail changes
   *  with Document properties too, not only with its own elements. */
  function fieldSig(): string {
    return JSON.stringify([doc().headerFooter ?? null, doc().meta ?? null, doc().title, doc().terms ?? null, store.termPreview])
  }
  function leafSig(slide: Slide): string {
    return JSON.stringify([slide.elements, slide.background, slide.footer ?? null, fieldSig()])
  }

  function thumbWidth(depth: number): number {
    return depth === 0 ? ROOT_THUMB : Math.max(96, CHILD_THUMB - (depth - 1) * 8)
  }

  function renderThumbFor(ly: Slide, depth: number): HTMLElement {
    const effective = effectiveLayout(doc(), ly)
    thumbSig.set(ly.id, JSON.stringify([effective.elements, effective.background, depth, fieldSig()]))
    return renderThumbnail(effective, doc(), thumbWidth(depth), { fieldMarkers: 'name', language: store.termPreview ?? undefined })
  }

  function buildRow(ly: Slide, depth: number, guides: string[], hasVisibleChildren: boolean): HTMLElement {
    const id = ly.id
    const row = div('ed-typetree-row')
    row.dataset.id = id
    row.dataset.depth = String(depth)
    if (hasVisibleChildren) row.dataset.parent = '1'
    if (id === opts.selectedId()) row.classList.add('active')
    row.draggable = true

    for (const g of guides) row.appendChild(div(`ed-typetree-guide ed-typetree-guide-${g}`))

    const card = div('ed-typetree-card')
    const thumb = div('ed-typetree-thumb')
    thumb.appendChild(renderThumbFor(ly, depth))

    const actions = div('ed-typetree-actions')
    const addB = iconBtn(ICONS.plus, t('New child slide type — inherits everything from this one'), () => newChild(id))
    const delB = iconBtn(ICONS.trash, t('Delete this slide type'), () => deleteType(id))
    delB.classList.add('ed-typetree-del')
    actions.append(addB, delB)
    thumb.appendChild(actions)

    const meta = div('ed-typetree-meta')
    const name = document.createElement('span')
    name.className = 'ed-typetree-name'
    name.textContent = ly.name || t('Untitled')
    name.title = t('Double-click to rename')
    if (doc().defaultLayoutId === id && !ly.parentOnly) {
      const star = document.createElement('span')
      star.className = 'ed-typetree-star'
      star.textContent = '★'
      star.title = t('Default slide type')
      meta.appendChild(star)
    }
    meta.appendChild(name)
    if (ly.parentOnly) {
      row.classList.add('is-parent-only')
      const badge = document.createElement('span')
      badge.className = 'ed-typetree-master'
      badge.textContent = t('Master')
      badge.title = t('Only a parent: its children inherit from it, but no slide uses it directly — it is not offered as a slide type')
      meta.appendChild(badge)
    }
    card.append(thumb, meta)
    const slidesLine = buildSlidesLine(id, directlyLinked(doc(), id).length, linkedSlides(doc(), id).filter((s) => !s.stateOf).length)
    if (slidesLine) card.appendChild(slidesLine)
    row.appendChild(card)

    row.addEventListener('click', () => { if (opts.selectedId() !== id) opts.onSelect(id) })
    name.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRename(id) })
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      openMenu(id, ev.clientX, ev.clientY)
    })
    wireRowDrag(row, card, id)
    return row
  }

  // ---- leaves ----------------------------------------------------------------

  /** "Slide N" + the slide's title: its title-role text, else its LARGEST
   *  written text that is not layout chrome. A flattened .pptx slide has no
   *  roles and bakes its footer ("- Intern -", "© …") in under slide-local
   *  ids, so "first text" would label every such slide with the footer. */
  function slideLabel(slide: Slide, known = layoutElementIds(doc())): { num: string; title: string } {
    const i = doc().slides.indexOf(slide)
    let best: { text: string; size: number } | undefined
    for (const e of slide.elements) {
      if (e.type !== 'text') continue
      const text = plainText(e.html).trim()
      if (!text) continue
      if (e.role === 'title') { best = { text, size: Infinity }; break }
      if (!known.has(e.id) && (!best || e.fontSize > best.size)) best = { text, size: e.fontSize }
    }
    return { num: t('Slide {n}', { n: i + 1 }), title: best?.text ?? '' }
  }

  function leafThumb(slide: Slide): HTMLElement {
    thumbSig.set(`slide:${slide.id}`, leafSig(slide))
    return renderThumbnail(slide, doc(), LEAF_THUMB)
  }

  function buildLeaf(slide: Slide, guides: string[], known: Set<string>): HTMLElement {
    const id = slide.id
    const leaf = div('ed-typetree-leaf')
    leaf.dataset.slideId = id
    leaf.draggable = true
    if (slide.hidden) leaf.classList.add('is-hidden')
    for (const g of guides) leaf.appendChild(div(`ed-typetree-guide ed-typetree-guide-${g}`))
    const body = div('ed-typetree-leafbody')
    const thumb = div('ed-typetree-leafthumb')
    thumb.appendChild(leafThumb(slide))
    const label = slideLabel(slide, known)
    const text = div('ed-typetree-leaftext')
    const num = document.createElement('span')
    num.className = 'ed-typetree-leafnum'
    num.textContent = label.num
    text.appendChild(num)
    if (label.title) {
      const title = document.createElement('span')
      title.className = 'ed-typetree-leaftitle'
      title.textContent = label.title
      text.appendChild(title)
    }
    body.append(thumb, text)
    leaf.appendChild(body)
    leaf.title = t('Double-click to go to this slide · drag it onto a slide type to make it follow that type')
    leaf.addEventListener('dblclick', () => opts.onGoToSlide(id))
    leaf.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      openLeafMenu(id, leaf, ev.clientX, ev.clientY)
    })
    leaf.addEventListener('dragstart', (ev) => {
      ev.stopPropagation()
      leafDragId = id
      leafVerdicts.clear()
      closeMenu()
      ev.dataTransfer!.setData(LEAF_DRAG_TYPE, id)
      ev.dataTransfer!.effectAllowed = 'move'
      leaf.classList.add('dragging')
    })
    leaf.addEventListener('dragend', () => {
      leafDragId = null
      leafVerdicts.clear()
      leaf.classList.remove('dragging')
      clearDropMarks()
    })
    return leaf
  }

  function buildUnlinkedHeader(): HTMLElement {
    const n = unlinkedSlides(doc()).length
    const open = isOpen(UNLINKED)
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'ed-typetree-unlinked'
    head.setAttribute('aria-expanded', String(open))
    head.textContent = `${open ? '▾' : '▸'} ${t('Not linked')} · ${n}`
    head.title = t('Slides that follow no slide type — drop a slide here to unlink it (it keeps its look)')
    head.addEventListener('click', () => setOpen(UNLINKED, !open))
    head.addEventListener('dragover', (ev) => {
      if (!leafDragId || !ev.dataTransfer?.types.includes(LEAF_DRAG_TYPE)) return
      const slide = doc().slides.find((s) => s.id === leafDragId)
      if (!slide?.layoutId || !find(slide.layoutId)) { ev.dataTransfer.dropEffect = 'none'; return }
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'move'
      clearDropMarks()
      head.classList.add('drop-unlink')
    })
    head.addEventListener('dragleave', () => head.classList.remove('drop-unlink'))
    head.addEventListener('drop', (ev) => {
      ev.preventDefault()
      clearDropMarks()
      const slideId = leafDragId
      leafDragId = null
      if (slideId) unlinkLeaf(slideId)
    })
    return head
  }

  /** The verdict for dropping the dragged leaf on type `targetId`, or null
   *  when that drop means nothing (it already follows that type) or is not
   *  allowed (a master, `parentOnly`, is never a slide's type). */
  function leafVerdict(targetId: string): RelinkPreview | null {
    if (!leafDragId) return null
    if (leafVerdicts.has(targetId)) return leafVerdicts.get(targetId)!
    const slide = doc().slides.find((s) => s.id === leafDragId)
    const target = find(targetId)
    const v = slide && target && !target.parentOnly && slide.layoutId !== targetId ? relinkPreview(doc(), slide, target) : null
    leafVerdicts.set(targetId, v)
    return v
  }

  function showLeafVerdict(row: HTMLElement, v: RelinkPreview) {
    const partial = v.verdict === 'partial'
    row.classList.add(partial ? 'drop-partial' : 'drop-fit')
    const thumb = row.querySelector('.ed-typetree-thumb')
    if (!thumb || thumb.querySelector('.ed-typetree-verdict')) return
    const tag = div(`ed-typetree-verdict ${partial ? 'is-partial' : 'is-fit'}`)
    const n = v.floating.length
    tag.textContent = !partial ? t('✓ Fits') : n === 1 ? t('1 item floats') : t('{n} items float', { n })
    thumb.appendChild(tag)
  }

  function relinkLeaf(slideId: string, targetId: string) {
    const slide = doc().slides.find((s) => s.id === slideId)
    const target = find(targetId)
    if (!slide || !target || target.parentOnly || slide.layoutId === targetId) return
    const { num } = slideLabel(slide)
    let applied = null as RelinkPreview | null
    store.commit(() => { applied = relinkSlide(store.doc, slideId, targetId) })
    if (!applied) return
    const n = applied.floating.length
    const name = target.name || t('Untitled')
    toastWithUndo(store, !n
      ? t('{slide} now follows “{name}”', { slide: num, name })
      : n === 1
        ? t('{slide} now follows “{name}” — 1 item has no placeholder and stays on top', { slide: num, name })
        : t('{slide} now follows “{name}” — {n} items have no placeholder and stay on top', { slide: num, name, n }))
  }

  function unlinkLeaf(slideId: string) {
    const slide = doc().slides.find((s) => s.id === slideId)
    if (!slide?.layoutId) return
    const { num } = slideLabel(slide)
    store.commit(() => {
      const s = store.doc.slides.find((x) => x.id === slideId)
      if (s) delete s.layoutId
    })
    toastWithUndo(store, t('{slide} no longer follows a slide type — it keeps its look', { slide: num }))
  }

  // ---- drag and drop --------------------------------------------------------

  function clearDropMarks() {
    for (const el of list.querySelectorAll('.drop-before, .drop-after, .drop-child, .drop-firstchild, .drop-root, .drop-fit, .drop-partial, .drop-unlink')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-child', 'drop-firstchild', 'drop-root', 'drop-fit', 'drop-partial', 'drop-unlink')
    }
    for (const el of list.querySelectorAll('.ed-typetree-verdict')) el.remove()
  }

  /** The move a drop in `zone` of target row `targetId` means, or null when
   *  refused (a cycle, or dropping onto yourself). `parentId` undefined =
   *  root. `beforeId` undefined = last among the new parent's children. */
  function resolveDrop(targetId: string, zone: DropZone): { parentId: string | undefined; beforeId: string | undefined } | null {
    if (!dragId || targetId === dragId) return null
    const d = doc()
    const target = find(targetId)
    if (!target) return null
    if (zone === 'child' || zone === 'firstChild') {
      if (isDescendantOf(d, targetId, dragId)) return null
      const first = zone === 'firstChild' ? (d.layouts ?? []).find((l) => l.parentId === targetId && l.id !== dragId) : undefined
      return { parentId: targetId, beforeId: first?.id }
    }
    const parentId = target.parentId && find(target.parentId) ? target.parentId : undefined
    if (parentId && isDescendantOf(d, parentId, dragId)) return null
    if (zone === 'before') return { parentId, beforeId: targetId }
    // "after" = before the target's next sibling (the dragged row itself
    // excluded), or last when the target is the last sibling.
    const siblings = (d.layouts ?? []).filter((l) => l.id !== dragId && (l.parentId ?? undefined) === (target.parentId ?? undefined))
    return { parentId, beforeId: siblings[siblings.indexOf(target) + 1]?.id }
  }

  function zoneFor(row: HTMLElement, card: HTMLElement, clientY: number): DropZone {
    const r = card.getBoundingClientRect()
    const f = (clientY - r.top) / Math.max(1, r.height)
    if (f < 0.25) return 'before'
    if (f > 0.75) return row.dataset.parent ? 'firstChild' : 'after'
    return 'child'
  }

  function wireRowDrag(row: HTMLElement, card: HTMLElement, id: string) {
    row.addEventListener('dragstart', (ev) => {
      dragId = id
      closeMenu()
      ev.dataTransfer!.setData(DRAG_TYPE, id)
      ev.dataTransfer!.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => {
      dragId = null
      row.classList.remove('dragging')
      clearDropMarks()
    })
    row.addEventListener('dragover', (ev) => {
      if (leafDragId && ev.dataTransfer?.types.includes(LEAF_DRAG_TYPE)) {
        // A leaf has no before/after — the whole row means "follow this type".
        const v = leafVerdict(id)
        if (!row.classList.contains('drop-fit') && !row.classList.contains('drop-partial')) clearDropMarks()
        if (!v) { ev.dataTransfer.dropEffect = 'none'; return }
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'move'
        showLeafVerdict(row, v)
        return
      }
      if (!dragId || !ev.dataTransfer?.types.includes(DRAG_TYPE)) return
      const zone = zoneFor(row, card, ev.clientY)
      clearDropMarks()
      if (!resolveDrop(id, zone)) { ev.dataTransfer.dropEffect = 'none'; return }
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'move'
      row.classList.add(zone === 'firstChild' ? 'drop-firstchild' : `drop-${zone}`)
    })
    row.addEventListener('dragleave', (ev) => {
      if (row.contains(ev.relatedTarget as Node | null)) return
      row.classList.remove('drop-before', 'drop-after', 'drop-child', 'drop-firstchild', 'drop-fit', 'drop-partial')
      row.querySelector('.ed-typetree-verdict')?.remove()
    })
    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      if (leafDragId) {
        const slideId = leafDragId
        leafDragId = null
        clearDropMarks()
        relinkLeaf(slideId, id)
        return
      }
      const zone = zoneFor(row, card, ev.clientY)
      const move = resolveDrop(id, zone)
      clearDropMarks()
      if (move) applyMove(move.parentId, move.beforeId)
    })
  }

  function wireTailDrop(tail: HTMLElement) {
    tail.addEventListener('dragover', (ev) => {
      if (!dragId || !ev.dataTransfer?.types.includes(DRAG_TYPE)) return
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'move'
      clearDropMarks()
      tail.classList.add('drop-root')
    })
    tail.addEventListener('dragleave', () => tail.classList.remove('drop-root'))
    tail.addEventListener('drop', (ev) => {
      ev.preventDefault()
      clearDropMarks()
      if (dragId) applyMove(undefined, undefined)
    })
  }

  /** Commit a move of the dragged row — one undo step covering the tree
   *  move AND the resync of every slide linked to the moved subtree. A
   *  drop that would leave everything exactly where it is commits nothing
   *  (no empty undo entry). */
  function applyMove(parentId: string | undefined, beforeId: string | undefined) {
    const id = dragId
    dragId = null
    if (!id) return
    const d = doc()
    const moved = find(id)
    if (!moved) return
    const oldParentId = moved.parentId && find(moved.parentId) ? moved.parentId : undefined
    const before = orderSig(d)
    // Dry-run on a cheap structural clone to skip no-op drops.
    const probe = { layouts: (d.layouts ?? []).map((l) => ({ id: l.id, parentId: l.parentId })) } as unknown as SlidomingoDoc
    if (!moveSlideTypeInTree(probe, id, parentId, beforeId) || orderSig(probe) === before) return
    store.commit(() => {
      if (moveSlideTypeInTree(store.doc, id, parentId, beforeId)) {
        resyncLinkedSlides(store.doc, id, layoutElementIds(store.doc))
      }
    })
    if (oldParentId !== parentId) {
      const name = moved.name || t('Untitled')
      const newParent = parentId ? find(parentId) : undefined
      const message = newParent
        ? t('“{name}” now inherits from “{parent}”', { name, parent: newParent.name || t('Untitled') })
        : !moved.elements.length
          ? t('“{name}” no longer inherits anything and is now blank', { name })
          : t('“{name}” no longer inherits from its parent', { name })
      toastWithUndo(store, message)
    }
  }

  // ---- actions ---------------------------------------------------------------

  function newChild(parentId: string) {
    const parent = find(parentId)
    if (!parent) return
    let childId = ''
    store.commit(() => { childId = createSlideTypeAsParentChild(store.doc, parent, t('New slide type')).id })
    opts.onSelect(childId)
    startRename(childId)
  }

  function deleteType(id: string) {
    const ly = find(id)
    if (!ly) return
    const kids = (doc().layouts ?? []).filter((l) => l.parentId === id).length
    const message = kids
      ? t('Delete “{name}”? Its {n} child slide type(s) keep their current look (what they inherited is copied into them). Slides linked to it keep their content but stop syncing.', { name: ly.name || t('Untitled'), n: kids })
      : t('Delete this slide type? Slides already linked to it keep their content but stop syncing.')
    if (!window.confirm(message)) return
    store.commit(() => removeLayout(store.doc, id))
  }

  function duplicate(id: string) {
    const ly = find(id)
    if (!ly) return
    let copyId = ''
    store.commit(() => {
      copyId = createSlideTypeAsBasis(store.doc, ly, t('{name} (copy)', { name: ly.name || t('Untitled') }), opts.remint).id
    })
    opts.onSelect(copyId)
  }

  function startRename(id: string) {
    const row = list.querySelector<HTMLElement>(`.ed-typetree-row[data-id="${CSS.escape(id)}"]`)
    const name = row?.querySelector<HTMLElement>('.ed-typetree-name')
    const ly = find(id)
    if (!row || !name || !ly) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'ed-typetree-rename'
    input.value = ly.name || ''
    row.draggable = false
    name.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      row.draggable = true
      const next = input.value.trim()
      const cur = find(id)
      if (save && cur && next && next !== cur.name) {
        store.commit(() => { const l = store.doc.layouts?.find((x) => x.id === id); if (l) l.name = next })
      } else {
        input.replaceWith(name)
      }
    }
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', (ev) => ev.stopPropagation())
  }

  // ---- context menu ----------------------------------------------------------

  let menuClose: (() => void) | null = null
  function closeMenu() { menuClose?.() }

  /** A slide type row's right-click menu. */
  function openMenu(id: string, clientX: number, clientY: number) {
    const ly = find(id)
    if (!ly) return
    popMenu(clientX, clientY, (item, sep) => {
      item(t('New child slide type'), () => newChild(id))
      item(t('Duplicate as independent copy'), () => duplicate(id))
      sep()
      item(t('Rename'), () => startRename(id))
      item(t('Set as default'), () => store.commit(() => { store.doc.defaultLayoutId = id }), doc().defaultLayoutId !== id && !ly.parentOnly)
      item(ly.parentOnly ? t('Offer as a slide type') : t('Use only as a parent'), () => store.commit(() => {
        const l = store.doc.layouts?.find((x) => x.id === id)
        if (!l) return
        if (l.parentOnly) delete l.parentOnly
        else l.parentOnly = true
      }))
      item(t('Detach from parent (keep look)'), () => store.commit(() => detachSlideType(store.doc, id)), !!ly.parentId)
      sep()
      item(t('Delete'), () => deleteType(id))
    })
  }

  /** A slide leaf's right-click menu. "Change slide type…" is editor.ts's
   *  own "Change layout…" picker, pointed at this slide. */
  function openLeafMenu(slideId: string, anchor: HTMLElement, clientX: number, clientY: number) {
    const slide = doc().slides.find((s) => s.id === slideId)
    if (!slide) return
    const linked = !!(slide.layoutId && find(slide.layoutId))
    popMenu(clientX, clientY, (item, sep) => {
      item(t('Change slide type…'), () =>
        document.dispatchEvent(new CustomEvent('slidomingo:apply-layout', { detail: { anchor, slideId } })))
      item(t('Go to slide'), () => opts.onGoToSlide(slideId))
      sep()
      item(t('Unlink (keep look)'), () => unlinkLeaf(slideId), linked)
    })
  }

  /** Fixed-position, viewport-clamped popover — same idiom as
   *  contextmenu.ts / comments.ts. */
  function popMenu(
    clientX: number, clientY: number,
    fill: (item: (label: string, onClick: () => void, enabled?: boolean) => void, sep: () => void) => void,
  ) {
    closeMenu()
    const menu = div('ed-ctx-menu')
    const item = (label: string, onClick: () => void, enabled = true) => {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      b.textContent = label
      b.disabled = !enabled
      b.addEventListener('click', () => { close(); onClick() })
      menu.appendChild(b)
    }
    const sep = () => menu.appendChild(div('ed-menu-sep'))
    fill(item, sep)

    document.body.appendChild(menu)
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - r.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - r.height - 4))}px`

    const close = () => {
      menu.remove()
      menuClose = null
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
    }
    const onOutside = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) close() }
    // Escape closes just the menu — stopPropagation keeps the Layout
    // Manager's own capture-phase Escape (exit the overlay) from also firing.
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    menuClose = close
    setTimeout(() => {
      if (menuClose !== close) return
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('keydown', onKey, true)
    })
  }

  // ---- thumbnails ------------------------------------------------------------

  let thumbTimer = 0
  function scheduleThumbs() {
    clearTimeout(thumbTimer)
    thumbTimer = window.setTimeout(() => {
      if (!root.isConnected) return
      for (const row of list.querySelectorAll<HTMLElement>('.ed-typetree-row')) {
        const ly = find(row.dataset.id!)
        const host = row.querySelector<HTMLElement>('.ed-typetree-thumb')
        if (!ly || !host) continue
        const depth = Number(row.dataset.depth)
        const effective = effectiveLayout(doc(), ly)
        const sig = JSON.stringify([effective.elements, effective.background, depth, fieldSig()])
        if (thumbSig.get(ly.id) === sig) continue
        host.querySelector('.beeslides-thumb-surface')?.replaceWith(renderThumbFor(ly, depth))
      }
      // Leaves: a linked slide changes whenever its type is edited (resync).
      for (const leaf of list.querySelectorAll<HTMLElement>('.ed-typetree-leaf')) {
        const slide = doc().slides.find((s) => s.id === leaf.dataset.slideId)
        const host = leaf.querySelector<HTMLElement>('.ed-typetree-leafthumb')
        if (!slide || !host) continue
        if (thumbSig.get(`slide:${slide.id}`) === leafSig(slide)) continue
        host.querySelector('.beeslides-thumb-surface')?.replaceWith(leafThumb(slide))
      }
    }, 150)
  }

  refresh()
  return { root, refresh, scheduleThumbs, startRename }
}

/** Order + parent signature of `doc.layouts` — "did this move change
 *  anything?" */
function orderSig(doc: SlidomingoDoc): string {
  return (doc.layouts ?? []).map((l) => `${l.id}<${l.parentId ?? ''}`).join('|')
}

/** A toast with an inline Undo button (the plain `.ed-toast` is
 *  pointer-events:none) — for a drop whose effect is a look change the user
 *  may not have expected. */
export function toastWithUndo(store: Store, message: string) {
  document.querySelector('.ed-toast')?.remove()
  const el = div('ed-toast ed-toast-action')
  const text = document.createElement('span')
  text.textContent = message
  const undo = document.createElement('button')
  undo.className = 'ed-toast-btn'
  undo.textContent = t('Undo')
  undo.addEventListener('click', () => { store.undo(); el.remove() })
  el.append(text, undo)
  document.body.appendChild(el)
  setTimeout(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 5000)
}

/** Visible text of an element's html — parsed inertly (DOMParser runs no
 *  script and loads no image, unlike `innerHTML` on a live element). */
function plainText(html: string): string {
  // Paragraph/line breaks become spaces, or "Line one" + "Line two" reads "Line oneLine two".
  const spaced = html.replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, ' $&')
  return (new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ')
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function btn(icon: string, label: string, onClick: () => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = `${icon}<span>${label}</span>`
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
function iconBtn(icon: string, title: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-typetree-act'
  b.type = 'button'
  b.innerHTML = icon
  b.title = title
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick() })
  // Keep a click on the action from starting a row drag.
  b.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return b
}
