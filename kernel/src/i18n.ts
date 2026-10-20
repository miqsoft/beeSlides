// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Internationalization, BeeSlides-sized: a ~1KB t() with English-string-as-key
// (gettext philosophy — the source stays readable, fallback is free), catalogs
// compiled into the bundle (self-containment: nothing is fetched), and locale
// resolution that follows the VIEWER (navigator.language, with a per-browser
// override). Language never enters the document format — a deck authored in
// Tokyo opens with French chrome in Paris.
//
// The ENGINE lives here; the CATALOGS are per-app string data and stay in the
// app (slides/src/i18n/*.ts), registered at boot via registerI18n(). Apps
// import their own ./i18n facade, never this module directly — the facade is
// what guarantees catalogs are registered before the first t().
//
// Locale resolution is LAZY on purpose: it depends on the catalog registry
// (navigator.language only wins if we actually have that catalog), so
// resolving at module scope would run against an empty registry and silently
// fall everyone back to English. Registration also clears the memo.


import { lsDel, lsGet, lsSet } from './storage.ts'

export type Catalog = Record<string, string>
export interface LocaleChoice { code: string; label: string }

/**
 * Key-once catalog shape. English-string-as-key means the source sentence is
 * the key in EVERY locale, so N catalogs store the same English text N times —
 * and deflate can't dedupe it (32KB window vs catalogs spanning hundreds of
 * KB). Packing stores each key once with translations positional by `locales`;
 * a 0, a short row, or an absent key all mean "fall back to English".
 */
export interface PackedCatalogs {
  locales: readonly string[]
  table: Record<string, ReadonlyArray<string | 0>>
  /** extra locale codes mapping onto a column, e.g. { 'zh-TW': 'zh-Hant' } */
  alias?: Record<string, string>
}

let CATALOGS: Record<string, Catalog> = {}
let PACKED: PackedCatalogs | null = null
/** locale code -> column index in PACKED.table rows */
let COLUMN: Record<string, number> = {}
let CHOICES: LocaleChoice[] = [{ code: 'en', label: 'English' }]

/**
 * Register this app's catalogs + picker choices. Call once, at boot.
 * Takes either `catalogs` (plain per-locale maps) or `packed` (key-once).
 */
export function registerI18n(opts: {
  catalogs?: Record<string, Catalog>
  packed?: PackedCatalogs
  choices: LocaleChoice[]
}): void {
  CATALOGS = opts.catalogs ?? {}
  PACKED = opts.packed ?? null
  COLUMN = {}
  if (PACKED) {
    PACKED.locales.forEach((code, i) => { COLUMN[code] = i })
    for (const [from, to] of Object.entries(PACKED.alias ?? {})) {
      const i = PACKED.locales.indexOf(to)
      if (i >= 0) COLUMN[from] = i
    }
  }
  CHOICES = opts.choices
  current = null // re-resolve: the registry the resolution depends on just changed
}

/** Do we actually carry strings for this locale code? Drives resolve(). */
function hasLocale(code: string): boolean {
  return PACKED ? COLUMN[code] !== undefined : !!CATALOGS[code]
}

/** The translation for `en` in the active locale, or undefined to fall back. */
function lookup(en: string, loc: string): string | undefined {
  if (PACKED) {
    const col = COLUMN[loc]
    if (col === undefined) return undefined
    const hit = PACKED.table[en]?.[col]
    return hit === 0 || hit === undefined ? undefined : hit
  }
  return CATALOGS[loc]?.[en]
}

/** Locales offered in the picker (label in its own language). */
export const localeChoices = (): LocaleChoice[] => CHOICES

/** Accented pseudo-locale (dev builds only): exposes unswept strings and
 *  layouts that break under longer text. */
const pseudo = (s: string): string =>
  '⟦' +
  s.replace(/[a-zA-Z]/g, (c) => {
    const map: Record<string, string> = {
      a: 'à', e: 'ē', i: 'ï', o: 'ő', u: 'ū', c: 'ĉ', n: 'ñ', s: 'š', y: 'ý',
      A: 'Å', E: 'Ê', I: 'Ì', O: 'Ø', U: 'Ü', C: 'Ç', N: 'Ñ', S: 'Š', Y: 'Ÿ',
    }
    return map[c] ?? c
  }) +
  '⟧'

function resolve(): string {
  const saved = lsGet('slidomingo-lang')
  if (saved) return saved
  const nav = navigator.language || 'en'
  if (hasLocale(nav)) return nav
  const base = nav.split('-')[0]
  if (base === 'zh') return 'zh-Hans'
  return hasLocale(base) ? base : 'en'
}

let current: string | null = null

function activeLocale(): string {
  if (current === null) current = resolve()
  return current
}

export const locale = (): string => activeLocale()

/** Persist the override and switch. Callers re-render their own UI. */
export function setLocale(code: string): void {
  if (code === 'en') lsDel('slidomingo-lang')
  else lsSet('slidomingo-lang', code)
  current = code
}

/** The catalog key for `en` in a context: "{en} ({context})". Kept in this
 *  exact shape — catalogs already carry keys like "Replace (find bar)". */
export const contextKey = (en: string, context: string): string => `${en} (${context})`

/**
 * Translate an English source string, then interpolate {placeholders}.
 *
 * `context` is gettext's msgctxt: for an English word that needs a DIFFERENT
 * translation in one place (the find bar's "Replace" → ja 置換, the
 * replace-file dialog's "Replace" → 置き換える). It looks up the key
 * "{en} ({context})" first and falls back to the plain `en` translation, then
 * to `en` itself — so English, and any catalog without the context key, show
 * the bare word, never the key.
 */
export function t(en: string, vars?: Record<string, string | number> | null, context?: string): string {
  const cur = activeLocale()
  let out = cur === 'x-pseudo'
    ? pseudo(en)
    : ((context ? lookup(contextKey(en, context), cur) : undefined) ?? lookup(en, cur) ?? en)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
  }
  return out
}

// dev convenience: window.beeslides.i18n exposes locale switching for testing;
// the pseudo locale is reachable by setLocale('x-pseudo') in any build.
export const i18nApi = { t, locale, setLocale, choices: localeChoices }
