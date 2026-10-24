#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The "allow this outside app?" question (desktop/src/main/agentconsent.ts):
// the app's name as shown and remembered, the box in the renderer's words or
// English, and the remembered list.
//
//   node scripts/test-agent-consent.ts
import { clientLabel, consentBox, consentStrings, isAllowedClient, MAX_ALLOWED_CLIENTS, rememberClient } from '../desktop/src/main/agentconsent.ts'

let failed = 0
const ok = (cond: boolean, msg: string): void => { if (cond) console.log(`  ok  ${msg}`); else { failed++; console.log(`FAIL  ${msg}`) } }

console.log('the app\'s name')
ok(clientLabel('claude-code') === 'Claude Code', 'claude-code reads as Claude Code')
ok(clientLabel('Cursor') === 'Cursor', 'a known name, any case')
ok(clientLabel('my-agent') === 'my-agent', 'an unknown name as it came')
ok(clientLabel('mcp') === 'An AI app' && clientLabel('') === 'An AI app' && clientLabel(42) === 'An AI app', 'no name (or the server\'s default) → "An AI app"')
ok(clientLabel('evil\nname\u0007') === 'evilname', 'control characters are dropped (the name is shown in a native box)')
ok(clientLabel('x'.repeat(200)).length === 60, 'at most 60 characters')

console.log('the box')
const en = consentBox({}, 'Claude Code')
ok(en.message === '“Claude Code” wants to work on your open decks' && en.buttons[0] === 'Allow' && en.buttons[1] === 'Don’t Allow', 'English without the renderer\'s words')
ok(/Settings ▸ AI chat ▸ Advanced/.test(en.detail), 'it says where to take it back')
const de = consentBox(consentStrings({ message: '„{client}“ möchte …', allow: 'Erlauben', deny: 'Nicht erlauben', detail: 'D' }), 'Cursor')
ok(de.message === '„Cursor“ möchte …' && de.buttons[0] === 'Erlauben' && de.detail === 'D', 'the renderer\'s translation, {client} filled in')
const bad = consentStrings({ message: 42, allow: 'x'.repeat(401), deny: '' })
ok(Object.keys(bad).length === 0, 'non-strings, empty and over-long values are ignored')

console.log('remembered apps')
ok(!isAllowedClient(undefined, 'Cursor') && !isAllowedClient(['Zed'], 'Cursor') && isAllowedClient(['Cursor'], 'Cursor'), 'allowed only when on the list')
ok(JSON.stringify(rememberClient(['A', 'B'], 'A')) === '["B","A"]', 'no duplicates, newest last')
ok(JSON.stringify(rememberClient('junk', 'A')) === '["A"]' && JSON.stringify(rememberClient([1, 'B'], 'A')) === '["B","A"]', 'a damaged stored list is cleaned')
const many = rememberClient(Array.from({ length: 30 }, (_, i) => `app${i}`), 'new')
ok(many.length === MAX_ALLOWED_CLIENTS && many[many.length - 1] === 'new' && !many.includes('app0'), `at most ${MAX_ALLOWED_CLIENTS}; the oldest drops out`)

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall agent consent checks passed')
