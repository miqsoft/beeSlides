// The native chat UI of an API-chat tab (profile kind `api`; no Claude Code,
// no pty): a message list with streamed markdown, collapsible tool-call rows
// (name, arguments, result, screenshots inline) and an input box. Main owns
// the conversation (src/main/apichat/session.ts); this view only renders the
// events it is sent and forwards what the user types.

import { logoSvg } from '../../../../slides/src/brand'
import { renderMarkdown } from '../../../../slides/src/chatmarkdown'

export { renderMarkdown }

type ToolImage = { data: string; mimeType: string }
export type ToolItem = { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; done: boolean; text?: string; images?: ToolImage[]; isError?: boolean; children?: ToolItem[] }
export type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'thinking'; text: string; chars: number; ms: number; open: boolean }
  | ToolItem

export type UsageReadout = { contextTokens: number; contextWindow: number; cacheRead: number; totalTokens?: number }

/** Mirrors main's apichat/types.ts ChatEvent. */
export type ChatEvent =
  | { type: 'user'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown>; parent?: string }
  | { type: 'tool-end'; id: string; text: string; images: ToolImage[]; isError: boolean; parent?: string }
  | ({ type: 'usage' } & UsageReadout)
  | { type: 'compacted'; summary: string }
  | { type: 'done'; stopped?: boolean }
  | { type: 'error'; message: string; retry?: { effort: string } }

export interface ChatView {
  el: HTMLElement
  apply(ev: ChatEvent): void
  sync(state: { display: DisplayItem[]; busy: boolean; usage?: UsageReadout | null }): void
  focus(): void
}

const RESULT_CLIP = 4000

const kilo = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** `42k / 200k context · 31k cached`, plus a session total once subagents ran. */
export function usageLine(u: UsageReadout): string {
  const bits = [`${kilo(u.contextTokens)} / ${kilo(u.contextWindow)} context`]
  if (u.cacheRead > 0) bits.push(`${kilo(u.cacheRead)} cached`)
  if (u.totalTokens && u.totalTokens > u.contextTokens) bits.push(`${kilo(u.totalTokens)} used in total`)
  return bits.join(' · ')
}

function argSummary(args: Record<string, unknown>): string {
  const bits: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (bits.length >= 3) break
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') bits.push(`${k}=${String(v).slice(0, 24)}`)
  }
  return bits.join(' ')
}


/** `4s`, `1m 05s`. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const HINT = 'Enter to send · Shift+Enter new line · /compact'
const HINT_BUSY = 'Esc to stop'
const HINT_NUDGE = 'Still working; press Esc or Stop to cancel'
/** Within this many px of the bottom the list follows new content. */
const STICK_PX = 40
/** Mirrors main's THINKING_KEEP: the panel shows only the tail of a long thought. */
const THINKING_KEEP = 4000

/** "~1.2k tokens" for a thought of `chars` characters (chars/4, like main's estimate). */
function thoughtSize(chars: number): string {
  const n = Math.ceil(chars / 4)
  return `~${n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : n} tokens`
}
const CONTEXT_WARN = 0.8
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>'
const ICON_COPY = '<svg class="ic-copy" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>'
  + '<svg class="ic-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>'

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return } catch { /* not focused / no permission: fall back */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.append(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}

/** An icon-only copy button: no text content, so it never shows up in a
 *  message's textContent (the e2e reads it). */
function copyButton(get: () => string): HTMLButtonElement {
  const b = node('button', 'chat-copy')
  b.type = 'button'
  b.title = 'Copy'
  b.setAttribute('aria-label', 'Copy')
  b.innerHTML = ICON_COPY
  let t: number | undefined
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    void copyText(get()).then(() => {
      b.classList.add('copied')
      clearTimeout(t)
      t = window.setTimeout(() => b.classList.remove('copied'), 1200)
    })
  })
  return b
}

type ToolRow = { row: HTMLDetailsElement; status: HTMLElement; body: HTMLElement; children?: HTMLElement; steps?: HTMLElement; count: number; name: string; parent?: string }

export function createChatView(opts: {
  label: string
  model?: string
  onSend: (text: string) => void
  onStop: () => void
  /** The "retry at lower reasoning" button of an error notice. */
  onRetry: (effort: string) => void
}): ChatView {
  const el = node('div', 'chat')
  const head = node('div', 'chat-head')
  const dot = node('span', 'chat-dot')
  dot.setAttribute('aria-hidden', 'true')
  head.append(dot, node('span', 'chat-head-label', opts.model ? `${opts.label} · ${opts.model}` : opts.label))
  const live = node('div', 'chat-sr')
  live.setAttribute('role', 'status')
  live.setAttribute('aria-live', 'polite')
  const mainEl = node('div', 'chat-main')
  const list = node('div', 'chat-list')
  list.setAttribute('aria-busy', 'false')
  const jump = node('button', 'chat-jump', '↓ New messages')
  jump.type = 'button'
  jump.hidden = true
  mainEl.append(list, jump)
  const form = node('form', 'chat-form')
  const compose = node('div', 'chat-compose')
  const input = node('textarea', 'chat-input')
  input.rows = 1
  input.placeholder = 'Ask for a change to the deck…'
  input.setAttribute('aria-label', 'Message')
  const btn = node('button', 'chat-send', 'Send')
  btn.type = 'submit'
  compose.append(input, btn)
  const hint = node('div', 'chat-hint', HINT)
  form.append(compose, hint)
  const usageEl = node('div', 'chat-usage')
  const usageText = node('span', 'chat-usage-text')
  const meter = node('span', 'chat-meter')
  const meterFill = node('span', 'chat-meter-fill')
  meter.append(meterFill)
  usageEl.append(usageText, meter)
  usageEl.hidden = true
  el.append(head, live, mainEl, form, usageEl)

  // The busy row: honey dots, what the model is doing, how long it has been.
  const activity = node('div', 'chat-activity')
  const wave = node('span', 'chat-wave')
  wave.setAttribute('aria-hidden', 'true')
  wave.append(node('i', ''), node('i', ''), node('i', ''))
  const phaseEl = node('span', 'chat-phase')
  const elapsedEl = node('span', 'chat-elapsed')
  activity.append(wave, phaseEl, elapsedEl)

  // Shown while the list is empty.
  const empty = node('div', 'chat-empty')
  const mark = node('div', 'chat-empty-mark')
  mark.innerHTML = logoSvg(48)
  empty.append(mark, node('div', 'chat-empty-title', 'What should we change?'))

  let busy = false
  let startedAt = 0
  let timer: number | undefined
  let flashTimer: number | undefined
  let rebuilding = false
  let stick = true
  /** The assistant message text is streaming into, if any. */
  let cur: { el: HTMLElement; md: HTMLElement; text: string } | null = null
  let frame = 0
  /** The reasoning row the model's thinking streams into, if any. */
  let think: { row: HTMLDetailsElement; name: HTMLElement; size: HTMLElement; pre: HTMLElement; text: string; chars: number; startedAt: number; ms: number; frame: number } | null = null
  const tools = new Map<string, ToolRow>()
  /** Top-level tools still running: id → name. */
  const running = new Map<string, string>()

  const announce = (s: string): void => { live.textContent = s }

  // ---- scrolling: follow the bottom only while the user is there
  const atBottom = (): boolean => list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX
  const follow = (): void => {
    if (stick) { list.scrollTop = list.scrollHeight; jump.hidden = true }
    else jump.hidden = false
  }
  list.addEventListener('scroll', () => { stick = atBottom(); if (stick) jump.hidden = true })
  jump.addEventListener('click', () => { stick = true; follow(); input.focus() })
  // A hidden tab (display:none) can't scroll; catch up once it has a size again.
  new ResizeObserver(() => { if (stick) list.scrollTop = list.scrollHeight }).observe(list)

  /** Adds a node to the list, above the activity row while that is shown. */
  const push = (n: HTMLElement, animate = true): void => {
    empty.remove()
    if (animate && !rebuilding) n.classList.add('chat-in')
    if (activity.isConnected) list.insertBefore(n, activity)
    else list.append(n)
    follow()
  }

  // ---- the busy row
  const phase = (): string => {
    if (cur && el.classList.contains('streaming')) return 'Writing…'
    const names = [...running.values()]
    const tasks = names.filter((n) => n === 'task').length
    if (tasks) return tasks > 1 ? 'Subagents working…' : 'Subagent working…'
    if (names.length) return `Running ${names[names.length - 1]}…`
    if (think && think.chars) return `Thinking… ${thoughtSize(think.chars)}`
    return 'Thinking…'
  }
  const updateActivity = (): void => {
    if (!busy) return
    const p = phase()
    if (phaseEl.textContent !== p) phaseEl.textContent = p
    const ms = Date.now() - startedAt
    elapsedEl.textContent = ms >= 1000 ? elapsedLabel(ms) : ''
  }

  // ---- input
  const updateSend = (): void => { btn.disabled = !busy && !input.value.trim() }
  const autosize = (): void => {
    input.style.height = 'auto'
    if (!input.scrollHeight) { input.style.height = ''; return } // hidden tab
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`
  }
  const setHint = (text: string, warn = false): void => {
    hint.textContent = text
    hint.classList.toggle('warn', warn)
  }

  const setBusy = (b: boolean): void => {
    const was = busy
    busy = b
    btn.textContent = b ? 'Stop' : 'Send'
    btn.title = b ? 'Stop (Esc)' : 'Send (Enter)'
    btn.classList.toggle('stop', b)
    el.classList.toggle('busy', b)
    list.setAttribute('aria-busy', String(b))
    if (b) {
      if (!was) { startedAt = Date.now(); announce('Working'); el.classList.remove('just-done') }
      empty.remove()
      list.append(activity)
      updateActivity()
      timer ??= window.setInterval(updateActivity, 1000)
      follow()
      setHint(HINT_BUSY)
    } else {
      closeAssistant()
      activity.remove()
      window.clearInterval(timer)
      timer = undefined
      running.clear()
      startedAt = 0
      setHint(HINT)
    }
    updateSend()
  }

  // ---- messages
  const render = (): void => {
    frame = 0
    if (!cur) return
    cur.md.innerHTML = renderMarkdown(cur.text)
    cur.md.querySelectorAll('pre').forEach((pre) => {
      const wrap = node('div', 'chat-pre')
      pre.replaceWith(wrap)
      wrap.append(pre, copyButton(() => pre.textContent ?? ''))
    })
    follow()
  }
  /** The reasoning row's text and counter (one DOM write per frame while streaming). */
  const paintThought = (t: NonNullable<typeof think>): void => {
    t.frame = 0
    t.pre.textContent = t.chars > t.text.length ? `… (the earlier ${thoughtSize(t.chars - t.text.length).replace(' tokens', '')} tokens are not shown)\n${t.text}` : t.text
    t.size.textContent = t.chars ? thoughtSize(t.chars) : ''
    t.pre.parentElement?.toggleAttribute('hidden', !t.chars)
  }
  /** Ends the reasoning row: "Thought for 12s". */
  function closeThinking(): void {
    const t = think
    if (!t) return
    think = null
    if (t.frame) cancelAnimationFrame(t.frame)
    if (!rebuilding) t.ms = Date.now() - t.startedAt
    paintThought(t)
    t.row.classList.remove('running')
    t.name.textContent = t.ms >= 1000 ? `Thought for ${elapsedLabel(t.ms)}` : 'Thought'
  }
  const addThinking = (text: string, from?: { chars: number; ms: number; open: boolean }): void => {
    if (!think) {
      closeAssistant()
      const row = document.createElement('details')
      row.className = 'chat-tool chat-think running'
      const sum = document.createElement('summary')
      const status = node('span', 'chat-tool-status')
      const name = node('span', 'chat-tool-name', 'Thinking…')
      const size = node('span', 'chat-tool-args')
      sum.append(status, name, size)
      const body = node('div', 'chat-tool-body')
      const pre = document.createElement('pre')
      body.append(pre)
      row.append(sum, body)
      push(row)
      think = { row, name, size, pre, text: '', chars: 0, startedAt: Date.now() - (from?.ms ?? 0), ms: 0, frame: 0 }
    }
    const t = think
    t.text = (t.text + text).slice(-THINKING_KEEP)
    t.chars += from ? from.chars : text.length
    t.ms = from ? from.ms : Date.now() - t.startedAt
    if (rebuilding) { paintThought(t); if (!from?.open) closeThinking(); return }
    t.frame ||= requestAnimationFrame(() => paintThought(t))
    updateActivity()
  }
  /** Ends the message text was streaming into, rendering what is pending. */
  function closeAssistant(): void {
    closeThinking()
    if (frame) { cancelAnimationFrame(frame); render() }
    cur?.el.classList.remove('streaming')
    el.classList.remove('streaming')
    cur = null
  }
  const addUser = (text: string): void => {
    closeAssistant()
    stick = true
    push(node('div', 'chat-msg user', text))
  }
  const addAssistantText = (text: string): void => {
    closeThinking()
    if (!cur) {
      const msg = node('div', 'chat-msg assistant')
      const md = node('div', 'chat-md')
      const c = { el: msg, md, text: '' }
      msg.append(md, copyButton(() => c.text))
      cur = c
      push(msg)
    }
    cur.text += text
    if (rebuilding) { render(); return }
    // One markdown render per frame, however many deltas arrived.
    cur.el.classList.add('streaming')
    el.classList.add('streaming')
    frame ||= requestAnimationFrame(render)
    updateActivity()
  }
  const fillResult = (id: string, text: string, images: ToolImage[], isError: boolean): void => {
    const t = tools.get(id)
    if (!t) return
    if (!t.parent) running.delete(id)
    t.status.textContent = isError ? '✗' : '✓'
    t.status.classList.toggle('pop', !rebuilding)
    t.row.classList.remove('running')
    t.row.classList.toggle('error', isError)
    t.body.querySelectorAll('.chat-result').forEach((n) => n.remove())
    const res = node('div', 'chat-result')
    const pre = document.createElement('pre')
    pre.textContent = text.length > RESULT_CLIP ? `${text.slice(0, RESULT_CLIP)}\n… (${text.length - RESULT_CLIP} more characters)` : text
    res.append(pre)
    for (const img of images) {
      const im = document.createElement('img')
      im.src = `data:${img.mimeType};base64,${img.data}`
      im.alt = 'screenshot'
      im.addEventListener('load', follow, { once: true })
      res.append(im)
    }
    t.body.append(res)
    // Screenshots are the point of review_slide: show them without a click.
    if (images.length) t.row.open = true
    updateActivity()
    follow()
  }
  const addTool = (id: string, name: string, args: Record<string, unknown>, parent?: string): void => {
    closeAssistant()
    const isTask = name === 'task'
    const row = document.createElement('details')
    row.className = isTask ? 'chat-tool chat-task running' : 'chat-tool running'
    const sum = document.createElement('summary')
    const status = node('span', 'chat-tool-status')
    const nm = node('span', 'chat-tool-name')
    let steps: HTMLElement | undefined
    if (isTask) {
      nm.textContent = `Subagent: ${typeof args.description === 'string' && args.description ? args.description : 'task'}`
      steps = node('span', 'chat-tool-args', '0 steps')
      sum.append(status, nm, steps)
    } else {
      nm.textContent = name
      sum.append(status, nm, node('span', 'chat-tool-args', argSummary(args)))
    }
    const body = node('div', 'chat-tool-body')
    const pre = document.createElement('pre')
    pre.textContent = isTask && typeof args.prompt === 'string' ? args.prompt : JSON.stringify(args, null, 2)
    body.append(pre)
    let children: HTMLElement | undefined
    if (isTask) {
      children = node('div', 'chat-children')
      body.append(children)
      row.open = true
    }
    row.append(sum, body)
    const owner = parent ? tools.get(parent) : undefined
    if (owner?.children) {
      if (!rebuilding) row.classList.add('chat-in')
      owner.children.append(row)
      owner.count++
      if (owner.steps) owner.steps.textContent = `${owner.count} step${owner.count === 1 ? '' : 's'}`
      follow()
    } else {
      running.set(id, name)
      push(row)
    }
    tools.set(id, { row, status, body, children, steps, count: 0, name, parent: owner ? parent : undefined })
    updateActivity()
  }
  const addError = (text: string, retry?: { effort: string }): void => {
    closeAssistant()
    const n = node('div', 'chat-msg notice error', text)
    n.setAttribute('role', 'alert')
    if (retry) {
      const b = node('button', 'chat-retry', `Retry at ${retry.effort} reasoning`)
      b.type = 'button'
      b.addEventListener('click', () => { b.remove(); opts.onRetry(retry.effort) })
      n.append(b)
    }
    push(n)
  }
  const addDivider = (text: string): void => { closeAssistant(); push(node('div', 'chat-msg divider', text)) }
  /** `✓ Done · 12s` / `■ Stopped · 8s` under a finished turn. */
  const addEnd = (stopped: boolean): void => {
    closeAssistant()
    const n = node('div', `chat-end ${stopped ? 'chat-stopped' : 'chat-done'}`)
    const icon = node('span', 'chat-end-icon')
    if (!stopped) icon.innerHTML = ICON_CHECK
    const ms = startedAt ? Date.now() - startedAt : 0
    const took = ms >= 1000 ? ` · ${elapsedLabel(ms)}` : ''
    n.append(icon, node('span', '', `${stopped ? 'Stopped' : 'Done'}${took}`))
    push(n, false)
    announce(stopped ? 'Stopped' : 'Done')
    if (!stopped) {
      el.classList.add('just-done')
      window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => el.classList.remove('just-done'), 1600)
    }
  }

  const setUsage = (u: UsageReadout | null | undefined): void => {
    usageEl.hidden = !u
    if (!u) { usageText.textContent = ''; return }
    usageText.textContent = usageLine(u)
    const share = u.contextWindow > 0 ? Math.min(1, u.contextTokens / u.contextWindow) : 0
    meterFill.style.width = `${(share * 100).toFixed(1)}%`
    meter.title = `${Math.round(share * 100)}% of the context window`
    usageEl.classList.toggle('warn', share > CONTEXT_WARN)
  }

  const reset = (): void => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (think?.frame) cancelAnimationFrame(think.frame)
    think = null
    cur = null
    el.classList.remove('streaming')
    list.replaceChildren(empty)
    tools.clear()
    running.clear()
    setUsage(null)
  }
  const addToolItem = (item: ToolItem, parent?: string): void => {
    addTool(item.id, item.name, item.args, parent)
    for (const c of item.children ?? []) addToolItem(c, item.id)
    if (item.done) fillResult(item.id, item.text ?? '', item.images ?? [], !!item.isError)
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (busy) { opts.onStop(); return }
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    autosize()
    updateSend()
    opts.onSend(text)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    // Enter never stops a running request: the text stays for later.
    if (busy) setHint(HINT_NUDGE, true)
    else form.requestSubmit()
  })
  input.addEventListener('input', () => { autosize(); updateSend() })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy && !e.isComposing) { e.preventDefault(); opts.onStop() }
  })

  reset()
  updateSend()

  return {
    el,
    focus: () => input.focus(),
    apply(ev) {
      switch (ev.type) {
        case 'user': addUser(ev.text); break
        case 'busy': setBusy(ev.busy); break
        case 'text-delta': addAssistantText(ev.text); break
        case 'thinking': addThinking(ev.text); break
        case 'tool-start': addTool(ev.id, ev.name, ev.args, ev.parent); break
        case 'usage': setUsage(ev); break
        case 'compacted': addDivider('Conversation compacted'); break
        case 'tool-end': fillResult(ev.id, ev.text, ev.images, ev.isError); break
        case 'done': addEnd(!!ev.stopped); break
        // Not the end of the turn by itself: main always follows with busy:false.
        case 'error': addError(ev.message, ev.retry); announce('Error'); break
      }
    },
    sync(state) {
      rebuilding = true
      reset()
      const last = state.display[state.display.length - 1]
      for (const item of state.display) {
        if (item.kind === 'user') addUser(item.text)
        else if (item.kind === 'assistant') { closeAssistant(); addAssistantText(item.text) }
        else if (item.kind === 'note') addDivider(item.text)
        else if (item.kind === 'thinking') { closeThinking(); addThinking(item.text, item) }
        else addToolItem(item)
      }
      // A thought or a message still streaming keeps taking deltas after the rebuild.
      if (state.busy && last?.kind === 'thinking' && last.open) { /* `think` stays open */ }
      else if (!(state.busy && last?.kind === 'assistant')) closeAssistant()
      else { cur?.el.classList.add('streaming'); el.classList.add('streaming') }
      rebuilding = false
      setBusy(state.busy)
      setUsage(state.usage)
      stick = true
      follow()
    },
  }
}
