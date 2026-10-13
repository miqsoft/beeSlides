// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Icon library: the list of icon sources the Icons button searches
// together (iconlibrary.ts owns the model). One card per source — a server
// (URL + optional token — in the desktop app stored encrypted by main and
// never shown again, like the AI keys) or a local folder — each with a name, an on/off
// switch, its own Test and a remove button. Edits persist as they are made;
// only adding and removing rebuild the list, so typing never loses focus.

import { t } from '../i18n'
import { ICONS } from '../icons'
import {
  canPickIconFolder, clearIconFolderHandle, hostOf, iconDesktop, iconSourceLabel, iconSources, iconTokenStatus, loadIconFolderHandle,
  MAX_LICENSE, newIconSourceId, pickIconFolder, setIconSources, testIconSource, type IconSource,
} from './iconlibrary'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function renderIconSources(host: HTMLElement, deps: { toast(message: string): void }): void {
  const wrap = el('div', 'ed-isrc-wrap')
  const title = el('div', 'ed-about-h', t('Icon library'))
  const intro = el('p', 'ed-hint', t('Where the Icons button searches. Add as many servers and folders as you like — results from all of them that are switched on appear together.'))
  const listEl = el('div', 'ed-isrc-list')
  const addRow = el('div', 'ed-isrc-add')
  wrap.append(title, intro, listEl, addRow)
  host.appendChild(wrap)

  let list = iconSources()
  const persist = () => { setIconSources(list) }

  const card = (src: IconSource): HTMLElement => {
    const root = el('div', 'ed-isrc')
    root.dataset.sourceId = src.id
    root.dataset.kind = src.kind
    root.classList.toggle('off', !src.enabled)

    // --- header: glyph, name, switch, test, remove
    const head = el('div', 'ed-isrc-head')
    const glyph = el('span', 'ed-isrc-glyph')
    glyph.innerHTML = src.kind === 'server' ? ICONS.globe : ICONS.folder
    const name = el('input', 'ed-isrc-name')
    name.type = 'text'
    name.value = src.name
    name.maxLength = 60
    name.placeholder = src.kind === 'server' ? (src.url ? hostOf(src.url) : t('Icon server')) : t('Local folder')
    name.setAttribute('aria-label', t('Name'))
    name.addEventListener('change', () => { src.name = name.value.trim(); persist() })
    const sw = el('button', 'ed-switch')
    sw.type = 'button'
    sw.setAttribute('role', 'switch')
    sw.title = t('Include in icon searches')
    sw.setAttribute('aria-label', t('Include in icon searches'))
    const paintSwitch = () => { sw.setAttribute('aria-checked', String(src.enabled)); root.classList.toggle('off', !src.enabled) }
    sw.addEventListener('click', () => { src.enabled = !src.enabled; paintSwitch(); persist() })
    paintSwitch()
    const test = el('button', 'ed-btn', t('Test'))
    test.type = 'button'
    const remove = el('button', 'ed-btn ed-btn-icon ed-isrc-remove')
    remove.type = 'button'
    remove.innerHTML = ICONS.trash
    remove.title = t('Remove this source')
    remove.setAttribute('aria-label', t('Remove this source'))
    head.append(glyph, name, sw, test, remove)

    // --- body
    const body = el('div', 'ed-isrc-body')
    let readFields: () => void = () => {}
    /** Desktop: hands a typed token to main (awaited before a Test). */
    let storeToken: () => Promise<void> = async () => {}
    const field = (label: string, input: HTMLInputElement) => {
      const f = el('label', 'ed-isrc-field')
      f.append(el('span', undefined, label), input)
      return f
    }
    if (src.kind === 'server') {
      const url = el('input')
      url.type = 'text'
      url.placeholder = t('Server URL')
      url.value = src.url
      url.spellcheck = false
      const token = el('input')
      token.type = 'password'
      token.autocomplete = 'off'
      token.placeholder = t('API token (optional)')
      const desktop = iconDesktop()
      const tokenField = field(t('API token (optional)'), token)
      body.append(field(t('Server URL'), url), tokenField)
      if (!desktop) {
        // only for servers behind a login; kept in this browser, never in the deck
        token.title = t('Sent to the icon server as a Bearer token. Kept in this browser only — never saved into a document.')
        token.value = src.token
        readFields = () => { src.url = url.value.trim(); src.token = token.value.trim(); name.placeholder = src.url ? hostOf(src.url) : t('Icon server') }
        for (const i of [url, token]) i.addEventListener('change', () => { readFields(); persist() })
      } else {
        // desktop: main keeps it encrypted, bound to this URL; the field
        // only ever sends a new one and is emptied once it is stored
        token.title = t('Sent to the icon server as a Bearer token. Stored encrypted by the operating system for this server URL — never shown again, never saved into a document.')
        const forget = el('button', 'ed-btn', t('Remove stored token'))
        forget.type = 'button'
        // .ed-btn sets display, which beats the hidden attribute
        forget.style.display = 'none'
        tokenField.after(forget)
        const paintToken = async () => {
          const stored = !!(await iconTokenStatus([src]))[src.id]
          token.placeholder = stored ? t('A token is stored — type to replace it') : t('API token (optional)')
          forget.style.display = stored ? '' : 'none'
        }
        storeToken = async () => {
          const v = token.value.trim()
          if (!v) return
          const r = await desktop.setIconToken(src.id, src.url, v).catch(() => ({ ok: false, error: undefined as string | undefined }))
          if (r.ok) token.value = ''
          else deps.toast(r.error ?? t('Could not store the token'))
          await paintToken()
        }
        readFields = () => { src.url = url.value.trim(); name.placeholder = src.url ? hostOf(src.url) : t('Icon server') }
        url.addEventListener('change', () => { readFields(); persist(); void paintToken() })
        token.addEventListener('change', () => { readFields(); persist(); void storeToken() })
        forget.addEventListener('click', async () => {
          await desktop.setIconToken(src.id, src.url, null).catch(() => { /* stays */ })
          await paintToken()
        })
        void paintToken()
      }
      if (!src.url) queueMicrotask(() => { if (root.isConnected && list.at(-1) === src && !src.name) url.focus() })
    } else {
      const status = el('span', 'ed-isrc-folder')
      const refresh = async () => {
        const handle = await loadIconFolderHandle(src.id)
        status.textContent = handle ? t('Folder: {name}', { name: handle.name }) : t('No folder chosen')
        change.textContent = handle ? t('Change folder…') : t('Choose folder…')
      }
      const change = el('button', 'ed-btn', t('Choose folder…'))
      change.type = 'button'
      change.addEventListener('click', async () => {
        const handle = await pickIconFolder(src.id)
        if (!handle) { if (!canPickIconFolder()) deps.toast(t("This browser can't pick a folder (no File System Access API)")); return }
        if (!src.name) { src.name = handle.name; name.value = handle.name }
        persist()
        await refresh()
      })
      body.append(status, change)
      void refresh()
    }

    // what the person says about everything this source serves; stamped onto
    // each icon inserted from it, and what `unlicensed-artwork` looks for
    const license = el('input')
    license.type = 'text'
    license.maxLength = MAX_LICENSE
    license.placeholder = t('License of these icons (optional)')
    license.title = t('Saved with every icon you insert from here, so the deck records the terms it may be used under. Leave blank if unknown.')
    license.value = src.license ?? ''
    license.spellcheck = false
    license.addEventListener('change', () => {
      const v = license.value.trim()
      if (v) src.license = v
      else delete src.license
      persist()
    })
    body.append(field(t('License of these icons (optional)'), license))

    const result = el('div', 'ed-isrc-result')
    result.setAttribute('role', 'status')

    test.addEventListener('click', async () => {
      readFields()
      persist()
      test.disabled = true
      await storeToken()
      result.className = 'ed-isrc-result'
      result.textContent = t('Testing…')
      const r = await testIconSource(src)
      result.className = 'ed-isrc-result ' + (r.ok ? 'ok' : 'bad')
      result.textContent = (r.ok ? '✓ ' : '✗ ') + r.message
      test.disabled = false
    })
    remove.addEventListener('click', async () => {
      if (!confirm(t('Remove the icon source “{name}”?', { name: iconSourceLabel(src) }))) return
      if (src.kind === 'folder') await clearIconFolderHandle(src.id)
      list = list.filter((s) => s.id !== src.id)
      persist()
      render()
    })

    root.append(head, body, result)
    return root
  }

  const render = () => {
    listEl.replaceChildren(...(list.length ? list.map(card) : [el('p', 'ed-isrc-empty', t('No icon sources yet — add a server or a folder.'))]))
  }

  const addServer = el('button', 'ed-btn')
  addServer.type = 'button'
  addServer.innerHTML = `${ICONS.plus}<span></span>`
  addServer.querySelector('span')!.textContent = t('Add icon server')
  addServer.addEventListener('click', () => {
    list = [...list, { id: newIconSourceId(), kind: 'server', name: '', enabled: true, url: '', token: '' }]
    persist()
    render()
  })
  const addFolder = el('button', 'ed-btn')
  addFolder.type = 'button'
  addFolder.innerHTML = `${ICONS.plus}<span></span>`
  addFolder.querySelector('span')!.textContent = t('Add local folder…')
  addFolder.addEventListener('click', async () => {
    const id = newIconSourceId()
    const handle = await pickIconFolder(id)
    if (!handle) { if (!canPickIconFolder()) deps.toast(t("This browser can't pick a folder (no File System Access API)")); return }
    list = [...list, { id, kind: 'folder', name: handle.name, enabled: true }]
    persist()
    render()
  })
  addRow.append(addServer, addFolder)

  render()
}
