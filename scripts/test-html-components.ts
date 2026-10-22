#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slide_html components: every kind the expander knows is documented where an
// agent looks (the tool's help, agents.md, the build-deck skill, the Code Mode
// instructions), and nothing documents a kind it does not know.
//
//   node scripts/test-html-components.ts
//
// What the components DO is checked in a browser: scripts/test-slide-html-e2e.mjs.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPONENTS } from '../slides/src/htmlcomponents.ts'

const root = join(import.meta.dirname, '..')
let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const kinds = Object.keys(COMPONENTS)
const docs = {
  'slide_html help (agentops/spec.ts)': readFileSync(join(root, 'slides/src/agentops/spec.ts'), 'utf8'),
  'docs/agents.md': readFileSync(join(root, 'docs/agents.md'), 'utf8'),
  'build-deck skill': readFileSync(join(root, 'desktop/src/main/apichat/skills/build-deck.md'), 'utf8'),
  'Code Mode instructions': readFileSync(join(root, 'desktop/src/mcp/slides-mcp-server.mjs'), 'utf8'),
}
for (const [where, text] of Object.entries(docs)) {
  const missing = kinds.filter((k) => !new RegExp(`\\b${k}\\b`).test(text))
  ok(!missing.length, `${where} names every component${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
}
// a kind named in a data-component="…" example must exist
for (const [where, text] of Object.entries(docs)) {
  const named = [...text.matchAll(/data-component=\\?"([a-z|]+)\\?"/g)].flatMap((m) => m[1].split('|'))
  const unknown = named.filter((k) => !kinds.includes(k))
  ok(!unknown.length, `${where}: examples use known kinds only${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
