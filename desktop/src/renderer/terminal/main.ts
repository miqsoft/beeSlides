// The Claude Code terminal panel's own bespoke UI: xterm.js renders each
// parallel session's pty stream delivered over the slidomingoTerminal
// contextBridge (src/preload/terminal.ts), plus a small header bar (tab strip
// + popout/dock/close/new-tab buttons) whose controls call the matching
// slidomingoTerminal methods.
//
// Multi-session (parallel-claude-sessions): one panel can host several
// independent `claude` sessions as tabs — one xterm.js Terminal + one pane
// per session, all created here, shown/hidden by toggling `.active` (xterm
// keeps writing to a hidden terminal's buffer fine; only the FIT needs
// redoing once a pane becomes visible again, since `fit()` against a
// `display:none` container measures zero). main (not this renderer) is the
// source of truth for which sessions exist — a tab's own ✕ only REQUESTS a
// close; the tab is actually removed from the UI on the terminal:tab-closed
// push that confirms it, so this renderer can never show a tab whose pty
// main has already torn down.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createChatView, type ChatEvent, type ChatView, type DisplayItem, type UsageReadout } from './chatView.ts'

/** Mirrors src/preload/terminal.ts's InitSession. */
type InitSession = {
  id: string; chatId: string; createdAt: number; scrollback: string; exitCode?: number | null
  kind: 'terminal' | 'chat'; label: string; model?: string; display?: DisplayItem[]; busy?: boolean; usage?: UsageReadout | null
}
/** Mirrors src/preload/terminal.ts's ChatSummary. */
type ChatSummary = { id: string; title: string; startedAt: number; updatedAt: number; openIn: string | null; openElsewhere: boolean; kind?: 'claude' | 'api'; profileName?: string }
type ProfileEntry = { id: string; name: string; kind: 'claude-code' | 'api' }
/** Mirrors src/preload/terminal.ts's FolderState. */
type FolderState = { folders: Array<{ path: string; name: string; exists: boolean }>; deckFolder: string | null; canAttach: boolean; stale: number; error?: string }

declare global {
  interface Window {
    slidomingoTerminal: {
      onInit(cb: (state: { sessions: InitSession[]; activeId: string | null; mode?: 'docked' | 'popped' }) => void): void
      onData(cb: (sessionId: string, data: string) => void): void
      onExit(cb: (sessionId: string, code: number | null) => void): void
      onTabClosed(cb: (sessionId: string) => void): void
      write(sessionId: string, data: string): void
      resize(sessionId: string, cols: number, rows: number): void
      reportActive(sessionId: string): void
      newTab(profileId?: string): Promise<InitSession | null>
      listProfiles(): Promise<{ defaultId: string; profiles: ProfileEntry[] }>
      chatSend(sessionId: string, text: string): void
      chatStop(sessionId: string): void
      chatRetry(sessionId: string, effort: string): void
      onChatEvent(cb: (sessionId: string, ev: ChatEvent) => void): void
      onChatSync(cb: (sessionId: string, state: { display: DisplayItem[]; busy: boolean; usage?: UsageReadout | null }) => void): void
      onShowProfiles(cb: () => void): void
      listChats(): Promise<ChatSummary[]>
      tabTitles(): Promise<Record<string, string | null>>
      resumeChat(chatId: string): Promise<InitSession | null>
      listFolders(): Promise<FolderState | null>
      addFolder(): Promise<FolderState | null>
      removeFolder(path: string): Promise<FolderState | null>
      restartStale(): Promise<InitSession[]>
      ready(): void
      closeTab(sessionId: string): void
      popOut(): void
      dock(): void
      close(): void
      resizePanel(width: number): void
      resizePanelCommit(): void
      onShowHistory(cb: () => void): void
      onTheme(cb: (theme: 'light' | 'dark') => void): void
    }
  }
}

// Chrome (header/buttons/resizer) follows the app's own Auto/Light/Dark
// theme — pushed from the document renderer, since this view has no access
// to that window's localStorage (see terminal.css's two token blocks). The
// html tag's own default (dark) holds until the first push arrives.
window.slidomingoTerminal.onTheme((theme) => { document.documentElement.dataset.theme = theme })

// Keep these values byte-identical to slides/src/editor/sessioncolor.ts's
// copy — see that file's header comment for why the color is independently
// re-derived here instead of pushed from the main process.
const SESSION_COLORS = ['#7A5CFF', '#2FB6B2', '#E8442E', '#F4B400', '#3D8BFD', '#22A559', '#D6558C', '#8A6D3B']
function colorForSession(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return SESSION_COLORS[hash % SESSION_COLORS.length]
}

interface SessionUI {
  id: string
  /** Terminal tabs (a Claude Code pty) have `term`/`fit`; API chat tabs `chat`. */
  term: Terminal | null
  fit: FitAddon | null
  chat: ChatView | null
  pane: HTMLDivElement
  tabEl: HTMLDivElement
  labelEl: HTMLSpanElement
  /** The AI profile's tab name (and an API tab's model): the label until the
   *  conversation has a title, the tooltip's second line after. */
  profileLabel: string
  model?: string
  /** The conversation's title from main (terminal:tab-titles); null = none yet. */
  title: string | null
  /** main may deliver an exit twice (in the init payload, and again on the
   *  ready flush) — print the exit line only once. */
  exited: boolean
}

const sessions = new Map<string, SessionUI>()
let activeId: string | null = null
let tabCounter = 0 // renderer-local, cosmetic only ("Session 1", "Session 2", …) — never reused, never sent anywhere

const tabsEl = document.getElementById('term-tabs')!
const tabsWrapEl = document.getElementById('term-tabs-wrap')!

const headerEl = document.getElementById('term-header')!
const switcherTitleEl = document.getElementById('term-switcher-title')!
const switcherDotEl = document.getElementById('term-switcher-dot')!
const switcherBtnEl = document.getElementById('term-history')!

/** The tab row shows once two chats are open (one chat needs only the
 *  switcher's title), with a fade cue (terminal.css) so an overflowing strip
 *  doesn't clip tabs silently. Run on scroll, resize, and tab add/remove/rename. */
function updateTabsOverflow(): void {
  headerEl.classList.toggle('has-tabs', sessions.size > 1)
  tabsWrapEl.classList.toggle('has-overflow', tabsEl.scrollWidth > tabsEl.clientWidth + 1)
  tabsWrapEl.classList.toggle('at-end', tabsEl.scrollLeft + tabsEl.clientWidth >= tabsEl.scrollWidth - 1)
}
tabsEl.addEventListener('scroll', updateTabsOverflow)
new ResizeObserver(updateTabsOverflow).observe(tabsEl)

/** The switcher shows the chat on screen: its title, or its profile's name
 *  until it has one. */
function updateSwitcher(): void {
  const ui = activeId ? sessions.get(activeId) : undefined
  switcherTitleEl.textContent = ui ? (ui.title ?? ui.profileLabel) : 'Claude'
  switcherDotEl.style.background = ui ? colorForSession(ui.id) : 'transparent'
  switcherBtnEl.title = ui ? `${ui.title ?? 'New chat'} · ${profileLine(ui)}\nOpen and earlier chats` : 'Open and earlier chats'
}

// The buffer stays a dark terminal in both app themes (terminal.css header),
// tinted to the app's warm palette instead of a neutral grey. Claude Code
// draws most of its colours in truecolor; the ANSI set covers the rest.
const TERM_THEME = {
  background: '#17130D',
  foreground: '#ECE4D2',
  cursor: '#FFC233',
  cursorAccent: '#17130D',
  selectionBackground: 'rgba(255, 194, 51, 0.28)',
  black: '#2B251A', red: '#EF6B5B', green: '#7CC48A', yellow: '#F2C14E',
  blue: '#7AA7E8', magenta: '#D28AD8', cyan: '#6CC4C0', white: '#D8CFBD',
  brightBlack: '#7D725E', brightRed: '#FF8A7A', brightGreen: '#9BDDA8', brightYellow: '#FFD772',
  brightBlue: '#9DC1F5', brightMagenta: '#E5A8EA', brightCyan: '#8FDCD8', brightWhite: '#F8F2E5',
  // A slim, translucent scrollbar that only reads as a thumb (no track,
  // no arrows) — xterm's default is a wide opaque grey bar.
  scrollbarSliderBackground: 'rgba(245, 238, 223, 0.14)',
  scrollbarSliderHoverBackground: 'rgba(245, 238, 223, 0.28)',
  scrollbarSliderActiveBackground: 'rgba(245, 238, 223, 0.4)',
}
const container = document.getElementById('term-container')!

function createSessionUI(s: InitSession): SessionUI {
  const id = s.id
  tabCounter += 1

  const pane = document.createElement('div')
  pane.className = 'term-pane'
  pane.dataset.sessionId = id
  container.appendChild(pane)

  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let chat: ChatView | null = null
  if (s.kind === 'chat') {
    chat = createChatView({
      label: s.label, model: s.model,
      onSend: (text) => window.slidomingoTerminal.chatSend(id, text),
      onStop: () => window.slidomingoTerminal.chatStop(id),
      onRetry: (effort) => window.slidomingoTerminal.chatRetry(id, effort),
    })
    pane.classList.add('chat-pane')
    pane.append(chat.el)
  } else {
    term = new Terminal({
      // lineHeight stays 1: the DOM renderer draws box-drawing glyphs from
      // the font, so taller rows break the frames Claude Code draws.
      fontSize: 13.5,
      fontFamily: 'Menlo, Monaco, monospace',
      theme: TERM_THEME,
      overviewRuler: { width: 8 },
      cursorBlink: true,
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(pane)
    term.onData((data) => window.slidomingoTerminal.write(id, data))
  }

  const tabEl = document.createElement('div')
  tabEl.className = 'term-tab'
  tabEl.setAttribute('role', 'tab')
  tabEl.style.setProperty('--tab-color', colorForSession(id))
  tabEl.dataset.profile = s.label
  tabEl.dataset.sessionId = id
  const dot = document.createElement('span')
  dot.className = 'term-tab-dot'
  dot.style.background = colorForSession(id)
  const label = document.createElement('span')
  label.className = 'term-tab-label'
  label.textContent = s.label
  const closeBtn = document.createElement('button')
  closeBtn.className = 'term-tab-close'
  closeBtn.title = 'Close this session'
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation() // don't also activate the tab we're closing
    window.slidomingoTerminal.closeTab(id)
  })
  tabEl.append(dot, label, closeBtn)
  tabEl.addEventListener('click', () => activate(id))
  tabsEl.appendChild(tabEl)
  updateTabsOverflow() // adding a tab grows scrollWidth, not the strip's own box

  const ui: SessionUI = { id, term, fit, chat, pane, tabEl, labelEl: label, profileLabel: s.label, model: s.model, title: null, exited: false }
  setTitle(ui, null)
  return ui
}

/** What a tab is called: its conversation's title once there is one. */
function profileLine(ui: SessionUI): string {
  return ui.model ? `${ui.profileLabel} · ${ui.model}` : ui.profileLabel
}

function setTitle(ui: SessionUI, title: string | null): void {
  ui.title = title
  ui.labelEl.textContent = title ?? ui.profileLabel
  ui.tabEl.title = title ? `${title}\n${profileLine(ui)}` : profileLine(ui)
  updateTabsOverflow()
  if (ui.id === activeId) {
    ui.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateSwitcher()
  }
}

/** Asks main for every open tab's conversation title. Titles appear once the
 *  first message is sent and change when Claude Code names the chat or the
 *  user /renames it, so this runs on a slow poll as well as on tab changes. */
let titlesInFlight = false
function refreshTitles(): void {
  if (titlesInFlight || sessions.size === 0) return
  titlesInFlight = true
  void window.slidomingoTerminal.tabTitles().then((titles) => {
    for (const [id, title] of Object.entries(titles)) {
      const ui = sessions.get(id)
      if (ui && ui.title !== title) setTitle(ui, title)
    }
  }).catch(() => { /* panel closing */ }).finally(() => { titlesInFlight = false })
}
setInterval(refreshTitles, 3000)
window.addEventListener('focus', refreshTitles)

/** Builds a tab from main's handover: xterm first, then the scrollback
 *  replay, so claude's first Ink screen (drawn before this renderer even
 *  loaded) is there before live output resumes on ready(). */
function createSessionFromInit(s: InitSession): SessionUI {
  const ui = createSessionUI(s)
  sessions.set(s.id, ui)
  if (ui.chat) ui.chat.sync({ display: s.display ?? [], busy: !!s.busy, usage: s.usage })
  else {
    if (s.scrollback) ui.term!.write(s.scrollback)
    if (s.exitCode !== undefined) writeExit(ui, s.exitCode)
  }
  return ui
}

function writeExit(ui: SessionUI, code: number | null): void {
  if (ui.exited || !ui.term) return
  ui.exited = true
  ui.term.write(`\r\n[process exited${code !== null ? ` (${code})` : ''}]\r\n`)
}

function activate(id: string): void {
  const ui = sessions.get(id)
  if (!ui) return
  activeId = id
  window.slidomingoTerminal.reportActive(id)
  for (const s of sessions.values()) {
    const isActive = s.id === id
    s.pane.classList.toggle('active', isActive)
    s.tabEl.classList.toggle('active', isActive)
    s.tabEl.setAttribute('aria-selected', String(isActive))
  }
  updateSwitcher()
  ui.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  fitActive()
  refreshTitles()
  if (ui.chat) ui.chat.focus()
  else ui.term?.focus()
}

function fitActive(): void {
  const ui = activeId ? sessions.get(activeId) : undefined
  if (!ui?.term || !ui.fit) return
  ui.fit.fit()
  window.slidomingoTerminal.resize(ui.id, ui.term.cols, ui.term.rows)
}

/** Removes a session's tab + pane + xterm instance from the UI — called only
 *  from the terminal:tab-closed push (main is authoritative; see header
 *  comment), never directly from a close-button click. */
function removeSessionUI(id: string): void {
  const ui = sessions.get(id)
  if (!ui) return
  sessions.delete(id)
  ui.pane.remove()
  ui.tabEl.remove()
  updateTabsOverflow()
  ui.term?.dispose()
  if (activeId === id) {
    const next = sessions.keys().next().value ?? null
    activeId = null
    if (next) activate(next)
    else updateSwitcher()
  }
}

window.slidomingoTerminal.onInit(({ sessions: initial, activeId: initialActive, mode }) => {
  if (mode) document.documentElement.dataset.mode = mode
  for (const s of initial) createSessionFromInit(s)
  if (initialActive) activate(initialActive)
  window.slidomingoTerminal.ready()
  refreshTitles()
})
window.slidomingoTerminal.onData((sessionId, data) => sessions.get(sessionId)?.term?.write(data))
window.slidomingoTerminal.onChatEvent((sessionId, ev) => sessions.get(sessionId)?.chat?.apply(ev))
window.slidomingoTerminal.onChatSync((sessionId, state) => sessions.get(sessionId)?.chat?.sync(state))
window.slidomingoTerminal.onExit((sessionId, code) => {
  const ui = sessions.get(sessionId)
  if (ui) writeExit(ui, code)
})
window.slidomingoTerminal.onTabClosed((sessionId) => removeSessionUI(sessionId))

/** A tab main just spawned ("+" or a resumed conversation): build it, show
 *  it, and ack so its live output starts flowing. */
function addSpawnedTab(result: InitSession | null): void {
  if (!result) return
  createSessionFromInit(result)
  activate(result.id)
  window.slidomingoTerminal.ready()
}

/** Drops a menu from the button that opened it: under the bar, flush with the
 *  button's left edge when it sits on the left half, else its right edge. */
function placeMenu(menu: HTMLElement, btn: HTMLElement): void {
  const r = btn.getBoundingClientRect()
  menu.style.top = `${Math.round(r.bottom + 4)}px`
  if (r.left + r.width / 2 < window.innerWidth / 2) {
    menu.style.left = `${Math.max(8, Math.round(r.left))}px`
    menu.style.right = 'auto'
  } else {
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`
    menu.style.left = 'auto'
  }
}

// --- new chat: split button ---------------------------------------------------
// The "+" opens a chat with the default profile; the caret lists every profile
// (Settings ▸ AI). View ▸ New Chat With… opens the same list.
document.getElementById('term-new-tab')!.addEventListener('click', () => {
  void window.slidomingoTerminal.newTab().then(addSpawnedTab)
})
const profileBtn = document.getElementById('term-new-menu')!
const profileMenu = document.getElementById('term-profile-menu')!

function closeProfiles(): void {
  profileMenu.hidden = true
  profileBtn.setAttribute('aria-expanded', 'false')
}
function openProfiles(): void {
  void window.slidomingoTerminal.listProfiles().then(({ defaultId, profiles }) => {
    profileMenu.replaceChildren()
    for (const p of profiles) {
      const item = document.createElement('button')
      item.className = 'term-history-item'
      item.setAttribute('role', 'menuitem')
      const title = document.createElement('span')
      title.className = 'term-history-title'
      title.textContent = p.name
      const meta = document.createElement('span')
      meta.className = 'term-history-meta'
      meta.textContent = (p.kind === 'api' ? 'Chat via API' : 'Claude Code') + (p.id === defaultId ? ' · default' : '')
      item.append(title, meta)
      item.addEventListener('click', () => {
        closeProfiles()
        void window.slidomingoTerminal.newTab(p.id).then(addSpawnedTab)
      })
      profileMenu.append(item)
    }
    placeMenu(profileMenu, profileBtn)
    profileMenu.hidden = false
    profileBtn.setAttribute('aria-expanded', 'true')
    ;(profileMenu.querySelector('button') as HTMLButtonElement | null)?.focus()
  })
}
profileBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  if (!profileMenu.hidden) { closeProfiles(); return }
  closeHistory()
  closeFolders()
  openProfiles()
})
window.slidomingoTerminal.onShowProfiles(() => { if (profileMenu.hidden) openProfiles() })

// --- history menu ----------------------------------------------------------
// This deck's earlier conversations (main's chathistory.ts). Picking one that
// a tab here already runs just shows that tab; any other is continued with
// `claude --resume` in a new tab.
const historyBtn = document.getElementById('term-history')!
const historyMenu = document.getElementById('term-history-menu')!

function whenLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`
}

function closeHistory(): void {
  historyMenu.hidden = true
  historyBtn.setAttribute('aria-expanded', 'false')
}

/** A small grey heading between the menu's "open" and "earlier" parts. */
function historySection(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'term-history-section'
  el.textContent = text
  return el
}

/** The tabs open in this panel, in strip order: pick one to switch to it. */
function renderOpenTabs(chats: ChatSummary[]): void {
  const whenOf = new Map(chats.filter((c) => c.openIn).map((c) => [c.openIn!, c.updatedAt]))
  historyMenu.append(historySection('Open'))
  for (const tabEl of Array.from(tabsEl.querySelectorAll<HTMLElement>('.term-tab'))) {
    const ui = sessions.get(tabEl.dataset.sessionId ?? '')
    if (!ui) continue
    const row = document.createElement('div')
    row.className = 'term-history-row'
    const item = document.createElement('button')
    item.className = 'term-history-item term-history-open'
    item.classList.toggle('active', ui.id === activeId)
    item.setAttribute('role', 'menuitem')
    item.title = ui.title ?? profileLine(ui)
    const title = document.createElement('span')
    title.className = 'term-history-title'
    const dot = document.createElement('span')
    dot.className = 'term-tab-dot'
    dot.style.background = colorForSession(ui.id)
    const text = document.createElement('span')
    text.textContent = ui.title ?? 'New chat'
    title.append(dot, text)
    const meta = document.createElement('span')
    meta.className = 'term-history-meta'
    const when = whenOf.get(ui.id)
    meta.textContent = profileLine(ui) + (when ? ` · ${whenLabel(when)}` : '')
    item.append(title, meta)
    item.addEventListener('click', () => { closeHistory(); activate(ui.id) })
    const close = document.createElement('button')
    close.className = 'term-folder-remove'
    close.title = 'Close this chat'
    close.setAttribute('aria-label', `Close ${ui.title ?? 'this chat'}`)
    close.textContent = '×'
    close.addEventListener('click', () => {
      window.slidomingoTerminal.closeTab(ui.id)
      row.remove()
    })
    row.append(item, close)
    historyMenu.append(row)
  }
}

function renderHistory(chats: ChatSummary[]): void {
  historyMenu.replaceChildren()
  if (sessions.size > 0) renderOpenTabs(chats)
  chats = chats.filter((c) => !c.openIn)
  if (sessions.size > 0) historyMenu.append(historySection('Earlier'))
  if (chats.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'term-history-empty'
    empty.textContent = 'No earlier conversations about this deck yet.'
    historyMenu.append(empty)
    return
  }
  for (const chat of chats) {
    const item = document.createElement('button')
    item.className = 'term-history-item'
    item.setAttribute('role', 'menuitem')
    item.title = chat.title
    const title = document.createElement('span')
    title.className = 'term-history-title'
    title.textContent = chat.title
    const meta = document.createElement('span')
    meta.className = 'term-history-meta'
    const state = chat.openElsewhere ? ' · open in another window' : ''
    meta.textContent = whenLabel(chat.updatedAt) + (chat.profileName ? ` · ${chat.profileName}` : '') + state
    item.append(title, meta)
    item.disabled = chat.openElsewhere
    item.addEventListener('click', () => {
      closeHistory()
      void window.slidomingoTerminal.resumeChat(chat.id).then(addSpawnedTab)
    })
    historyMenu.append(item)
  }
}

function openHistory(): void {
  void window.slidomingoTerminal.listChats().then((chats) => {
    renderHistory(chats)
    placeMenu(historyMenu, historyBtn)
    historyMenu.hidden = false
    historyBtn.setAttribute('aria-expanded', 'true')
    ;(historyMenu.querySelector('.term-history-item:not(:disabled):not(.active)') as HTMLButtonElement | null)?.focus()
  })
}
historyBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  if (!historyMenu.hidden) { closeHistory(); return }
  closeFolders()
  openHistory()
})
window.slidomingoTerminal.onShowHistory(() => { if (historyMenu.hidden) openHistory() })
document.addEventListener('mousedown', (ev) => {
  if (!profileMenu.hidden && !profileMenu.contains(ev.target as Node) && !profileBtn.contains(ev.target as Node)) closeProfiles()
  if (!historyMenu.hidden && !historyMenu.contains(ev.target as Node) && ev.target !== historyBtn && !historyBtn.contains(ev.target as Node)) closeHistory()
  if (!foldersMenu.hidden && !foldersMenu.contains(ev.target as Node) && !foldersBtn.contains(ev.target as Node)) closeFolders()
})
// Ctrl+Tab / Ctrl+Shift+Tab step through the tabs, like a browser. Capture
// phase, so the key never reaches the focused xterm.
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Tab' || !ev.ctrlKey || ev.metaKey || ev.altKey || sessions.size < 2) return
  ev.preventDefault()
  ev.stopPropagation()
  const ids = Array.from(tabsEl.querySelectorAll<HTMLElement>('.term-tab')).map((t) => t.dataset.sessionId!)
  const at = activeId ? ids.indexOf(activeId) : -1
  activate(ids[(at + (ev.shiftKey ? -1 : 1) + ids.length) % ids.length])
}, true)
// A mouse wheel scrolls the tab strip sideways.
tabsEl.addEventListener('wheel', (ev) => {
  if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return
  tabsEl.scrollLeft += ev.deltaY
  ev.preventDefault()
}, { passive: false })
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !historyMenu.hidden) { closeHistory(); historyBtn.focus() }
  if (ev.key === 'Escape' && !profileMenu.hidden) { closeProfiles(); profileBtn.focus() }
  if (ev.key === 'Escape' && !foldersMenu.hidden) { closeFolders(); foldersBtn.focus() }
})

// --- folders menu ------------------------------------------------------------
// Folders the user attached to this deck's AI chats (main's attachedfolders.ts;
// local metadata, never saved in the deck). A Claude Code tab can only gain a
// folder by being relaunched, so tabs that predate a change get a Restart.
const foldersBtn = document.getElementById('term-folders')!
const foldersMenu = document.getElementById('term-folders-menu')!
const foldersCount = document.getElementById('term-folders-count')!

function closeFolders(): void {
  foldersMenu.hidden = true
  foldersBtn.setAttribute('aria-expanded', 'false')
}

function renderFolders(state: FolderState): void {
  foldersCount.hidden = state.folders.length === 0
  foldersCount.textContent = String(state.folders.length)
  foldersMenu.replaceChildren()
  const row = (title: string, meta: string, tip: string): HTMLButtonElement => {
    const item = document.createElement('button')
    item.className = 'term-history-item'
    item.setAttribute('role', 'menuitem')
    item.title = tip
    const t = document.createElement('span')
    t.className = 'term-history-title'
    t.textContent = title
    const m = document.createElement('span')
    m.className = 'term-history-meta term-folder-path'
    m.textContent = meta
    item.append(t, m)
    return item
  }
  if (state.deckFolder) {
    const own = row("This deck's folder", state.deckFolder, state.deckFolder)
    own.disabled = true
    foldersMenu.append(own)
  }
  for (const f of state.folders) {
    const wrap = document.createElement('div')
    wrap.className = 'term-folder-row'
    const item = row(f.name, f.exists ? f.path : `${f.path} — not found`, f.path)
    item.disabled = true
    const remove = document.createElement('button')
    remove.className = 'term-folder-remove'
    remove.title = 'Detach this folder'
    remove.setAttribute('aria-label', `Detach ${f.name}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => { void window.slidomingoTerminal.removeFolder(f.path).then((s) => { if (s) renderFolders(s) }) })
    wrap.append(item, remove)
    foldersMenu.append(wrap)
  }
  const add = row('Attach folders…', state.canAttach ? 'Let this deck\u2019s AI chats read the files in one or more folders.' : 'Save the deck first.', 'Attach folders')
  add.disabled = !state.canAttach
  add.addEventListener('click', () => { void window.slidomingoTerminal.addFolder().then((s) => { if (s) renderFolders(s) }) })
  foldersMenu.append(add)
  if (state.error) {
    const err = document.createElement('div')
    err.className = 'term-folder-error'
    err.textContent = state.error
    foldersMenu.append(err)
  }
  if (state.stale > 0) {
    const note = document.createElement('div')
    note.className = 'term-folder-note'
    note.textContent = state.stale === 1 ? 'A Claude Code tab was started before this change.' : `${state.stale} Claude Code tabs were started before this change.`
    const restart = document.createElement('button')
    restart.className = 'term-folder-restart'
    restart.textContent = 'Restart them (conversations continue)'
    restart.addEventListener('click', () => {
      restart.disabled = true
      void window.slidomingoTerminal.restartStale().then((tabs) => {
        for (const t of tabs) addSpawnedTab(t)
        void window.slidomingoTerminal.listFolders().then((s) => { if (s) renderFolders(s) })
      })
    })
    foldersMenu.append(note, restart)
  }
}

function openFolders(): void {
  void window.slidomingoTerminal.listFolders().then((state) => {
    if (!state) return
    renderFolders(state)
    placeMenu(foldersMenu, foldersBtn)
    foldersMenu.hidden = false
    foldersBtn.setAttribute('aria-expanded', 'true')
  })
}
foldersBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  if (!foldersMenu.hidden) { closeFolders(); return }
  closeHistory()
  closeProfiles()
  openFolders()
})
// The count on the button is there from the start, not only once the menu was opened.
void window.slidomingoTerminal.listFolders().then((state) => { if (state) renderFolders(state) })

// A raw ResizeObserver/mousemove can fire dozens of times per second during a
// drag, and each firing here used to mean a synchronous fitAddon.fit() + a PTY
// resize — i.e. a SIGWINCH-equivalent storm hitting the shell/`claude`
// mid-redraw, which is exactly the kind of thing that corrupts (or blanks) a
// TUI that repaints on resize. The throttle that actually rate-limits this
// lives in the MAIN process now (terminalPanel.ts's requestPanelWidth) — not
// here — because a renderer's own rAF/setTimeout are subject to Chromium's
// page-visibility/background throttling and were measured to go completely
// silent (rAF: 0 callbacks in 2s; setTimeout: clamped to ~1/s) for this
// secondary WebContentsView under some focus states, which would have made a
// renderer-side coalesce silently swallow every resize instead of just
// smoothing it. Node's timers in the main process have no such throttling.
// With the upstream setBounds calls already rate-limited there, what reaches
// this ResizeObserver is already at a safe cadence — no coalescing needed.
// Only the ACTIVE session is re-fit; a hidden pane's `fit()` would measure a
// zero-size container and corrupt its dimensions — it gets fit on activate()
// instead, once it's actually visible again.
const resizeObserver = new ResizeObserver(() => fitActive())
resizeObserver.observe(container)

document.getElementById('term-popout')!.addEventListener('click', () => window.slidomingoTerminal.popOut())
document.getElementById('term-dock')!.addEventListener('click', () => window.slidomingoTerminal.dock())
document.getElementById('term-close')!.addEventListener('click', () => window.slidomingoTerminal.close())

// Left-edge drag handle for the panel's own pixel WIDTH (mirrors editor.ts's
// makeResizer for the sidebar/props panels) — this view always fills its
// host's bounds, so window.innerWidth IS the current panel width; dragging
// the left edge left (screenX decreasing) grows the panel. Sent unthrottled:
// a single number over IPC is cheap, and the main process is what actually
// rate-limits the expensive relayout (see the comment above).
const resizer = document.getElementById('term-resizer')!
resizer.addEventListener('mousedown', (down) => {
  down.preventDefault()
  const startScreenX = down.screenX
  const startWidth = window.innerWidth
  document.body.classList.add('term-resizing')
  const move = (ev: MouseEvent) => {
    window.slidomingoTerminal.resizePanel(startWidth - (ev.screenX - startScreenX))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.classList.remove('term-resizing')
    window.slidomingoTerminal.resizePanelCommit()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})
