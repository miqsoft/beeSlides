// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The "Customize with AI" chat: a sidebar beside Settings ▸ Customize and
// Settings ▸ Keyboard shortcuts (desktop only — the chat runs in main,
// desktop/src/main/apichat/customizechat.ts). It looks and behaves like the
// chat panel: the conversation as bubbles with streamed markdown, a working
// indicator while the model thinks or edits, and after each turn a card of
// what it changed with "Undo". It needs an API profile; with Claude Code as
// the default it points to the terminal's /customize-ui instead.
//
// Model text goes through chatmarkdown.ts (escaped first, only our own tags
// added back) — never raw into innerHTML.

import type { Store } from '../../store'
import { t } from '../../i18n'
import { ICONS } from '../../icons'
import { renderMarkdown } from '../../chatmarkdown'
import { PATCH_KEYS } from './catalog'
import { styleFromElement } from './logic'
import type { UiProfileStore } from './store'
import { button, el } from './ui'

interface ChatItem { kind: 'user' | 'assistant'; text: string }
interface Turn { revBefore: number; changes: Array<{ rev: number; summary: string }>; afterItem?: number }
interface ChatInfo { available: boolean; kind: 'api' | 'claude-code' | 'none'; profileName: string | null; disabled?: boolean; items: ChatItem[]; turns: Turn[]; busy: boolean }
type ChatEvent =
  | { type: 'user'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string }
  | { type: 'tool-end' }
  | { type: 'error'; message: string }
  | ({ type: 'turn' } & Turn)
  | { type: string }

export interface ChatBridge {
  customizeChatInfo(): Promise<ChatInfo>
  customizeChatSend(text: string, digest: string | null): Promise<{ ok: boolean; error?: string }>
  customizeChatStop(): Promise<unknown>
  customizeChatClear(): Promise<unknown>
  onCustomizeChatEvent(cb: (ev: ChatEvent) => void): () => void
  toggleTerminal?: () => Promise<void>
}

export function chatBridge(): ChatBridge | null {
  const d = (window as unknown as { slidomingoDesktop?: Partial<ChatBridge> }).slidomingoDesktop
  return d?.customizeChatInfo ? (d as ChatBridge) : null
}

/** One line about what is selected and how it looks — what "this look" means. */
export function selectionDigest(store: Store): string | null {
  const els = store.selectedElements
  if (!els.length) return null
  const parts = els.slice(0, 3).map((e) => {
    const text = e.type === 'text' ? ` "${e.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)}"` : ''
    return `${e.type}${text} ${JSON.stringify(styleFromElement(e, PATCH_KEYS))}`
  })
  const more = els.length > 3 ? ` (+${els.length - 3} more)` : ''
  return `[editor selection] ${parts.join('; ')}${more}`.slice(0, 1500)
}

export interface ChatPaneDeps {
  store: Store
  profiles: UiProfileStore
  bridge: ChatBridge
  /** Settings ▸ AI chat (to add an API profile). */
  openAiSettings?: () => void
  /** Hide the sidebar. */
  onClose?: () => void
}

const SUGGESTIONS = (): string[] => [
  t('Make the editor compact and the accent teal'),
  t('Add a “Brand” tab with my selection’s look as a style'),
  t('Give ⌘⇧H to “Hide slide”'),
  t('Hide the ribbon groups I never use: Zoom and Symbols'),
]

/** Within this many px of the bottom the log follows new text. */
const STICK_PX = 40

export function renderChatPane(host: HTMLElement, deps: ChatPaneDeps): void {
  const { bridge } = deps
  const box = el('aside', 'ed-czc')
  box.setAttribute('aria-label', t('Customize with AI'))
  host.appendChild(box)

  const head = el('div', 'ed-czc-head')
  const dot = el('span', 'ed-czc-dot')
  const title = el('div', 'ed-czc-title')
  title.append(el('b', undefined, t('Customize with AI')))
  const who = el('span', 'ed-czc-who')
  title.appendChild(who)
  const clear = button('', () => void bridge.customizeChatClear().then(() => { items = []; turns = []; error = ''; paint() }), t('New conversation'), 'ed-czc-icon')
  clear.innerHTML = ICONS.plus
  clear.setAttribute('aria-label', t('New conversation'))
  head.append(dot, title, clear)
  if (deps.onClose) {
    const x = button('×', () => deps.onClose!(), t('Hide the AI chat'), 'ed-czc-icon')
    x.setAttribute('aria-label', t('Hide the AI chat'))
    head.appendChild(x)
  }
  box.appendChild(head)

  const log = el('div', 'ed-czc-log')
  log.setAttribute('role', 'log')
  log.setAttribute('aria-live', 'polite')
  const ctx = el('div', 'ed-czc-ctx')
  const form = el('div', 'ed-czc-form')
  const input = el('textarea', 'ed-czc-input')
  input.rows = 1
  input.placeholder = t('Ask for a change to your editor…')
  input.setAttribute('aria-label', t('Ask for a change to your editor…'))
  const send = button('', () => void submit(), t('Send (Enter)'), 'ed-czc-send')
  send.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>'
  send.setAttribute('aria-label', t('Send'))
  const stop = button('', () => void bridge.customizeChatStop(), t('Stop (Esc)'), 'ed-czc-send ed-czc-stop')
  stop.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>'
  stop.setAttribute('aria-label', t('Stop'))
  form.append(input, send, stop)
  const hint = el('div', 'ed-czc-hint', t('Enter to send · Shift+Enter new line'))

  let items: ChatItem[] = []
  let turns: Turn[] = []
  let busy = false
  let tool: string | null = null
  let error = ''
  let streaming = false

  const alive = () => box.isConnected
  const off = bridge.onCustomizeChatEvent((ev) => {
    if (!alive()) { off(); return }
    if (ev.type === 'user') { items.push({ kind: 'user', text: (ev as { text: string }).text }); error = '' }
    else if (ev.type === 'text-delta') {
      const last = items[items.length - 1]
      if (last?.kind === 'assistant' && streaming) last.text += (ev as { text: string }).text
      else items.push({ kind: 'assistant', text: (ev as { text: string }).text })
      streaming = true
      tool = null
    } else if (ev.type === 'tool-start') { tool = (ev as { name: string }).name; streaming = false }
    else if (ev.type === 'tool-end') tool = null
    else if (ev.type === 'busy') { busy = (ev as { busy: boolean }).busy; if (!busy) { tool = null; streaming = false } }
    else if (ev.type === 'error') error = (ev as { message: string }).message
    else if (ev.type === 'turn') turns.push({ ...(ev as Turn), afterItem: items.length })
    else return
    paint()
  })

  const turnCard = (tn: Turn): HTMLElement => {
    const card = el('div', 'ed-czc-turn')
    if (!tn.changes.length) { card.classList.add('ed-czc-none'); card.textContent = t('No changes to your editor'); return card }
    const headRow = el('div', 'ed-czc-turnhead')
    headRow.appendChild(el('span', 'ed-czc-turntitle', tn.changes.length === 1 ? t('Changed 1 thing') : t('Changed {n} things', { n: tn.changes.length })))
    const undo = button(t('Undo'), () => void deps.profiles.revert(tn.revBefore).then((r) => {
      if (r.ok) { undo.disabled = true; undo.textContent = t('Undone') }
      else { error = r.error === 'too-old' ? t('That change is too old to go back to') : t('Could not go back'); paint() }
    }), t('Put your editor back the way it was before this answer'), 'ed-btn')
    headRow.appendChild(undo)
    const ul = el('ul')
    for (const c of tn.changes) ul.appendChild(el('li', undefined, c.summary))
    card.append(headRow, ul)
    return card
  }

  const empty = (): HTMLElement => {
    const e = el('div', 'ed-czc-empty')
    e.appendChild(el('p', undefined, t('Tell the AI how you want this editor to look and work — your own tabs and buttons, shortcuts, menus, colours. It never touches your deck, and every change can be undone.')))
    const chips = el('div', 'ed-czc-chips')
    for (const s of SUGGESTIONS()) {
      chips.appendChild(button(s, () => { input.value = s; autosize(); input.focus() }, undefined, 'ed-czc-chip'))
    }
    e.appendChild(chips)
    return e
  }

  const paint = () => {
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_PX
    log.replaceChildren()
    const byIndex = new Map<number, Turn[]>()
    for (const tn of turns) {
      const k = tn.afterItem ?? items.length
      byIndex.set(k, [...(byIndex.get(k) ?? []), tn])
    }
    items.forEach((it, i) => {
      for (const tn of byIndex.get(i) ?? []) log.appendChild(turnCard(tn))
      const m = el('div', `ed-czc-msg ed-czc-${it.kind}`)
      if (it.kind === 'assistant') {
        const md = el('div', 'ed-czc-md')
        md.innerHTML = renderMarkdown(it.text)
        m.appendChild(md)
        if (busy && streaming && i === items.length - 1) m.classList.add('streaming')
      } else m.textContent = it.text
      log.appendChild(m)
    })
    for (const tn of byIndex.get(items.length) ?? []) log.appendChild(turnCard(tn))
    if (busy && !streaming) {
      const a = el('div', 'ed-czc-activity')
      a.appendChild(el('span', 'ed-czc-wave'))
      a.querySelector('.ed-czc-wave')!.innerHTML = '<i></i><i></i><i></i>'
      a.appendChild(el('span', undefined, tool ? t('Changing your editor…') : t('Thinking…')))
      log.appendChild(a)
    }
    if (error) log.appendChild(el('div', 'ed-czc-error', error))
    if (!items.length && !busy) log.appendChild(empty())
    if (stick || busy) log.scrollTop = log.scrollHeight
    box.classList.toggle('busy', busy)
    send.hidden = busy
    stop.hidden = !busy
    hint.textContent = busy ? t('Working — Esc to stop') : t('Enter to send · Shift+Enter new line')
    paintContext()
  }

  const paintContext = () => {
    const n = deps.store.selectedElements.length
    ctx.hidden = !n
    ctx.textContent = n ? (n === 1 ? t('Sees your selection (1 element) — say “this look” to use it') : t('Sees your selection ({n} elements) — say “this look” to use it', { n })) : ''
  }

  const autosize = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }

  const submit = async () => {
    const text = input.value.trim()
    if (!text || busy) return
    error = ''
    const r = await bridge.customizeChatSend(text, selectionDigest(deps.store))
    if (r.ok) { input.value = ''; autosize() }
    else { error = r.error === 'busy' ? t('Still working on the last request') : t('The chat is not available'); paint() }
  }
  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation() // the editor's own shortcuts (and Settings' Esc) stay out of the chat field
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void submit() }
    else if (ev.key === 'Escape' && busy) { ev.preventDefault(); void bridge.customizeChatStop() }
  })

  void bridge.customizeChatInfo().then((info) => {
    if (!alive()) return
    if (!info.available) {
      const e = el('div', 'ed-czc-empty')
      e.appendChild(el('p', undefined, info.kind === 'claude-code'
        ? t('This chat needs an API profile (Settings ▸ AI chat). With Claude Code, open the terminal and type /customize-ui.')
        : t('This chat needs an API profile — add one in Settings ▸ AI chat.')))
      if (deps.openAiSettings) e.appendChild(button(t('Set up AI chat…'), () => deps.openAiSettings!(), undefined, 'ed-btn ed-btn-primary'))
      if (info.kind === 'claude-code' && bridge.toggleTerminal) e.appendChild(button(t('Open the Claude Code terminal'), () => void bridge.toggleTerminal!()))
      box.appendChild(e)
      return
    }
    items = info.items
    turns = info.turns
    busy = info.busy
    who.textContent = info.profileName ?? ''
    box.append(log, ctx, form, hint)
    paint()
    autosize()
  })
}
