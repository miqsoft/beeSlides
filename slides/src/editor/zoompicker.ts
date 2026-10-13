// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Insert ▸ Zoom — "Slide or section zoom…" and "Summary zoom…" (PowerPoint's
// Slide / Section / Summary Zoom; model.ts ZoomElement, DECISIONS 2026-10-09).
//
// One modal for both: a Slides tab and a Sections tab of thumbnails. A slide
// or section zoom picks ONE target and inserts a tile on the current slide; a
// summary zoom picks several and inserts a whole overview slide (one tile per
// section — a picked slide that does not start a section yet starts one) in a
// "Summary" section of its own, as ONE commit. The panel's "Change…" reuses
// the single-pick mode.

import type { Store } from '../store'
import type { SlideCanvas } from './canvas'
import {
  defaultZoom, insertSummaryZoom, isLightBg, sectionRange, sectionsInOrder,
  type Slide, type SlidomingoDoc, type ZoomTarget,
} from '../model'
import { renderThumbnail } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { flipMenuIfNeeded } from './floatingposition'

export interface ZoomPickOpts {
  /** one target, picked by clicking it; or several, confirmed with Insert */
  multi: boolean
  title: string
  /** the slide the tile will sit on — not offered as a single target */
  overviewId?: string
  /** pre-selected in single mode ("Change…") */
  current?: ZoomTarget
  onPick: (targets: ZoomTarget[]) => void
}

const targetKey = (tg: ZoomTarget | undefined): string =>
  !tg ? '' : 'slide' in tg ? `slide:${tg.slide}` : `section:${tg.section}`

/** "3 — Results", the number the show displays for slide `i`. */
export function zoomSlideLabel(doc: SlidomingoDoc, i: number): string {
  const s = doc.slides[i]
  const n = doc.slides.slice(0, i + 1).filter((x) => !x.stateOf).length
  const title = slideTitle(s)
  return title ? `${n} — ${title}` : String(n)
}

/** A slide's name, else its title text (read in an inert document). */
export function slideTitle(s: Slide | undefined): string {
  if (!s) return ''
  if (s.name) return s.name
  const el = s.elements.find((e) => e.type === 'text' && e.role === 'title')
  if (el?.type !== 'text') return ''
  return new DOMParser().parseFromString(el.html, 'text/html').body.textContent?.trim().slice(0, 60) ?? ''
}

/** What a tile's target reads as in the panel ("Slide 3 — Results", "Section: Methods"). */
export function zoomTargetLabel(doc: SlidomingoDoc, target: ZoomTarget | undefined): string {
  if (target && 'slide' in target) {
    const i = doc.slides.findIndex((s) => s.id === target.slide)
    if (i >= 0) return t('Slide {label}', { label: zoomSlideLabel(doc, i) })
  } else if (target && 'section' in target) {
    const sec = sectionsInOrder(doc).find((s) => s.id === target.section)
    if (sec) return t('Section: {name}', { name: sec.name })
  }
  return t('Zoom target missing')
}

export function openZoomPicker(store: Store, opts: ZoomPickOpts): void {
  const doc = store.doc
  document.querySelector('.ed-about-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'ed-about-overlay'
  const box = document.createElement('div')
  box.className = 'ed-about ed-zoompick'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const h = document.createElement('h2')
  h.textContent = opts.title
  box.appendChild(h)

  const sections = sectionsInOrder(doc)
  const picked = new Set<string>()
  const byKey = new Map<string, ZoomTarget>()
  let tab: 'slides' | 'sections' = opts.current && 'section' in opts.current && sections.length ? 'sections' : 'slides'

  const tabs = document.createElement('div')
  tabs.className = 'ed-seg ed-zoompick-tabs'
  tabs.setAttribute('role', 'tablist')
  const tabBtn = (key: typeof tab, label: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-seg-btn'
    b.textContent = label
    b.setAttribute('role', 'tab')
    b.dataset.tab = key
    b.addEventListener('click', () => { tab = key; paint() })
    return b
  }
  tabs.append(tabBtn('slides', t('Slides')), tabBtn('sections', t('Sections')))
  box.appendChild(tabs)

  const hint = document.createElement('p')
  hint.className = 'ed-about-fine'
  box.appendChild(hint)

  const grid = document.createElement('div')
  grid.className = 'ed-zoompick-grid'
  box.appendChild(grid)

  const actions = document.createElement('div')
  actions.className = 'ed-dialog-actions'
  const cancel = document.createElement('button')
  cancel.className = 'ed-btn'
  cancel.textContent = t('Cancel')
  cancel.addEventListener('click', () => close())
  actions.appendChild(cancel)
  const insert = document.createElement('button')
  insert.className = 'ed-btn ed-btn-primary'
  insert.textContent = t('Insert')
  insert.addEventListener('click', () => {
    const keys = [...picked]
    if (!keys.length) return
    close()
    opts.onPick(keys.map((k) => byKey.get(k)!))
  })
  if (opts.multi) actions.appendChild(insert)
  box.appendChild(actions)

  const card = (key: string, target: ZoomTarget, thumbOf: Slide, label: string, sub: string, disabled = false) => {
    byKey.set(key, target)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-zoompick-card'
    b.dataset.key = key
    b.disabled = disabled
    if (thumbOf.hidden) b.classList.add('ed-zoompick-hidden')
    const thumb = renderThumbnail(thumbOf, doc, 150)
    thumb.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'ed-zoompick-name'
    name.textContent = label
    b.append(thumb, name)
    if (sub) {
      const s = document.createElement('span')
      s.className = 'ed-zoompick-sub'
      s.textContent = sub
      b.appendChild(s)
    }
    const on = opts.multi ? picked.has(key) : targetKey(opts.current) === key
    b.classList.toggle('ed-zoompick-on', on)
    b.setAttribute('aria-pressed', String(on))
    b.addEventListener('click', () => {
      if (!opts.multi) { close(); opts.onPick([target]); return }
      if (picked.has(key)) picked.delete(key)
      else picked.add(key)
      paint()
    })
    grid.appendChild(b)
  }

  function paint() {
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.tab === tab
      b.classList.toggle('ed-btn-armed', on)
      b.setAttribute('aria-selected', String(on))
    }
    grid.replaceChildren()
    if (tab === 'slides') {
      hint.textContent = opts.multi
        ? t('Pick the slides that start each part — each one becomes a section with a tile on the summary slide.')
        : t('Pick the slide the tile zooms into. While presenting, clicking the tile plays it and zooms back out.')
      doc.slides.forEach((s, i) => {
        if (s.stateOf) return
        card(`slide:${s.id}`, { slide: s.id }, s, zoomSlideLabel(doc, i), s.hidden ? t('hidden') : '',
          !opts.multi && s.id === opts.overviewId)
      })
    } else {
      hint.textContent = sections.length
        ? (opts.multi
          ? t('Pick the sections to summarise — one tile each.')
          : t('Pick the section the tile zooms into. While presenting, clicking it plays the whole section and zooms back out.'))
        : t('This deck has no sections yet — add one with “New section here” between slides in the slide panel, or pick slides instead.')
      for (const sec of sections) {
        const r = sectionRange(doc, sec)
        const first = doc.slides[r.start]
        if (!first) continue
        const n = r.end - r.start
        card(`section:${sec.id}`, { section: sec.id }, first, sec.name, n === 1 ? t('1 slide') : t('{n} slides', { n }))
      }
    }
    insert.disabled = !picked.size
    insert.textContent = picked.size ? t('Insert ({n})', { n: picked.size }) : t('Insert')
  }
  paint()

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close() } }
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', onKey, true)
  overlay.appendChild(box)
  document.body.appendChild(overlay)
  ;(grid.querySelector<HTMLButtonElement>('.ed-zoompick-on') ?? grid.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
}

/** A tile on the current slide that zooms into `target`, framed for the slide's background. */
export function insertZoomTile(store: Store, canvas: SlideCanvas, target: ZoomTarget) {
  const { width: W, height: H } = store.doc.size
  const w = Math.round(W * 0.3)
  const h = Math.round((w * H) / W)
  const light = isLightBg(store.slide.background)
  canvas.insert(defaultZoom(target, {
    x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h,
    stroke: light ? '#D9D9D9' : '#FFFFFF', strokeWidth: 3, radius: 6,
  }))
}

/** Insert ▸ Zoom ▸ Slide or section zoom… */
export function pickSlideZoom(store: Store, canvas: SlideCanvas) {
  openZoomPicker(store, {
    multi: false,
    title: t('Slide or section zoom'),
    overviewId: store.slide.id,
    onPick: ([target]) => { if (target) insertZoomTile(store, canvas, target) },
  })
}

/** Insert ▸ Zoom ▸ Summary zoom… — a new overview slide, one commit, then shown. */
export function pickSummaryZoom(store: Store) {
  openZoomPicker(store, {
    multi: true,
    title: t('Summary zoom'),
    onPick: (targets) => {
      let id = ''
      store.commit(() => {
        const ov = insertSummaryZoom(store.doc, targets, t('Summary'), t('Summary'),
          (s) => slideTitle(s) || t('Section {n}', { n: store.doc.slides.indexOf(s) + 1 }))
        id = ov?.id ?? ''
      }, 'slides')
      const i = store.doc.slides.findIndex((s) => s.id === id)
      if (i >= 0) store.goTo(i)
    },
  })
}

/** The toolbar/ribbon "Zoom" dropdown (editor-only: the Layout Manager's
 *  surfaces never get it — a slide type cannot zoom into a deck's slides). */
export function zoomDropdown(store: Store, canvas: SlideCanvas): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-dropdown ed-slides-only'
  const menu = document.createElement('div')
  menu.className = 'ed-menu'
  const button = (icon: string, label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.className = 'ed-btn'
    b.innerHTML = `${icon}<span>${label}</span>`
    b.title = title
    b.addEventListener('click', onClick)
    return b
  }
  const trigger = button(ICONS.zoom, t('Zoom'), t('Insert a zoom — a live tile of another slide or section that the show zooms into'), () => {
    wrap.classList.toggle('open')
    if (wrap.classList.contains('open')) flipMenuIfNeeded(wrap, menu)
  })
  menu.append(
    button(ICONS.zoom, t('Slide or section zoom…'), t('A tile on this slide that zooms into one slide or section and back'), () => {
      wrap.classList.remove('open')
      pickSlideZoom(store, canvas)
    }),
    button(ICONS.grid, t('Summary zoom…'), t('A new overview slide with one tile per section'), () => {
      wrap.classList.remove('open')
      pickSummaryZoom(store)
    }),
  )
  wrap.append(trigger, menu)
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
  })
  return wrap
}
