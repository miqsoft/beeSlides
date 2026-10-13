// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// EVERY ipcMain handler in this app is registered through handleFrom/onFrom,
// naming the one renderer allowed to call it (docs/DECISIONS.md 2026-10-08,
// "IPC sender checks"):
//
//   'app-shell' — the main frame of a doc view running this build's own
//                 slides shell (windows.ts isAppShellSender): every
//                 `slidomingo:*` channel;
//   'terminal'  — the main frame of a Claude Code terminal view running the
//                 terminal renderer (terminalPanel.ts isTerminalSender):
//                 every `terminal:*` / `chat:*` channel.
//
// A message from anywhere else — another app's page, a speaker window, a
// subframe, a view navigated away from the app — is refused before the
// handler runs. A refusal never throws (a rejected ipcMain.handle is logged by
// Electron's own console call, which can crash main — desktop/CLAUDE.md): an
// invoke resolves to an IpcRefusal, a sendSync gets one as its returnValue,
// and one guarded log line per channel and sender says what was refused.
// scripts/test-desktop-ipc-guard.mjs fails on any ipcMain.handle/.on outside
// this file.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isAppShellSender } from './windows.ts'
import { isTerminalSender } from './terminalPanel.ts'

export type IpcCaller = 'app-shell' | 'terminal'

export interface IpcRefusal { ok: false; refused: true; error: string }

const CALLER_NAMES: Record<IpcCaller, string> = {
  'app-shell': "BeeSlides's own app shell",
  terminal: 'the Claude Code terminal panel',
}

function allowed(who: IpcCaller, ev: IpcMainEvent | IpcMainInvokeEvent): boolean {
  try {
    return who === 'app-shell' ? isAppShellSender(ev) : isTerminalSender(ev)
  } catch { return false }
}

const logged = new Set<string>()

function refuse(who: IpcCaller, channel: string, ev: IpcMainEvent | IpcMainInvokeEvent): IpcRefusal {
  const error = `${channel} refused: only ${CALLER_NAMES[who]} may call it`
  const key = `${channel}|${ev.sender.id}`
  if (!logged.has(key)) {
    logged.add(key)
    let from = ''
    try { from = ev.senderFrame?.url ?? '' } catch { /* frame gone */ }
    try { console.error(`[ipc] ${error} (sender ${ev.sender.id}${from ? `, ${from.slice(0, 120)}` : ''})`) } catch { /* pipe gone */ }
  }
  return { ok: false, refused: true, error }
}

/** ipcMain.handle for one caller; anyone else gets an IpcRefusal. */
export function handleFrom<T>(
  who: IpcCaller,
  channel: string,
  fn: (ev: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (ev, ...args) => (allowed(who, ev) ? fn(ev, ...args) : refuse(who, channel, ev)))
}

/** ipcMain.on for one caller; anyone else is ignored (a sendSync gets an
 *  IpcRefusal back, so the caller never hangs). */
export function onFrom(
  who: IpcCaller,
  channel: string,
  fn: (ev: IpcMainEvent, ...args: any[]) => unknown,
): void {
  ipcMain.on(channel, (ev, ...args) => {
    if (allowed(who, ev)) {
      const r = fn(ev, ...args)
      if (r instanceof Promise) r.catch((err) => { try { console.error(`[ipc] ${channel} failed:`, err) } catch { /* pipe gone */ } })
      return
    }
    const refusal = refuse(who, channel, ev)
    try { ev.returnValue = refusal } catch { /* an async message has no reply */ }
  })
}
