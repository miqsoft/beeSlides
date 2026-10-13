#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Writes the bench's fixture decks (./fixtures/*.json) — deterministic ids and
// positions, so every checkout is measured on byte-identical input. The JSON
// files are committed; rerun this only to change a fixture on purpose
// (results before and after such a change are not comparable).
//
//   node desktop/scripts/bench/make-fixtures.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FONT = 'Arial, Helvetica, sans-serif'
const INK = '#2B2B2B'
const ACCENT = '#1F6FB2'

function doc(title, slides) {
  return {
    format: 'slidomingo/slides',
    version: 1,
    // a fixed uuid per title: parseDoc wants a uuid-shaped docId
    docId: `be0c0000-0000-4000-8000-${createHash('sha1').update(title).digest('hex').slice(0, 12)}`,
    title,
    size: { width: 1280, height: 720 },
    theme: { background: '#FFFFFF', color: INK, accent: ACCENT, fontFamily: FONT },
    slides,
    modified: '2026-10-11T10:00:00.000Z',
  }
}
const slide = (id, name, elements, extra = {}) => ({ id, name, background: '#FFFFFF', transition: 'fade', elements, notes: '', ...extra })
const base = (id, x, y, w, h, extra = {}) => ({ id, x, y, w, h, rotation: 0, opacity: 1, ...extra })
const rect = (id, x, y, w, h, fill, extra = {}) => ({ ...base(id, x, y, w, h), type: 'shape', shape: 'rect', fill, stroke: '#C9D6E3', strokeWidth: 1, radius: 8, ...extra })
const text = (id, x, y, w, h, html, extra = {}) => ({
  ...base(id, x, y, w, h), type: 'text', html, fontSize: 16, fontFamily: FONT, fontWeight: 400, color: INK,
  align: 'left', valign: 'top', lineHeight: 1.25, ...extra,
})
const title = (id, s) => text(id, 64, 32, 1152, 56, s, { role: 'title', fontSize: 32, fontWeight: 700, valign: 'middle' })

/** A card = background rect + title + body, grouped (click selects the card). */
function card(key, x, y, w, h, heading, body, opts = {}) {
  const g = { groupId: `grp-${key}` }
  return [
    rect(`${key}-bg`, x, y, w, h, opts.fill ?? '#EEF3F8', g),
    text(`${key}-title`, x + 12, y + 12, w - 24, 24, heading, { fontSize: opts.titleSize ?? 17, fontWeight: 700, color: opts.titleColor ?? INK, ...g }),
    text(`${key}-body`, x + 12, y + 44, w - 24, h - 56, body, { fontSize: opts.bodySize ?? 13, color: '#4A4A4A', ...g }),
  ]
}

const AP = [
  ['AP 11.1', '✓ Anforderungsanalyse abgeschlossen'],
  ['AP 11.2', '✓ Prototype evaluated with 3 pilot users'],
  ['AP 11.3', '✓ Datenmodell finalisiert'],
  ['AP 11.4', '◐ CI pipeline migrated, tests green'],
  ['AP 11.5', '◐ Schnittstellen dokumentiert'],
  ['AP 11.6', '○ Security review not started'],
  ['AP 11.7', '○ Rollout-Plan in Abstimmung'],
]
const legend = () => text('legend', 66, 318, 520, 22, '✓ erledigt &nbsp;·&nbsp; ◐ in Arbeit &nbsp;·&nbsp; ○ offen', { fontSize: 12, color: '#6B6B6B' })

/** The 7 AP cards, evenly laid out (or jittered). */
function apCards(jitter = null) {
  const w = 152, gap = 14, x0 = 66, y0 = 112, h = 190
  return AP.flatMap(([t, b], i) => {
    const j = jitter?.[i] ?? [0, 0, 0]
    return card(`ap${i + 1}`, x0 + i * (w + gap) + j[0], y0 + j[1], w + j[2], h, t, b)
  })
}

const fixtures = {}

// 1. The user's real case: an area comment over the lower third.
fixtures['comment-delete-rebalance'] = doc('Projektstatus AP 11', [
  slide('s-status', 'Status and next steps', [
    title('title', 'Status and next steps'),
    ...apCards(),
    legend(),
    ...card('fin', 240, 500, 300, 90, 'Finale Zahlen', 'Kennzahlen Q3 konsolidiert', { fill: '#FFF4E0' }),
    ...card('report', 740, 500, 300, 90, 'Abschlussbericht', 'Entwurf bis KW 46', { fill: '#FFF4E0' }),
    { ...base('arrow-fin-report', 540, 535, 200, 20), type: 'shape', shape: 'line', fill: '#6B6B6B', stroke: '#6B6B6B', strokeWidth: 3, radius: 0, lineEnd: 'arrow', from: { el: 'fin-bg', side: 'right' }, to: { el: 'report-bg', side: 'left' } },
    rect('summary-bar', 64, 624, 1152, 56, ACCENT, { stroke: ACCENT, radius: 6 }),
    text('summary-text', 84, 632, 1112, 40, 'Zusammenfassung: Projekt im Plan — Abschluss Q4 2026', { fontSize: 18, fontWeight: 700, color: '#FFFFFF', valign: 'middle' }),
  ], {
    comments: [{
      id: 'c-area-lower', x: 40, y: 470, w: 1200, h: 230, author: '',
      text: 'Das hier bitte entfernen', at: '2026-10-11T10:00:00.000Z', forAgent: true,
    }],
  }),
])

// 2. Same cards, hand-jittered: x/y off by 3–15px, uneven gaps, one wider card.
fixtures['realign-cards'] = doc('Projektstatus AP 11', [
  slide('s-status', 'Status and next steps', [
    title('title', 'Status and next steps'),
    ...apCards([[0, 0, 0], [6, 9, 0], [-4, -3, 0], [11, 14, 12], [5, 4, 0], [-3, 11, 0], [8, -5, 0]]),
    legend(),
  ]),
])

// 3. Six boxes scattered over the slide.
const SERVICES = [
  ['Beratung', 'Workshops & Konzeption'], ['Entwicklung', 'Custom software, agile'], ['Testing', 'Automatisierte Tests'],
  ['Betrieb', '24/7 operations'], ['Schulung', 'Trainings vor Ort'], ['Support', 'Ticketing & hotline'],
]
const SCATTER = [[90, 130, 230, 120], [470, 170, 210, 110], [860, 118, 250, 130], [150, 420, 220, 125], [560, 470, 240, 105], [930, 390, 200, 140]]
fixtures['grid-2x3'] = doc('Leistungsportfolio', [
  slide('s-services', 'Unsere Services', [
    title('title', 'Unsere Services'),
    ...SERVICES.flatMap(([t, b], i) => card(`svc${i + 1}`, ...SCATTER[i], t, b)),
  ]),
])

// 4. Content crammed into the top 45 %.
fixtures['fill-space'] = doc('Quartalsbericht', [
  slide('s-kpis', 'Kennzahlen Q3', [
    title('title', 'Kennzahlen Q3'),
    ...card('kpi1', 64, 104, 270, 110, 'Umsatz', '+12 % ggü. Vorjahr'),
    ...card('kpi2', 350, 104, 270, 110, 'Kunden', '1.240 active accounts'),
    ...card('kpi3', 636, 104, 270, 110, 'Churn', '2,1 % (Ziel: < 3 %)'),
    ...card('kpi4', 922, 104, 270, 110, 'NPS', '47, up from 39'),
    text('note', 64, 228, 800, 60, 'Alle Zahlen vorläufig, finaler Abschluss folgt nach dem Audit. Figures exclude the Benelux pilot.', { fontSize: 14, color: '#4A4A4A' }),
  ]),
])

// 5. Six cards whose titles get restyled.
const TEAMS = [
  ['Frontend', 'React, Design-System'], ['Backend', 'APIs & Datenbanken'], ['DevOps', 'CI/CD, monitoring'],
  ['QA', 'Testautomatisierung'], ['Data', 'Analytics & reporting'], ['Security', 'Pentests, Audits'],
]
fixtures['recolor-titles'] = doc('Teamstruktur', [
  slide('s-teams', 'Teams', [
    title('title', 'Teams und Verantwortlichkeiten'),
    ...TEAMS.flatMap(([t, b], i) => card(`team${i + 1}`, 64 + (i % 3) * 392, 120 + Math.floor(i / 3) * 280, 368, 250, t, b, { titleSize: 20, bodySize: 15 })),
  ]),
])

// 6. Content plus three grey sticky notes on top of it.
const note = (key, x, y, rot, s) => {
  const g = { groupId: `grp-${key}` }
  return [
    rect(`${key}-bg`, x, y, 180, 120, '#D9D9D9', { stroke: '#BDBDBD', radius: 2, rotation: rot, shadow: { x: 2, y: 3, blur: 6, color: 'rgba(0,0,0,0.25)' }, ...g }),
    text(`${key}-text`, x + 12, y + 12, 156, 96, s, { fontSize: 15, color: '#333333', rotation: rot, ...g }),
  ]
}
fixtures['delete-notes'] = doc('Roadmap 2027', [
  slide('s-roadmap', 'Roadmap', [
    title('title', 'Roadmap 2027'),
    text('bullets', 64, 120, 560, 400, '<ul><li>Q1: Migration der Build-Infrastruktur</li><li>Q2: New onboarding flow</li><li>Q3: Mandantenfähigkeit</li><li>Q4: Public API v2</li></ul>', { fontSize: 22, lineHeight: 1.5, role: 'body' }),
    rect('visual', 680, 120, 536, 400, '#E8EEF5', { stroke: '#C9D6E3' }),
    text('visual-caption', 700, 290, 496, 60, 'Timeline-Grafik', { fontSize: 20, color: '#7A8A9A', align: 'center', valign: 'middle' }),
    ...note('note1', 420, 140, -3, 'TODO: Zahlen prüfen'),
    ...note('note2', 980, 450, 2, 'Quelle?'),
    ...note('note3', 140, 520, -1, 'Grafik ersetzen (Lisa)'),
  ]),
])

// 7. Empty one-slide deck.
fixtures['create-deck'] = doc('Untitled', [slide('s-1', undefined, [])])
delete fixtures['create-deck'].slides[0].name

// 8. A small existing deck to extend.
fixtures['add-comparison'] = doc('Build-Server Migration', [
  slide('s-title', 'Titel', [
    text('t-title', 96, 250, 1088, 90, 'Build-Server Migration', { role: 'title', fontSize: 52, fontWeight: 700, align: 'center', valign: 'middle' }),
    text('t-sub', 96, 350, 1088, 40, 'Entscheidungsvorlage · Team Platform · Oktober 2026', { role: 'subtitle', fontSize: 22, color: '#5A5A5A', align: 'center' }),
  ]),
  slide('s-situation', 'Ausgangslage', [
    title('sit-title', 'Ausgangslage'),
    text('sit-body', 64, 120, 1152, 420, '<ul><li>Jenkins 2.3 auf eigener Hardware, Wartung durch 1 Person</li><li>Build times grew to ~40 min per merge request</li><li>Hardware-Garantie läuft 06/2027 aus</li></ul>', { role: 'body', fontSize: 24, lineHeight: 1.5 }),
  ]),
  slide('s-requirements', 'Anforderungen', [
    title('req-title', 'Anforderungen'),
    text('req-body', 64, 120, 1152, 420, '<ul><li>Builds unter 15 Minuten</li><li>Secrets stay on-premise for customer projects</li><li>Kosten max. 2.000 € / Monat</li><li>Self-service für alle Teams</li></ul>', { role: 'body', fontSize: 24, lineHeight: 1.5 }),
  ]),
])

mkdirSync(OUT, { recursive: true })
for (const [name, d] of Object.entries(fixtures)) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(d, null, 1) + '\n')
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${OUT}`)
