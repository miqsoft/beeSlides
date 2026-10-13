// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The comments pill: a small floating control in the canvas' bottom-end corner
// (left of the zoom pill) that drives the review loop with Claude —
//   💬 N open        opens a list of the open threads: click one to jump to it,
//                    tick which ones to send
//   ✓ M to check     step ‹ › through threads Claude marked done
//   ✦ Send           hand every open (or the ticked) comment to Claude as a list
//   ◌ N resolved     show / hide the done threads' markers
// Shown only while the deck has any comments. Send needs the desktop shell.

import type { Store } from '../store'
import { t } from '../i18n'
import { commentSlideIndex, commentStats, resolvedShown, sendCommentsToClaude, setResolvedShown } from './comments'

export class CommentsPill {
  readonly root: HTMLElement
  private claudeOpen = false
  private checkPos = -1
  private listOpen = false
  /** ids ticked in the open list (all by default) */
  private picked = new Set<string>()

  constructor(
    private store: Store,
    private openThread: (id: string) => void,
    private toast: (msg: string) => void,
    /** redraw the canvas markers (after "N resolved" is toggled) */
    private refreshMarkers: () => void,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'ed-cmtpill'
    this.root.hidden = true
    store.on('doc', () => this.update())
    store.on('current', () => this.update())
    this.update()
    document.addEventListener('pointerdown', (ev) => {
      if (this.listOpen && !this.root.contains(ev.target as Node)) { this.listOpen = false; this.update() }
    })
  }

  setClaudeAvailable(open: boolean) {
    this.claudeOpen = open
    this.update()
  }

  /** Jump to thread `id`: switch slide first, then let the marker open it. */
  jump(id: string) {
    const idx = commentSlideIndex(this.store.doc, id)
    if (idx < 0) return
    this.store.goTo(idx)
    this.openThread(id)
  }

  private step(ids: string[], pos: number, dir: 1 | -1): number {
    const next = (pos + dir + ids.length) % ids.length
    this.jump(ids[next])
    return next
  }

  private mk(cls: string, text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'ed-cmtpill-btn ' + cls
    b.textContent = text
    b.title = title
    b.addEventListener('click', fn)
    return b
  }

  /** The popover above the pill: one row per open thread (slide, author, text). */
  private renderList(open: string[]): HTMLElement {
    const list = document.createElement('div')
    list.className = 'ed-cmtpill-list'
    for (const id of open) {
      const idx = commentSlideIndex(this.store.doc, id)
      const c = this.store.doc.slides[idx]?.comments?.find((x) => x.id === id)
      if (!c) continue
      const row = document.createElement('div')
      row.className = 'ed-cmtpill-row'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = this.picked.has(id)
      cb.title = t('Include when sending to Claude')
      cb.addEventListener('change', () => {
        if (cb.checked) this.picked.add(id); else this.picked.delete(id)
        this.update()
      })
      const go = document.createElement('button')
      go.className = 'ed-cmtpill-go'
      go.title = t('Go to comment')
      const num = document.createElement('b')
      num.textContent = String(idx + 1)
      const txt = document.createElement('span')
      txt.textContent = c.text
      go.append(num, txt)
      go.addEventListener('click', () => this.jump(id))
      row.append(cb, go)
      list.appendChild(row)
    }
    return list
  }

  update() {
    const { open, check, openCount, doneCount } = commentStats(this.store.doc)
    this.root.hidden = !!this.store.editingSurface || (!openCount && !check.length && !doneCount)
    this.root.textContent = ''
    if (this.root.hidden) return
    if (openCount) {
      this.root.appendChild(this.mk('open', '💬 ' + t('{n} open', { n: openCount }), t('Show open comments'), () => {
        this.listOpen = !this.listOpen
        if (this.listOpen) this.picked = new Set(commentStats(this.store.doc).open)
        this.update()
      }))
    } else this.listOpen = false
    if (this.listOpen) this.root.appendChild(this.renderList(open))
    if (check.length) {
      const grp = document.createElement('span')
      grp.className = 'ed-cmtpill-grp'
      grp.append(
        this.mk('nav', '‹', t('Previous'), () => { this.checkPos = this.step(check, this.checkPos < 0 ? 0 : this.checkPos, -1) }),
        this.mk('check', '✓ ' + t('{n} to check', { n: check.length }), t('Next'),
          () => { this.checkPos = this.step(check, this.checkPos, 1) }),
        this.mk('nav', '›', t('Next'), () => { this.checkPos = this.step(check, this.checkPos, 1) }),
      )
      this.root.appendChild(grp)
    }
    if (window.slidomingoDesktop?.sendAgentPrompt) {
      const send = this.mk('send', '✦ ' + t('Send comments to Claude'),
        this.claudeOpen ? t('Send comments to Claude') : t('Starts Claude Code'), () => {
        const n = sendCommentsToClaude(this.store, this.listOpen ? this.picked : undefined)
        this.listOpen = false
        if (n) this.toast(this.claudeOpen ? t('Sent {n} comments to Claude', { n }) : t('Starting Claude Code with {n} comments…', { n }))
      })
      send.disabled = this.listOpen ? !this.picked.size : !openCount
      if (openCount) this.root.appendChild(send)
    }
    if (doneCount) {
      const shown = resolvedShown()
      const b = this.mk('done' + (shown ? ' on' : ''), (shown ? '◉ ' : '◌ ') + t('{n} resolved', { n: doneCount }),
        shown ? t('Hide resolved comments') : t('Show resolved comments'), () => {
          setResolvedShown(!shown)
          this.refreshMarkers()
          this.update()
        })
      this.root.appendChild(b)
    }
  }
}
