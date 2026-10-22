// Owns the Claude Code terminal panel's lifecycle: a WebContentsView that is
// either docked as a sibling of a document window's docView, or popped out
// into its own plain BrowserWindow. Moving between the two used to RELOCATE
// the same WebContentsView instance across windows (removeChildView from one
// parent, addChildView into another) — but Electron/Chromium does not
// correctly re-bind a WebContentsView's native compositor surface when its
// owning top-level window changes, which is why that used to render as a
// blank pop-out and then a white main window on dock-back. Every OTHER view
// in this codebase (docView, this panel's own initial dock, the speaker
// window via plain window.open) is created once and attached to one window
// for its whole life — never relocated. Pop/dock now follow that same
// create-once pattern: on each transition the current view is torn down and
// a FRESH one is built in whichever window now hosts the panel, rewired to
// the SAME still-running pty(s) (the actual shell/`claude` process(es) are
// never touched, only the on-screen renderer is rebuilt).
//
// **Scrollback lives in main, and pty output is never forwarded before
// `terminal:ready`.** Every session records its own pty output from the
// moment the pty spawns (SessionState.scrollback, capped). A view gets that
// replay inside `terminal:init` (or the "+" handler's response), and live
// `terminal:data` for a session is gated until the renderer acks with
// `terminal:ready`, after which main flushes whatever arrived between the
// snapshot and the ack. Without this, `claude` (spawned before the renderer
// has even started loading) drew its whole first Ink screen into the void,
// leaving a blank pane that also looked like it ignored input. The same
// replay is what lets the transcript survive pop/dock.
//
// **Multi-session (parallel-claude-sessions)**: one docked/popped panel can
// now host several independent `claude` sessions as a small tab strip in the
// SAME renderer (see desktop/src/renderer/terminal/main.ts) — one pty + one
// MCP server config + one contextDir subfolder per tab (`SessionState`
// below), all sharing the panel's single WebContentsView, docked/popped-out
// width and pop/dock lifecycle (those stay panel-level, not per-tab, exactly
// as before). Closing a tab kills only that tab's pty and its session
// subfolder — the cheap way to start a fresh `claude` conversation without
// losing the window's other sessions. Session ids are `crypto.randomUUID()`
// (never a reused index) specifically so a closed-then-reopened tab can never
// be confused with the slide locks its predecessor held — see
// slides/src/store.ts's lock registry and editor.ts's applyAgentAction/
// applyExternalSlideWrite, the actual lock-enforcement chokepoint. This file
// only threads a `sessionId` through every forwarded request/response; it
// holds no lock state of its own.
import { BrowserWindow, WebContentsView, app, dialog, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_PROMPTS, asPaste, drawIconsPrompt, fixCommentsPrompt, fixImportPrompt, planIconsPrompt, styleIconsPrompt } from './agentprompts.ts'
import { renderToPdf } from './sourcerender.ts'
import { createPty, loginShellEnv, type ClaudeChat, type PtyHandle } from './pty.ts'
import { apiKeyFor, apiSkillsDir, getProfile, getProfiles, resolveRoles } from './aiprofilesStore.ts'
import { mergeSettings, REASONING_EFFORTS, tabLabel, type AiProfile, type ClaudeCodeProfile, type ReasoningEffort } from './aiprofiles.ts'
import { ApiChatSession, displayFromMessages, type DisplayItem, type UsageReadout } from './apichat/session.ts'
import { BUILTIN_SKILLS, CUSTOMIZE_UI_SKILL_MD } from './apichat/skills/index.ts'
import type { ChatEvent } from './apichat/types.ts'
import { writeFileAtomic } from './fsutil.ts'
import { forwardAgentRequest, isSafeId, type AgentChannel } from './agentbridge.ts'
import { addFolder, existingFolders, listFolders, removeFolder, retargetFolders, validateFolder } from './attachedfolders.ts'
import { addRecord, backfillChats, belongsTo, clip, findTranscript, getRecord, isChatId, listChats, retarget, tailTranscriptTitle, type ChatSummary, type DeckKey, type TitleTail } from './chathistory.ts'
import { deckKeyFor, docWebContentsFor, draftsDir, layoutWindow, launchPathFor, windowForDocWebContents } from './windows.ts'
import { isInside } from './docfile.ts'
import { guardNavigation } from './navguard.ts'
import { handleFrom, onFrom } from './ipcguard.ts'
import { ensureWorkspace, isUntitledKey, workspaceKey } from './workspaces.ts'
// Bundled straight into the built main.js (see raw-modules.d.ts) so a
// generate request's context dir carries the reference docs `claude` needs
// without a separate copy-at-build step or a runtime fetch of the repo.
import FORMAT_MD from '../../../docs/format.md?raw'
import AGENTS_MD from '../../../docs/agents.md?raw'
// Condensed design brief used ONLY by the generate flow (writeGenerateFiles
// below) — format.md/agents.md above stay the full reference for ordinary
// write_slide/insert_elements MCP edits in every terminal session.
import GENERATE_BRIEF from '../../../docs/generate-brief.md?raw'
// Same trick for the get_slide/write_slide MCP server — see
// ../mcp/slides-mcp-server.mjs and its own header comment.
import SLIDES_MCP_SERVER from '../mcp/slides-mcp-server.mjs?raw'
import { serverWithAgentAreas, serverWithCodeMode } from './agenttools.ts'
import { codeModeEnabled } from './agentexec.ts'

let mcpServerFilled: string | null = null
/** The server as written to disk: with the grouped `deck`/… tools filled in
 *  (agenttools.ts). Without its placeholder it still works, minus those.
 *  Also the copy outside AI apps run (agentendpoint.ts). */
export function mcpServerSource(): string {
  try { return (mcpServerFilled ??= serverWithCodeMode(serverWithAgentAreas(SLIDES_MCP_SERVER), codeModeEnabled())) } catch { return SLIDES_MCP_SERVER }
}
// The UserPromptSubmit hook that attaches a selection.json digest to every
// prompt — see ../mcp/selection-digest.mjs and createSession's settings.json.
import SELECTION_DIGEST from '../mcp/selection-digest.mjs?raw'
// SessionStart hook: reports the conversation id `claude` is on (/clear, /resume).
import SESSION_NOTE from '../mcp/session-note.mjs?raw'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** A start-page (startuppicker.ts) request for Claude Code: design a deck
 *  from a description, or rebuild a PowerPoint as a native deck or as a
 *  layout (a template file: slide types + theme). `baseline` is our own
 *  converter's draft of the same file (kernel convert/pptx.ts). */
export type GenerateRequest =
  | { kind: 'describe'; description: string }
  | { kind: 'pptx'; target: 'deck' | 'layout'; sourcePath: string; name: string; baseline?: unknown }

/** A renderer-sent request, checked before anything touches the disk: a
 *  pptx request must name an existing absolute .pptx/.potx FILE (it is
 *  copied into the context dir, never read in place). */
/** An absolute path to an existing .pptx/.potx FILE. */
function isPptxFile(p: unknown): p is string {
  if (typeof p !== 'string' || !isAbsolute(p) || !/\.(pptx|potx)$/i.test(p)) return false
  try { return statSync(p).isFile() } catch { return false }
}

/** Types `text` into `win`'s Claude session (the tab last typed into, else
 *  the first), as if the user had typed it — opening the panel, or a tab,
 *  with it as the initial task when there is none. The text comes from
 *  agentprompts.ts, never straight from a document. */
function deliverPrompt(win: BrowserWindow, text: string): void {
  const panel = panels.get(win.id)
  // initialTask is shell-quoted without escaping (pty.ts) — never pass a risky one.
  const initialTask = /['$`\\]/.test(text) ? undefined : text
  if (!panel) {
    // no terminal yet: open it and start Claude with the prompt
    void openPanel(win, { initialTask })
    return
  }
  revealPanel(panel)
  const session = (panel.lastInputSessionId && panel.sessions.get(panel.lastInputSessionId)) || panel.sessions.values().next().value
  if (session) {
    if (session.chat) void session.chat.send(text)
    else {
      // a multi-line message is one bracketed paste; Enter follows once the
      // TUI has taken the paste in
      session.pty.write(asPaste(text))
      setTimeout(() => { try { session.pty.write('\r') } catch { /* exited */ } }, 150)
    }
    return
  }
  // panel open but every tab closed: spawn one like the "+" button does
  // and hand it to the view through the same message an init uses
  void (async () => {
    const created = await createSession(panel.workspace, panel.contextDir, basename(panel.contextDir), () => deckKeyForWindow(panel.hostWindow), { initialTask })
    if (!created || panels.get(win.id) !== panel) return
    const init = wireAndRegisterSession(panel, created)
    try { panel.view.webContents.send('terminal:init', { sessions: [init], activeId: created.id, mode: panel.mode }) } catch { /* view gone */ }
  })()
}

export function isValidGenerateRequest(r: unknown): r is GenerateRequest {
  if (!r || typeof r !== 'object') return false
  const req = r as Record<string, unknown>
  if (req.kind === 'describe') return typeof req.description === 'string' && req.description.trim() !== ''
  if (req.kind !== 'pptx') return false
  if (req.target !== 'deck' && req.target !== 'layout') return false
  if (typeof req.name !== 'string' || typeof req.sourcePath !== 'string') return false
  return isPptxFile(req.sourcePath)
}

const DEFAULT_PANEL_WIDTH = 420
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 800

function clampPanelWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)))
}

/** One `claude` pty + its own MCP wiring — one per open terminal TAB. Several
 *  of these live under one PanelState, sharing its single WebContentsView. */
interface SessionState {
  id: string
  /** The `claude` conversation this tab runs (`--session-id`/`--resume`) —
   *  distinct from `id`, which is minted fresh per tab even when an old
   *  conversation is resumed, so slide locks never carry over. */
  chatId: string
  /** `terminal` = a Claude Code pty; `chat` = a native API chat (`chat` below,
   *  `pty` is then an inert stand-in so the shared plumbing needs no branches). */
  kind: 'terminal' | 'chat'
  /** The AI profile this tab runs; its name is the tab label. */
  profile: AiProfile
  chat: ApiChatSession | null
  pty: PtyHandle
  /** The attached folders this tab's `claude` was launched with (a pty cannot
   *  gain `--add-dir`s later): when they differ from the deck's current list
   *  the panel offers a restart. Empty for chat tabs, which read them live. */
  extraDirs: string[]
  createdAt: number
  /** Every pty chunk since spawn, oldest dropped past SCROLLBACK_MAX_BYTES —
   *  replayed into each freshly built view (see the header comment). */
  scrollback: string[]
  scrollbackBytes: number
  /** Absolute index of scrollback[0] — chunks dropped off the front so far.
   *  `scrollbackBase + scrollback.length` is a monotonic "chunks ever
   *  recorded" counter, which is what a view's replay mark is measured in. */
  scrollbackBase: number
  /** Set once the pty exits, so a view built afterward (or one whose
   *  ready ack is still pending) still shows the exit line. */
  exitCode: number | null | undefined
  /** This session's OWN subfolder, one level below the panel's shared
   *  contextDir (`<contextDir>/session-<id>`) — its private mcp-config.json
   *  plus every per-request write-back file (slide-request-*.json,
   *  agent-query-*.json, edit.json, …). Keeping these per-session, not
   *  shared, is what lets two tabs call write_slide/insert_elements at the
   *  same instant without their request files colliding on a filename —
   *  the actual mutual-exclusion enforcement (locks) lives downstream, in
   *  slides/src/store.ts, keyed by THIS id. */
  contextDir: string
  editWatcher: FSWatcher | null
  editDebounceTimer: NodeJS.Timeout | null
  slideWatcher: FSWatcher | null
  agentWatcher: FSWatcher | null
  /** uuid-named MCP request files already forwarded — fs.watch fires several
   *  events per write, and with no debounce each would otherwise re-dispatch
   *  the same request (a write verb applied twice). See claimRequestFile. */
  handledRequestFiles: Set<string>
  /** At most one pending "partial write, parse again shortly" retry per file. */
  requestRetryTimers: Map<string, NodeJS.Timeout>
  /** How far the tab title has read this tab's transcript (terminal:tab-titles). */
  titleTail?: TitleTail
}

interface PanelState {
  view: WebContentsView
  /** Unsubscribes the CURRENT view's pty listeners for one session — call
   *  before replacing `view` with a fresh one (pop/dock) so the outgoing
   *  view's closures (which `.send()` on what's about to be dead webContents)
   *  don't keep firing forever. Rebuilt (one entry per live session) every
   *  time `view` is rebuilt. */
  sessionUnwire: Map<string, () => void>
  mode: 'docked' | 'popped'
  /** Docked panel slid away (toggle / header ✕). Its ptys keep running and the
   *  view stays alive, parked off the window's right edge at full size (so the
   *  terminal never sees a resize); only disposePanel ends the sessions. */
  hidden: boolean
  /** How much of the docked panel is on screen, 0..1 — animated by
   *  animateReveal; 0 while `hidden` once the slide has finished. */
  reveal: number
  revealTimer: NodeJS.Timeout | null
  hostWindow: BrowserWindow
  popoutWindow: BrowserWindow | null
  /** Per-window-scoped shared directory — selection.json, format.md,
   *  agents.md, the MCP server script, and the generate-request/result
   *  channel all live directly here (identical for every tab); each
   *  session's OWN subfolder lives one level below (SessionState.contextDir).
   *  Lives exactly as long as the panel — created here, removed whole in
   *  disposePanel. */
  contextDir: string
  /** The cwd every session of this panel runs in (see workspaceForWindow).
   *  Fixed at open: the context dir lives inside it, and a draft saved while
   *  the panel is open keeps its `untitled-<n>` workspace until reopened. */
  workspace: string
  /** Set when `workspace` is an `untitled-<n>` one — removed whole in
   *  disposePanel (docId workspaces persist; workspaces.ts sweeps them). */
  scratchDir: string | null
  /** Parallel to the per-session watchers, for requestGenerate's
   *  generate-result.json write-back (see startGenerateWatcher) — started
   *  unconditionally for every panel (like a session's watchers) so a plain
   *  ⌘\`-opened terminal is already watching by the time requestGenerate later
   *  writes into its contextDir. Panel-scoped, not per-session: "Create a
   *  template" targets the document as a whole, not one tab. */
  generateWatcher: FSWatcher | null
  generateDebounceTimer: NodeJS.Timeout | null
  /** Every open tab, insertion order = tab order. The FIRST session (if any)
   *  is what requestGenerate/writeGenerateFiles's initialTask launches into
   *  when the panel is first created. */
  sessions: Map<string, SessionState>
  /** The tab the user last typed into — where a prompt the editor asks for
   *  (slidomingo:agent-prompt, e.g. "Polish with Claude") is sent. Main has
   *  no other notion of the active tab; null = the first one. */
  lastInputSessionId: string | null
  /** The tab the renderer last ACTIVATED (`terminal:activated`) — what a
   *  rebuilt view (pop-out / dock) reopens on instead of always the first
   *  tab. May name a tab closed since: read it via activeSessionIdFor. */
  activeSessionId: string | null
}

const CONTEXT_README =
  `This directory is BeeSlides' live selection context for Claude Code —` +
  ` SHARED by every terminal tab (parallel session) open against this document.\n\n` +
  `selection.json updates automatically (~400ms debounce) as the user selects\n` +
  `elements, edits them, or switches surface (deck slide, slide type in the\n` +
  `Layout Manager, reusable object). It also carries selectedSlideIds: slides\n` +
  `multi-selected in the Slide Sorter. It is NOT written for an encrypted deck.\n` +
  `A one-line digest of it (selection-digest.mjs, a UserPromptSubmit hook) is\n` +
  `attached to every message you receive, so you rarely need to read it.\n\n` +
  `Each terminal TAB has its own session-<id> subfolder one level below this\n` +
  `directory (its mcp-config.json, settings.json and per-request files). You\n` +
  `never need to touch it; the MCP tools already point at it.\n\n` +
  `MCP tools (server "beeslides") give progressively-disclosed access.\n` +
  `Prefer the cheap ones; get_slide/write_slide move a whole slide's JSON:\n` +
  `  read:  doc_info, outline, find_text (search the deck), list_reusable_objects,\n` +
  `         measure, validate,\n` +
  `         comments, recent_changes, render_preview,\n` +
  `         check_layout, review_slide (screenshot + frames + findings),\n` +
  `         get_slide (view "summary" to read, "full" before write_slide).\n` +
  `  write: update_element (patch props of one element — the default edit),\n` +
  `         insert_elements, set_frame, duplicate_element, delete_element,\n` +
  `         reorder_element, apply_change_pattern, write_slide (restructure\n` +
  `         only), propose_variants (2-6 designs of one slide as HTML for\n` +
  `         the user to compare and pick; applies nothing),\n` +
  `         create_reusable_object, promote_to_reusable_object,\n` +
  `         create_slide_type,\n` +
  `         slide_type({op: rename|reorder|move|detach|relink}),\n` +
  `         deck({op: add|duplicate|delete|move|hide|rename|transition|\n` +
  `         background|notes|section_*|state_add|state_sync|hover|properties|help}),\n` +
  `         deck_settings({op: theme|size|present|slide_timing|header_footer|\n` +
  `         footer_elements|slide_footer|numbering|help}),\n` +
  `         icons({op: search|insert|help}) (the user's icon library),\n` +
  `         elements({op: edit|delete|arrange|align|distribute|match_size|help})\n` +
  `         (several elements in one call; layout by intent).\n` +
  `Every slideId also accepts a reusable object's or slide type's id; a write\n` +
  `to a slide type reaches every deck slide using it. Each write is one undo\n` +
  `step and returns "warnings" (validate() findings for that slide); a TEXT\n` +
  `OVERFLOW banner means the text does not fit — measure() and fix it.\n` +
  `The app also guards the layout around each write, in the same undo step:\n` +
  `grown text, kept gaps and attached arrows come back as "↻ LAYOUT\n` +
  `ADJUSTED"; "⚠ LAYOUT" lists what still overlaps — fix it and call\n` +
  `check_layout until clean. reflow:false on a write opts out (report only).\n\n` +
  `Several sessions may edit the same slide; each write is its own undo step.\n` +
  `Re-read (get_slide) before a bigger edit if another session may be working.\n\n` +
  `agents.md starts with a quick reference (element shapes, common props);\n` +
  `read only that part unless you need more. format.md is the full spec.\n\n` +
  `If a generate-request.json shows up here (the app's start page writes one\n` +
  `when asked to design a deck, or to rebuild a PowerPoint as a deck or as a\n` +
  `layout), read it alongside generate-brief.md in this same directory (the\n` +
  `condensed design brief — format.md and agents.md above cover the full\n` +
  `reference if you need more). A "pptx" request comes with source.pptx (the\n` +
  `file itself) and pptx-converted.json (our converter's draft of it). Users\n` +
  `call a template a "layout" — the format field is still \`template\`.\n` +
  `Write the complete BeeSlides document as JSON to\n` +
  `generate-result.json as that JSON object alone. The app renders this file\n` +
  `live as a preview while you work, so don't wait until the whole deck is\n` +
  `done to write it once — save it again at a few points along the way (e.g.\n` +
  `once the theme and slide types are in place, then again after each slide\n` +
  `or small batch of slides), with each save still the complete, currently\n` +
  `valid document, not a fragment. You can overwrite generate-result.json\n` +
  `again any time the user asks for changes — the app picks up every new\n` +
  `version.\n`

/** The fixed task `createPty` appends to the launch line for a panel opened
 *  via requestGenerate — see pty.ts's `initialTask`. Hand-verified free of
 *  shell-special characters (no `'`, `"`, backticks, `$`, `\`, no
 *  possessives), same discipline as pty.ts's own claudeInstruction, since it
 *  is interpolated into a single-quoted pty command. */
const generateTask = (dir: string): string =>
  `A generation request is waiting at ./${dir}/generate-request.json. ` +
  `Read it and ./${dir}/generate-brief.md, the condensed format and design ` +
  `brief; format.md and agents.md in the same folder cover the full ` +
  `reference if needed. Build the complete, polished BeeSlides ` +
  `document the request asks for as JSON, then write it to ` +
  `./${dir}/generate-result.json as that JSON object alone. The app shows ` +
  `this file live as a preview while you work, so do not wait until the ` +
  `whole deck is done to write it once: save it again at a few points along ` +
  `the way, for example once the theme and slide types are in ` +
  `place, then again after each slide or small batch of slides, so progress ` +
  `is visible as you go. Each save must still be the complete, currently ` +
  `valid document, never a fragment. Keep iterating and overwrite ` +
  `generate-result.json again whenever the user asks for changes.`

const panels = new Map<number, PanelState>() // keyed by hostWindow.id

/** Per-window live width, seeded from the persisted value when a panel is
 *  created (so two windows can differ mid-drag) and dropped in disposePanel
 *  — persistence itself lives in panel-width.json (see below), not here. */
const panelWidths = new Map<number, number>()

/** Per-window resolved app theme ('light'/'dark'), pushed by editor.ts (see
 *  slidomingo:terminal-theme below) — kept even with no panel open yet, so a
 *  panel created AFTER the theme is known opens already matching instead of
 *  flashing its default. Not persisted: re-sent by the document renderer
 *  every boot. */
const windowThemes = new Map<number, 'light' | 'dark'>()

const isDev = !app.isPackaged
const preloadPath = join(__dirname, '../preload/terminal.mjs')
const rendererIndex = join(__dirname, '../renderer/terminal/index.html')

// --- persisted panel width (one value, shared across windows) -------------
// Same shape/posture as recent.ts's store: a small JSON file under userData,
// loaded lazily (app.getPath needs the app ready, so this can't run at
// module top level) and cached after first read.

let cachedPersistedWidth: number | null = null

const panelWidthStorePath = (): string => join(app.getPath('userData'), 'panel-width.json')

function loadPersistedWidth(): number {
  if (cachedPersistedWidth != null) return cachedPersistedWidth
  try {
    const parsed = JSON.parse(readFileSync(panelWidthStorePath(), 'utf8'))
    cachedPersistedWidth = typeof parsed?.width === 'number' ? clampPanelWidth(parsed.width) : DEFAULT_PANEL_WIDTH
  } catch {
    cachedPersistedWidth = DEFAULT_PANEL_WIDTH
  }
  return cachedPersistedWidth
}

function persistWidth(width: number): void {
  cachedPersistedWidth = width
  try { writeFileSync(panelWidthStorePath(), JSON.stringify({ width }), 'utf8') } catch { /* best effort */ }
}

function launchPathForWindow(win: BrowserWindow): string | null {
  const docWc = docWebContentsFor(win)
  return docWc ? launchPathFor(docWc.id) : null
}

/** The folder `claude` runs in: an app-owned workspace per deck under
 *  userData (keyed by docId, so it survives rename/move/Save As; an
 *  `untitled-<winId>` one without a docId). It is NOT the deck's folder — that
 *  would make the folder (and its ancestors) the Claude Code project and load
 *  their CLAUDE.md/settings/hooks. The deck's folder is granted separately
 *  (deckDirForWindow → --add-dir). Pre-trusted in pty.ts (ensureClaudeTrust),
 *  which is safe because it only ever holds our own files. */
export const claudeWorkspacesRoot = (): string => join(app.getPath('userData'), 'claude-workspaces')

function workspaceForWindow(win: BrowserWindow): string {
  const path = launchPathForWindow(win)
  const key = workspaceKey(deckKeyForWindow(win).docId, win.id)
  return ensureWorkspace(claudeWorkspacesRoot(), key, path ? basename(path) : null, !!deckDirOf(path), { 'customize-ui': CUSTOMIZE_UI_SKILL_MD })
}

/** The folder of a SAVED deck (a draft under userData/Drafts has none worth
 *  granting), or null. */
function deckDirOf(path: string | null): string | null {
  if (!path) return null
  return isInside(path, draftsDir()) ? null : dirname(path)
}

function titleForWindow(win: BrowserWindow): string {
  const path = launchPathForWindow(win)
  return `Claude Code — ${path ? basename(path) : 'Untitled'}`
}

/** Is `raw` the terminal renderer's page (the dev server under
 *  `electron-vite dev`, else the built file)? */
export function isTerminalRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const dev = isDev ? process.env['ELECTRON_RENDERER_URL'] : ''
    if (dev) return url.origin === new URL(dev).origin
    return url.protocol === 'file:' && resolve(fileURLToPath(url)) === resolve(rendererIndex)
  } catch { return false }
}

/** webContents ids of every live terminal view (docked, popped out, or a
 *  pop/dock replacement still loading) — buildTerminalView adds them. */
const terminalViewIds = new Set<number>()

/** Did this IPC come from the main frame of a terminal view running the
 *  terminal renderer? Every `terminal:*` / `chat:*` handler requires it
 *  (ipcguard.ts). */
export function isTerminalSender(ev: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!terminalViewIds.has(ev.sender.id)) return false
  const frame = ev.senderFrame
  if (!frame || frame.parent) return false
  return isTerminalRendererUrl(frame.url)
}

async function loadTerminalRenderer(view: WebContentsView): Promise<void> {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await view.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await view.webContents.loadFile(rendererIndex)
  }
}

/** Guards a requestId/sessionId used to build a filesystem path or forwarded
 *  over IPC — both always originate from a `crypto.randomUUID()` (the MCP
 *  server's for requestId, this file's for sessionId), but are validated here
 *  anyway before they touch a filesystem path or a Map lookup, since a
 *  renderer's IPC payload is not to be trusted by construction. */
/** The tab a rebuilt view should open on: the user's last real activation if
 *  that tab is still open, else the first one. */
function activeSessionIdFor(panel: PanelState): string | null {
  if (panel.activeSessionId && panel.sessions.has(panel.activeSessionId)) return panel.activeSessionId
  return [...panel.sessions.keys()][0] ?? null
}

// --- chat history ------------------------------------------------------------
// Which conversations belong to which deck (chathistory.ts): every session is
// launched under an id this file picks, recorded against the window's deck,
// and listed in the panel's history menu, where one can be resumed in a new
// tab. The transcripts stay in Claude Code's own folder; the pointers live in
// userData.

const chatHistoryPath = (): string => join(app.getPath('userData'), 'chat-history.json')

// Folders the user attached to a deck's chats (attachedfolders.ts): local
// metadata in userData, never in the deck file.
const attachedFoldersPath = (): string => join(app.getPath('userData'), 'attached-folders.json')
/** The deck's attached folders that exist right now — what a session gets. */
const foldersOf = (deck: DeckKey): string[] => existingFolders(listFolders(attachedFoldersPath(), deck))

/** Where `claude` keeps its transcripts — the pty's env decides (the user's
 *  shell may set CLAUDE_CONFIG_DIR), not Electron's. */
async function claudeConfigDir(profile?: AiProfile): Promise<string> {
  if (profile?.kind === 'claude-code' && profile.configDir) return profile.configDir
  return (await loginShellEnv())['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

/** Every distinct Claude config folder across the profiles (history lookup). */
async function allClaudeConfigDirs(): Promise<string[]> {
  const dirs = new Set<string>([await claudeConfigDir()])
  for (const p of getProfiles().profiles) if (p.kind === 'claude-code') dirs.add(await claudeConfigDir(p))
  return [...dirs]
}

const apiChatsDir = (): string => join(app.getPath('userData'), 'api-chats')

/** A Claude Code profile for flows that need Claude reading files (the start
 *  page's generate flows): the preferred one if it is one, else the first. */
function claudeProfileOrFirst(preferred?: AiProfile): ClaudeCodeProfile {
  if (preferred?.kind === 'claude-code') return preferred
  const first = getProfiles().profiles.find((p): p is ClaudeCodeProfile => p.kind === 'claude-code')
  return first ?? { id: 'claude-code-default', name: 'Claude Code', kind: 'claude-code', command: 'claude' }
}

/** An inert PtyHandle for chat tabs. */
const NO_PTY: PtyHandle = {
  onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {}, dispose: () => {},
}

function deckKeyForWindow(win: BrowserWindow): DeckKey {
  const docWc = docWebContentsFor(win)
  return docWc ? deckKeyFor(docWc.id) : { docId: null, path: null }
}

/** The tab (in any window) currently running a conversation — one
 *  transcript must never have two `claude` processes appending to it. */
function sessionRunningChat(chatId: string): { panel: PanelState; session: SessionState } | null {
  for (const panel of panels.values()) {
    for (const session of panel.sessions.values()) if (session.chatId === chatId) return { panel, session }
  }
  return null
}

/** windows.ts: the deck in this window got a new docId or path while its
 *  panel may be running conversations — keep their records on the deck. */
export function noteDeckIdentityChanged(win: BrowserWindow): void {
  const panel = panels.get(win.id)
  if (!panel) return
  retarget(chatHistoryPath(), [...panel.sessions.values()].map((s) => s.chatId), deckKeyForWindow(win))
  retargetFolders(attachedFoldersPath(), deckKeyForWindow(win))
}

/** ~1 MB of pty output per session — plenty for a claude TUI's redraws,
 *  bounded so a long-running session can't grow main's memory forever. */
const SCROLLBACK_MAX_BYTES = 1_000_000

function recordScrollback(session: SessionState, data: string): void {
  session.scrollback.push(data)
  session.scrollbackBytes += data.length
  while (session.scrollbackBytes > SCROLLBACK_MAX_BYTES && session.scrollback.length > 1) {
    session.scrollbackBytes -= session.scrollback.shift()!.length
    session.scrollbackBase += 1
  }
}

/** Snapshot for a view's replay: the joined scrollback plus the absolute
 *  mark it ends at (see SessionState.scrollbackBase). */
function scrollbackSnapshot(session: SessionState): { scrollback: string; mark: number } {
  return { scrollback: session.scrollback.join(''), mark: session.scrollbackBase + session.scrollback.length }
}

/** Per-view, per-session forwarding gate. `mark` is where the replay handed
 *  to this view ended; `ready` flips on the renderer's terminal:ready ack. */
interface ViewSessionGate { ready: boolean; mark: number }

/** Keyed by the view's webContents.id — the terminal:ready handler resolves
 *  its gate from ev.sender.id, which works even for a pop/dock replacement
 *  view that hasn't been swapped into panel.view yet. */
const viewGates = new Map<number, Map<string, ViewSessionGate>>()

function wireViewToSession(view: WebContentsView, session: SessionState): () => void {
  const wcId = view.webContents.id
  let gates = viewGates.get(wcId)
  if (!gates) {
    gates = new Map()
    viewGates.set(wcId, gates)
    view.webContents.once('destroyed', () => viewGates.delete(wcId))
  }
  const gate: ViewSessionGate = { ready: false, mark: scrollbackSnapshot(session).mark }
  gates.set(session.id, gate)
  const send = (channel: string, ...args: unknown[]): void => {
    try { view.webContents.send(channel, ...args) } catch { /* view gone */ }
  }
  // Before the ack, output only accumulates in session.scrollback (recorded
  // by createSession's own listener) — flushed from there on terminal:ready.
  const offData = session.pty.onData((data) => { if (gate.ready) send('terminal:data', session.id, data) })
  const offExit = session.pty.onExit((code) => { if (gate.ready) send('terminal:exit', session.id, code) })
  const offChat = session.chat?.onEvent((ev) => { if (gate.ready) send('chat:event', session.id, ev) })
  return () => { offData(); offExit(); offChat?.(); viewGates.get(wcId)?.delete(session.id) }
}

/** Sets each session's gate mark to "now" and returns the replay payload for
 *  terminal:init / the "+" response — call right before sending it, so
 *  nothing is replayed twice or skipped between snapshot and ack. */
type TerminalInitSession = {
  id: string; chatId: string; createdAt: number; scrollback: string; exitCode: number | null | undefined
  kind: 'terminal' | 'chat'; label: string; model?: string; display?: DisplayItem[]; busy?: boolean; usage?: UsageReadout | null
}

const chatSnapshot = (session: SessionState): { display: DisplayItem[]; busy: boolean; usage: UsageReadout | null } | null =>
  session.chat ? { display: session.chat.display, busy: session.chat.busy, usage: session.chat.lastUsage } : null

function initPayloadFor(view: WebContentsView, session: SessionState): TerminalInitSession {
  const { scrollback, mark } = scrollbackSnapshot(session)
  const gate = viewGates.get(view.webContents.id)?.get(session.id)
  if (gate) gate.mark = mark
  const chat = chatSnapshot(session)
  return {
    id: session.id, chatId: session.chatId, createdAt: session.createdAt, scrollback, exitCode: session.exitCode,
    kind: session.kind, label: tabLabel(session.profile),
    ...(session.profile.kind === 'api' ? { model: session.profile.model } : {}),
    ...(chat ?? {}),
  }
}

/** terminal:ready — the renderer has built its session UIs and written the
 *  replay. Flush whatever was recorded after each pending gate's mark, then
 *  open the gate for live forwarding. Synchronous, so no pty chunk can land
 *  between the flush and `ready = true`. */
function markViewReady(sender: WebContents): void {
  const gates = viewGates.get(sender.id)
  if (!gates) return
  for (const [sessionId, gate] of gates) {
    if (gate.ready) continue
    // Session ids are randomUUIDs, unique across every panel.
    let session: SessionState | undefined
    for (const panel of panels.values()) session ??= panel.sessions.get(sessionId)
    if (!session) continue
    const from = Math.max(0, gate.mark - session.scrollbackBase)
    const missed = session.scrollback.slice(from).join('')
    if (missed) sender.send('terminal:data', sessionId, missed)
    // An exit that landed while the gate was closed was swallowed by
    // wireViewToSession — re-send it. The renderer ignores a duplicate (an
    // exit already carried by the init payload), see its `exited` guard.
    if (session.exitCode !== undefined) sender.send('terminal:exit', sessionId, session.exitCode)
    // A chat has no byte stream to replay: the renderer rebuilds from a full
    // snapshot, which also covers events that fired before it was ready.
    const chat = chatSnapshot(session)
    if (chat) sender.send('chat:sync', sessionId, chat)
    gate.ready = true
  }
}

/** Surfaces the terminal renderer's own console + crashes on the terminal
 *  running `npm run dev` — windows.ts does this for docView, but this view
 *  never got the same instrumentation, so a JS error or a renderer crash in
 *  the terminal panel was previously invisible anywhere. */
function wireDevDiagnostics(view: WebContentsView): void {
  if (!isDev) return
  // Same EPIPE landmine as windows.ts's docView instrumentation: a plain
  // console write here can itself throw (the debug pipe from `npm run
  // dev-all` going away mid-session) and crash the whole main process over
  // what should be a best-effort debug log.
  const log = (...args: unknown[]) => { try { console.log(...args) } catch { /* pipe gone, best effort */ } }
  const logError = (...args: unknown[]) => { try { console.error(...args) } catch { /* pipe gone, best effort */ } }
  view.webContents.on('console-message', (_e, _level, message) => log('[terminal-renderer]', message))
  view.webContents.on('render-process-gone', (_e, details) => logError('[terminal-renderer] gone:', details.reason))
}

/** Builds one fresh terminal WebContentsView wired to EVERY given session —
 *  construction + pty wiring only, which can't meaningfully fail. Deliberately
 *  does NOT attach to any window, set bounds, navigate, or push theme: the
 *  caller attaches + lays out first (matching windows.ts's
 *  createDocumentWindow attach-before-navigate order) and only then awaits
 *  loadTerminalRenderer — see popOutTerminalPanel/dockTerminalPanel for why
 *  this split matters (build-fully-before-swapping the working original out). */
function buildTerminalView(sessions: Iterable<SessionState>): { view: WebContentsView; sessionUnwire: Map<string, () => void> } {
  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // matches the document view's personal-dev-build posture
    },
  })
  guardNavigation(view.webContents) // a file dropped on the pane would otherwise get this preload
  const wcId = view.webContents.id
  terminalViewIds.add(wcId)
  view.webContents.once('destroyed', () => terminalViewIds.delete(wcId))
  const sessionUnwire = new Map<string, () => void>()
  for (const session of sessions) sessionUnwire.set(session.id, wireViewToSession(view, session))
  wireDevDiagnostics(view)
  return { view, sessionUnwire }
}

/** Pushes the current theme to a view — always keyed off the panel's
 *  hostWindow id, regardless of which window (host or popout) the view is
 *  physically attached to right now. windowThemes is only ever populated
 *  keyed by the host document window's id (slidomingo:terminal-theme below), so
 *  keying this off a popout's own id would always miss. */
function sendCurrentTheme(view: WebContentsView, hostWindowId: number): void {
  const theme = windowThemes.get(hostWindowId)
  if (theme) view.webContents.send('terminal:theme', theme)
}

/** The panel width to use for a window, live-drag value first, else the
 *  persisted default — regardless of docked/popped state (a resize while
 *  popped out still updates what the NEXT dock uses). */
function widthForWindow(windowId: number): number {
  return panelWidths.get(windowId) ?? loadPersistedWidth()
}

/** `0` unless the given window currently has a DOCKED, visible panel —
 *  consumed by windows.ts's layoutWindow. */
export function panelWidthFor(windowId: number): number {
  const panel = panels.get(windowId)
  return panel && panel.mode === 'docked' ? Math.round(widthForWindow(windowId) * panel.reveal) : 0
}

/** Positions the docked panel's own WebContentsView flush against the
 *  window's right edge (a WebContentsView has no automatic sizing — without
 *  an explicit setBounds call here it renders at zero size). No-op if there
 *  is no panel for this window, or it's currently popped out. Called by
 *  windows.ts's layoutWindow right after it resizes docView, with the same
 *  content-area rect so the two views tile exactly with no gap or overlap. */
export function layoutDockedPanel(win: BrowserWindow, contentBounds: { width: number; height: number }): void {
  const panel = panels.get(win.id)
  if (!panel || panel.mode !== 'docked') return
  // The view keeps its FULL size while it slides in/out and is merely
  // positioned further right (clipped by the window): resizing it per frame
  // would fire a pty resize per frame at `claude`'s TUI (see the throttle note
  // below), and a hidden panel parked at zero size would reflow it to ~2 columns.
  const full = Math.min(widthForWindow(win.id), contentBounds.width)
  const shown = Math.min(panelWidthFor(win.id), contentBounds.width)
  panel.view.setBounds({ x: contentBounds.width - shown, y: 0, width: full, height: contentBounds.height })
}

/** Slides the docked panel to `target` (1 = fully shown, 0 = gone) by
 *  re-laying the window out per frame — the document view narrows/widens in
 *  step with it. Restarts from wherever a previous slide got to, so a quick
 *  second toggle reverses smoothly. `done` runs once the target is reached. */
const REVEAL_MS = 180
function animateReveal(panel: PanelState, target: 0 | 1, done?: () => void): void {
  if (panel.revealTimer) { clearInterval(panel.revealTimer); panel.revealTimer = null }
  const win = panel.hostWindow
  const from = panel.reveal
  if (from === target || win.isDestroyed()) {
    panel.reveal = target
    if (!win.isDestroyed()) layoutWindow(win)
    done?.()
    return
  }
  const start = Date.now()
  panel.revealTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / REVEAL_MS)
    const eased = 1 - Math.pow(1 - t, 3)
    panel.reveal = from + (target - from) * eased
    if (win.isDestroyed()) { clearInterval(panel.revealTimer!); panel.revealTimer = null; return }
    layoutWindow(win)
    if (t >= 1) {
      clearInterval(panel.revealTimer!)
      panel.revealTimer = null
      panel.reveal = target
      done?.()
    }
  }, 16)
}

/** Slides a hidden docked panel back in and gives it keyboard focus. */
function showPanel(panel: PanelState): void {
  if (panel.mode !== 'docked' || !panel.hidden) return
  panel.hidden = false
  docWebContentsFor(panel.hostWindow)?.send('slidomingo:terminal-state', { open: true })
  animateReveal(panel, 1, () => { try { panel.view.webContents.focus() } catch { /* view gone */ } })
}

/** Slides the docked panel away WITHOUT ending its sessions — closing and
 *  reopening it used to kill every `claude` and start a new conversation (and
 *  a new history entry) each time. A panel with no tab left has nothing to
 *  keep, so that one is disposed. */
function hidePanel(panel: PanelState): void {
  if (panel.mode !== 'docked' || panel.hidden) return
  if (panel.sessions.size === 0) { disposePanel(panel.hostWindow.id); return }
  panel.hidden = true
  docWebContentsFor(panel.hostWindow)?.send('slidomingo:terminal-state', { open: false })
  try { docWebContentsFor(panel.hostWindow)?.focus() } catch { /* window gone */ }
  animateReveal(panel, 0)
}

/** Live update during a drag (see the terminal renderer's .term-resizer) —
 *  clamps, updates the in-memory width, and relayouts immediately so the
 *  panel tracks the pointer with no flicker. Not yet persisted; that's
 *  commitPanelWidth, sent once on mouseup. */
export function setPanelWidth(windowId: number, width: number): void {
  panelWidths.set(windowId, clampPanelWidth(width))
  const panel = panels.get(windowId)
  if (panel) layoutWindow(panel.hostWindow)
}

// --- panel-resize throttle -------------------------------------------------
// A raw drag's mousemove stream (measured well past 100/s) would otherwise
// drive layoutWindow — which setBounds()es the terminal WebContentsView —
// at the same rate, and each of THOSE bounds changes fires the terminal
// renderer's own ResizeObserver, which fires a PTY resize (a
// SIGWINCH-equivalent). The result was a resize storm hitting the shell/
// `claude` mid-redraw — exactly the kind of thing that corrupts (or blanks)
// a TUI that repaints on resize, which is what "the terminal goes white
// while dragging" actually was.
//
// This throttles it HERE, in the main process, deliberately NOT in the
// renderer: a renderer's own rAF/setTimeout are subject to Chromium's
// page-visibility/background throttling, and were measured (via a CDP-driven
// test session) to go completely silent — rAF fired 0 times in 2 real
// seconds, setTimeout clamped to ~1/s — for this secondary WebContentsView
// under some focus states. A renderer-side coalesce built on either would
// have risked silently swallowing every resize instead of just smoothing it.
// Node's timers here have no such throttling.
const RESIZE_THROTTLE_MS = 33 // ~30/s — smooth to drag, a small fraction of the raw mousemove rate
const pendingWidths = new Map<number, number>()
let resizeThrottleTimer: NodeJS.Timeout | null = null

/** Rate-limited entry point for terminal:panel-resize — call this from the
 *  IPC handler instead of setPanelWidth directly. */
export function requestPanelWidth(windowId: number, width: number): void {
  pendingWidths.set(windowId, width)
  if (resizeThrottleTimer) return
  resizeThrottleTimer = setTimeout(() => {
    resizeThrottleTimer = null
    for (const [wid, w] of pendingWidths) setPanelWidth(wid, w)
    pendingWidths.clear()
  }, RESIZE_THROTTLE_MS)
}

/** Persists whatever width is currently in effect for this window — called
 *  once per drag, on mouseup (terminal:panel-resize-commit), not on every
 *  live move. Flushes a still-pending throttled resize first (the mousemove
 *  right before mouseup can easily land inside the current throttle window),
 *  so the persisted value is always the true final drag position, not a
 *  slightly-stale one. */
export function commitPanelWidth(windowId: number): void {
  const pending = pendingWidths.get(windowId)
  if (pending != null) {
    pendingWidths.delete(windowId)
    setPanelWidth(windowId, pending)
  }
  persistWidth(widthForWindow(windowId))
}

/** Tears down one session's pty + watchers/timers. `removeDir` controls
 *  whether its own subfolder is deleted immediately (true for closing a
 *  single tab) or left for the caller's recursive contextDir removal (false
 *  for a whole-panel teardown, where the parent directory is about to go
 *  anyway — see disposePanel). */
function teardownSession(session: SessionState, opts: { removeDir: boolean }): void {
  session.pty.dispose()
  session.chat?.dispose()
  if (session.editDebounceTimer) clearTimeout(session.editDebounceTimer)
  try { session.editWatcher?.close() } catch { /* already gone */ }
  for (const timer of session.requestRetryTimers.values()) clearTimeout(timer)
  try { session.slideWatcher?.close() } catch { /* already gone */ }
  try { session.agentWatcher?.close() } catch { /* already gone */ }
  if (opts.removeDir) {
    try { rmSync(session.contextDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Closes ONE terminal tab: kills that session's pty, tears down its
 *  watchers/subfolder, unwires it from the panel's current view, and tells
 *  both renderers (the terminal tab strip, and the document's own editor —
 *  so any slide lock this session held is released immediately rather than
 *  waiting out the idle timeout, see slides/src/store.ts). Silently no-ops
 *  for an unknown sessionId (already closed, or a stale IPC message). */
function closeSession(panel: PanelState, sessionId: string): void {
  const session = panel.sessions.get(sessionId)
  if (!session) return
  panel.sessions.delete(sessionId)
  const unwire = panel.sessionUnwire.get(sessionId)
  if (unwire) { unwire(); panel.sessionUnwire.delete(sessionId) }
  teardownSession(session, { removeDir: true })
  docWebContentsFor(panel.hostWindow)?.send('slidomingo:agent-session-closed', { sessionId })
  try { panel.view.webContents.send('terminal:tab-closed', sessionId) } catch { /* view may be gone */ }
}

/** Tears down a window's terminal panel (view + every session's pty, and its
 *  pop-out window if it has one) — call when the host document window itself
 *  is closing, so a docked-or-popped panel never outlives it as an orphaned
 *  pty. */
export function disposeTerminalPanel(hostWindowId: number): void {
  disposePanel(hostWindowId)
}

/** Whether this window has a terminal panel on screen (docked and not slid
 *  away, or popped out) — what windows.ts's replaceDocument checks so the chat
 *  follows the deck. A hidden panel is not "open", but still has sessions bound
 *  to the old deck: see hasTerminalPanel. */
export function isTerminalPanelOpen(hostWindowId: number): boolean {
  const panel = panels.get(hostWindowId)
  return !!panel && !panel.hidden
}

/** Whether this window has a terminal panel at all, hidden or not. */
export function hasTerminalPanel(hostWindowId: number): boolean {
  return panels.has(hostWindowId)
}

function disposePanel(hostWindowId: number): void {
  const panel = panels.get(hostWindowId)
  if (!panel) return
  const hostWindow = panel.hostWindow
  panels.delete(hostWindowId)
  panelWidths.delete(hostWindowId)
  if (panel.revealTimer) { clearInterval(panel.revealTimer); panel.revealTimer = null }
  for (const [sessionId, session] of panel.sessions) {
    teardownSession(session, { removeDir: false }) // contextDir rmSync below covers every subfolder at once
    docWebContentsFor(hostWindow)?.send('slidomingo:agent-session-closed', { sessionId })
  }
  if (panel.generateDebounceTimer) clearTimeout(panel.generateDebounceTimer)
  try { panel.generateWatcher?.close() } catch { /* already gone */ }
  try { panel.hostWindow.contentView.removeChildView(panel.view) } catch { /* window may be gone */ }
  // panelWidthFor is 0 now: give the doc view its full width back (the header
  // × path never went through toggleTerminalPanel's relayout).
  if (!hostWindow.isDestroyed()) layoutWindow(hostWindow)
  // Detaching alone leaves the renderer alive (a hidden, orphaned page per
  // close/reopen, plus its viewGates entry) — pop/dock already close theirs.
  try { panel.view.webContents.close() } catch { /* already gone */ }
  if (panel.popoutWindow && !panel.popoutWindow.isDestroyed()) panel.popoutWindow.destroy()
  try { rmSync(panel.contextDir, { recursive: true, force: true }) } catch { /* best effort */ }
  if (panel.scratchDir) {
    try { rmSync(panel.scratchDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  // Safe no-op when the host window itself is what's closing — windows.ts
  // already deletes the docView registration before calling
  // disposeTerminalPanel, so docWebContentsFor returns null there.
  docWebContentsFor(hostWindow)?.send('slidomingo:terminal-state', { open: false })
}

/** Watches a session's own subfolder for `claude` dropping edit.json (the
 *  original single-element write-back channel — no longer advertised to
 *  Claude since update_element replaced it, kept so an older session or
 *  script that still writes it keeps working) and, once the write
 *  settles, forwards its parsed contents (tagged with this session's id) to
 *  the document renderer. Debounced because a single save can fire several
 *  fs.watch events. Best effort: a watch that fails to start (or a malformed
 *  edit.json) just means no write-back for that session — never fatal to the
 *  terminal itself. */
function startEditWatcher(panel: PanelState, session: SessionState): void {
  try {
    session.editWatcher = watch(session.contextDir, (_event, filename) => {
      if (filename === 'session-note.json') { processSessionNote(panel, session); return }
      if (filename !== 'edit.json') return
      if (session.editDebounceTimer) clearTimeout(session.editDebounceTimer)
      session.editDebounceTimer = setTimeout(() => processEditFile(panel, session), 200)
    })
  } catch { /* best effort — an unwatchable contextDir just means no write-back */ }
}

/** session-note.mjs reported the conversation id this tab's `claude` is on. A
 *  new one means claude started it itself (/clear, in-pty /resume): record it
 *  on the deck and follow it, so the history menu lists it and the
 *  running-chat guard keeps pointing at the right tab. */
function processSessionNote(panel: PanelState, session: SessionState): void {
  let id: unknown
  try { id = JSON.parse(readFileSync(join(session.contextDir, 'session-note.json'), 'utf8')).session_id } catch { return }
  if (!isChatId(id) || id === session.chatId) return
  const deck = deckKeyForWindow(panel.hostWindow)
  addRecord(chatHistoryPath(), { id, docId: deck.docId, path: deck.path, startedAt: Date.now() })
  session.chatId = id
}

function processEditFile(panel: PanelState, session: SessionState): void {
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(join(session.contextDir, 'edit.json'), 'utf8'))
  } catch {
    return // not there yet, mid-write, or already handled — swallow
  }
  const tagged = payload && typeof payload === 'object' ? { ...payload, sessionId: session.id } : payload
  docWebContentsFor(panel.hostWindow)?.send('slidomingo:apply-edit', tagged)
}

/** Watches the panel's SHARED contextDir for `claude` dropping
 *  generate-result.json (requestGenerate's write-back channel — panel-wide,
 *  not per-session, since "Create a template" targets the whole document) and
 *  forwards its parsed contents to the document renderer on every write —
 *  re-arms itself, so a user iterating with Claude Code before deciding just
 *  has each new version replace the pending one in startuppicker.ts's "Load
 *  into editor" UI. Same debounce/best-effort posture as startEditWatcher. */
function startGenerateWatcher(panel: PanelState): void {
  try {
    panel.generateWatcher = watch(panel.contextDir, (_event, filename) => {
      if (filename !== 'generate-result.json') return
      if (panel.generateDebounceTimer) clearTimeout(panel.generateDebounceTimer)
      panel.generateDebounceTimer = setTimeout(() => processGenerateFile(panel), 200)
    })
  } catch { /* best effort — an unwatchable contextDir just means no write-back */ }
}

function processGenerateFile(panel: PanelState): void {
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(join(panel.contextDir, 'generate-result.json'), 'utf8'))
  } catch {
    return // not there yet, mid-write, or already handled — swallow
  }
  docWebContentsFor(panel.hostWindow)?.send('slidomingo:generate-result', payload)
}

/** Watches a session's own subfolder for the get_slide/write_slide MCP tools'
 *  per-request files (see ../mcp/slides-mcp-server.mjs) and forwards each to
 *  the document renderer over the matching IPC channel once its write
 *  lands. Unlike edit.json (a fixed, single-slot filename, rewritten in place
 *  and so still debounced), every request carries its own uuid in the
 *  filename and is written exactly once, so this watches by REGEX and
 *  forwards it IMMEDIATELY via claimRequestFile — no debounce, which used to
 *  add a flat 200ms to every MCP tool call. */
function startSlideWatcher(panel: PanelState, session: SessionState): void {
  try {
    session.slideWatcher = watch(session.contextDir, (_event, filename) => {
      if (!filename) return
      if (/^slide-request-.+\.json$/.test(filename)) {
        claimRequestFile(session, filename, (payload) => forwardRequestFile(panel, session, 'slide-request', payload))
      } else if (/^slide-write-(?!result-).+\.json$/.test(filename)) {
        // The negative lookahead excludes slide-write-result-<id>.json — the
        // APP's own response file, written by the slidomingo:apply-slide-write-result
        // handler below into this same watched directory. Without it, that
        // write would be misread as a fresh incoming write request and
        // bounced back through applyExternalSlideWrite as a malformed one.
        claimRequestFile(session, filename, (payload) => forwardRequestFile(panel, session, 'slide-write', payload))
      }
    })
  } catch { /* best effort — an unwatchable contextDir just means no MCP write-back */ }
}

/** Forward a uuid-named MCP request file exactly once, as soon as it parses.
 *  The MCP server writes it atomically (tmp + rename), so the first event
 *  normally parses; a torn read (a non-atomic writer) retries once ~20ms
 *  later instead of every call paying a fixed debounce. Later fs.watch
 *  events for an already-forwarded file (including its own unlink) are
 *  ignored via handledRequestFiles — uuids are never reused, so entries only
 *  need to outlive the burst of events, then are dropped. */
function claimRequestFile(session: SessionState, filename: string, run: (payload: unknown) => void, retried = false): void {
  if (session.handledRequestFiles.has(filename)) return
  let text: string
  try {
    text = readFileSync(join(session.contextDir, filename), 'utf8')
  } catch {
    return // not there (yet), or already handled and removed — swallow
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    if (retried || session.requestRetryTimers.has(filename)) return
    session.requestRetryTimers.set(filename, setTimeout(() => {
      session.requestRetryTimers.delete(filename)
      claimRequestFile(session, filename, run, true)
    }, 20))
    return
  }
  const pending = session.requestRetryTimers.get(filename)
  if (pending) { clearTimeout(pending); session.requestRetryTimers.delete(filename) }
  session.handledRequestFiles.add(filename)
  setTimeout(() => session.handledRequestFiles.delete(filename), 30_000)
  run(payload)
}

/** The answer file the MCP server waits for, per request kind
 *  (slides-mcp-server.mjs roundTrip). */
const RESPONSE_PREFIX: Record<AgentChannel, string> = {
  'slide-request': 'slide-response',
  'slide-write': 'slide-write-result',
  'agent-query': 'agent-query-result',
  'agent-action': 'agent-action-result',
}

/** Hands a claimed request file to the editor (agentbridge.ts) and writes the
 *  answer back as `<response prefix>-<requestId>.json` in the session's own
 *  subfolder, removing the request file. */
function forwardRequestFile(panel: PanelState, session: SessionState, channel: AgentChannel, payload: unknown): void {
  // sessionId is what lets editor.ts's applyAgentAction attribute the slide
  // lock a write verb acquires to THIS tab, and refuse a conflicting write
  // from a different one — see slides/src/store.ts's lock registry.
  forwardAgentRequest(panel.hostWindow, session.id, channel, payload, (result) => {
    try { writeFileAtomic(join(session.contextDir, `${RESPONSE_PREFIX[channel]}-${result.requestId}.json`), JSON.stringify(result, null, 2)) } catch { /* best effort */ }
    try { rmSync(join(session.contextDir, `${channel}-${result.requestId}.json`), { force: true }) } catch { /* best effort */ }
  })
}

/** Removes any leftover slide-request-…, slide-response-…, slide-write-…, or
 *  slide-write-result-….json from a PRIOR session in this directory before
 *  the watchers above are armed — mirrors writeGenerateFiles' stale-result
 *  clearing, for the same reason (a stale response file would otherwise
 *  "answer" the very next tool call to reuse that filename, which can't
 *  actually happen with fresh uuids, but a stale REQUEST file left behind by
 *  a crash could still confuse a human poking around the directory). Each
 *  session gets a brand-new subfolder, so in practice this only matters if a
 *  subfolder name were ever reused — kept anyway, it's free insurance. */
function clearStaleSlideFiles(contextDir: string): void {
  let names: string[]
  try {
    names = readdirSync(contextDir)
  } catch {
    return // contextDir doesn't exist yet — nothing to clear
  }
  for (const name of names) {
    if (/^slide-(request|response|write)-.+\.json$/.test(name)) {
      try { rmSync(join(contextDir, name), { force: true }) } catch { /* best effort */ }
    }
  }
}

/** Watches a session's own subfolder for the progressive-disclosure MCP
 *  tools' per-request files (see ../mcp/slides-mcp-server.mjs's agent-query/
 *  agent-action channels) — same multiplexed-by-regex, forward-once
 *  (claimRequestFile) shape as startSlideWatcher above, since both channels
 *  are processed identically (parse, forward, let the
 *  renderer's own response handler clean up the request file). This watcher
 *  is VERB-AGNOSTIC (the regex matches any agent-action-<uuid>.json
 *  regardless of verb) — adding release_slide needed no change here; only
 *  editor.ts's dispatch (applyAgentAction) knows verb-specific behavior. */
function startAgentWatcher(panel: PanelState, session: SessionState): void {
  // The slides a session writes stay marked as its work (store.ts locks: the
  // thumbnail badge, and the "other chats" part of every other tab's editing
  // context) until its turn ends: an API chat says so with busy:false, a
  // `claude` tab through the Stop hook's turn-done file (createSession).
  const turnDone = (): void => { docWebContentsFor(panel.hostWindow)?.send('slidomingo:agent-session-closed', { sessionId: session.id }) }
  session.chat?.onEvent((ev) => { if (ev.type === 'busy' && !ev.busy) turnDone() })
  try {
    session.agentWatcher = watch(session.contextDir, (_event, filename) => {
      if (!filename) return
      if (filename === 'turn-done') turnDone()
      else if (/^agent-query-(?!result-).+\.json$/.test(filename)) {
        // Negative lookahead excludes agent-query-result-<id>.json — the
        // APP's own response file (slidomingo:agent-query-response handler
        // below) — for the same reason slide-write's does.
        claimRequestFile(session, filename, (payload) => forwardRequestFile(panel, session, 'agent-query', payload))
      } else if (/^agent-action-(?!result-).+\.json$/.test(filename)) {
        claimRequestFile(session, filename, (payload) => forwardRequestFile(panel, session, 'agent-action', payload))
      }
    })
  } catch { /* best effort — an unwatchable contextDir just means no MCP write-back */ }
}


/** Removes any leftover agent-query-…/agent-query-result-…/agent-action-…/
 *  agent-action-result-….json from a PRIOR session — mirrors
 *  clearStaleSlideFiles, for the same reason. */
function clearStaleAgentFiles(contextDir: string): void {
  let names: string[]
  try {
    names = readdirSync(contextDir)
  } catch {
    return // contextDir doesn't exist yet — nothing to clear
  }
  for (const name of names) {
    if (/^agent-(query|action)-.+\.json$/.test(name)) {
      try { rmSync(join(contextDir, name), { force: true }) } catch { /* best effort */ }
    }
  }
}

/** Writes a generate request into the panel's SHARED contextDir: the request
 *  itself, plus the condensed generation brief `claude` needs to answer it
 *  (format.md/agents.md are already written unconditionally by openPanel
 *  into the same directory, for the write_slide/insert_elements MCP path —
 *  no need to duplicate them here). Also clears any stale PRIOR result —
 *  without this, an old generate-result.json from an earlier request in the
 *  same directory would immediately (falsely) "complete" a brand new one the
 *  instant its watcher arms. Best effort, same posture as every other fs
 *  call in this file. */
function writeGenerateFiles(contextDir: string, request: GenerateRequest): void {
  try {
    mkdirSync(contextDir, { recursive: true })
    for (const stale of ['generate-result.json', 'source.pptx', 'pptx-converted.json']) {
      rmSync(join(contextDir, stale), { force: true })
    }
    let written: unknown = request
    if (request.kind === 'pptx') {
      // The file is COPIED in (the request names it relatively), and the
      // converter's draft goes beside it rather than inline — it can be
      // megabytes of pictures, and the request should stay readable.
      copyFileSync(request.sourcePath, join(contextDir, 'source.pptx'))
      const hasBaseline = request.baseline !== undefined
      if (hasBaseline) writeFileSync(join(contextDir, 'pptx-converted.json'), JSON.stringify(request.baseline), 'utf8')
      written = {
        kind: 'pptx', target: request.target, name: request.name,
        source: 'source.pptx', ...(hasBaseline ? { converted: 'pptx-converted.json' } : {}),
      }
    }
    writeFileSync(join(contextDir, 'generate-request.json'), JSON.stringify(written, null, 2), 'utf8')
    writeFileSync(join(contextDir, 'generate-brief.md'), GENERATE_BRIEF, 'utf8')
  } catch { /* best effort */ }
}

/** Writes the live selection snapshot into the given window's panel context
 *  directory (shared — every tab reads the same selection.json) — no-op if
 *  that window has no open panel (nothing is reading it). Fire-and-forget;
 *  failures (e.g. disk pressure) are swallowed, this is a convenience
 *  artifact, not a durable one. */
export function writeSelectionContext(win: BrowserWindow, json: string): void {
  const panel = panels.get(win.id)
  if (!panel) return
  try { writeFileSync(join(panel.contextDir, 'selection.json'), json, 'utf8') } catch { /* best effort */ }
}

/** Spawns one new session (pty + its own subfolder + MCP config + watchers)
 *  under `sharedContextDir`. Does NOT wire it to any view or register it on
 *  a panel — callers do that once they know whether a panel/view already
 *  exists (openPanel, for the first tab, builds the view around the initial
 *  session; the "+" button wires a new one into the panel's EXISTING view —
 *  see wireAndRegisterSession below). Returns null (after showing an error
 *  dialog) if the pty itself fails to spawn. */
async function createSession(
  cwd: string, sharedContextDir: string, sharedDirName: string, deckOf: () => DeckKey, opts?: { initialTask?: string; resumeChatId?: string; /** Relaunch under an existing id that has no transcript yet (restart of an unused tab). */ freshChatId?: string; profile?: AiProfile },
): Promise<SessionState | null> {
  const profile = opts?.profile ?? getProfile(null)
  const deck = deckOf()
  const extraDirs = profile.kind === 'api' ? [] : foldersOf(deck)
  const id = randomUUID()
  const chat: ClaudeChat = opts?.resumeChatId ? { id: opts.resumeChatId, resume: true } : { id: opts?.freshChatId ?? randomUUID(), resume: false }
  const sessionDirName = `${sharedDirName}/session-${id}`
  const sessionDir = join(sharedContextDir, `session-${id}`)
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'mcp-config.json'), JSON.stringify({
      mcpServers: {
        'beeslides': {
          command: 'node',
          args: [join(sharedContextDir, 'slides-mcp-server.mjs'), sessionDir],
        },
      },
    }, null, 2), 'utf8')
    // Loaded with --settings (pty.ts), which merges with the user's own
    // settings. The hook's stdout is attached to each prompt as context, so
    // Claude never spends a turn reading selection.json. Absolute, double-
    // quoted paths: a relative `./` path breaks whenever the hook's cwd is not
    // the workspace (a "Cannot find module" SessionStart error). The shell
    // line is only built when the path has no shell-special characters, and
    // is guarded so a missing script can never surface as a hook error.
    const hookCommand = (script: string, arg?: string): string | null => {
      const file = join(sharedContextDir, script)
      const parts = arg ? [file, arg] : [file]
      if (!parts.every((x) => /^[\w\s./@+=,:~-]+$/.test(x))) return null
      return `[ -f "${file}" ] && node ${parts.map((x) => `"${x}"`).join(' ')}; exit 0`
    }
    // The digest gets the session dir to tell this tab's own slides from
    // the other tabs' (selection.json agentWork).
    const digest = hookCommand('selection-digest.mjs', sessionDir)
    const note = hookCommand('session-note.mjs', sessionDir)
    const turnFile = join(sessionDir, 'turn-done')
    const turnDone = /^[\w\s./@+=,:~-]+$/.test(turnFile) ? `: > "${turnFile}"; exit 0` : null
    const ours = {
      hooks: {
        ...(digest && { UserPromptSubmit: [{ hooks: [{ type: 'command', command: digest, timeout: 5 }] }] }),
        ...(note && { SessionStart: [{ hooks: [{ type: 'command', command: note, timeout: 5 }] }] }),
        ...(turnDone && { Stop: [{ hooks: [{ type: 'command', command: turnDone, timeout: 5 }] }] }),
      },
    }
    // `claude` honours only the LAST --settings; a profile whose command (a
    // shell function) passes its own settings file would lose it to ours, so
    // that file is merged in here.
    let settings: Record<string, unknown> = ours
    if (profile.kind === 'claude-code' && profile.settingsFile) {
      try { settings = mergeSettings(JSON.parse(readFileSync(profile.settingsFile, 'utf8')), ours) } catch { /* unreadable: ours alone */ }
    }
    writeFileSync(join(sessionDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  } catch { /* best effort — a missing/unwritable cwd just means no context file */ }
  clearStaleSlideFiles(sessionDir)
  clearStaleAgentFiles(sessionDir)

  let pty: PtyHandle = NO_PTY
  let apiChat: ApiChatSession | null = null
  try {
    if (profile.kind === 'api') {
      apiChat = new ApiChatSession({
        chatId: chat.id, profile, apiKey: await apiKeyFor(profile),
        sessionDir, sharedDir: sharedContextDir, transcriptDir: apiChatsDir(),
        skillsDir: apiSkillsDir(), builtinSkills: BUILTIN_SKILLS,
        roles: await resolveRoles(profile, sessionDir),
        folders: () => foldersOf(deckOf()),
      }, chat.resume)
      // A fixed prompt (Polish / Fix comments) the panel was opened with.
      if (opts?.initialTask) void apiChat.send(opts.initialTask)
    } else {
      pty = await createPty(cwd, sharedDirName, sessionDirName, chat, undefined, undefined, opts?.initialTask, deckDirOf(deck.path) ?? undefined, profile, extraDirs)
    }
  } catch (err) {
    console.error('[terminalPanel] createPty failed, session will not open:', err)
    try { dialog.showErrorBox('Claude Code terminal unavailable', String(err instanceof Error ? err.message : err)) } catch { /* best effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }) } catch { /* best effort */ }
    return null
  }

  if (!chat.resume) {
    addRecord(chatHistoryPath(), {
      id: chat.id, docId: deck.docId, path: deck.path, startedAt: Date.now(),
      profileId: profile.id, kind: profile.kind === 'api' ? 'api' : 'claude',
    })
  }

  const session: SessionState = {
    id, chatId: chat.id, kind: apiChat ? 'chat' : 'terminal', profile, chat: apiChat, pty, extraDirs, createdAt: Date.now(), contextDir: sessionDir,
    scrollback: [], scrollbackBytes: 0, scrollbackBase: 0, exitCode: undefined,
    editWatcher: null, editDebounceTimer: null,
    slideWatcher: null, agentWatcher: null,
    handledRequestFiles: new Set(), requestRetryTimers: new Map(),
  }
  // Subscribed right away (claude is already starting) and for the pty's
  // whole life — independent of any view, see the header comment.
  pty.onData((data) => recordScrollback(session, data))
  pty.onExit((code) => { session.exitCode = code })
  return session
}

function startSessionWatchers(panel: PanelState, session: SessionState): void {
  startEditWatcher(panel, session)
  startSlideWatcher(panel, session)
  startAgentWatcher(panel, session)
}

/** Wires an already-created session into a panel whose view already exists
 *  (the "+" button's path — openPanel's initial session is wired inline,
 *  since its view is built around it) and registers it + starts its
 *  watchers. Returns the tab-strip-facing summary the renderer needs. */
function wireAndRegisterSession(panel: PanelState, session: SessionState): TerminalInitSession {
  panel.sessions.set(session.id, session)
  panel.sessionUnwire.set(session.id, wireViewToSession(panel.view, session))
  startSessionWatchers(panel, session)
  // Gated like an init: the renderer acks with terminal:ready once the new
  // tab's xterm exists and has the replay written.
  return initPayloadFor(panel.view, session)
}

/** Creates the terminal WebContentsView + this window's FIRST session and
 *  docks it — the shared body behind both toggleTerminalPanel's first toggle
 *  and requestGenerate's launch path. `opts.initialTask`, when given, is
 *  handed straight to createSession so `claude` starts working it as soon as
 *  it launches (see pty.ts). `opts.compactWidth`, when true, seeds this
 *  window's live panel width at MIN_PANEL_WIDTH instead of the user's
 *  persisted default — used by requestGenerate's fresh launch so a wide
 *  dragged-elsewhere width never eats the live-preview stage; the persisted
 *  default itself (panelWidthStorePath) is untouched, and a manual drag
 *  afterward updates it normally. Does nothing (silently) if a panel already
 *  exists for this window — callers that care (toggleTerminalPanel) check
 *  first. */
async function openPanel(win: BrowserWindow, opts?: { initialTask?: string; compactWidth?: boolean; profile?: AiProfile }): Promise<void> {
  if (panels.has(win.id)) return

  const cwd = workspaceForWindow(win)
  const contextDirName = `.slidomingo-context-${win.id}`
  const contextDir = join(cwd, contextDirName)

  // Written BEFORE createSession (which launches `claude --mcp-config
  // ./<sessionDir>/mcp-config.json` as soon as the shell is ready) so these
  // shared reference files already exist the moment `claude` goes looking
  // for them. format.md/agents.md are written unconditionally here too, not
  // only inside writeGenerateFiles' "Create a template" path — write_slide
  // payloads need that authoring guide in EVERY terminal session, not just
  // ones that started from template generation.
  try {
    mkdirSync(contextDir, { recursive: true })
    writeFileSync(join(contextDir, 'README.md'), CONTEXT_README, 'utf8')
    writeFileSync(join(contextDir, 'format.md'), FORMAT_MD, 'utf8')
    writeFileSync(join(contextDir, 'agents.md'), AGENTS_MD, 'utf8')
    writeFileSync(join(contextDir, 'slides-mcp-server.mjs'), mcpServerSource(), 'utf8')
    writeFileSync(join(contextDir, 'selection-digest.mjs'), SELECTION_DIGEST, 'utf8')
    writeFileSync(join(contextDir, 'session-note.mjs'), SESSION_NOTE, 'utf8')
  } catch { /* best effort — a missing/unwritable cwd just means no context file */ }

  // Both awaits below MUST never let this function's promise reject: it
  // resolves an `ipcMain.handle('slidomingo:toggle-terminal', ...)` call, and a
  // rejection there is caught internally by Electron's own error-reporting
  // path (replyWithError), which logs via console.warn — and in some
  // environments that write itself dies with EIO, crashing the whole main
  // process over what should be a recoverable, best-effort failure (the
  // panel just doesn't open). Every other call in this function already
  // follows this discipline; these two historically didn't.
  const session = await createSession(cwd, contextDir, contextDirName, () => deckKeyForWindow(win), { initialTask: opts?.initialTask, profile: opts?.profile })
  if (!session) return

  const { view, sessionUnwire } = buildTerminalView([session])

  const panel: PanelState = {
    view, sessionUnwire, mode: 'docked', hidden: false, reveal: 0, revealTimer: null,
    hostWindow: win, popoutWindow: null, contextDir,
    workspace: cwd,
    scratchDir: isUntitledKey(basename(cwd)) ? cwd : null,
    generateWatcher: null, generateDebounceTimer: null,
    sessions: new Map([[session.id, session]]),
    lastInputSessionId: null,
    activeSessionId: session.id,
  }
  panels.set(win.id, panel)
  panelWidths.set(win.id, opts?.compactWidth ? MIN_PANEL_WIDTH : loadPersistedWidth())
  startGenerateWatcher(panel)
  startSessionWatchers(panel, session)

  // Attach + lay out BEFORE navigating — matches windows.ts's
  // mountDocument (the codebase's other example of a window whose
  // whole content is a child WebContentsView). Navigating first, as this
  // used to, meant the view briefly existed as an unattached, unsized
  // WebContentsView with no lifecycle tie to any window.
  win.contentView.addChildView(view)
  layoutWindow(win)
  try {
    await loadTerminalRenderer(view)
  } catch (err) {
    console.error('[terminalPanel] loadTerminalRenderer failed, closing the partially-opened panel:', err)
    disposePanel(win.id)
    layoutWindow(win)
    try { dialog.showErrorBox('Claude Code terminal unavailable', String(err instanceof Error ? err.message : err)) } catch { /* best effort */ }
    return
  }
  sendCurrentTheme(view, win.id)
  view.webContents.send('terminal:init', { sessions: [initPayloadFor(view, session)], activeId: session.id, mode: panel.mode })
  docWebContentsFor(win)?.send('slidomingo:terminal-state', { open: true })
  if (panels.get(win.id) === panel) animateReveal(panel, 1)
}

/** First toggle: creates the terminal WebContentsView + the window's first
 *  session, docks it. Further toggles while docked slide it away and back —
 *  the sessions keep running (a reopen shows the same conversations, not a new
 *  one); only closing a tab or the window ends one. While popped out, focuses
 *  the pop-out window instead of no-op'ing — a no-op click reads as broken
 *  once the ribbon button visibly shows "chat is open". */
export async function toggleTerminalPanel(win: BrowserWindow): Promise<void> {
  const existing = panels.get(win.id)
  if (existing) {
    if (existing.mode !== 'docked') existing.popoutWindow?.focus()
    else if (existing.hidden) showPanel(existing)
    else hidePanel(existing)
    return
  }
  await openPanel(win)
}

/** Brings the panel on screen if it is slid away (or, popped out, focuses it). */
function revealPanel(panel: PanelState): void {
  if (panel.mode === 'docked') showPanel(panel)
  else panel.popoutWindow?.focus()
}

/** View ▸ Claude Chats…: opens the terminal panel when it is closed, then
 *  opens its history menu. */
export async function showChatHistory(win: BrowserWindow): Promise<void> {
  if (!panels.has(win.id)) await openPanel(win)
  const panel = panels.get(win.id)
  if (!panel) return
  revealPanel(panel)
  const wc = panel.view.webContents
  const send = (): void => { try { wc.send('terminal:show-history') } catch { /* view gone */ } }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 100))
  else send()
}

/** View ▸ New Chat With…: opens the panel when it is closed, then shows the
 *  "+" menu, where a profile is picked. */
export async function showNewChatMenu(win: BrowserWindow): Promise<void> {
  if (!panels.has(win.id)) await openPanel(win)
  const panel = panels.get(win.id)
  if (!panel) return
  revealPanel(panel)
  const wc = panel.view.webContents
  const send = (): void => { try { wc.send('terminal:show-profiles') } catch { /* view gone */ } }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 100))
  else send()
}

/** startuppicker.ts's AI paths (Describe it, PowerPoint with AI…): if this
 *  window has no terminal panel yet, opens one with
 *  `claude` already launched onto the request (GENERATE_TASK/generateTask)
 *  — a normal, fully interactive session the user can keep talking to, never
 *  a one-shot batch call. If a panel already exists (the user had opened the
 *  terminal manually before using this flow), `claude` is NOT relaunched —
 *  the request files are just dropped into its shared contextDir for the
 *  user to point any of their open tabs at. Either way, generate-result.json
 *  (once `claude` writes one) is picked up by the generateWatcher every panel
 *  already starts and forwarded to the renderer as 'slidomingo:generate-result'. */
export async function requestGenerate(win: BrowserWindow, request: GenerateRequest): Promise<{ status: 'launched' | 'queued' }> {
  const existing = panels.get(win.id)
  if (existing) {
    writeGenerateFiles(existing.contextDir, request)
    revealPanel(existing)
    return { status: 'queued' }
  }
  const contextDirName = `.slidomingo-context-${win.id}`
  const contextDir = join(workspaceForWindow(win), contextDirName)
  writeGenerateFiles(contextDir, request)
  // The generate flows have Claude Code read files: never an API chat.
  await openPanel(win, { initialTask: generateTask(contextDirName), compactWidth: true, profile: claudeProfileOrFirst(getProfile(null)) })
  return { status: 'launched' }
}

/** Pops the panel into a new, plain BrowserWindow. Transactional: builds and
 *  fully loads the replacement view FIRST, while the currently-docked view
 *  stays completely untouched and functional, and only tears the old view
 *  down once the new one has proven it loaded. If the build fails, or the
 *  panel moved on to some other state while it was loading, the half-built
 *  replacement is discarded and the original is left exactly as it was — no
 *  wedged mode, no silently-destroyed working state over a transient
 *  renderer-load hiccup. Every tab's transcript is replayed into the new view
 *  from main's scrollback (see the header comment); the underlying ptys/
 *  `claude` processes are never touched. */
export async function popOutTerminalPanel(win: BrowserWindow): Promise<void> {
  const panel = panels.get(win.id)
  if (!panel || panel.mode === 'popped' || panel.hidden) return

  // show:false — attach-before-navigate (matches windows.ts's
  // createDocumentWindow) means there's a real async gap between the window
  // existing and its content being ready; a default-visible window would sit
  // blank on screen for that whole gap. Shown only once loadTerminalRenderer
  // below has proven the content is actually ready.
  const popout = new BrowserWindow({
    width: widthForWindow(win.id),
    height: 720,
    title: titleForWindow(win),
    show: false,
  })

  const { view, sessionUnwire } = buildTerminalView(panel.sessions.values())
  popout.contentView.addChildView(view) // attach — window is hidden, safe to give it real bounds now
  const layoutPopout = (): void => {
    const { width, height } = popout.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  popout.on('resize', layoutPopout)
  layoutPopout()

  try {
    await loadTerminalRenderer(view) // navigate AFTER attach
  } catch (err) {
    console.error('[terminalPanel] failed to build pop-out view:', err)
    for (const unwire of sessionUnwire.values()) unwire()
    try { view.webContents.close() } catch { /* already gone */ }
    if (!popout.isDestroyed()) popout.destroy()
    return // panel untouched: still docked, still working
  }
  // The panel (or its mode) may have changed while the view was loading —
  // never commit a freshly built view onto a panel that moved on without it.
  if (panels.get(win.id) !== panel || panel.mode !== 'docked') {
    for (const unwire of sessionUnwire.values()) unwire()
    try { view.webContents.close() } catch { /* already gone */ }
    if (!popout.isDestroyed()) popout.destroy()
    return
  }
  sendCurrentTheme(view, win.id)
  view.webContents.send('terminal:init', {
    sessions: [...panel.sessions.values()].map((s) => initPayloadFor(view, s)),
    activeId: activeSessionIdFor(panel),
    mode: panel.mode,
  })

  // Only now — the replacement has PROVEN it works — tear down the old,
  // still-working docked view and commit the swap.
  const oldView = panel.view
  const oldUnwire = panel.sessionUnwire
  for (const unwire of oldUnwire.values()) unwire()
  try { win.contentView.removeChildView(oldView) } catch { /* window may be gone */ }
  try { oldView.webContents.close() } catch { /* already gone */ }

  panel.view = view
  panel.sessionUnwire = sessionUnwire
  // MUST flip before layoutWindow: panelWidthFor/layoutDockedPanel read
  // panel.mode to decide whether docView should still yield space for the
  // panel. Setting this after the call (as it used to be) meant layoutWindow
  // saw a still-'docked' panel whose view had just been detached — docView
  // was laid out too narrow for a panel no longer there, leaving a blank gap
  // (the window's own near-white backgroundColor, windows.ts) where the
  // document should be.
  panel.mode = 'popped'
  if (panel.revealTimer) { clearInterval(panel.revealTimer); panel.revealTimer = null }
  panel.reveal = 1
  layoutWindow(win)
  popout.show() // gated on proven-loaded content, not a fixed assumption

  popout.on('close', () => {
    // Falls back to disposing the ptys/view if the original host window no
    // longer exists — the panel has nowhere left to dock back into.
    if (panel.hostWindow.isDestroyed()) {
      disposePanel(win.id)
    } else {
      dockTerminalPanel(win).catch((err) => console.error('[terminalPanel] dock-on-close failed:', err))
    }
  })

  panel.popoutWindow = popout
}

/** Reverse of popOutTerminalPanel: same transactional build-then-swap shape.
 *  Builds and fully loads the replacement view in the host window FIRST —
 *  kept at zero size so it paints nothing over the live document mid-load,
 *  since a WebContentsView has no setVisible/hide, only bounds — while the
 *  popout window and its view stay untouched and functional. Only once the
 *  new view has proven it loaded does this tear down the popout and commit
 *  the swap. Triggered by closing the pop-out window, or an explicit "dock"
 *  control in its own header bar. */
export async function dockTerminalPanel(win: BrowserWindow): Promise<void> {
  const panel = panels.get(win.id)
  if (!panel || panel.mode === 'docked') return
  if (win.isDestroyed()) {
    disposePanel(win.id)
    return
  }

  const { view, sessionUnwire } = buildTerminalView(panel.sessions.values())
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 }) // invisible until swap — old popout still fully live

  try {
    await loadTerminalRenderer(view)
  } catch (err) {
    console.error('[terminalPanel] failed to build docked view:', err)
    for (const unwire of sessionUnwire.values()) unwire()
    try { win.contentView.removeChildView(view) } catch { /* already gone */ }
    try { view.webContents.close() } catch { /* already gone */ }
    return // panel untouched: still popped, still working
  }
  if (panels.get(win.id) !== panel || panel.mode !== 'popped' || win.isDestroyed()) {
    for (const unwire of sessionUnwire.values()) unwire()
    try { win.contentView.removeChildView(view) } catch { /* already gone */ }
    try { view.webContents.close() } catch { /* already gone */ }
    return
  }
  sendCurrentTheme(view, win.id)
  view.webContents.send('terminal:init', {
    sessions: [...panel.sessions.values()].map((s) => initPayloadFor(view, s)),
    activeId: activeSessionIdFor(panel),
    mode: panel.mode,
  })

  // Only now — the replacement has PROVEN it works — tear down the old,
  // still-working popped-out view/window and commit the swap.
  const oldView = panel.view
  const oldUnwire = panel.sessionUnwire
  const popout = panel.popoutWindow
  for (const unwire of oldUnwire.values()) unwire()
  if (popout && !popout.isDestroyed()) {
    try { popout.contentView.removeChildView(oldView) } catch { /* already gone */ }
    popout.destroy()
  }
  // Unconditionally: closing the pop-out window starts this dock and has
  // usually destroyed the window by the time the new view has loaded — and a
  // WebContentsView's renderer outlives its window (windows.ts
  // unmountDocument), so skipping this with the window left one orphaned
  // terminal renderer per pop-out → close cycle.
  try { if (!oldView.webContents.isDestroyed()) oldView.webContents.close() } catch { /* already gone */ }

  panel.view = view
  panel.sessionUnwire = sessionUnwire
  panel.mode = 'docked'
  panel.popoutWindow = null
  panel.hidden = false
  panel.reveal = 1
  layoutWindow(win) // real bounds now, atomically with docView shrinking back
}

/** ipcMain handlers for terminal:input / terminal:resize / terminal:popout /
 *  terminal:dock / terminal:close / terminal:new-tab / terminal:ready /
 *  terminal:close-tab,
 *  each resolving which panel a message belongs to via the sender's
 *  webContents.id — one WebContentsView per PANEL (shared by every tab), so
 *  no separate registration is needed per session. */
export function registerTerminalIpc(): void {
  function panelForSender(webContentsId: number): PanelState | null {
    for (const panel of panels.values()) {
      if (panel.view.webContents.id === webContentsId) return panel
    }
    return null
  }

  onFrom('terminal', 'terminal:input', (ev, sessionId: string, data: string) => {
    const panel = panelForSender(ev.sender.id)
    const session = isSafeId(sessionId) ? panel?.sessions.get(sessionId) : undefined
    if (!panel || !session) return
    panel.lastInputSessionId = sessionId
    session.pty.write(data)
  })

  // From the DOCUMENT view: a fixed prompt typed into this window's Claude
  // session (the tab last typed into, else the first), as if the user had
  // typed it — "Polish with Claude" next to Tidy. The renderer only names
  // the prompt; the text itself lives here, so a document can never put
  // arbitrary input into the pty.
  onFrom('app-shell', 'slidomingo:agent-prompt', (ev, kind: unknown, comments: unknown) => {
    // fix-comments lists the comments the user sent, draw-icons the icons to
    // draw (both sanitized, agentprompts.ts)
    const text = kind === 'fix-comments' ? fixCommentsPrompt(comments)
      : kind === 'draw-icons' ? drawIconsPrompt(comments)
      : kind === 'plan-icons' ? planIconsPrompt(comments)
      : kind === 'style-icons' ? styleIconsPrompt(comments)
      : typeof kind === 'string' && Object.hasOwn(AGENT_PROMPTS, kind) ? AGENT_PROMPTS[kind] : undefined
    const win = windowForDocWebContents(ev.sender.id)
    if (text && win) deliverPrompt(win, text)
  })
  // From the DOCUMENT view: "Fix with Claude" on a PowerPoint import's
  // report. The renderer sends the work list (slides/src/importrepair.ts
  // repairItems) and the picked file's path; main copies the file in beside
  // the session, renders a PDF of it when LibreOffice is there, and types
  // the sanitized list (agentprompts.ts fixImportPrompt) into the session.
  handleFrom('app-shell', 'slidomingo:fix-import', async (ev, raw: unknown) => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win || !raw || typeof raw !== 'object') return { ok: false, error: 'bad request' }
    const contextDir = panels.get(win.id)?.contextDir ?? join(workspaceForWindow(win), `.slidomingo-context-${win.id}`)
    const importDir = join(contextDir, 'import')
    let source = false
    let pdf = false
    try {
      rmSync(importDir, { recursive: true, force: true })
      mkdirSync(importDir, { recursive: true })
      const { sourcePath } = raw as { sourcePath?: unknown }
      if (isPptxFile(sourcePath)) {
        copyFileSync(sourcePath, join(importDir, 'source.pptx'))
        source = true
        pdf = !!(await renderToPdf(join(importDir, 'source.pptx'), importDir))
      }
    } catch { /* best effort: the list still goes, without the file */ }
    const text = fixImportPrompt(raw, { dir: basename(contextDir), source, pdf })
    if (!text) return { ok: false, error: 'nothing to fix' }
    if (win.isDestroyed()) return { ok: false, error: 'window closed' }
    deliverPrompt(win, text)
    return { ok: true, source, pdf }
  })
  onFrom('terminal', 'terminal:activated', (ev, sessionId: unknown) => {
    const panel = panelForSender(ev.sender.id)
    if (panel && isSafeId(sessionId)) panel.activeSessionId = sessionId
  })
  onFrom('terminal', 'terminal:resize', (ev, sessionId: string, cols: number, rows: number) => {
    const panel = panelForSender(ev.sender.id)
    if (isSafeId(sessionId)) panel?.sessions.get(sessionId)?.pty.resize(cols, rows)
  })
  // Distinct from terminal:resize above (one session's PTY rows/cols) — this
  // resizes the whole PANEL's own pixel width, driven by the renderer's
  // .term-resizer drag handle. Live update on every move; commit (persist)
  // once on mouseup.
  onFrom('terminal', 'terminal:panel-resize', (ev, width: number) => {
    const panel = panelForSender(ev.sender.id)
    if (panel) requestPanelWidth(panel.hostWindow.id, width)
  })
  onFrom('terminal', 'terminal:panel-resize-commit', (ev) => {
    const panel = panelForSender(ev.sender.id)
    if (panel) commitPanelWidth(panel.hostWindow.id)
  })
  onFrom('terminal', 'terminal:popout', (ev) => {
    const panel = panelForSender(ev.sender.id)
    if (panel) popOutTerminalPanel(panel.hostWindow).catch((err) => console.error('[terminalPanel] pop-out failed:', err))
  })
  onFrom('terminal', 'terminal:dock', (ev) => {
    const panel = panelForSender(ev.sender.id)
    if (panel) dockTerminalPanel(panel.hostWindow).catch((err) => console.error('[terminalPanel] dock failed:', err))
  })
  // Slides the WHOLE panel away (every tab keeps running) — the header's own
  // ✕ button, same as the toggle. Distinct from terminal:close-tab, a single
  // tab's own ✕, which ends that session.
  onFrom('terminal', 'terminal:close', (ev) => {
    const panel = panelForSender(ev.sender.id)
    if (panel) hidePanel(panel)
  })
  // The tab strip's "+" control — spawns a fresh `claude` session (a new pty
  // + its own contextDir subfolder) as an additional tab in THIS panel,
  // wired into the already-live view. This is also the "quick new chat" path
  // (close a tab, click + again) since a closed tab's session subfolder and
  // pty are gone for good. Its conversation is not: terminal:resume-chat
  // below continues it in a new tab.
  handleFrom('terminal', 'terminal:new-tab', async (ev, profileId?: unknown): Promise<TerminalInitSession | null> => {
    const panel = panelForSender(ev.sender.id)
    if (!panel) return null
    const contextDirName = basename(panel.contextDir)
    const profile = getProfile(typeof profileId === 'string' ? profileId : null)
    const session = await createSession(panel.workspace, panel.contextDir, contextDirName, () => deckKeyForWindow(panel.hostWindow), { profile })
    if (!session) return null
    return wireAndRegisterSession(panel, session)
  })
  // The "+" menu: the profiles a new chat can open with.
  handleFrom('terminal', 'terminal:list-profiles', () => {
    const { profiles, defaultId } = getProfiles()
    return { defaultId, profiles: profiles.map((p) => ({ id: p.id, name: tabLabel(p), kind: p.kind })) }
  })
  // From the document's settings page / commands: a new tab with a profile.
  onFrom('app-shell', 'slidomingo:new-chat-with', (ev, profileId: unknown) => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win) return
    const profile = getProfile(typeof profileId === 'string' ? profileId : null)
    const panel = panels.get(win.id)
    if (!panel) { void openPanel(win, { profile }).then(() => layoutWindow(win)); return }
    void (async () => {
      const created = await createSession(panel.workspace, panel.contextDir, basename(panel.contextDir), () => deckKeyForWindow(panel.hostWindow), { profile })
      if (!created || panels.get(win.id) !== panel) return
      const init = wireAndRegisterSession(panel, created)
      try { panel.view.webContents.send('terminal:init', { sessions: [init], activeId: created.id, mode: panel.mode }) } catch { /* view gone */ }
    })()
  })
  onFrom('terminal', 'chat:send', (ev, sessionId: unknown, text: unknown) => {
    const panel = panelForSender(ev.sender.id)
    const session = isSafeId(sessionId) ? panel?.sessions.get(sessionId) : undefined
    if (!panel || !session?.chat || typeof text !== 'string') return
    panel.lastInputSessionId = session.id
    void session.chat.send(text.slice(0, 20000))
  })
  // The "retry at lower reasoning" button under an empty, budget-spent turn.
  onFrom('terminal', 'chat:retry', (ev, sessionId: unknown, effort: unknown) => {
    const panel = panelForSender(ev.sender.id)
    const session = isSafeId(sessionId) ? panel?.sessions.get(sessionId) : undefined
    if (!panel || !session?.chat || !REASONING_EFFORTS.includes(effort as ReasoningEffort)) return
    panel.lastInputSessionId = session.id
    void session.chat.retry(effort as ReasoningEffort)
  })
  onFrom('terminal', 'chat:stop', (ev, sessionId: unknown) => {
    const panel = panelForSender(ev.sender.id)
    if (isSafeId(sessionId)) panel?.sessions.get(sessionId)?.chat?.stop()
  })
  // The history menu: this deck's earlier conversations, newest first, each
  // marked with the tab already running it (here, or in another window).
  handleFrom('terminal', 'terminal:list-chats', async (ev): Promise<Array<ChatSummary & { openIn: string | null; openElsewhere: boolean }>> => {
    const panel = panelForSender(ev.sender.id)
    if (!panel) return []
    try {
      const key = deckKeyForWindow(panel.hostWindow)
      const configDir = await claudeConfigDir()
      // Conversations from before the history feature existed have transcripts but no record.
      // Legacy chats ran in the deck's own folder.
      const legacy = deckDirOf(key.path)
      for (const dir of await allClaudeConfigDirs()) {
        backfillChats(chatHistoryPath(), dir, legacy ? [panel.workspace, legacy] : [panel.workspace], key)
      }
      const profiles = getProfiles().profiles
      const dirOfProfile = new Map<string, string>()
      for (const p of profiles) if (p.kind === 'claude-code' && p.configDir) dirOfProfile.set(p.id, p.configDir)
      const chats = listChats(chatHistoryPath(), configDir, key, Date.now(), {
        apiDir: apiChatsDir(),
        configDirOf: (r) => (r.profileId && dirOfProfile.get(r.profileId)) || configDir,
      }).map((c) => ({ ...c, profileName: profiles.find((p) => p.id === c.profileId)?.name }))
      return chats.map((c) => {
        const running = sessionRunningChat(c.id)
        return { ...c, openIn: running?.panel === panel ? running.session.id : null, openElsewhere: !!running && running.panel !== panel }
      })
    } catch {
      return []
    }
  })
  // Tab labels: each open tab's conversation title (null = nothing said yet,
  // the tab keeps its profile name). Polled by the panel, so a Claude Code
  // transcript is read only from where the last poll stopped.
  handleFrom('terminal', 'terminal:tab-titles', async (ev): Promise<Record<string, string | null>> => {
    const panel = panelForSender(ev.sender.id)
    const out: Record<string, string | null> = {}
    if (!panel) return out
    for (const session of panel.sessions.values()) {
      try {
        if (session.chat) {
          const first = session.chat.display.find((d) => d.kind === 'user')
          out[session.id] = first && 'text' in first && first.text.trim() ? clip(first.text) : null
          continue
        }
        const known = session.titleTail?.file
        const file = known && basename(known) === `${session.chatId}.jsonl`
          ? known
          : findTranscript(await claudeConfigDir(session.profile), session.chatId)
        if (!file) { out[session.id] = null; continue }
        const { title, tail } = tailTranscriptTitle(file, session.titleTail ?? null)
        session.titleTail = tail
        out[session.id] = title
      } catch { out[session.id] = null }
    }
    return out
  })
  // Continue one of them in a new tab (`claude --resume`). Only a conversation
  // recorded for THIS deck, and never one a tab is already running.
  // `resuming` covers the spawn's await, so a double click can't start two.
  const resuming = new Set<string>()
  handleFrom('terminal', 'terminal:resume-chat', async (ev, chatId: unknown): Promise<TerminalInitSession | null> => {
    const panel = panelForSender(ev.sender.id)
    if (!panel || !isChatId(chatId)) return null
    if (!belongsTo(chatHistoryPath(), chatId, deckKeyForWindow(panel.hostWindow))) return null
    if (sessionRunningChat(chatId) || resuming.has(chatId)) return null
    resuming.add(chatId)
    try {
      const contextDirName = basename(panel.contextDir)
      // Reopen under the profile it ran with. A deleted one falls back to the
      // default, or (an API chat needs an API profile) the first API profile.
      const rec = getRecord(chatHistoryPath(), chatId)
      const wantApi = rec?.kind === 'api'
      let profile = getProfile(rec?.profileId)
      if ((profile.kind === 'api') !== wantApi) {
        const other = getProfiles().profiles.find((p) => (p.kind === 'api') === wantApi)
        if (!other) return null
        profile = other
      }
      const session = await createSession(panel.workspace, panel.contextDir, contextDirName, () => deckKeyForWindow(panel.hostWindow), { resumeChatId: chatId, profile })
      if (!session) return null
      return wireAndRegisterSession(panel, session)
    } finally {
      resuming.delete(chatId)
    }
  })
  // ---- Attached folders (attachedfolders.ts) -------------------------------
  // The deck's AI chats can reach extra folders the user picks here: `claude`
  // via `--add-dir`, API chats via read-only file tools. The paths come from a
  // native dialog in main and live in userData only — never in the deck.
  const sameFolders = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
  /** Claude Code tabs launched with a different folder list than the deck has now. */
  const staleTabs = (panel: PanelState): SessionState[] => {
    const current = foldersOf(deckKeyForWindow(panel.hostWindow))
    return [...panel.sessions.values()].filter((x) => x.kind === 'terminal' && !sameFolders(x.extraDirs, current))
  }
  const folderState = (panel: PanelState, error?: string) => {
    const key = deckKeyForWindow(panel.hostWindow)
    const all = listFolders(attachedFoldersPath(), key)
    const live = existingFolders(all)
    return {
      folders: all.map((path) => ({ path, name: basename(path) || path, exists: live.includes(path) })),
      /** The deck's own folder: always reachable, never removable. */
      deckFolder: deckDirOf(key.path),
      canAttach: !!(key.docId || key.path),
      stale: staleTabs(panel).length,
      ...(error ? { error } : {}),
    }
  }
  handleFrom('terminal', 'terminal:list-folders', (ev) => {
    const panel = panelForSender(ev.sender.id)
    return panel ? folderState(panel) : null
  })
  handleFrom('terminal', 'terminal:add-folder', async (ev) => {
    const panel = panelForSender(ev.sender.id)
    if (!panel) return null
    const key = deckKeyForWindow(panel.hostWindow)
    const parent = BrowserWindow.fromWebContents(ev.sender) ?? panel.hostWindow
    const picked = await dialog.showOpenDialog(parent, {
      title: 'Attach folders to this deck\u2019s AI chats',
      message: 'The AI chats of this deck will be able to read the files in the folders you pick.',
      buttonLabel: 'Attach',
      defaultPath: deckDirOf(key.path) ?? undefined,
      properties: ['openDirectory', 'multiSelections'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return folderState(panel)
    // Several can be picked at once; keep going past a bad one, report the first problem.
    let error: string | undefined
    for (const raw of picked.filePaths) {
      const checked = validateFolder(raw)
      if (!checked.ok) { error ??= checked.error; continue }
      const added = addFolder(attachedFoldersPath(), key, checked.path)
      if (!added.ok) { error ??= added.error; break }
    }
    return folderState(panel, error)
  })
  handleFrom('terminal', 'terminal:remove-folder', (ev, folder: unknown) => {
    const panel = panelForSender(ev.sender.id)
    if (!panel) return null
    const key = deckKeyForWindow(panel.hostWindow)
    // Only a folder that is in this deck's list — the string is never used as a path otherwise.
    if (typeof folder === 'string' && listFolders(attachedFoldersPath(), key).includes(folder)) removeFolder(attachedFoldersPath(), key, folder)
    return folderState(panel)
  })
  // Relaunches the Claude Code tabs that predate a folder change, each in its
  // own conversation (`--resume`; a tab that never got a message has no
  // transcript and starts over under the same id). The old process is killed
  // first: one transcript never has two `claude` appending to it.
  handleFrom('terminal', 'terminal:restart-stale', async (ev): Promise<TerminalInitSession[]> => {
    const panel = panelForSender(ev.sender.id)
    if (!panel) return []
    const out: TerminalInitSession[] = []
    for (const old of staleTabs(panel)) {
      const { chatId, profile } = old
      const used = !!findTranscript(await claudeConfigDir(profile), chatId)
      closeSession(panel, old.id)
      const created = await createSession(panel.workspace, panel.contextDir, basename(panel.contextDir), () => deckKeyForWindow(panel.hostWindow), used ? { resumeChatId: chatId, profile } : { freshChatId: chatId, profile })
      if (created) out.push(wireAndRegisterSession(panel, created))
    }
    return out
  })
  // The renderer's ack after terminal:init / a "+" tab: its xterms exist and
  // hold the replay, so live pty output may flow now (see markViewReady).
  // Resolved via viewGates, not panelForSender: a pop/dock replacement view
  // may ack before it has been swapped into panel.view.
  onFrom('terminal', 'terminal:ready', (ev) => markViewReady(ev.sender))
  onFrom('terminal', 'terminal:close-tab', (ev, sessionId: string) => {
    const panel = panelForSender(ev.sender.id)
    if (panel && isSafeId(sessionId)) closeSession(panel, sessionId)
  })

  // Fire-and-forget, from the DOCUMENT view (not the terminal view) — the
  // editor pushes a fresh selection snapshot on every debounced change.
  // Colocated here (not index.ts) because it needs the `panels` map.
  onFrom('app-shell', 'slidomingo:selection-context', (ev, json: string) => {
    const win = windowForDocWebContents(ev.sender.id)
    if (win) writeSelectionContext(win, json)
  })

  // The document renderer's resolved Auto/Light/Dark theme — a separate
  // renderer (the terminal panel) has no access to its localStorage/media
  // query resolution, so it's pushed here rather than guessed. Stored per
  // window even without a live panel (see windowThemes above), and forwarded
  // immediately when one exists.
  onFrom('app-shell', 'slidomingo:terminal-theme', (ev, theme: 'light' | 'dark') => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win) return
    windowThemes.set(win.id, theme)
    panels.get(win.id)?.view.webContents.send('terminal:theme', theme)
  })

  // Reverse leg of the write-back channel (see processEditFile above): the
  // editor reports whether it applied edit.json, from the DOCUMENT view.
  // Written to edit-result.json so `claude` can read it back with its own
  // tools; edit.json is removed here so a stale command file never lingers
  // or gets reprocessed. sessionId (added by editor.ts, echoed back from what
  // processEditFile tagged onto the forwarded payload) says which session's
  // subfolder to write into.
  onFrom('app-shell', 'slidomingo:apply-edit-result', (ev, result: { ok: boolean; summary?: string; error?: string; sessionId?: string }) => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win) return
    const panel = panels.get(win.id)
    const session = panel && isSafeId(result.sessionId) ? panel.sessions.get(result.sessionId) : null
    if (!session) return
    const { sessionId: _sessionId, ...toWrite } = result
    try { writeFileSync(join(session.contextDir, 'edit-result.json'), JSON.stringify(toWrite, null, 2), 'utf8') } catch { /* best effort */ }
    try { rmSync(join(session.contextDir, 'edit.json'), { force: true }) } catch { /* best effort */ }
  })
}
