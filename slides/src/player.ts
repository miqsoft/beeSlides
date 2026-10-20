// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The viewer half of the boot: the password gate and the player card. Shared
// by the editor entry (main.ts — a `doc.readonly` file, an encrypted file) and
// the viewer-only entry (viewer.ts), which must stay free of anything under
// editor/ so the editor tree-shakes out of a viewer file.

import { appConfig } from '../../kernel/src/app.ts'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'
import {
  decryptEnvelope, downloadFile, serializeAuto, setEncryptionPassword, suggestedFileName,
  type EncEnvelope,
} from './save'
import { parseDoc, type SlidomingoDoc } from './model'
import { refuseGatedWrite, showFormatGateBanner } from './formatgate'
import { injectFonts } from './fonts'
import { startPresentation } from './present'
import { openSpeakerWindow, setSpeakerWindow, speakerIdleBody, speakerWindow } from './screens'
import { WORDMARK_HTML, logoSvg } from './brand'
import { t } from './i18n'

/** Encrypted file: ask for the password (looping on failure), then hand the
 *  decrypted document to `onDoc`. */
export function passwordGate(envelope: EncEnvelope, onDoc: (doc: SlidomingoDoc) => void) {
  const gate = document.createElement('div')
  gate.className = 'ed-pwgate'
  gate.innerHTML =
    `<div class="ed-pwcard"><div class="ed-pwmark">🔒</div>` +
    `<h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter password to open this deck')}</p>` +
    `<input type="password" autocomplete="current-password">` +
    `<button>${t('Unlock')}</button><div class="ed-pwerr"></div></div>`
  document.body.appendChild(gate)
  document.getElementById('beeslides-splash')?.remove()
  const input = gate.querySelector('input')!
  const button = gate.querySelector('button')!
  const err = gate.querySelector<HTMLElement>('.ed-pwerr')!
  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    button.setAttribute('disabled', '')
    const json = await decryptEnvelope(envelope, pass)
    button.removeAttribute('disabled')
    if (json === null) {
      err.textContent = t('Wrong password — try again')
      input.select()
      return
    }
    const doc = parseDoc(json)
    if (!doc) {
      err.textContent = t('Wrong password — try again')
      return
    }
    setEncryptionPassword(pass) // saves + updates keep writing encrypted
    gate.remove()
    onDoc(doc)
  }
  button.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void tryUnlock()
  })
  input.focus()
}

type PlayMode = 'fullscreen' | 'presenter' | 'window' | 'kiosk'
const PLAY_MODES: PlayMode[] = ['fullscreen', 'presenter', 'window', 'kiosk']
/** Viewer preferences (never in the document): the last mode, and the kiosk timing. */
const MODE_KEY = 'slidomingo-present-mode'
const KIOSK_KEY = 'slidomingo-present-kiosk'

function savedKiosk(): { seconds?: number; loop?: boolean } {
  try { return JSON.parse(lsGet(KIOSK_KEY) || '{}') ?? {} } catch { return {} }
}

/** The four mode glyphs: one clean 24px stroke icon each (no emoji, no icon set — the viewer stays small). */
const MODE_ICON: Record<PlayMode, string> = {
  fullscreen: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><rect x="8.5" y="9" width="7" height="6" rx="1"/>',
  presenter: '<rect x="2.5" y="4" width="12" height="9" rx="1.5"/><rect x="9.5" y="9.5" width="12" height="9" rx="1.5" fill="#17120A"/><path d="M5.5 16.5h3"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18"/><circle cx="6.2" cy="7.3" r=".6" fill="currentColor"/><circle cx="8.4" cy="7.3" r=".6" fill="currentColor"/>',
  kiosk: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/><path d="M12 8.5V12l2.4 1.6"/>',
}
const icon = (body: string, size = 26) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const PLAY_GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5Z" fill="currentColor"/></svg>'

/**
 * The viewer: a start card to pick how to present — full screen, presenter
 * view (speaker window + audience window), in a window, or kiosk — and the
 * show itself. In the show F / S / K swap fullscreen, the speaker view and
 * kiosk; Esc leaves it and lands back on this card, never the editor. A
 * `doc.readonly` file gets this inside the editor build; a file written by
 * File ▸ Export gets it from the viewer-only build (viewer.ts).
 *
 * No autostart (except `#present`): full screen and the speaker window both
 * need a click, so they are the card's job. Presenter view is ONE click: it
 * opens the speaker window and starts the show together. The speaker window
 * is opened first, in the click, so it is never trapped in the slides'
 * fullscreen Space; if the browser then refuses fullscreen (the popup used
 * the click's activation) the show runs in this window and says "press F".
 */
export function playerMode(doc: SlidomingoDoc) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('beeslides-splash')?.remove()
  const modeInfo: Record<PlayMode, [string, string]> = {
    fullscreen: [t('Full screen'), t('One window, slides only')],
    presenter: [t('Presenter view'), t('Notes window + audience window')],
    window: [t('In a window'), t('Plays in this window')],
    kiosk: [t('Kiosk'), t('Runs by itself')],
  }
  const saved = savedKiosk()
  const kioskSeconds = Math.min(3600, Math.max(1, Math.round(doc.present?.autoAdvance ?? saved.seconds ?? 10)))
  const kioskLoop = doc.present?.loop ?? saved.loop ?? true
  const stored = lsGet(MODE_KEY) as PlayMode | null
  let mode: PlayMode = stored && PLAY_MODES.includes(stored) ? stored : 'fullscreen'

  const card = document.createElement('div')
  card.className = 'ed-player'
  card.innerHTML =
    `<div class="ed-playercard ed-playercard-wide">` +
    `<div class="ed-playbrand"><span class="ed-playlogo">${logoSvg(96, { animated: true })}</span>` +
    `<span class="ed-playword">${WORDMARK_HTML}</span></div>` +
    `<h1>${doc.title.replace(/</g, '&lt;')}</h1>` +
    `<p>${t('View and present this deck.')}</p>` +
    `<div class="ed-playmodes" role="radiogroup" aria-label="${t('How to present')}">` +
    PLAY_MODES.map((m) =>
      `<button type="button" class="ed-playmode" role="radio" data-mode="${m}">` +
      `<span class="ed-playmode-ico">${icon(MODE_ICON[m])}</span><b>${modeInfo[m][0]}</b><small>${modeInfo[m][1]}</small></button>`).join('') +
    `</div>` +
    `<div class="ed-playkiosk" hidden><label>${t('Advance every')} ` +
    `<input type="number" class="ed-playsecs" min="1" max="3600" step="1" value="${kioskSeconds}"> ${t('seconds')}</label>` +
    `<label><input type="checkbox" class="ed-playloop"${kioskLoop ? ' checked' : ''}> ${t('Loop')}</label></div>` +
    `<div class="ed-playhint" aria-live="polite"></div>` +
    `<button type="button" class="ed-playgo">${PLAY_GLYPH}<span>${t('Start')}</span></button>` +
    `<button type="button" class="ed-playcopy">${t('Save a copy')}</button>` +
    `<p class="ed-playkeys">${t('F full screen / window · S speaker view · K kiosk · Esc back to this card')}</p></div>`
  document.body.appendChild(card)
  const q = <E extends HTMLElement>(sel: string) => card.querySelector<E>(sel)!
  const goBtn = q<HTMLButtonElement>('.ed-playgo')
  const hint = q('.ed-playhint')
  const kioskRow = q('.ed-playkiosk')
  const secsInput = q<HTMLInputElement>('.ed-playsecs')
  const loopInput = q<HTMLInputElement>('.ed-playloop')
  const speakerTitle = `${doc.title} — ${t('Speaker view')}`

  const sync = () => {
    card.querySelectorAll<HTMLElement>('.ed-playmode').forEach((b) => {
      const on = b.dataset.mode === mode
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    })
    kioskRow.hidden = mode !== 'kiosk'
    hint.textContent = ''
  }
  const pick = (m: PlayMode) => { mode = m; lsSet(MODE_KEY, m); sync() }
  card.querySelectorAll<HTMLElement>('.ed-playmode').forEach((b, i) => {
    b.addEventListener('click', () => { pick(b.dataset.mode as PlayMode); b.focus() })
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
      if (!step) return
      e.preventDefault()
      const next = PLAY_MODES[(i + step + PLAY_MODES.length) % PLAY_MODES.length]
      pick(next)
      card.querySelector<HTMLElement>(`.ed-playmode[data-mode="${next}"]`)?.focus()
    })
  })

  const start = (as: PlayMode = mode) => {
    // a speaker window left open from an earlier show must not ride along into the other modes
    if (as !== 'presenter') { speakerWindow()?.close(); setSpeakerWindow(null) }
    const opts: Parameters<typeof startPresentation>[3] = { fullscreen: as !== 'window' }
    if (as === 'kiosk') {
      const seconds = Math.min(3600, Math.max(1, Math.round(Number(secsInput.value)) || kioskSeconds))
      secsInput.value = String(seconds)
      opts.kiosk = { seconds, loop: loopInput.checked }
      lsSet(KIOSK_KEY, JSON.stringify(opts.kiosk))
    }
    card.style.display = 'none'
    startPresentation(doc, 0, () => {
      card.style.display = ''
      sync()
      goBtn.focus()
    }, opts)
  }
  goBtn.addEventListener('click', () => {
    if (mode === 'presenter' && !speakerWindow()) {
      // the speaker window first, in this click; the show adopts it (present.ts)
      const w = openSpeakerWindow(speakerTitle, speakerIdleBody(doc.title,
        t('Notes, controls and slide thumbnails appear here when you start presenting. Drag this window to your second display.')))
      if (!w) { hint.textContent = t('Allow pop-ups for this file to open the speaker window.'); return }
    }
    start()
  })
  card.querySelector('.ed-playcopy')!.addEventListener('click', () => {
    if (refuseGatedWrite((m) => alert(m))) return
    void serializeAuto(doc).then((html) => downloadFile(html, suggestedFileName(doc)))
  })
  ;(window as any).beeslides = (window as any).slidomingo = { format: doc.format, doc, readonly: true }
  showFormatGateBanner()
  sync()
  if (location.hash === '#present') start('fullscreen') // a link that asks for the show; fullscreen degrades to the tab without a click
  else {
    // Enter starts it, but the focus glow only shows once a key is actually used
    goBtn.focus()
    goBtn.dataset.quiet = ''
    document.addEventListener('keydown', () => delete goBtn.dataset.quiet, { once: true })
  }
}
