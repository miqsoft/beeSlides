// Second, separate contextBridge for the terminal panel's own renderer —
// kept as its own file so the DOCUMENT preload (src/preload/index.ts) is
// never touched by this feature. node-pty lives only in the main process;
// this bridge is the terminal renderer's only way to reach it.
//
// Multi-session (parallel-claude-sessions): one panel now hosts several
// independent `claude` ptys as tabs (see terminalPanel.ts's SessionState) —
// data/exit/input/resize are all tagged with a sessionId so the renderer's
// tab strip (main.ts) can route each pty's stream to its own xterm.js
// instance. newTab/closeTab are the "+" control and a tab's own ✕.
import { contextBridge, ipcRenderer } from 'electron'

/** One tab's state as main hands it over: `scrollback` is every byte the pty
 *  produced so far (write it before anything else), `exitCode` is set only
 *  if the process already exited. */
type InitSession = {
  id: string; chatId: string; createdAt: number; scrollback: string; exitCode?: number | null
  /** `chat` = a native API chat tab (no pty); `label` is the profile's tab name. */
  kind: 'terminal' | 'chat'; label: string; model?: string; display?: unknown[]; busy?: boolean; usage?: unknown
}

/** One of this deck's earlier conversations (main's chathistory.ts).
 *  `openIn` = the tab here already running it; `openElsewhere` = a tab in
 *  another window is. */
type ChatSummary = { id: string; title: string; startedAt: number; updatedAt: number; openIn: string | null; openElsewhere: boolean; kind?: 'claude' | 'api'; profileName?: string }

/** The deck's attached folders (main's attachedfolders.ts) as the panel shows them. */
type FolderState = {
  folders: Array<{ path: string; name: string; exists: boolean }>
  deckFolder: string | null
  canAttach: boolean
  /** Claude Code tabs launched before the last folder change. */
  stale: number
  error?: string
}

contextBridge.exposeInMainWorld('slidomingoTerminal', {
  /** Pushed once, right after this renderer finishes loading — every session
   *  already open in this panel, each with its scrollback replay (see
   *  terminalPanel.ts's header comment), so the tab strip can build itself
   *  without a chicken-and-egg "which tabs exist" round trip. Live
   *  terminal:data is held back until ready() below. */
  onInit: (cb: (state: { sessions: InitSession[]; activeId: string | null }) => void): void => {
    ipcRenderer.on('terminal:init', (_ev, state) => cb(state))
  },
  onData: (cb: (sessionId: string, data: string) => void): void => {
    ipcRenderer.on('terminal:data', (_ev, sessionId, data) => cb(sessionId, data))
  },
  onExit: (cb: (sessionId: string, code: number | null) => void): void => {
    ipcRenderer.on('terminal:exit', (_ev, sessionId, code) => cb(sessionId, code))
  },
  /** Fires when a session closes for a reason OTHER than this renderer's own
   *  close-button click (e.g. the whole panel closing) — main is always the
   *  source of truth for which tabs exist. */
  onTabClosed: (cb: (sessionId: string) => void): void => {
    ipcRenderer.on('terminal:tab-closed', (_ev, sessionId) => cb(sessionId))
  },
  write: (sessionId: string, data: string): void => ipcRenderer.send('terminal:input', sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): void => ipcRenderer.send('terminal:resize', sessionId, cols, rows),
  /** Which tab the user is on — lets pop-out/dock reopen on it, not tab 1. */
  reportActive: (sessionId: string): void => ipcRenderer.send('terminal:activated', sessionId),
  /** Spawns a fresh `claude` session (new pty + its own contextDir subfolder)
   *  as an additional tab in this same panel — resolves to null if the panel
   *  itself is gone (window closing mid-click) or the pty failed to spawn. */
  newTab: (profileId?: string): Promise<InitSession | null> => ipcRenderer.invoke('terminal:new-tab', profileId),
  /** The "+" menu's entries (names are tab labels). */
  listProfiles: (): Promise<{ defaultId: string; profiles: Array<{ id: string; name: string; kind: 'claude-code' | 'api' }> }> => ipcRenderer.invoke('terminal:list-profiles'),
  // ---- API chat tabs (no pty): see desktop/src/main/apichat ----
  chatSend: (sessionId: string, text: string): void => ipcRenderer.send('chat:send', sessionId, text),
  chatStop: (sessionId: string): void => ipcRenderer.send('chat:stop', sessionId),
  chatRetry: (sessionId: string, effort: string): void => ipcRenderer.send('chat:retry', sessionId, effort),
  onChatEvent: (cb: (sessionId: string, ev: unknown) => void): void => { ipcRenderer.on('chat:event', (_ev, id, e) => cb(id, e)) },
  /** A full snapshot (display list + busy flag), sent once a view is ready. */
  onChatSync: (cb: (sessionId: string, state: { display: unknown[]; busy: boolean; usage?: unknown }) => void): void => { ipcRenderer.on('chat:sync', (_ev, id, st) => cb(id, st)) },
  /** View ▸ New Chat With… opens the "+" menu. */
  onShowProfiles: (cb: () => void): void => { ipcRenderer.on('terminal:show-profiles', () => cb()) },
  /** This deck's earlier conversations, newest activity first. */
  listChats: (): Promise<ChatSummary[]> => ipcRenderer.invoke('terminal:list-chats'),
  /** Continues one of them (`claude --resume`) as a new tab — null if it is
   *  not this deck's, already running, or the pty failed to spawn. Ack with
   *  ready() exactly like newTab. */
  resumeChat: (chatId: string): Promise<InitSession | null> => ipcRenderer.invoke('terminal:resume-chat', chatId),
  // ---- Attached folders: the deck's AI chats can read these ----
  listFolders: (): Promise<FolderState | null> => ipcRenderer.invoke('terminal:list-folders'),
  /** Opens the native folder dialog (in main) and attaches the pick. */
  addFolder: (): Promise<FolderState | null> => ipcRenderer.invoke('terminal:add-folder'),
  removeFolder: (path: string): Promise<FolderState | null> => ipcRenderer.invoke('terminal:remove-folder', path),
  /** Relaunches the Claude Code tabs that predate a folder change; ack each with ready() like newTab. */
  restartStale: (): Promise<InitSession[]> => ipcRenderer.invoke('terminal:restart-stale'),
  /** Ack after onInit / a newTab result: every session UI exists and holds
   *  its replay — main starts forwarding live pty output only after this. */
  ready: (): void => ipcRenderer.send('terminal:ready'),
  /** Closes one tab: kills its pty, removes its contextDir subfolder, and
   *  releases any slide locks it held (see store.ts). Never closes the whole
   *  panel — see close() below for that. */
  closeTab: (sessionId: string): void => ipcRenderer.send('terminal:close-tab', sessionId),
  popOut: (): void => ipcRenderer.send('terminal:popout'),
  dock: (): void => ipcRenderer.send('terminal:dock'),
  /** Closes the WHOLE panel — every open tab. Distinct from closeTab above. */
  close: (): void => ipcRenderer.send('terminal:close'),
  // Panel WIDTH in pixels, driven by the .term-resizer drag handle — distinct
  // from resize() above, which is one session's PTY rows/cols.
  resizePanel: (width: number): void => ipcRenderer.send('terminal:panel-resize', width),
  resizePanelCommit: (): void => ipcRenderer.send('terminal:panel-resize-commit'),
  // The app's resolved Auto/Light/Dark theme, pushed from the document
  // renderer via the main process (see terminalPanel.ts) — this view has no
  // access to the document's own localStorage to resolve it itself.
  /** View ▸ Claude Chats… — open the history menu. */
  onShowHistory: (cb: () => void): void => {
    ipcRenderer.on('terminal:show-history', () => cb())
  },
  onTheme: (cb: (theme: 'light' | 'dark') => void): void => {
    ipcRenderer.on('terminal:theme', (_ev, theme) => cb(theme))
  },
})
