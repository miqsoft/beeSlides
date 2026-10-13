// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Document properties ▸ Language & terms: the document's language
// (`doc.meta.language`) and the translated-terms table (`doc.terms`) that
// `{{term:Name}}` reads. A template carries the table ("Page" | "Seite"), a
// deck made from it picks a column. Writes nothing for a default, so a deck
// that never touches this carries neither field.

import type { SlidomingoDoc } from '../model'
import { docLanguage, renameTermRefs } from '../model'
import type { Store } from '../store'
import { locale, t } from '../i18n'

type Terms = NonNullable<SlidomingoDoc['terms']>

/** Offered in the pickers before any table exists; any BCP-47 code can be typed. */
const COMMON_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'ja', 'zh-Hans', 'zh-Hant']

/** A language's name in the UI language ("Deutsch" → "German" for an English UI). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([locale()], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** A typed code as BCP-47 (`DE` → `de`, `en_gb` → `en-GB`), or null if it is not one. */
function canonicalCode(raw: string): string | null {
  try {
    return Intl.getCanonicalLocales(raw.trim().replace(/_/g, '-'))[0] ?? null
  } catch {
    return null
  }
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function button(label: string, cls = 'ed-btn'): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  return b
}

/** A deck's view of its layout's terms: plain text, the active column marked. */
function readOnlyTable(terms: Terms, active: string | undefined): HTMLTableElement {
  const table = document.createElement('table')
  table.className = 'ed-doclang-table ed-doclang-readonly'
  const row = (cells: string[], tag: 'th' | 'td', mark?: (i: number) => boolean) => {
    const tr = document.createElement('tr')
    cells.forEach((text, i) => {
      const c = document.createElement(tag)
      c.textContent = text
      if (mark?.(i)) c.classList.add('ed-doclang-active')
      tr.appendChild(c)
    })
    table.appendChild(tr)
  }
  const isActive = (i: number) => i > 0 && terms.languages[i - 1] === active
  row([t('Term'), ...terms.languages.map(languageName)], 'th', isActive)
  for (const e of terms.entries) row([e.name, ...terms.languages.map((l) => e.text[l] ?? '—')], 'td', isActive)
  return table
}

/** The Language row + the terms table, appended to `host`. Refills itself on 'doc'. */
export function renderDocLanguage(host: HTMLElement, store: Store): void {
  const title = document.createElement('div')
  title.className = 'ed-about-h'
  title.textContent = t('Language & terms')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  const box = div('ed-doclang')
  host.append(title, hint, box)

  const commitTerms = (mut: (terms: Terms) => void) => store.commit(() => {
    const next: Terms = store.doc.terms
      ? { languages: [...store.doc.terms.languages], entries: store.doc.terms.entries.map((e) => ({ name: e.name, text: { ...e.text } })) }
      : { languages: [], entries: [] }
    mut(next)
    if (next.languages.length || next.entries.length) store.doc.terms = next
    else delete store.doc.terms
  })

  const fill = () => {
    box.replaceChildren()
    const terms = store.doc.terms
    const langs = terms?.languages ?? []
    // The table belongs to the TEMPLATE (a layout file, edited in its
    // template window); a deck only picks one of its languages.
    const editable = store.doc.template === true
    hint.textContent = editable
      ? t('Words this layout’s slide types show in more than one language — “Page” | “Seite”. On a slide type, select a word and choose Make translatable. A deck made from this layout picks its language and every term follows; Language below is the one new decks start in.')
      : langs.length
        ? t('The language this deck is written in. The words below come from its layout and switch with it — dates too. They are edited in the layout.')
        : t('The language this deck is written in — dates follow it. Translated words come from a layout that defines them.')

    // Language picker: "Automatic" = the table's first language (or the viewer's, for dates)
    const row = div('ed-about-meta ed-doclang-row')
    const label = document.createElement('label')
    label.textContent = t('Language')
    const sel = document.createElement('select')
    sel.className = 'ed-doclang-select'
    const auto = document.createElement('option')
    auto.value = ''
    auto.textContent = langs.length
      ? t('Automatic ({language})', { language: languageName(langs[0]) })
      : t('Automatic (the reader’s)')
    sel.appendChild(auto)
    const current = store.doc.meta?.language ?? ''
    // with a table: exactly its languages (the template decides); without,
    // the choice only formats dates, so any language goes
    const offered = langs.length ? [...langs] : [...COMMON_LANGUAGES]
    if (current && !offered.includes(current)) offered.push(current)
    for (const code of offered) {
      const o = document.createElement('option')
      o.value = code
      o.textContent = langs.length && !langs.includes(code) ? t('{language} (no terms)', { language: languageName(code) }) : languageName(code)
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => {
      store.commit(() => {
        const meta = (store.doc.meta ??= {})
        if (sel.value) meta.language = sel.value
        else delete meta.language
      })
      refresh()
    })
    label.htmlFor = sel.id = 'ed-doclang-select'
    row.append(label, sel)
    box.appendChild(row)

    if (!editable) {
      if (terms?.entries.length) box.appendChild(readOnlyTable(terms, docLanguage(store.doc)))
      return
    }

    // Terms table: one column per language
    const table = document.createElement('table')
    table.className = 'ed-doclang-table'
    const head = document.createElement('tr')
    const th = (text: string) => { const c = document.createElement('th'); c.textContent = text; return c }
    head.appendChild(th(t('Term')))
    const active = docLanguage(store.doc)
    for (const code of langs) {
      const c = th(languageName(code))
      c.title = code
      if (code === active) c.classList.add('ed-doclang-active')
      const del = button('✕', 'ed-btn ed-btn-icon ed-doclang-del')
      del.title = t('Remove this language and its translations')
      del.addEventListener('click', () => commitTerms((tm) => {
        tm.languages = tm.languages.filter((l) => l !== code)
        for (const e of tm.entries) delete e.text[code]
      }))
      c.appendChild(del)
      head.appendChild(c)
    }
    head.appendChild(th(''))
    table.appendChild(head)

    // Handlers find their row by INDEX and read the current name then: a
    // name edit commits on Tab, and the table is not rebuilt under the
    // cursor (see below), so a closed-over name could be stale.
    const entryAt = (tm: Terms | undefined, i: number) => tm?.entries[i]
    for (const [i, entry] of (terms?.entries ?? []).entries()) {
      const tr = document.createElement('tr')
      const nameCell = document.createElement('td')
      const n = document.createElement('input')
      n.type = 'text'
      n.value = entry.name
      n.className = 'ed-doclang-name'
      n.setAttribute('aria-label', t('Term name'))
      n.title = t('Type {token} in a text box to show it', { token: `{{term:${entry.name}}}` })
      n.addEventListener('change', () => {
        const old = entryAt(store.doc.terms, i)?.name
        const next = n.value.trim().replace(/[{}]/g, '')
        if (old === undefined || !next || next === old || store.doc.terms?.entries.some((e) => e.name === next)) { n.value = old ?? ''; return }
        commitTerms((tm) => {
          entryAt(tm, i)!.name = next
          renameTermRefs(store.doc, old, next)
        })
      })
      nameCell.appendChild(n)
      tr.appendChild(nameCell)
      for (const code of langs) {
        const td = document.createElement('td')
        const v = document.createElement('input')
        v.type = 'text'
        v.value = entry.text[code] ?? ''
        v.placeholder = entry.text[langs[0]] ?? entry.name
        v.setAttribute('aria-label', `${entry.name} — ${languageName(code)}`)
        v.addEventListener('change', () => commitTerms((tm) => {
          const e = entryAt(tm, i)
          if (!e) return
          if (v.value) e.text[code] = v.value
          else delete e.text[code]
        }))
        td.appendChild(v)
        tr.appendChild(td)
      }
      const delCell = document.createElement('td')
      const del = button('✕', 'ed-btn ed-btn-icon')
      del.title = t('Remove this term')
      del.addEventListener('click', () => commitTerms((tm) => { tm.entries.splice(i, 1) }))
      delCell.appendChild(del)
      tr.appendChild(delCell)
      table.appendChild(tr)
    }
    if (langs.length || terms?.entries.length) box.appendChild(table)

    // Add a term / add a language
    const actions = div('ed-doclang-actions')
    const addTerm = button(t('＋ Add term'))
    addTerm.addEventListener('click', () => {
      const existing = new Set((store.doc.terms?.entries ?? []).map((e) => e.name))
      let name = t('Term')
      for (let i = 2; existing.has(name); i++) name = `${t('Term')} ${i}`
      commitTerms((tm) => {
        // a table with no language yet starts with the document's (or the UI's)
        if (!tm.languages.length) tm.languages.push(canonicalCode(store.doc.meta?.language ?? '') ?? canonicalCode(locale()) ?? 'en')
        tm.entries.push({ name, text: {} })
      })
      refresh()
      box.querySelector<HTMLInputElement>('.ed-doclang-table tr:last-child .ed-doclang-name')?.select()
    })
    const langInput = document.createElement('input')
    langInput.type = 'text'
    langInput.className = 'ed-doclang-addlang'
    langInput.placeholder = t('Language code, e.g. de')
    langInput.setAttribute('aria-label', t('Language to add'))
    const list = document.createElement('datalist')
    list.id = 'ed-doclang-codes'
    for (const code of COMMON_LANGUAGES.filter((c) => !langs.includes(c))) {
      const o = document.createElement('option')
      o.value = code
      o.label = languageName(code)
      list.appendChild(o)
    }
    langInput.setAttribute('list', list.id)
    const addLang = button(t('＋ Add language'))
    const doAddLang = () => {
      const code = canonicalCode(langInput.value)
      if (!code) { langInput.setCustomValidity(t('Not a language code')); langInput.reportValidity(); return }
      langInput.setCustomValidity('')
      if (langs.includes(code)) { langInput.value = ''; return }
      commitTerms((tm) => { tm.languages.push(code) })
      refresh()
      box.querySelector<HTMLInputElement>('.ed-doclang-addlang')?.focus()
    }
    addLang.addEventListener('click', doAddLang)
    langInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doAddLang() } })
    langInput.addEventListener('input', () => langInput.setCustomValidity(''))
    actions.append(addTerm, langInput, list, addLang)
    box.appendChild(actions)
  }
  const sigOf = () => JSON.stringify([store.doc.terms ?? null, store.doc.meta?.language ?? ''])
  let sig = ''
  let stale = false
  function refresh() { sig = sigOf(); stale = false; fill() }
  refresh()
  // Not rebuilt while a text field in it has focus: an edit commits on Tab,
  // and a rebuild then would drop the focus the Tab just moved. It catches
  // up when focus leaves the box.
  const typing = () => document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' && box.contains(document.activeElement)
  box.addEventListener('focusout', (ev) => {
    if (stale && !box.contains(ev.relatedTarget as Node | null)) refresh()
  })
  const off = store.on('doc', () => {
    if (!box.isConnected) { off?.(); return }
    if (sigOf() === sig) return
    // a Tab commits from inside the blur, while activeElement is <body>:
    // look once the focus has landed
    setTimeout(() => {
      if (!box.isConnected || sigOf() === sig) return
      if (typing()) stale = true
      else refresh()
    })
  })
}

/** The Layout Manager's "Preview: EN | DE" switch: renders {{term:…}} and
 *  dates on the slide types in another of the table's languages, so a
 *  template author sees that "Seite 12 von 140" still fits. Editor state
 *  only (`store.termPreview`), never saved. Hidden with fewer than two
 *  languages; follows table edits by itself. `onChange` repaints what the
 *  canvas's 'current' event does not (the type tree's thumbnails). */
export function buildTermPreview(store: Store, onChange: () => void): HTMLElement {
  const wrap = div('ed-termpreview')
  wrap.setAttribute('role', 'group')
  wrap.setAttribute('aria-label', t('Preview language'))
  const fill = () => {
    wrap.replaceChildren()
    const langs = store.doc.terms?.languages ?? []
    if (store.termPreview && !langs.includes(store.termPreview)) store.termPreview = null
    wrap.hidden = langs.length < 2
    if (wrap.hidden) return
    const label = document.createElement('span')
    label.className = 'ed-termpreview-label'
    label.textContent = t('Preview')
    wrap.appendChild(label)
    const shown = store.termPreview ?? docLanguage(store.doc)
    for (const code of langs) {
      const b = button(code.toUpperCase(), 'ed-btn ed-termpreview-btn')
      b.title = t('Show the terms in {language}', { language: languageName(code) })
      b.setAttribute('aria-pressed', String(code === shown))
      b.addEventListener('click', () => {
        store.termPreview = code === docLanguage(store.doc) ? null : code
        fill()
        store.emit('current') // re-render the canvas without touching the doc
        onChange()
      })
      wrap.appendChild(b)
    }
  }
  fill()
  const sigOf = () => JSON.stringify([store.doc.terms?.languages ?? [], docLanguage(store.doc) ?? ''])
  let sig = sigOf()
  const off = store.on('doc', () => {
    if (!wrap.isConnected) { off(); return }
    const next = sigOf()
    if (next !== sig) { sig = next; fill() }
  })
  return wrap
}
