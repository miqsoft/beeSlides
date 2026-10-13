// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Review comments. Threads live in Slide.comments (saved with the file,
// never rendered in present/print). The editor shows them as small numbered
// markers on the canvas — at the anchored element's top-right corner, or
// stacked in the slide's top-left for slide-level (and orphaned) threads.
// Clicking a marker opens the thread popover: entries, reply, resolve, ⋯ menu.
// New threads start in an inline composer card next to the anchor.
//
// A thread is in ONE of three states: open → to check (Claude says fixed) →
// done. Done threads are hidden unless "Show resolved" is on (comments pill).
// Claude is reached through ONE path, `sendCommentsToClaude` (pill, ribbon,
// menu, a thread's own button); `forAgent` just records "sent, not finished".

import type { Store } from '../store'
import { uid, type Comment, type SlidomingoDoc } from '../model'
import { t } from '../i18n'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { elementLabel } from './contextmenu'

/** In-page text prompt. `window.prompt` is unsupported in Electron (throws or
 *  returns null), so comments ask through a <dialog> instead — works on the
 *  web and desktop alike. Resolves null on cancel / empty. */
export function askText(opts: { title: string; placeholder?: string; initial?: string; okLabel: string; singleLine?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'ed-dialog ed-askdialog'
    const h = document.createElement('h2')
    h.textContent = opts.title
    // a name is one line (Enter submits); a comment gets a textarea (⌘/Ctrl+Enter)
    const ta: HTMLInputElement | HTMLTextAreaElement = opts.singleLine ? document.createElement('input') : document.createElement('textarea')
    if (ta instanceof HTMLTextAreaElement) ta.rows = 3
    ta.style.width = '100%'
    ta.placeholder = opts.placeholder ?? ''
    ta.value = opts.initial ?? ''
    const actions = document.createElement('div')
    actions.className = 'ed-dialog-actions'
    const cancel = document.createElement('button')
    cancel.textContent = t('Cancel')
    const ok = document.createElement('button')
    ok.className = 'ed-primary'
    ok.textContent = opts.okLabel
    actions.append(cancel, ok)
    dlg.append(h, ta, actions)
    document.body.appendChild(dlg)
    let settled = false
    const done = (v: string | null) => {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      resolve(v?.trim() || null)
    }
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', () => done(ta.value))
    ;(ta as HTMLElement).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (opts.singleLine || ev.metaKey || ev.ctrlKey) && !ev.isComposing) { ev.preventDefault(); done(ta.value) }
    })
    dlg.addEventListener('cancel', () => done(null))
    dlg.showModal()
    ta.focus()
    ta.select()
  })
}

/** The commenter's name — never prompted for. Order: the remembered
 *  `slidomingo-author` (set via the thread menu's "Set your name…"), the
 *  desktop OS username, then '' (valid; simply not shown). */
export function commentAuthor(): string {
  return lsGet('slidomingo-author') || window.slidomingoDesktop?.userName || ''
}

/** Ask for a display name (thread ⋯ menu); existing threads keep their
 *  original author. */
export async function changeCommentAuthor(): Promise<string | null> {
  const next = await askText({
    title: t('Your name (shown on new comments):'), initial: lsGet('slidomingo-author') ?? '', okLabel: t('OK'),
  })
  if (!next) return null
  lsSet('slidomingo-author', next)
  return next
}

/** Exported for editor/panels.ts's History section, which wants the same
 *  "3m ago" phrasing for action-log timestamps (epoch ms there, ISO here —
 *  `new Date()` accepts both). */
export function relTime(iso: string | number): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 45) return t('just now')
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) })
  if (s < 86400 * 30) return t('{n}d ago', { n: Math.round(s / 86400) })
  return new Date(iso).toLocaleDateString()
}

type AnchorRect = { left: number; top: number; right: number; bottom: number }

const CLAUDE = 'Claude'

/** Whether done threads still get canvas markers (comments pill toggle;
 *  per window, not saved). To-check threads always show. */
let showResolved = false
export const resolvedShown = () => showResolved
export function setResolvedShown(on: boolean) { showResolved = on }

/** Position a fixed popover beside `r` (flips left when there's no room
 *  right, clamps to the viewport). Call after it is in the DOM. */
function placePopover(pop: HTMLElement, r: AnchorRect) {
  const w = pop.offsetWidth || 320
  const h = pop.offsetHeight || 200
  let left = r.right + 8
  if (left + w > window.innerWidth - 8) left = r.left - w - 8
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  const top = Math.max(8, Math.min(r.top - 10, window.innerHeight - h - 8))
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
}

function autogrow(ta: HTMLTextAreaElement, max = 160) {
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function avatar(name: string): HTMLElement {
  const a = el('span', 'ed-comment-avatar')
  if (name === CLAUDE) {
    a.classList.add('claude')
    a.textContent = '✦'
  } else {
    let h = 0
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
    a.style.background = `hsl(${h} 50% 42%)`
    a.textContent = (name.trim()[0] ?? '?').toUpperCase()
  }
  return a
}

/** Deck-wide review counts for the comments pill / thumb badges. */
export function commentStats(doc: SlidomingoDoc): { open: string[]; check: string[]; openCount: number; doneCount: number } {
  const open: string[] = []
  const check: string[] = []
  let doneCount = 0
  for (const s of doc.slides) for (const c of s.comments ?? []) {
    if (c.agentDone) check.push(c.id)
    else if (!c.resolved) open.push(c.id)
    else doneCount++
  }
  return { open, check, openCount: open.length, doneCount }
}

/** The slide index owning comment `id`, or -1. */
export function commentSlideIndex(doc: SlidomingoDoc, id: string): number {
  return doc.slides.findIndex((s) => s.comments?.some((c) => c.id === id))
}

/** One line of the "fix these comments" message main writes into the chat
 *  (desktop terminalPanel.ts `fixCommentsPrompt` formats and sanitizes it). */
export interface SentComment {
  id: string
  /** 1-based slide number */
  slide: number
  /** what it is anchored to: an element's label, 'area', 'point' or '' (the slide) */
  on: string
  text: string
  /** the user's latest reply after a Claude reply — feedback on an earlier attempt */
  feedback?: string
}

/** "Send comments to Claude": ONE undo step that marks every open comment in
 *  the deck as sent (`forAgent`), then hands the list to the window's Claude
 *  session, which shows it as a message and works through it. `only` limits
 *  it to those comment ids. Returns how many were sent (0 = nothing happened). */
export function sendCommentsToClaude(store: Store, only?: Set<string>): number {
  const send = window.slidomingoDesktop?.sendAgentPrompt
  if (!send) return 0
  const want = new Set(commentStats(store.doc).open.filter((id) => !only || only.has(id)))
  if (!want.size) return 0
  const list: SentComment[] = []
  store.commit(() => {
    store.doc.slides.forEach((s, i) => {
      for (const c of s.comments ?? []) {
        if (!want.has(c.id)) continue
        c.forAgent = true
        const el = c.elementId ? s.elements.find((e) => e.id === c.elementId) : undefined
        const on = el ? elementLabel(el) : typeof c.w === 'number' ? 'area' : typeof c.x === 'number' ? 'point' : ''
        const replies = c.replies ?? []
        const lastClaude = replies.map((r) => r.author).lastIndexOf(CLAUDE)
        const feedback = lastClaude >= 0 ? replies.slice(lastClaude + 1).map((r) => r.text).join(' / ') : ''
        list.push({ id: c.id, slide: i + 1, on, text: c.text, ...(feedback ? { feedback } : {}) })
      }
    })
  })
  send('fix-comments', list)
  return list.length
}

export class CommentsUI {
  private layer: HTMLElement
  private justCreated: string | null = null
  /** Tears down whichever popover (composer or thread) is open. */
  private dismiss: (() => void) | null = null

  constructor(
    private store: Store,
    stageParent: HTMLElement,
    private scaleOf: () => number,
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'ed-comment-layer'
    stageParent.appendChild(this.layer)
  }

  /** Rebuild the markers for the current slide (call after render/relayout). */
  refresh() {
    this.layer.innerHTML = ''
    const slide = this.store.slide
    const scale = this.scaleOf()
    let slideStack = 0
    ;(slide.comments ?? []).forEach((c) => {
      if (c.resolved && !c.agentDone && !showResolved) return
      const el = c.elementId ? slide.elements.find((e) => e.id === c.elementId) : undefined
      const marker = document.createElement('button')
      const check = !!c.agentDone
      marker.className = 'ed-comment-marker' + (c.resolved && !check ? ' resolved' : '') + (check ? ' check' : '')
      marker.dataset.cid = c.id
      if (c.id === this.justCreated) {
        marker.classList.add('fresh')
        setTimeout(() => { this.justCreated = null }, 1200)
      }
      const count = 1 + (c.replies?.length ?? 0)
      marker.textContent = count > 1 ? String(count) : (c.author.trim()[0]?.toUpperCase() ?? '•')
      if (check || (c.forAgent && !c.resolved)) {
        const badge = document.createElement('span')
        badge.className = 'ed-comment-badge'
        badge.textContent = check ? '✓' : '✦'
        marker.appendChild(badge)
      }
      marker.title = `${c.author ? c.author + ': ' : ''}${c.text.slice(0, 80)}`
      if (!el && typeof c.x === 'number' && typeof c.y === 'number' && typeof c.w === 'number' && typeof c.h === 'number') {
        // area anchor: dashed outline, pin at its top-right corner
        const box = document.createElement('div')
        box.className = 'ed-comment-area' + (c.resolved && !c.agentDone ? ' resolved' : '') + (c.forAgent && !c.resolved ? ' agent-open' : '')
        box.style.left = `${c.x * scale}px`
        box.style.top = `${c.y * scale}px`
        box.style.width = `${c.w * scale}px`
        box.style.height = `${c.h * scale}px`
        this.layer.appendChild(box)
        marker.style.left = `${(c.x + c.w) * scale - 11}px`
        marker.style.top = `${c.y * scale - 11}px`
      } else if (el) {
        marker.style.left = `${(el.x + el.w) * scale - 11}px`
        marker.style.top = `${el.y * scale - 11}px`
      } else if (typeof c.x === 'number' && typeof c.y === 'number') {
        // point anchor: the bubble's bottom-left tip sits ON the point
        marker.classList.add('point')
        marker.style.left = `${c.x * scale}px`
        marker.style.top = `${c.y * scale - 21}px`
      } else {
        marker.style.left = '10px'
        marker.style.top = `${10 + slideStack * 28}px`
        slideStack++
      }
      marker.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.openThread(c.id, marker)
      })
      this.layer.appendChild(marker)
    })
  }

  /** Open thread `id` on the CURRENT slide (the editor switches slides first).
   *  Returns false when its marker is not on this slide. */
  openThreadById(id: string): boolean {
    const marker = this.layer.querySelector<HTMLElement>(`[data-cid="${CSS.escape(id)}"]`)
    if (!marker) return false
    this.openThread(id, marker)
    return true
  }

  /** Install the outside-click / Esc dismissal shared by composer and thread.
   *  `onOutside` decides whether an outside click closes (the composer keeps
   *  a non-empty draft). Returns the teardown. */
  private armDismiss(pop: HTMLElement, close: () => void, onOutside: () => boolean = () => true) {
    const down = (ev: PointerEvent) => {
      if (!pop.contains(ev.target as Node) && onOutside()) close()
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      close()
    }
    const timer = setTimeout(() => document.addEventListener('pointerdown', down, true))
    document.addEventListener('keydown', key, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }

  /** Start a new thread on an element, at a point, or on the slide, in an
   *  inline composer card beside `anchorRect` (client coords). */
  openNew(
    elementId?: string,
    point?: { x: number; y: number },
    area?: { x: number; y: number; w: number; h: number },
    anchorRect?: AnchorRect,
  ): Promise<void> {
    this.dismiss?.()
    return new Promise((resolve) => {
      const lr = this.layer.getBoundingClientRect()
      const rect = anchorRect ?? { left: lr.left + 10, top: lr.top + 10, right: lr.left + 32, bottom: lr.top + 32 }

      const pending = el('div', 'ed-comment-pending')
      pending.style.left = `${rect.right - 11}px`
      pending.style.top = `${(point && !area && !elementId ? rect.top - 21 : rect.top - 11)}px`
      if (point && !area && !elementId) pending.style.left = `${rect.left}px`
      document.body.appendChild(pending)

      const pop = el('div', 'ed-comment-pop ed-comment-composer')
      const ta = el('textarea', 'ed-comment-input')
      ta.rows = 2
      ta.placeholder = t('Add a comment…')
      const foot = el('div', 'ed-comment-composer-foot')
      const ok = el('button', 'ed-primary ed-comment-send', t('Comment'))
      ok.type = 'button'
      ok.disabled = true
      foot.append(ok)
      pop.append(ta, foot)
      document.body.appendChild(pop)
      placePopover(pop, rect)
      ta.focus()

      const teardownDismiss = this.armDismiss(pop, () => finish(false), () => !ta.value.trim())
      let done = false
      const finish = (submit: boolean) => {
        if (done) return
        done = true
        teardownDismiss()
        this.dismiss = null
        pop.remove()
        pending.remove()
        if (submit) {
          const text = ta.value.trim()
          if (text) {
            const comment: Comment = {
              id: uid('cmt'), elementId, ...(point ?? {}), ...(area ?? {}), author: commentAuthor(), text,
              at: new Date().toISOString(),
            }
            this.justCreated = comment.id
            this.store.commit(() => {
              const s = this.store.slide
              s.comments = [...(s.comments ?? []), comment]
            })
            this.refresh()
          }
        }
        resolve()
      }
      this.dismiss = () => finish(false)

      ta.addEventListener('input', () => {
        autogrow(ta)
        ok.disabled = !ta.value.trim()
      })
      ;(ta as HTMLElement).addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && ta.value.trim()) { ev.preventDefault(); finish(true) }
      })
      ok.addEventListener('click', () => { if (ta.value.trim()) finish(true) })
    })
  }

  private openThread(commentId: string, anchor: HTMLElement) {
    this.dismiss?.()
    const find = () => this.store.slide.comments?.find((x) => x.id === commentId)
    if (!find()) return
    const rect = anchor.getBoundingClientRect()

    const pop = el('div', 'ed-comment-pop')
    document.body.appendChild(pop)
    const teardownDismiss = this.armDismiss(pop, () => close())
    const close = () => {
      teardownDismiss()
      this.dismiss = null
      pop.remove()
    }
    this.dismiss = close

    /** Mutate the live comment through the store, then rebuild in place. */
    const mutate = (fn: (live: Comment) => void) => {
      this.store.commit(() => { const live = find(); if (live) fn(live) })
      this.refresh()
      render(true)
    }

    const render = (keepReply = false) => {
      const c = find()
      if (!c) { close(); return }
      const draft = keepReply ? pop.querySelector<HTMLTextAreaElement>('.ed-comment-reply')?.value ?? '' : ''
      pop.textContent = ''

      // header: anchor kind + resolve + ⋯
      const head = el('div', 'ed-comment-pop-head')
      const kind = c.elementId ? 'Element' : typeof c.w === 'number' ? 'Area' : typeof c.x === 'number' ? 'Point' : 'Slide'
      const icon = { Element: '▢', Area: '⬚', Point: '⌖', Slide: '▭' }[kind]
      const label = el('span', 'ed-comment-kind')
      label.append(el('span', 'ed-comment-kind-icon', icon), t(kind))
      // open threads resolve here; to-check / done ones use their banner
      const resolveB = el('button', 'ed-comment-iconbtn', '✓')
      resolveB.title = t('Resolve')
      resolveB.hidden = !!c.resolved
      resolveB.addEventListener('click', () => mutate((l) => { l.resolved = true }))
      const moreB = el('button', 'ed-comment-iconbtn', '⋯')
      moreB.title = t('More options')
      const menu = el('div', 'ed-comment-menu')
      menu.hidden = true
      const item = (text: string, fn: () => void, cls = '') => {
        const b = el('button', 'ed-comment-menu-item ' + cls, text)
        b.addEventListener('click', () => { menu.hidden = true; fn() })
        menu.appendChild(b)
      }
      item(t('Set your name…'), () => { close(); void changeCommentAuthor() })
      item(t('Delete thread'), () => {
        this.store.commit(() => {
          const s = this.store.slide
          s.comments = (s.comments ?? []).filter((x) => x.id !== commentId)
          if (!s.comments.length) delete s.comments
        })
        close()
        this.refresh()
      }, 'danger')
      moreB.addEventListener('click', () => { menu.hidden = !menu.hidden })
      head.append(label, resolveB, moreB, menu)
      pop.appendChild(head)

      if (c.agentDone) {
        const banner = el('div', 'ed-comment-banner ed-comment-check', '✦ ' + t('Claude marked this done — please check') + ' ')
        const actions = el('div', 'ed-comment-check-actions')
        const accept = el('button', 'ed-comment-agent-btn', t('Accept'))
        accept.addEventListener('click', () => mutate((l) => { delete l.agentDone }))
        const reopen = el('button', 'ed-comment-agent-btn secondary', t('Reopen'))
        reopen.addEventListener('click', () => mutate((l) => { delete l.agentDone; delete l.resolved }))
        actions.append(accept, reopen)
        banner.appendChild(actions)
        pop.appendChild(banner)
      } else if (c.resolved) {
        const banner = el('div', 'ed-comment-banner', t('Resolved') + ' ')
        const reopen = el('button', 'ed-comment-link', t('Reopen'))
        reopen.addEventListener('click', () => mutate((l) => { delete l.resolved }))
        banner.appendChild(reopen)
        pop.appendChild(banner)
      }
      if (!c.resolved && window.slidomingoDesktop?.sendAgentPrompt) {
        const strip = el('div', 'ed-comment-agent', c.forAgent ? '✦ ' + t('Sent to Claude') : '')
        const send = el('button', 'ed-comment-agent-btn', c.forAgent ? t('Send again') : '✦ ' + t('Send to Claude'))
        send.addEventListener('click', () => { close(); sendCommentsToClaude(this.store, new Set([commentId])); this.refresh() })
        strip.appendChild(send)
        pop.appendChild(strip)
      } else if (c.forAgent && !c.resolved) {
        pop.appendChild(el('div', 'ed-comment-agent', '✦ ' + t('Sent to Claude')))
      }

      // entries
      const all = [{ author: c.author, at: c.at, text: c.text }, ...(c.replies ?? [])]
      const showNames = new Set(all.map((e) => e.author).filter(Boolean)).size > 1
      const entries = el('div', 'ed-comment-entries')
      for (const e of all) {
        const row = el('div', 'ed-comment-entry')
        if (showNames && e.author) row.appendChild(avatar(e.author))
        const body = el('div', 'ed-comment-entry-body')
        const meta = el('div', 'ed-comment-meta')
        if (showNames && e.author) meta.append(el('b', 'ed-comment-name', e.author), ' · ')
        meta.append(el('span', 'ed-comment-time', relTime(e.at)))
        body.append(meta, el('p', 'ed-comment-text', e.text))
        row.appendChild(body)
        entries.appendChild(row)
      }
      pop.appendChild(entries)

      // reply
      const row = el('div', 'ed-comment-replyrow')
      const reply = el('textarea', 'ed-comment-reply')
      reply.rows = 1
      reply.placeholder = t('Reply…')
      reply.value = draft
      const send = el('button', 'ed-comment-sendbtn', '↵')
      send.title = t('Send')
      const submit = () => {
        const text = reply.value.trim()
        if (!text) return
        reply.value = ''
        // a reply on a to-check thread is feedback on Claude's attempt: reopen it
        // (forAgent is kept) so the next Send picks it up
        mutate((l) => {
          l.replies = [...(l.replies ?? []), { id: uid('cmt'), author: commentAuthor(), text, at: new Date().toISOString() }]
          if (l.agentDone) { delete l.agentDone; delete l.resolved }
        })
        const next = pop.querySelector<HTMLTextAreaElement>('.ed-comment-reply')
        next?.focus()
        const list = pop.querySelector('.ed-comment-entries')
        if (list) list.scrollTop = list.scrollHeight
      }
      reply.addEventListener('input', () => autogrow(reply, 96))
      reply.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit() }
      })
      send.addEventListener('click', submit)
      row.append(reply, send)
      pop.appendChild(row)

      placePopover(pop, rect)
      if (draft) autogrow(reply, 96)
    }

    render()
    pop.querySelector<HTMLTextAreaElement>('.ed-comment-reply')?.focus()
  }
}
