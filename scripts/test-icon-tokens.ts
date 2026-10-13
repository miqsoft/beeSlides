#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Icon-server tokens in the desktop app — the pure half.
//
//   node scripts/test-icon-tokens.ts
//
// WHAT THIS PROVES (desktop/src/main/icontokenscore.ts):
//  1. A token's root is the server URL as typed (origin + path, no trailing
//     slash); anything that is not plain http(s) has none.
//  2. `underRoot` only admits the same origin AND a path at or below the
//     root at a segment boundary — no sibling prefix, no dot-segment escape,
//     no userinfo trick — so main never sends a token anywhere else.
//  3. `stripSourceTokens` takes every token out of a stored source list,
//     reports the ones worth keeping, and leaves a token-free list alone
//     byte for byte (so viewerprefs.ts never echoes an unchanged value).

import { serverRoot, sourceUrl, stripSourceTokens, underRoot } from '../desktop/src/main/icontokenscore.ts'

let failed = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}`, detail ?? '') }
}

console.log('serverRoot')
check('plain https', serverRoot('https://icons.example.org') === 'https://icons.example.org')
check('trailing slashes dropped', serverRoot('https://icons.example.org/lib//') === 'https://icons.example.org/lib')
check('port kept', serverRoot('http://localhost:5050/') === 'http://localhost:5050')
check('whitespace trimmed', serverRoot('  https://a.example/x ') === 'https://a.example/x')
check('no scheme → none', serverRoot('icons.example.org') === null)
check('file: → none', serverRoot('file:///etc') === null)
check('javascript: → none', serverRoot('javascript:alert(1)') === null)
check('userinfo → none', serverRoot('https://user:pw@a.example') === null)
check('not a string → none', serverRoot(42) === null && serverRoot(undefined) === null)

console.log('underRoot')
const root = 'https://a.example/icons'
check('the root itself', underRoot('https://a.example/icons', root))
check('search below it', underRoot('https://a.example/icons/api/search?q=x', root))
check('file below it', underRoot('https://a.example/icons/files/a%2Fb.svg', root))
check('sibling prefix refused', !underRoot('https://a.example/icons-evil/api', root))
check('parent refused', !underRoot('https://a.example/', root))
check('dot segments resolved, then refused', !underRoot('https://a.example/icons/../admin', root))
check('encoded dot segments refused', !underRoot('https://a.example/icons/%2e%2e/admin', root))
check('other host refused', !underRoot('https://b.example/icons/api', root))
check('other scheme refused', !underRoot('http://a.example/icons/api', root))
check('other port refused', !underRoot('https://a.example:8443/icons/api', root))
check('lookalike host refused', !underRoot('https://a.example.evil.org/icons/api', root))
check('userinfo refused', !underRoot('https://x@a.example/icons/api', root))
check('origin-only root admits any path', underRoot('http://localhost:5050/files/x.svg', 'http://localhost:5050'))
check('garbage refused', !underRoot('not a url', root))

console.log('stripSourceTokens')
const legacy = JSON.stringify([
  { id: 'src_a', kind: 'server', name: '', enabled: true, url: 'https://a.example', token: ' secret ' },
  { id: 'src_b', kind: 'server', name: '', enabled: true, url: 'https://b.example', token: '' },
  { id: 'dir', kind: 'folder', name: 'Mine', enabled: true },
  { id: 'bad id!', kind: 'server', url: 'https://c.example', token: 'x' },
])
const s = stripSourceTokens(legacy)
const parsed = JSON.parse(s.value) as Array<Record<string, unknown>>
check('no token key survives', parsed.every((r) => !('token' in r)), s.value)
check('everything else kept', parsed.length === 4 && parsed[2].name === 'Mine' && parsed[0].url === 'https://a.example')
check('non-empty, valid tokens carried (trimmed)', JSON.stringify(s.tokens) === JSON.stringify([{ id: 'src_a', url: 'https://a.example', token: 'secret' }]), s.tokens)
check('ids reported', JSON.stringify(s.ids) === JSON.stringify(['src_a', 'src_b', 'dir', 'bad id!']), s.ids)
const clean = JSON.stringify([{ id: 'src_a', kind: 'server', name: '', enabled: true, url: 'https://a.example' }])
check('token-free list returned byte for byte', stripSourceTokens(clean).value === clean)
check('not JSON passes through', stripSourceTokens('{oops').value === '{oops' && stripSourceTokens('{oops').ids === null)
check('not an array passes through', stripSourceTokens('{"a":1}').value === '{"a":1}')

console.log('sourceUrl')
check('finds a server source', sourceUrl(legacy, 'src_b') === 'https://b.example')
check('a folder has none', sourceUrl(legacy, 'dir') === null)
check('missing list', sourceUrl(undefined, 'src_a') === null)

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall icon-token checks passed')
