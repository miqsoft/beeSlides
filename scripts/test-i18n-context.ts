#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Context-specific translations in the kernel's t() (gettext msgctxt).
//
//   node scripts/test-i18n-context.ts
//
// WHAT THIS PROVES. One English word can need two translations: the find bar's
// "Replace" is ja 置換, the replace-file dialog's "Replace" is 置き換える.
// `t(en, vars, context)` looks up the catalog key "{en} ({context})" first,
// then the plain `en` translation, then `en` itself — never the key. Both
// catalog shapes (plain and packed) behave the same, placeholders still
// interpolate, and the pseudo locale accents the English word, not the key.

import { registerI18n, setLocale, t, contextKey } from '../kernel/src/i18n.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const eq = (got: string, want: string, msg: string) =>
  ok(got === want, `${msg}${got === want ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)

const choices = [{ code: 'en', label: 'English' }, { code: 'ja', label: '日本語' }, { code: 'de', label: 'Deutsch' }]

eq(contextKey('Replace', 'find bar'), 'Replace (find bar)', 'key format is "{en} ({context})" (existing catalog keys keep working)')

function scenario(label: string, register: () => void) {
  console.log(`\n${label}`)
  register()
  setLocale('ja')
  eq(t('Replace', null, 'find bar'), '置換', 'ja: context key wins')
  eq(t('Replace'), '置き換える', 'ja: no context → plain translation')
  eq(t('Replace', undefined, 'unknown place'), '置き換える', 'ja: unknown context → plain translation, not the key')
  eq(t('Untranslated', undefined, 'find bar'), 'Untranslated', 'ja: nothing translated → English word, not the key')
  eq(t('{n} found', { n: 3 }, 'find bar'), '3 件 (検索)', 'ja: placeholders interpolate into the context translation')
  eq(t('{n} found', { n: 3 }), '3 件', 'ja: placeholders on the plain translation')
  setLocale('de')
  eq(t('Replace', null, 'find bar'), 'Ersetzen', 'de: catalog without the context key → plain translation')
  setLocale('en')
  eq(t('Replace', null, 'find bar'), 'Replace', 'en: bare word, never the key')
  setLocale('x-pseudo')
  const p = t('Replace', null, 'find bar')
  ok(p.startsWith('⟦') && !p.includes('find bar') && !p.includes('置'), `pseudo: accents the English word only (${p})`)
  setLocale('en')
}

scenario('plain catalogs', () => registerI18n({
  catalogs: {
    ja: { 'Replace': '置き換える', 'Replace (find bar)': '置換', '{n} found': '{n} 件', '{n} found (find bar)': '{n} 件 (検索)' },
    de: { 'Replace': 'Ersetzen' },
  },
  choices,
}))

scenario('packed catalogs', () => registerI18n({
  packed: {
    locales: ['ja', 'de'],
    table: {
      'Replace': ['置き換える', 'Ersetzen'],
      'Replace (find bar)': ['置換', 0],
      '{n} found': ['{n} 件'],
      '{n} found (find bar)': ['{n} 件 (検索)'],
    },
  },
  choices,
}))

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
