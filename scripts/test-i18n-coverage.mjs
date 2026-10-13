// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Language coverage gate.
//
//     node scripts/test-i18n-coverage.mjs [--quiet]
//
// CORE catalogs (slides/src/i18n/*.ts) are COMPILED INTO EVERY SAVED FILE.
// A missing key there ships as English inside an otherwise translated
// interface, in every deck anyone saves, and cannot be corrected without
// cutting a new release. So core must be 100% — this FAILS the build.
//
// Reads the generated packed.ts for the key universe — the same source
// build-i18n.mjs uses, so this gate and that generator can never disagree.
// Do NOT regex the catalogs: build-i18n.mjs learned that the hard way
// ("a regex over the source silently missed 54 of 650 entries").

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreDir = join(root, 'slides/src/i18n')

const quiet = process.argv.includes('--quiet')

// --- the key universe -------------------------------------------------------
const packedSrc = readFileSync(join(coreDir, 'packed.ts'), 'utf8')
const KEYS = [...packedSrc.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1]))
if (!KEYS.length) {
  console.error('test-i18n-coverage: no keys found in packed.ts — has build-i18n.mjs run?')
  process.exit(1)
}
const LOCALES = JSON.parse(packedSrc.match(/PACKED_LOCALES[^=]*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'))

const pct = (n) => ((n / KEYS.length) * 100).toFixed(1)
const bar = (n) => '█'.repeat(Math.round((n / KEYS.length) * 20)).padEnd(20, '·')

let failed = false

// --- core: must be complete -------------------------------------------------
// Read the packed table rather than the catalogs: a 0 (or a short row) is
// exactly what the runtime treats as "no translation, fall back to English",
// so this measures what a reader actually gets.
const rows = [...packedSrc.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):\s*(\[[\s\S]*?\]),$/gm)]
const coreMissing = Object.fromEntries(LOCALES.map((l) => [l, []]))
for (const [, k, arr] of rows) {
  let vals
  try { vals = JSON.parse(arr) } catch { continue }
  LOCALES.forEach((l, i) => { if (vals.length <= i || vals[i] === 0) coreMissing[l].push(JSON.parse(k)) })
}

if (!quiet) console.log(`\ncore catalogs — shipped in every saved file (${KEYS.length} strings)`)
for (const l of LOCALES) {
  const miss = coreMissing[l]
  const have = KEYS.length - miss.length
  if (!quiet) console.log(`  ${l.padEnd(9)} ${bar(have)} ${String(have).padStart(4)}/${KEYS.length}  ${pct(have)}%`)
  if (miss.length) {
    failed = true
    console.error(`\n  FAIL ${l} is missing ${miss.length} string(s) — core catalogs must be complete:`)
    for (const k of miss.slice(0, 12)) console.error(`    ${JSON.stringify(k)}`)
    if (miss.length > 12) console.error(`    …and ${miss.length - 12} more`)
    console.error(`  Add them to slides/src/i18n/${l}.ts, then: node scripts/build-i18n.mjs\n`)
  }
}

if (!quiet) console.log(`\n  core: ${LOCALES.length} locales, all complete required`)

if (failed) { console.error('language coverage: FAILED\n'); process.exit(1) }
console.log('\nlanguage coverage: OK\n')
