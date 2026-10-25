// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// An icon set's panels: the icon and the set (nothing selected), the Drawing
// and Styles sections, and a selected shape's part and paint in a style.

import type { ShapeElement, Slide, SlideElement } from '../../model'
import { askText } from '../comments'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { iconShapes, iconShortSide, iconsetInfo, type IconsetGrid } from '../../iconset'
import {
  addExamplesFromFiles, addLook, describeStyleWithAi, examplePreviewUrl, findLook, iconExamples, iconExportTip, iconPreviewUrl, learnFromIcon, lookPreviewUrl, moveLook, removeExample, removeLook, restoreIconToSet,
  withStyle, writeIconsetInfo,
} from '../iconsetactions'
import { LOOK_PRESETS, clearTweaks, iconParts, iconTweaks, lookFromPreset, setTweak, tweakedIconCount, type IconPart } from '../../iconstyles'
import { loadMyLooks, lookFromClipText, lookToClipText, removeMyLook, saveMyLook } from '../iconlooklibrary'
import type { IconLook, IconPaint, IconShapeTweak, IconsetInfo, IconsetStyle } from '../../model'
import { LIMITS } from '../../untrusted'
import { type PanelContext, toast } from './context'

/** An icon set's panel: this icon (name, search words, what it shows, a
 *  real-size preview), then the set (brief, the one style, licence) and its
 *  actions. The actions run in the Editor (slidomingo:iconset events). */
export function buildIconsetPanel(ctx: PanelContext) {
  const doc = ctx.store.doc
  const slide = ctx.store.slide
  const info = iconsetInfo(doc)
  if (!info) return
  const act = (action: string) => () => document.dispatchEvent(new CustomEvent('slidomingo:iconset', { detail: { action } }))
  const field = (value: string, multi: boolean, placeholder: string, onCommit: (v: string) => void): HTMLElement => {
    const el = multi ? document.createElement('textarea') : document.createElement('input')
    if (el instanceof HTMLTextAreaElement) { el.rows = 3; el.className = 'ed-iconset-text' }
    else el.type = 'text'
    el.value = value
    el.placeholder = placeholder
    el.maxLength = LIMITS.prose
    el.addEventListener('change', () => onCommit(el.value))
    return el
  }
  const setInfo = (next: IconsetInfo) => ctx.edit(() => writeIconsetInfo(ctx.store.doc, next), true)
  const ai = !!window.slidomingoDesktop?.sendAgentPrompt
  const empty = doc.slides.filter((s) => !s.elements.length).length
  const drawB = () => {
    const draw = document.createElement('button')
    draw.className = 'ed-btn ed-btn-block'
    draw.textContent = empty === 1 ? t('Draw 1 empty icon') : empty ? t('Draw {n} empty icons', { n: empty }) : t('Draw with AI')
    draw.title = t('Claude drafts every empty icon (or the icons selected in the icon list) from native shapes, in the set style')
    draw.addEventListener('click', act('draw'))
    return draw
  }
  // a set with nothing drawn: point at the Claude chat (and Home ▸ Plan with
  // AI) instead of a second chat box in the panel (DECISIONS "No chat box in the panel")
  const planning = ai && doc.slides.every((s) => !s.elements.length)
  if (planning) {
    const start = document.createElement('p')
    start.className = 'ed-hint ed-iconset-start'
    start.textContent = t('Tell Claude in the chat what the set is for, or use Plan with AI in Home — Claude plans empty icons for you to check, then Draw.')
    ctx.host.appendChild(start)
    ctx.host.appendChild(drawB())
  }

  ctx.section('Icon')
  const nameField = field(slide.name ?? '', false, t('e.g. fingerprint'), (v) =>
    ctx.edit(() => { if (v.trim()) ctx.store.slide.name = v.trim(); else delete ctx.store.slide.name }, true))
  nameField.title = t('The icon’s name — also its file name when you export the set')
  ctx.row('Name', nameField)
  ctx.row('Keywords', field((slide.icon?.keywords ?? []).join(', '), false, t('search words, comma separated'), (v) =>
    ctx.edit(() => {
      const s = ctx.store.slide
      const keywords = v.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 32)
      const icon: NonNullable<Slide['icon']> = { ...s.icon, keywords }
      if (!keywords.length) delete icon.keywords
      if (Object.keys(icon).length) s.icon = icon; else delete s.icon
    }, true)))
  ctx.row('What it shows', field(slide.icon?.prompt ?? '', true, t('For Claude: e.g. a fingerprint inside a magnifying glass'), (v) =>
    ctx.edit(() => {
      const s = ctx.store.slide
      const icon: NonNullable<Slide['icon']> = { ...s.icon, prompt: v.trim() }
      if (!icon.prompt) delete icon.prompt
      if (Object.keys(icon).length) s.icon = icon; else delete s.icon
    }, true)))
  if (slide.elements.length) {
    const strip = document.createElement('div')
    strip.className = 'ed-iconset-preview'
    strip.title = t('Actual size: 16, 24, 32 and 48 px')
    const url = iconPreviewUrl(ctx.store, slide.id)
    for (const px of [16, 24, 32, 48]) {
      const img = document.createElement('img')
      img.src = url
      // px is the icon's height; a wide canvas is wider
      img.height = px
      img.width = Math.round(px * info.grid / info.gridH)
      img.alt = ''
      img.style.background = slide.background // the icon on its own canvas
      strip.appendChild(img)
    }
    ctx.host.appendChild(strip)
  } else {
    // an empty icon: say so, instead of four blank squares
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Not drawn yet. Draw it with the tools in Insert, or let Claude draft it.')
    ctx.host.appendChild(hint)
    if (ai && !planning) ctx.host.appendChild(drawB())
  }

  buildIconDrawing(ctx, info, field)
  buildIconStyles(ctx, info)

  ctx.section('Icon set')
  ctx.row('Set name', field(doc.title === 'Untitled icon set' ? '' : doc.title, false, t('e.g. Forensics'), (v) =>
    ctx.edit(() => { ctx.store.doc.title = v.trim() || 'Untitled icon set' }, true)))
  ctx.row('License', field(info.license ?? '', false, t('e.g. CC-BY-4.0'), (v) => {
    const next = { ...info }
    if (v.trim()) next.license = v.trim(); else delete next.license
    setInfo(next)
  }))
  ctx.row('Author', field(info.author ?? '', false, '', (v) => {
    const next = { ...info }
    if (v.trim()) next.author = v.trim(); else delete next.author
    setInfo(next)
  }))
  const exp = document.createElement('button')
  exp.className = 'ed-btn ed-btn-block'
  exp.textContent = t('Export icon set…')
  exp.title = iconExportTip(doc)
  exp.addEventListener('click', act('export'))
  ctx.host.appendChild(exp)
}

/** The DRAWING side of the set's style (DECISIONS "Drawing style and
 *  styles"): what Claude reads before it draws — the brief, example icons
 *  someone likes, and the line width, ends, corners, padding and ink. The
 *  Styles section below only repaints what is drawn. */
function buildIconDrawing(ctx: PanelContext, info: IconsetGrid, field: (value: string, multi: boolean, placeholder: string, onCommit: (v: string) => void) => HTMLElement) {
  const setInfo = (next: IconsetInfo) => ctx.edit(() => writeIconsetInfo(ctx.store.doc, next), true)
  const hint = (text: string) => {
    const p = document.createElement('p')
    p.className = 'ed-hint'
    p.textContent = text
    ctx.host.appendChild(p)
  }
  ctx.section('Drawing')
  hint(t('How every icon is drawn — Claude reads this and your example icons before it draws. Styles below only repaint.'))
  ctx.row('Brief', field(info.brief ?? '', true, t('e.g. friendly and rounded, few details, for a forensics course'), (v) => {
    const next = { ...info }
    if (v.trim()) next.brief = v.trim(); else delete next.brief
    setInfo(next)
  }))

  // icons someone likes: Claude draws like them, the line settings follow them
  const examples = iconExamples(ctx.store.doc)
  const strip = document.createElement('div')
  strip.className = 'ed-iconset-examples'
  examples.forEach((ex, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-iconset-example'
    b.title = t('“{name}” — click to remove', { name: ex.name })
    const img = document.createElement('img')
    img.src = examplePreviewUrl(ctx.store, ex)
    img.alt = ex.name
    img.width = img.height = 24
    b.appendChild(img)
    b.addEventListener('click', () => removeExample(ctx.store, i))
    strip.appendChild(b)
  })
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'ed-iconset-example ed-iconset-example-add'
  add.innerHTML = ICONS.plus
  add.title = t('Add icons you like (SVG files from any library) — Claude draws new icons like them')
  add.setAttribute('aria-label', t('Add examples'))
  add.addEventListener('click', () => {
    void addExamplesFromFiles(ctx.store).then((r) => {
      if (r === 'unreadable') toast(t('No icon shapes found in those files'))
      else if (r) toast(Object.keys(r.changed).length
        ? t('Added the examples and took their line width, ends and corners')
        : t('Added the examples — Claude draws new icons like them'), 4000)
    })
  })
  strip.appendChild(add)
  // not ctx.row: a <label> would forward a click on its text to the first example (removing it)
  const exRow = document.createElement('div')
  exRow.className = 'ed-row'
  const exLabel = document.createElement('span')
  exLabel.textContent = t('Examples')
  exRow.append(exLabel, strip)
  ctx.host.appendChild(exRow)

  const st = info.style
  const side = iconShortSide(info)
  ctx.row('Stroke (units)', ctx.number(st.strokeWidth, 0.25, (v) => v > 0 && v <= side / 2 && setInfo(withStyle(info, { strokeWidth: v }))))
  const CAPS: Record<string, IconsetStyle['cap']> = { Round: 'round', Square: 'square', Flat: 'butt' }
  const JOINS: Record<string, IconsetStyle['join']> = { Round: 'round', Bevel: 'bevel', Miter: 'miter' }
  // duotone is paint (a Style) now; a set drawn that way keeps the choice
  const FILLS: Record<string, IconsetStyle['fill']> = { Outline: 'outline', Solid: 'solid', ...(st.fill === 'duotone' ? { Duotone: 'duotone' as const } : {}) }
  const keyOf = <V,>(m: Record<string, V>, v: V) => Object.keys(m).find((k) => m[k] === v) ?? Object.keys(m)[0]
  ctx.row('Line ends', ctx.select(Object.keys(CAPS), keyOf(CAPS, st.cap), (v) => setInfo(withStyle(info, { cap: CAPS[v] }))))
  ctx.row('Corners', ctx.select(Object.keys(JOINS), keyOf(JOINS, st.join), (v) => setInfo(withStyle(info, { join: JOINS[v] }))))
  ctx.row('Drawn as', ctx.select(Object.keys(FILLS), keyOf(FILLS, st.fill), (v) => setInfo(withStyle(info, { fill: FILLS[v] }))))
  ctx.row('Padding (units)', ctx.number(st.padding, 0.5, (v) => v >= 0 && v < side / 2 && setInfo(withStyle(info, { padding: v }))))
  ctx.row('Ink', ctx.color(st.color, (v, fin) => fin && setInfo(withStyle(info, { color: v }))))
  const apply = document.createElement('button')
  apply.className = 'ed-btn ed-btn-block'
  apply.textContent = t('Apply set style')
  apply.title = t('Stroke width, caps, joins and ink from the set, on every icon (or the selected ones)')
  apply.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:iconset', { detail: { action: 'style' } })))
  ctx.host.appendChild(apply)
}

// ---- icon styles (iconstyles.ts, DECISIONS "Icon styles") ----------------------------

/** The style picked in the Styles gallery ('' = the set's own style): the
 *  one the canvas shows the icons in (store.iconLook). */
function lookSel(ctx: PanelContext): string { return ctx.store.shownLook?.id ?? '' }

/** The icon the style previews show: this one, else the first that has a drawing. */
function lookPreviewSlideId(ctx: PanelContext): string {
  const cur = ctx.store.slide
  if (cur.elements.length) return cur.id
  return ctx.store.doc.slides.find((s) => s.elements.length)?.id ?? cur.id
}

/** One gallery card: a real-size preview of the icon in a style, and its name. */
function lookCard(name: string, url: string, opts: { active?: boolean; title?: string; onClick: () => void; onRemove?: () => void }): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'ed-look-card' + (opts.active ? ' is-active' : '')
  card.setAttribute('aria-pressed', String(!!opts.active))
  if (opts.title) card.title = opts.title
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  img.width = img.height = 40
  const label = document.createElement('span')
  label.textContent = name
  card.append(img, label)
  card.addEventListener('click', opts.onClick)
  if (opts.onRemove) {
    const x = document.createElement('span')
    x.className = 'ed-look-remove'
    x.textContent = '×'
    x.title = t('Remove from My styles')
    x.setAttribute('role', 'button')
    x.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onRemove!() })
    card.appendChild(x)
  }
  return card
}

/** The Styles section: the set's looks as a gallery of the current icon, the
 *  drawer to add one (presets, My styles, from this icon, paste, describe
 *  with AI) and the picked look's settings. A style only repaints; other
 *  shapes are the Drawing section's job. */
function buildIconStyles(ctx: PanelContext, info: IconsetInfo) {
  const looks = info.variants ?? []
  const sid = lookPreviewSlideId(ctx)
  ctx.section('Styles')
  const grid = document.createElement('div')
  grid.className = 'ed-looks'
  // previews sit on the icons' own canvas colour, like the size strip above
  ctx.host.style.setProperty('--look-paper', ctx.store.slide.background || '#ffffff')
  const pick = (id: string) => () => { ctx.lookDrawer = false; ctx.store.showLook(id || null) }
  grid.appendChild(lookCard(t('As drawn'), lookPreviewUrl(ctx.store, sid, null), {
    active: !lookSel(ctx), title: t('The icons as drawn — change that under Drawing'), onClick: pick(''),
  }))
  for (const l of looks) grid.appendChild(lookCard(l.name, lookPreviewUrl(ctx.store, sid, l), { active: lookSel(ctx) === l.id, onClick: pick(l.id) }))
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'ed-look-card ed-look-add' + (ctx.lookDrawer ? ' is-active' : '')
  add.innerHTML = `${ICONS.plus}<span></span>`
  add.querySelector('span')!.textContent = t('Add style')
  add.title = t('Show the same icons in another style: presets, your saved styles, or make one')
  add.setAttribute('aria-expanded', String(ctx.lookDrawer))
  add.addEventListener('click', () => { ctx.lookDrawer = !ctx.lookDrawer; ctx.rebuild(true) })
  grid.appendChild(add)
  ctx.host.appendChild(grid)

  if (ctx.lookDrawer) buildLookDrawer(ctx, info, sid)
  const sel = lookSel(ctx) ? looks.find((l) => l.id === lookSel(ctx)) : undefined
  if (sel) buildLookEditor(ctx, sel, looks)
  else if (!ctx.lookDrawer) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = looks.length
      ? t('Every style paints the same drawings, so a fix to an icon shows in all of them. Export writes one folder per style.')
      : t('Styles repaint the same drawings — bold, solid, colour, sticker, badge … Nothing is redrawn, and export writes one folder per style.')
    ctx.host.appendChild(hint)
  }
  if (looks.length) {
    const sheet = document.createElement('button')
    sheet.className = 'ed-btn ed-btn-block'
    sheet.textContent = t('Compare all styles…')
    sheet.title = t('Every icon in every style side by side')
    sheet.addEventListener('click', () => openLookSheet(ctx))
    ctx.host.appendChild(sheet)
  }
}

/** "Add style": presets, My styles, and the ways to make one. */
function buildLookDrawer(ctx: PanelContext, info: IconsetInfo, sid: string) {
  const drawer = document.createElement('div')
  drawer.className = 'ed-look-drawer'
  const head = (label: string) => {
    const h = document.createElement('div')
    h.className = 'ed-subhead'
    h.textContent = label
    drawer.appendChild(h)
  }
  const note = (text: string) => {
    const p = document.createElement('p')
    p.className = 'ed-hint'
    p.textContent = text
    drawer.appendChild(p)
  }
  const added = (id: string, name: string) => {
    ctx.lookDrawer = false
    toast(t('Added the style “{name}”', { name }))
    ctx.store.showLook(id)
  }
  head(t('Presets'))
  const presets = document.createElement('div')
  presets.className = 'ed-looks ed-looks-small'
  for (const p of LOOK_PRESETS) {
    const look = lookFromPreset(p, info.style.color, t(p.name))
    presets.appendChild(lookCard(t(p.name), lookPreviewUrl(ctx.store, sid, look), {
      title: t(p.hint),
      onClick: () => added(addLook(ctx.store, look), look.name),
    }))
  }
  drawer.appendChild(presets)

  const mine = loadMyLooks()
  if (mine.length) {
    head(t('My styles'))
    const row = document.createElement('div')
    row.className = 'ed-looks ed-looks-small'
    for (const l of mine) {
      row.appendChild(lookCard(l.name, lookPreviewUrl(ctx.store, sid, l), {
        title: t('Saved in this app — use it in any icon set'),
        onClick: () => added(addLook(ctx.store, l), l.name),
        onRemove: () => { removeMyLook(l.id); ctx.rebuild(true) },
      }))
    }
    drawer.appendChild(row)
  }

  head(t('Make your own'))
  const action = (label: string, title: string, run: () => void) => {
    const b = document.createElement('button')
    b.className = 'ed-btn ed-btn-block'
    b.textContent = label
    b.title = title
    b.addEventListener('click', run)
    drawer.appendChild(b)
  }
  if (window.slidomingoDesktop?.sendAgentPrompt) {
    action(t('Describe with AI…'), t('Say how the icons should look — Claude makes it a style'), () => {
      void askText({
        title: t('Describe a style'),
        placeholder: t('e.g. playful comic look, yellow fills, thick black lines and a hard shadow'),
        okLabel: t('Send to Claude'),
      }).then((text) => {
        if (text && describeStyleWithAi(ctx.store, text)) toast(t('Claude is making the style — it appears in Styles when done'))
      })
    })
  }
  action(t('From this icon'), t('Paint one icon by hand (fills, line color and width), then take its look as a style — the icon goes back to the set style'), () => {
    const l = learnFromIcon(ctx.store)
    if (!l) { toast(t('This icon has nothing drawn yet')); return }
    const lookId = addLook(ctx.store, l)
    restoreIconToSet(ctx.store, ctx.store.slide.id)
    added(lookId, l.name)
    toast(t('Learned a style from this icon, and put the icon back in the set style (⌘Z brings your paint back)'), 5000)
  })
  action(t('Paste style'), t('Add a style someone shared with Copy style'), () => {
    const apply = (text: string | null) => {
      if (!text) return
      const l = lookFromClipText(text)
      if (typeof l === 'string') { toast(t('That is not an icon style')); return }
      added(addLook(ctx.store, l), l.name)
    }
    // the clipboard when it holds a style, else a box to paste into
    const askPaste = () => void askText({ title: t('Paste style'), placeholder: '{ "format": "slidomingo-icon-style", … }', okLabel: t('Add') }).then(apply)
    const clip = navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error('no clipboard'))
    void clip.then((text) => (typeof lookFromClipText(text) === 'string' ? askPaste() : apply(text))).catch(askPaste)
  })
  note(t('Need other shapes — hand-drawn, more detail, rounder? That is the drawing: change Drawing above (brief, examples) and redraw.'))
  ctx.host.appendChild(drawer)
}

/** The picked style's settings and actions. The basics show; the rest
 *  (detail fill, ends, corners, cut-outs, shadow, border, badge, sharing,
 *  order) is behind "More settings". */
function buildLookEditor(ctx: PanelContext, look: IconLook, looks: readonly IconLook[]) {
  const id = look.id
  const row = (label: string, input: HTMLElement) => ctx.row(label, input).classList.add('ed-look-row')
  const set = (fn: (l: IconLook) => void, final = true) => ctx.edit(() => {
    const l = findLook(ctx.store.doc, id)
    if (l) fn(l)
  }, final)
  const keyOf = <V,>(m: Record<string, V>, v: V) => Object.keys(m).find((k) => m[k] === v) ?? Object.keys(m)[0]
  /** a fill per part: on/off, colour, opacity */
  const partRow = (part: IconPart, label: string) => {
    const paint = look.fill?.[part]
    const wrap = document.createElement('div')
    wrap.className = 'ed-look-paint'
    wrap.appendChild(ctx.toggle(!!paint, (on) => set((l) => {
      const f = { ...l.fill }
      if (on) f[part] = { color: part === 'accent' ? '#fb923c' : part === 'body' ? '#7dd3fc' : l.stroke.color }
      else delete f[part]
      if (Object.keys(f).length) l.fill = f; else delete l.fill
    })))
    if (paint) {
      wrap.appendChild(ctx.color(paint.color, (v, fin) => set((l) => { if (l.fill?.[part]) l.fill[part]!.color = v }, fin)))
      const op = ctx.number(Math.round((paint.opacity ?? 1) * 100), 5, (v) => v >= 5 && v <= 100 && set((l) => {
        const p: IconPaint | undefined = l.fill?.[part]
        if (!p) return
        if (v >= 100) delete p.opacity; else p.opacity = v / 100
      }))
      op.title = t('Opacity (%)')
      op.classList.add('ed-look-pct')
      wrap.appendChild(op)
    }
    row(label, wrap)
  }

  const nameField = document.createElement('input')
  nameField.type = 'text'
  nameField.value = look.name
  nameField.maxLength = 60
  nameField.addEventListener('change', () => { const v = nameField.value.trim(); if (v) set((l) => { l.name = v }) })
  row('Name', nameField)
  row('Line weight (×)', ctx.number(look.stroke.weight, 0.1, (v) => v >= 0.25 && v <= 4 && set((l) => { l.stroke.weight = Math.round(v * 100) / 100 })))
  row('Line color', ctx.color(look.stroke.color, (v, fin) => set((l) => { l.stroke.color = v }, fin)))
  partRow('body', 'Body fill')
  partRow('accent', 'Accent fill')

  // the rest, folded; the toggle says how many of them are on
  const extrasOn = [look.fill?.detail, look.stroke.cap, look.stroke.join, look.knockout, look.shadow, look.halo, look.sketch, look.tile].filter(Boolean).length
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'ed-btn ed-btn-block ed-look-more'
  more.setAttribute('aria-expanded', String(ctx.lookMore))
  more.textContent = ctx.lookMore ? t('Fewer settings') : extrasOn ? t('More settings ({n} on)', { n: extrasOn }) : t('More settings')
  more.addEventListener('click', () => { ctx.lookMore = !ctx.lookMore; ctx.rebuild(true) })
  ctx.host.appendChild(more)
  if (ctx.lookMore) {
    partRow('detail', 'Detail fill')
    const ENDS: Record<string, IconsetStyle['cap'] | undefined> = { 'As the set': undefined, Round: 'round', Square: 'square', Flat: 'butt' }
    const CORNERS: Record<string, IconsetStyle['join'] | undefined> = { 'As the set': undefined, Round: 'round', Bevel: 'bevel', Miter: 'miter' }
    row('Line ends', ctx.select(Object.keys(ENDS), keyOf(ENDS, look.stroke.cap), (v) => set((l) => { if (ENDS[v]) l.stroke.cap = ENDS[v]; else delete l.stroke.cap })))
    row('Corners', ctx.select(Object.keys(CORNERS), keyOf(CORNERS, look.stroke.join), (v) => set((l) => { if (CORNERS[v]) l.stroke.join = CORNERS[v]; else delete l.stroke.join })))
    row('Cut details out', ctx.toggle(!!look.knockout, (on) => set((l) => { if (on) l.knockout = true; else delete l.knockout })))
    row('Hard shadow', ctx.toggle(!!look.shadow, (on) => set((l) => { if (on) l.shadow = { dx: 0.9, dy: 0.9, color: '#111111' }; else delete l.shadow })))
    if (look.shadow) {
      row('Shadow color', ctx.color(look.shadow.color, (v, fin) => set((l) => { if (l.shadow) l.shadow.color = v }, fin)))
      row('Shadow offset (units)', offsetPair(ctx, look.shadow.dx, look.shadow.dy, (dx, dy) => set((l) => { if (l.shadow) { l.shadow.dx = dx; l.shadow.dy = dy } })))
    }
    row('Sticker border', ctx.toggle(!!look.halo, (on) => set((l) => { if (on) l.halo = { width: 1.5, color: '#ffffff' }; else delete l.halo })))
    if (look.halo) {
      row('Border width (units)', ctx.number(look.halo.width, 0.25, (v) => v > 0 && v <= 4 && set((l) => { if (l.halo) l.halo.width = v })))
      row('Border color', ctx.color(look.halo.color, (v, fin) => set((l) => { if (l.halo) l.halo.color = v }, fin)))
    }
    // a wobble is not a hand-drawn set (that is a drawing); only looks that have one show it
    if (look.sketch) row('Hand-drawn', ctx.number(look.sketch, 0.1, (v) => v >= 0 && v <= 1 && set((l) => { if (v > 0) l.sketch = Math.round(v * 100) / 100; else delete l.sketch })))
    const BADGE: Record<string, 'circle' | 'rounded' | 'square' | undefined> = { None: undefined, Circle: 'circle', Rounded: 'rounded', Square: 'square' }
    row('Badge', ctx.select(Object.keys(BADGE), keyOf(BADGE, look.tile?.shape), (v) => set((l) => {
      const shape = BADGE[v]
      if (shape) l.tile = { color: '#4f46e5', scale: 0.62, ...l.tile, shape }; else delete l.tile
    })))
    if (look.tile) row('Badge color', ctx.color(look.tile.color, (v, fin) => set((l) => { if (l.tile) l.tile.color = v }, fin)))
  }

  // single icons painted their own way in this style (buildIconShapeStyle)
  const tweaked = tweakedIconCount(look)
  const sid = ctx.store.slide.id
  const note = document.createElement('p')
  note.className = 'ed-hint'
  note.textContent = tweaked
    ? t('{n} icons have their own changes in this style (• on the canvas chips).', { n: tweaked })
    : t('The canvas shows the icon in this style. Select a shape there to paint it its own way in this style.')
  ctx.host.appendChild(note)
  if (tweaked) {
    const undo = document.createElement('div')
    undo.className = 'ed-look-actions'
    const b = (label: string, title: string, slideId?: string) => {
      const btn = document.createElement('button')
      btn.className = 'ed-btn'
      btn.textContent = label
      btn.title = title
      btn.addEventListener('click', () => set((l) => clearTweaks(l, slideId)))
      undo.appendChild(btn)
    }
    if (look.tweaks?.[sid]) b(t('Reset this icon'), t('This icon painted as the style again'), sid)
    b(t('Reset all icons'), t('Every icon painted as the style again'))
    ctx.host.appendChild(undo)
  }

  const bar = document.createElement('div')
  bar.className = 'ed-look-actions'
  const act = (label: string, title: string, run: () => void, cls = '') => {
    const b = document.createElement('button')
    b.className = `ed-btn ${cls}`.trim()
    b.textContent = label
    b.title = title
    b.addEventListener('click', run)
    bar.appendChild(b)
  }
  act(t('Save to My styles'), t('Keep this style in the app, to use it in any icon set'), () => {
    const cur = findLook(ctx.store.doc, id)
    if (!cur) return
    toast(saveMyLook(cur) ? t('Saved “{name}” to My styles', { name: cur.name }) : t('Could not save — storage is not available here'))
  }, 'ed-primary')
  act(t('Duplicate'), t('A copy of this style to vary'), () => {
    const cur = findLook(ctx.store.doc, id)
    if (!cur) return
    ctx.store.showLook(addLook(ctx.store, cur))
  })
  if (ctx.lookMore) {
    act(t('Copy style'), t('Copy the style as text to share it — paste it with Add style ▸ Paste style'), () => {
      const cur = findLook(ctx.store.doc, id)
      if (!cur) return
      void navigator.clipboard?.writeText(lookToClipText(cur)).then(() => toast(t('Style copied')), () => toast(t('Could not copy')))
    })
    const at = looks.findIndex((l) => l.id === id)
    if (at > 0) act('↑', t('Move earlier'), () => moveLook(ctx.store, id, -1))
    if (at < looks.length - 1) act('↓', t('Move later'), () => moveLook(ctx.store, id, 1))
  }
  act(t('Delete'), t('Remove this style from the set (the icons stay)'), () => { ctx.store.showLook(null); removeLook(ctx.store, id) }, 'ed-danger')
  ctx.host.appendChild(bar)
}

/** Icon sets: what the selected shapes are in the icon (their part, the
 *  same in every style) and, while a style is shown on the canvas, their own
 *  paint in it (IconLook.tweaks) — the drawing itself stays shared. */
export function buildIconShapeStyle(ctx: PanelContext, els: readonly SlideElement[]) {
  const shapes = els.filter((e): e is ShapeElement => e.type === 'shape')
  if (ctx.store.doc.kind !== 'iconset' || !shapes.length) return
  const slide = ctx.store.slide
  const look = ctx.store.shownLook
  const ids = shapes.map((e) => e.id)
  const drawn = iconShapes(ctx.store.doc, slide).shapes
  const parts = iconParts(drawn)
  const guessed = new Map(drawn.map((d, i) => [d.el.id, parts[i]] as const))
  ctx.section('Icon style', { label: look ? t('In “{name}”', { name: look.name }) : t('Icon part') })

  const PARTS: Record<string, IconPart | undefined> = { Guess: undefined, Body: 'body', Detail: 'detail', Accent: 'accent' }
  const PART_NAME: Record<IconPart, string> = { body: 'Body', detail: 'Detail', accent: 'Accent' }
  const own = shapes[0].iconPart
  ctx.row('Part', ctx.select(Object.keys(PARTS), own ? PART_NAME[own] : 'Guess', (v) => ctx.edit(() => {
    for (const e of ctx.store.slide.elements) {
      if (!ids.includes(e.id) || e.type !== 'shape') continue
      const part = PARTS[v]
      if (part) e.iconPart = part; else delete e.iconPart
    }
  }, true)))
  const hint = (text: string) => {
    const p = document.createElement('p')
    p.className = 'ed-hint'
    p.textContent = text
    ctx.host.appendChild(p)
  }
  const g = guessed.get(shapes[0].id)
  if (!own && g) hint(t('Guessed: {part}. Every style paints body, detail and accent its own way — the part counts in all of them.', { part: t(PART_NAME[g]) }))
  if (!look) {
    if (ctx.store.doc.iconset?.variants?.length) hint(t('Show a style above the canvas to paint this shape its own way in it.'))
    return
  }

  const lookId = look.id
  const tweakOf = (id: string): IconShapeTweak => iconTweaks(look, slide.id)[id] ?? {}
  const first = tweakOf(ids[0])
  const tweak = (fn: (tw: IconShapeTweak) => void, final = true) => ctx.edit(() => {
    const l = findLook(ctx.store.doc, lookId)
    if (!l) return
    for (const id of ids) {
      const tw = structuredClone(iconTweaks(l, slide.id)[id] ?? {})
      fn(tw)
      setTweak(l, slide.id, id, tw)
    }
  }, final)

  // what the style paints this shape with now — a starting colour for its own
  const part = shapes[0].iconPart ?? g ?? 'detail'
  const styleFill = look.fill?.[part]?.color ?? look.stroke.color
  if (shapes.some((e) => !drawn.find((d) => d.el.id === e.id)?.open)) {
    const FILL: Record<string, 'style' | 'none' | 'own'> = { 'As the style': 'style', 'No fill': 'none', 'Own color': 'own' }
    const mode = first.fill === 'none' ? 'No fill' : first.fill ? 'Own color' : 'As the style'
    const wrap = document.createElement('div')
    wrap.className = 'ed-look-paint'
    wrap.appendChild(ctx.select(Object.keys(FILL), mode, (v) => tweak((tw) => {
      if (FILL[v] === 'none') tw.fill = 'none'
      else if (FILL[v] === 'own') tw.fill = { color: typeof tw.fill === 'object' ? tw.fill.color : styleFill }
      else delete tw.fill
    })))
    if (first.fill && first.fill !== 'none') {
      const paint = first.fill
      wrap.appendChild(ctx.color(paint.color, (v, fin) => tweak((tw) => { tw.fill = { ...(typeof tw.fill === 'object' ? tw.fill : {}), color: v } }, fin)))
      const op = ctx.number(Math.round((paint.opacity ?? 1) * 100), 5, (v) => v >= 5 && v <= 100 && tweak((tw) => {
        if (typeof tw.fill !== 'object') return
        if (v >= 100) delete tw.fill.opacity; else tw.fill.opacity = v / 100
      }))
      op.title = t('Opacity (%)')
      op.classList.add('ed-look-pct')
      wrap.appendChild(op)
    }
    ctx.row('Fill here', wrap)
  }
  const line = document.createElement('div')
  line.className = 'ed-look-paint'
  line.appendChild(ctx.toggle(!!first.stroke, (on) => tweak((tw) => { if (on) tw.stroke = look.stroke.color; else delete tw.stroke })))
  if (first.stroke) line.appendChild(ctx.color(first.stroke, (v, fin) => tweak((tw) => { tw.stroke = v }, fin)))
  ctx.row('Own line color', line)
  ctx.row('Show in this style', ctx.toggle(!first.hide, (on) => tweak((tw) => { if (on) delete tw.hide; else tw.hide = true })))
  if (ids.some((id) => Object.keys(tweakOf(id)).length)) {
    const reset = document.createElement('button')
    reset.className = 'ed-btn ed-btn-block'
    reset.textContent = t('Paint as the style again')
    reset.title = t('Drop the own changes of the selected shapes in this style')
    reset.addEventListener('click', () => tweak((tw) => { for (const k of Object.keys(tw)) delete tw[k as keyof IconShapeTweak] }))
    ctx.host.appendChild(reset)
  } else {
    hint(t('Changes here apply to this icon in “{name}” only; the drawing and the other styles stay as they are.', { name: look.name }))
  }
}

/** Two small numbers (x, y) that commit together. */
function offsetPair(ctx: PanelContext, x: number, y: number, onEdit: (x: number, y: number) => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-look-pair'
  const ix = ctx.number(x, 0.1, (v) => Number.isFinite(v) && Math.abs(v) <= 4 && onEdit(v, y))
  const iy = ctx.number(y, 0.1, (v) => Number.isFinite(v) && Math.abs(v) <= 4 && onEdit(x, v))
  ix.title = 'x'
  iy.title = 'y'
  wrap.append(ix, iy)
  return wrap
}

/** "Compare all styles…": every icon in every style, on light or dark. */
function openLookSheet(ctx: PanelContext) {
  const doc = ctx.store.doc
  const info = iconsetInfo(doc)
  if (!info) return
  const looks: Array<IconLook | null> = [null, ...(info.variants ?? [])]
  const dlg = document.createElement('dialog')
  dlg.className = 'ed-dialog ed-look-sheet'
  dlg.style.setProperty('--look-paper', ctx.store.slide.background || '#ffffff')
  const top = document.createElement('div')
  top.className = 'ed-look-sheet-top'
  const h = document.createElement('h2')
  h.textContent = t('All styles')
  const bg = ctx.segButtons([['light', t('Light')], ['dark', t('Dark')]], 'light', (v) => {
    dlg.classList.toggle('is-dark', v === 'dark')
    // one-colour icons follow the text colour (currentColor): light on dark
    dlg.querySelectorAll<HTMLImageElement>('img[data-light]').forEach((img) => { img.src = (v === 'dark' ? img.dataset.dark : img.dataset.light) ?? '' })
    bg.querySelectorAll('button').forEach((b, i) => {
      const on = (i === 1) === (v === 'dark')
      b.classList.toggle('ed-btn-armed', on)
      b.setAttribute('aria-pressed', String(on))
    })
  })
  const close = document.createElement('button')
  close.className = 'ed-btn'
  close.textContent = t('Close')
  close.addEventListener('click', () => dlg.close())
  top.append(h, bg, close)
  const scroll = document.createElement('div')
  scroll.className = 'ed-look-sheet-scroll'
  const table = document.createElement('table')
  const head = table.createTHead().insertRow()
  head.insertCell().textContent = ''
  for (const s of doc.slides) {
    const th = document.createElement('th')
    th.textContent = s.name ?? ''
    head.appendChild(th)
  }
  const body = table.createTBody()
  for (const look of looks) {
    const tr = body.insertRow()
    const name = document.createElement('th')
    name.scope = 'row'
    name.textContent = look ? look.name : t('As drawn')
    tr.appendChild(name)
    doc.slides.forEach((s, index) => {
      const img = document.createElement('img')
      img.src = img.dataset.light = lookPreviewUrl(ctx.store, s.id, look)
      img.dataset.dark = lookPreviewUrl(ctx.store, s.id, look, '#f3f4f6')
      img.width = img.height = 40
      img.alt = s.name ?? ''
      // a cell opens that icon in that style on the canvas, to look closer or change it
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'ed-look-cell'
      const tweaked = !!look?.tweaks?.[s.id]
      if (tweaked) open.classList.add('is-tweaked')
      open.title = `${s.name ?? ''} · ${look ? look.name : t('As drawn')}` + (tweaked ? ` · ${t('own changes in this style')}` : '')
      open.appendChild(img)
      open.addEventListener('click', () => {
        dlg.close()
        ctx.store.goTo(index)
        ctx.store.showLook(look?.id ?? null)
      })
      tr.insertCell().appendChild(open)
    })
  }
  scroll.appendChild(table)
  dlg.append(top, scroll)
  dlg.addEventListener('close', () => dlg.remove())
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close() })
  document.body.appendChild(dlg)
  dlg.showModal()
}
