// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Wie fliegt eine Biene?" — an eleven-slide explainer that doubles as a tour
// of the format: morph (the cover bee becomes the anatomy bee), an interactive
// state, click builds (step / exitStep / byParagraph), countUp, every generic
// loop (wiggle about a pivot for the wings, pulse, blink, float, spin), marching
// dashes, motion paths (the waggle dance), an equation, a chart, a table, zoom
// tiles and linked sources. Ordinary elements only — everything is editable.
//
// Facts and where they come from (also in the last slide and the notes):
//   230 Hz / ~90° stroke while hovering — Altshuler et al., PNAS 102:18213 (2005)
//   the 1934 "bumblebee can't fly" calculation — Magnan & Sainte-Laguë
//   mosquito > 800 Hz — Bomphrey et al., Nature 544:92 (2017)
//   bumblebee ~180 Hz, Hemaris hawkmoth ~60 Hz — bioRxiv 2025.05.07.652680
//   fruit fly ~200 Hz — Altshuler, quoted by UC ANR Bug Squad (2006)
//   flight muscles need > ~10 °C; ≥ 35 °C at swarm take-off — Heinrich-line
//     studies; Seeley et al., Naturwissenschaften (2003)
//   colony 20 000–80 000 workers; queen 2–5 y; worker 4–6 weeks in summer;
//     drones ~8 weeks — UC ANR / extension material
//   waggle angle = angle to the sun; 2.5 s run ≈ 2 625 m; round dance < 50 m
//     — NC State Extension, "Honey Bee Dance Language"
//   foraging median 1.7 km, 95 % within 6 km — Visscher & Seeley (1982);
//     maximum ~14 km — Frontiers in Ecology and Evolution review (2015)
//   ~15 mph (~24 km/h) — The Hive and the Honey Bee, via UC ANR Bug Squad

const INK = '#2B1D0E'
const HONEY = '#F6B73C'
const AMBER = '#E8902A'
const CREAM = '#FFF8E7'
const PAPER = '#FFFDF6'
const WING = '#E6F4FF'
const WING_EDGE = '#8FBFE0'
const SKY = '#CFE8FF'
const GREY = '#6B5A48'
/** amber/honey for TEXT: #9A5F00 is 4.9:1 on cream (body text), #B86E00 3.8:1 (large numbers) */
const AMBER_TEXT = '#9A5F00'
const HONEY_TEXT = '#B86E00'
const RED = '#D2452B'

let font = 'system-ui, sans-serif'
let seq = 0
const uid = (p) => `${p}-${++seq}`

const base = (o) => ({ rotation: 0, opacity: 1, ...o })
const shape = (kind, o) => base({ type: 'shape', shape: kind, fill: '#000000', stroke: 'none', strokeWidth: 0, ...o, id: o.id ?? uid('s') })
const disc = (cx, cy, w, h, o) => shape('ellipse', { x: cx - w / 2, y: cy - h / 2, w, h, ...o })
const rect = (x, y, w, h, o) => shape('rect', { x, y, w, h, ...o })
/** a line drawn from (x1, y1) to (x2, y2) — a horizontal line shape, rotated */
const line = (x1, y1, x2, y2, o) => {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  return shape('line', { x: cx - len / 2, y: cy - 4, w: len, h: 8, rotation: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI, strokeWidth: 3, fill: INK, ...o })
}
/** a path in its own design box (0 0 dw dh), placed at `frame` */
const motif = (d, [dw, dh], [x, y, w, h], o) => shape('path', { d, pathBox: [0, 0, dw, dh], x, y, w, h, ...o })
const text = (html, x, y, w, h, o = {}) => base({
  type: 'text', html, x, y, w, h, fontSize: 24, fontFamily: font, fontWeight: 400, color: INK,
  align: 'left', valign: 'top', lineHeight: 1.3, ...o, id: o.id ?? uid('t'),
})
const title = (html, o = {}) => text(html, 80, 54, 1100, 76, { id: 'title', role: 'title', fontSize: 50, fontWeight: 800, lineHeight: 1.1, letterSpacing: -0.5, ...o })
const kicker = (s, o = {}) => text(s, 82, 30, 700, 24, { id: 'kicker', fontSize: 14, fontWeight: 700, letterSpacing: 3, color: AMBER_TEXT, ...o })
const slide = (o) => ({ notes: '', transition: 'fade', background: CREAM, ...o })
/** page number from fields: the deck renumbers itself when slides move */
const pageNo = () => text('{{page}} / {{pages}}', 1000, 670, 200, 24, { id: 'pageno', fontSize: 14, color: GREY, align: 'right' })
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace"

const HEX = 'M25 0L75 0L100 43.3L75 86.6L25 86.6L0 43.3Z'
const hex = (cx, cy, size, o) => motif(HEX, [100, 86.6], [cx - size / 2, cy - (size * 0.866) / 2, size, size * 0.866], o)

/**
 * The bee, facing right, centred on its thorax. The SAME ids on every slide
 * it appears on, so Morph carries it from the cover into the anatomy slide.
 * Wings pivot about their root (`origin: 'right'`) — the wiggle is the
 * wingbeat.
 */
function bee(cx, cy, s, { flap = true, dim = 1, hl = null, groups = false } = {}) {
  const op = (part) => (hl && part !== hl ? dim : 1)
  // hover groups (anatomy slide): pointing at a part dims the others
  const GROUP = { head: 'kopf', thorax: 'brust', body: 'brust', abd: 'hinterleib', wings: 'fluegel' }
  const g = (part) => (groups ? { group: GROUP[part] } : {})
  const sc = (v) => v * s
  const wing = (id, rootX, rootY, w, h, rot, amount, cycle) => shape('ellipse', {
    id, x: cx + sc(rootX - w), y: cy + sc(rootY - h / 2), w: sc(w), h: sc(h), rotation: rot,
    fill: WING, stroke: WING_EDGE, strokeWidth: Math.max(1, sc(1.1)), opacity: 0.5 * op('wings'), ...g('wings'),
    ...(flap ? { fx: { loop: { type: 'wiggle', amount, duration: cycle, origin: 'right' } } } : {}),
  })
  return [
    wing('bee-wingB', -2, -26, 92, 34, 26, 6, 0.2),
    line(cx + sc(-12), cy + sc(26), cx + sc(-32), cy + sc(62), { id: 'bee-leg1', strokeWidth: sc(3), opacity: op('body'), ...g('body') }),
    line(cx + sc(4), cy + sc(28), cx + sc(0), cy + sc(66), { id: 'bee-leg2', strokeWidth: sc(3), opacity: op('body'), ...g('body') }),
    line(cx + sc(18), cy + sc(24), cx + sc(34), cy + sc(60), { id: 'bee-leg3', strokeWidth: sc(3), opacity: op('body'), ...g('body') }),
    disc(cx - sc(84), cy + sc(8), sc(122), sc(84), { id: 'bee-abd', fill: HONEY, stroke: INK, strokeWidth: sc(3), rotation: 8, opacity: op('abd'), ...g('abd') }),
    disc(cx - sc(70), cy + sc(8), sc(15), sc(78), { id: 'bee-str1', fill: INK, rotation: 8, opacity: op('abd'), ...g('abd') }),
    disc(cx - sc(102), cy + sc(10), sc(15), sc(66), { id: 'bee-str2', fill: INK, rotation: 8, opacity: op('abd'), ...g('abd') }),
    shape('triangle', { id: 'bee-sting', x: cx - sc(160), y: cy + sc(4), w: sc(16), h: sc(14), rotation: -90, fill: INK, opacity: op('abd'), ...g('abd') }),
    disc(cx, cy, sc(72), sc(64), { id: 'bee-thorax', fill: '#6B4A22', stroke: INK, strokeWidth: sc(3), opacity: op('thorax'), ...g('thorax') }),
    disc(cx + sc(52), cy - sc(2), sc(54), sc(52), { id: 'bee-head', fill: INK, opacity: op('head'), ...g('head') }),
    disc(cx + sc(62), cy - sc(8), sc(17), sc(25), { id: 'bee-eye', fill: '#120B04', stroke: '#4A3A28', strokeWidth: sc(1.5), opacity: op('head'), ...g('head') }),
    disc(cx + sc(65), cy - sc(14), sc(6), sc(6), { id: 'bee-glint', fill: '#FFFFFF', opacity: op('head'), ...g('head') }),
    line(cx + sc(60), cy - sc(24), cx + sc(84), cy - sc(58), { id: 'bee-ant', strokeWidth: sc(3), opacity: op('head'), ...g('head') }),
    wing('bee-wingF', 8, -30, 120, 44, 36, 8, 0.18),
  ]
}

// ——— the slides ————————————————————————————————————————————————————

function cover() {
  const combs = [[1010, 120, 90], [1088, 165, 90], [1088, 75, 90], [1166, 120, 90], [1166, 210, 90], [1244, 165, 90], [1010, 210, 90]]
  return slide({
    id: 'cover', name: 'Titel', background: CREAM,
    notes: 'Die Biene schwebt — genau das, was Honigbienen beim Blütenbesuch tun. Die Flügel sind ganz normale Formen mit einer Wackel-Schleife, deren Drehpunkt an der Flügelwurzel liegt.',
    elements: [
      ...combs.map(([x, y, s], i) => hex(x, y, s, { id: `comb${i}`, fill: HONEY, opacity: 0.18 })),
      motif('M0 260C120 240 160 120 300 140C420 158 400 40 560 70', [560, 260], [430, 300, 560, 260], {
        id: 'trail', fill: 'none', stroke: AMBER, strokeWidth: 3, strokeStyle: 'dashed', opacity: 0.7,
      }),
      ...bee(1010, 380, 1.5),
      text('BIOLOGIE · AERODYNAMIK', 84, 150, 600, 24, { id: 'kicker', fontSize: 15, fontWeight: 700, letterSpacing: 4, color: AMBER_TEXT, fx: { enter: 'fade-up' } }),
      text('Wie fliegt<br>eine Biene?', 80, 186, 700, 220, { id: 'title', role: 'title', fontSize: 96, fontWeight: 900, lineHeight: 1.0, letterSpacing: -2, fx: { enter: 'fade-up', order: 1 } }),
      text('Kleine Flügel, große Physik — in zwölf Folien.', 84, 420, 620, 40, { id: 'sub', fontSize: 26, color: GREY, fx: { enter: 'fade-up', order: 2 } }),
    ],
  })
}

function myth() {
  return slide({
    id: 'myth', name: 'Der Mythos', transition: 'push',
    notes: 'Die Rechnung stammt aus Antoine Magnans Buch von 1934, durchgeführt von seinem Assistenten André Sainte-Laguë. Sie war richtig — für einen starren Flugzeugflügel. → klickt die drei Absätze nacheinander herein, dann den Stempel. Taste X öffnet die Zusatzfolie zum Strömungsabriss.',
    elements: [
      kicker('1934'),
      title('Der Mythos'),
      text('„Nach den Gesetzen der Aerodynamik kann eine Hummel nicht fliegen.“', 80, 160, 1000, 120, { fontSize: 40, fontWeight: 700, lineHeight: 1.2, color: INK }),
      text('<div>Ein Zoologe und ein Mathematiker rechneten mit einem <b>starren Flugzeugflügel</b>.</div><div>Für so kleine Flügel ergab das viel zu wenig Auftrieb.</div><div>Der Denkfehler: Insektenflügel <b>schlagen, drehen sich und erzeugen Wirbel</b> — sie sind keine Tragflächen.</div>',
        80, 320, 760, 280, { fontSize: 26, lineHeight: 1.6, color: GREY, fx: { byParagraph: true, step: 1, enter: 'fade-up' } }),
      rect(900, 380, 300, 120, { id: 'stamp-box', fill: 'none', stroke: RED, strokeWidth: 6, radius: 10, rotation: -10, fx: { step: 4, enter: 'fade' } }),
      text('Für Neugierige: Taste X →', 900, 560, 300, 30, { id: 'extra-hint', fontSize: 18, fontWeight: 700, color: AMBER_TEXT, align: 'right', link: 'stall' }),
      text('FALSCH', 900, 398, 300, 92, { id: 'stamp', fontSize: 64, fontWeight: 900, letterSpacing: 6, color: RED, align: 'center', rotation: -10, fx: { step: 4, enter: 'fade' } }),
    ],
  })
}

/** An EXTRA: hidden right after the myth slide — X opens it, → carries on. */
function stall() {
  const wingAt = (id, x, y, rot, o = {}) => motif('M0 40C40 4 160 -6 300 14C380 26 440 40 470 50C380 44 240 40 120 52C60 58 10 58 0 40Z', [470, 60], [x, y, 360, 46], { id, fill: WING, stroke: WING_EDGE, strokeWidth: 3, rotation: rot, ...o })
  const eddy = (id, x, y, w) => motif('M0 20C20 0 40 0 50 18C58 34 40 40 30 28C22 18 34 8 44 14', [60, 40], [x, y, w, w * 0.66], { id, fill: 'none', stroke: '#7FA8C9', strokeWidth: 3 })
  return slide({
    id: 'stall', name: 'Für Neugierige: Strömungsabriss', hidden: true,
    notes: 'Zusatzfolie (Extra): nicht Teil des normalen Ablaufs. Taste X auf der Mythos-Folie öffnet sie, → geht weiter zum Bauplan. Kernaussage nach UF/IFAS: Bei großem Anstellwinkel reißt die Strömung am starren Flügel ab; Insektenflügel erzeugen dort einen anhaftenden Vorderkanten-Wirbel.',
    elements: [
      kicker('FÜR NEUGIERIGE'),
      title('Warum die Rechnung scheiterte'),
      wingAt('stall-rigid', 120, 330, -24),
      ...[[380, 260, 70], [450, 300, 54], [500, 250, 44]].map(([x, y, w], k) => eddy(`stall-eddy${k}`, x, y, w)),
      text('<b>Starrer Flügel, steil angestellt</b><br>Die Strömung reißt ab — kein Auftrieb mehr.', 110, 470, 460, 90, { fontSize: 21, lineHeight: 1.4 }),
      wingAt('stall-insect', 720, 330, -24),
      disc(800, 300, 70, 46, { id: 'stall-lev', fill: 'none', stroke: AMBER, strokeWidth: 4 }),
      text('<b>Insektenflügel, genauso steil</b><br>Ein Wirbel an der Vorderkante bleibt haften — der Auftrieb steigt.', 710, 470, 460, 90, { fontSize: 21, lineHeight: 1.4 }),
      pageNo(),
    ],
  })
}

function anatomy() {
  const cx = 720
  const cy = 400
  const s = 2.4
  const label = (id, html, lx, ly, px, py, w = 300) => {
    const group = { 'lbl-head': 'kopf', 'lbl-thorax': 'brust', 'lbl-abd': 'hinterleib', 'lbl-wings': 'fluegel' }[id]
    return [
      line(lx, ly, px, py, { id: `${id}-line`, fill: GREY, strokeWidth: 2, strokeStyle: 'dashed', group }),
      disc(px, py, 12, 12, { id: `${id}-dot`, fill: AMBER, group }),
      text(html, lx + (lx < px ? -w - 8 : 8), ly - 16, w, 70, { id: `${id}-text`, fontSize: 21, lineHeight: 1.3, align: lx < px ? 'right' : 'left', group }),
    ]
  }
  return slide({
    id: 'anatomy', name: 'Der Bauplan', transition: 'morph',
    hover: { type: 'focus-group', dim: 0.25 },
    notes: 'Morph: Die Biene vom Titel ist dieselbe — dieselben Element-IDs, nur größer. Mit der Maus auf einen Körperteil zeigen hebt ihn hervor (Fokus-Gruppen). Ein Klick auf die Brust öffnet die Detailfolie (eine interaktive Zustandsfolie).',
    elements: [
      kicker('DER BAUPLAN'),
      title('Drei Teile, vier Flügel'),
      ...bee(cx, cy, s, { flap: false, groups: true }),
      ...label('lbl-head', '<b>Kopf</b><br>Augen, Fühler', 1060, 260, cx + 52 * s, cy - 2 * s, 200),
      ...label('lbl-thorax', '<b>Brust (Thorax)</b><br>der Motor — klick mich', 420, 620, cx, cy + 20 * s, 340),
      ...label('lbl-abd', '<b>Hinterleib</b><br>Honigmagen, Stachel', 300, 300, cx - 110 * s, cy - 10 * s, 250),
      ...label('lbl-wings', '<b>4 Flügel</b>, je zwei mit<br>Häkchen (Hamuli) gekoppelt', 960, 150, cx - 40 * s, cy - 60 * s, 300),
      rect(cx - 40 * s, cy - 36 * s, 80 * s, 72 * s, { id: 'hit-thorax', fill: 'rgba(0,0,0,0)', link: 'thorax', group: 'brust' }),
    ],
  })
}

function thoraxState() {
  // the bee steps aside (Morph moves it) to make room for the diagram and text
  const cx = 640
  const cy = 480
  const s = 1.7
  const box = (x, y) => [
    rect(x, y, 260, 180, { id: `sec-${x}`, fill: '#F3E3C8', stroke: INK, strokeWidth: 3, radius: 90 }),
  ]
  return slide({
    id: 'thorax', name: 'Brust: Flugmuskeln', stateOf: 'anatomy', transition: 'morph',
    notes: 'Zustandsfolie: nur über den Klick auf die Brust erreichbar; ← führt zurück. Die beiden Muskelpaare pulsieren gegenläufig.',
    elements: [
      kicker('DER MOTOR'),
      title('Indirekte Flugmuskeln'),
      ...bee(cx, cy, s, { hl: 'thorax', dim: 0.15, flap: false }),
      ...box(80, 190),
      rect(185, 210, 50, 140, { id: 'mus-v', fill: RED, opacity: 0.85, radius: 12, fx: { loop: { type: 'pulse', amount: 0.1, duration: 1.4 } } }),
      rect(105, 260, 210, 40, { id: 'mus-l', fill: AMBER, opacity: 0.9, radius: 12, fx: { loop: { type: 'pulse', amount: 0.1, duration: 1.4, delay: 0.7 } } }),
      text('<span style="color:#D2452B"><b>senkrecht</b></span> · <span style="color:#9A5F00"><b>längs</b></span>', 80, 380, 260, 32, { fontSize: 20, align: 'center' }),
      text('<div>Die Muskeln greifen <b>nicht an den Flügeln</b> an — sie verformen die Brust.</div><div>Zwei Paare arbeiten im Wechsel und lassen die Flügel kippen.</div><div><b>Asynchron:</b> Ein Nervenimpuls löst viele Schläge aus — die Muskeln werden durch Dehnung wieder aktiviert.</div>',
        860, 190, 360, 360, { fontSize: 21, lineHeight: 1.45, color: GREY }),
      text('← Zurück zum Bauplan', 82, 640, 320, 32, { id: 'back', fontSize: 20, fontWeight: 700, color: AMBER_TEXT, link: 'anatomy' }),
    ],
  })
}

function wingbeat() {
  const px = 860
  const py = 400
  return slide({
    id: 'beat', name: '230 pro Sekunde',
    notes: 'Altshuler u. a. (PNAS 2005): Schwebende Honigbienen schlagen mit nur ~90° Ausschlag, dafür ~230-mal pro Sekunde. In Zeitlupe: ein Schlag dauert hier 1,2 s statt 4,3 ms — gut 270-mal langsamer.',
    elements: [
      kicker('FREQUENZ'),
      title('Kurz und schnell'),
      text('230', 80, 170, 520, 190, { fontSize: 180, fontWeight: 900, letterSpacing: -6, color: HONEY_TEXT, lineHeight: 1, fx: { countUp: true } }),
      text('Flügelschläge pro Sekunde<br>beim Schweben', 86, 370, 480, 80, { fontSize: 26, fontWeight: 700 }),
      text('Die meisten Insekten schlagen weit aus. Honigbienen nur etwa <b>90°</b> — dafür sehr schnell.', 86, 470, 480, 100, { fontSize: 22, color: GREY, lineHeight: 1.45 }),
      // the stroke, slowed down: ±45° about the root = 90°
      motif('M0 0A260 260 0 0 1 0 367.7', [76.2, 367.7], [px + 183.8, py - 183.8, 76.2, 367.7], { id: 'arc', fill: 'none', stroke: GREY, strokeWidth: 2, strokeStyle: 'dashed', opacity: 0.6 }),
      line(px, py, px + 184, py - 184, { id: 'lim1', fill: GREY, strokeWidth: 2, opacity: 0.35 }),
      line(px, py, px + 184, py + 184, { id: 'lim2', fill: GREY, strokeWidth: 2, opacity: 0.35 }),
      text('90°', px + 276, py - 22, 90, 44, { fontSize: 30, fontWeight: 800, color: GREY }),
      shape('ellipse', {
        id: 'slow-wing', x: px, y: py - 34, w: 250, h: 68, fill: WING, stroke: WING_EDGE, strokeWidth: 3, opacity: 0.9,
        fx: { loop: { type: 'wiggle', amount: 45, duration: 1.2, origin: 'left' } },
      }),
      disc(px, py, 70, 70, { id: 'slow-body', fill: '#6B4A22', stroke: INK, strokeWidth: 3 }),
      text('Zeitlupe: rund 270× langsamer', 760, 640, 440, 30, { fontSize: 18, color: GREY, align: 'right' }),
    ],
  })
}

function lift() {
  // a cambered wing seen from the side; air swirls over its leading edge
  const VX = 800
  const VY = 330
  const swirl = (k) => {
    const r = 12 + k * 6
    const a0 = (k * 60 * Math.PI) / 180
    // clockwise in screen space: air rolls over the top, back down the front
    const pts = Array.from({ length: 13 }, (_, i) => {
      const a = a0 + (i / 12) * Math.PI * 2
      return `${Math.round((Math.cos(a) - Math.cos(a0)) * r * 10) / 10},${Math.round((Math.sin(a) - Math.sin(a0)) * r * 0.7 * 10) / 10}`
    })
    return { x: VX + Math.cos(a0) * r, y: VY + Math.sin(a0) * r * 0.7, path: `M0,0 L${pts.slice(1).join(' L')} Z` }
  }
  return slide({
    id: 'lift', name: 'Auftrieb',
    notes: 'Die Auftriebsformel gilt auch für Insekten — entscheidend ist der Beiwert. Der Vorderkanten-Wirbel bleibt während des Schlags auf dem Flügel und hebt ihn weit über das, was eine starre Tragfläche schafft. Bei Bienen wirken außerdem die Kräfte an den Umkehrpunkten besonders stark (Altshuler 2005).',
    elements: [
      kicker('AERODYNAMIK'),
      title('Woher kommt der Auftrieb?'),
      { id: 'formula', type: 'math', tex: 'L = \\tfrac{1}{2}\\,\\rho\\,v^{2}\\,S\\,C_L', x: 80, y: 160, w: 520, h: 90, rotation: 0, opacity: 1, fontSize: 52, color: INK, align: 'left', valign: 'middle' },
      text('<div>$\\rho$ — Dichte der Luft</div><div>$v$ — Tempo des Flügels</div><div>$S$ — Flügelfläche</div><div>$C_L$ — Auftriebsbeiwert: <b>hier liegt der Trick</b></div>',
        84, 280, 520, 200, { fontSize: 24, lineHeight: 1.6, color: GREY, fx: { byParagraph: true, step: 1, enter: 'fade-up' } }),
      text('Ein <b>Wirbel an der Vorderkante</b> bleibt auf dem Flügel „kleben“ und senkt den Druck darüber. Dazu kommen Kräfte beim Drehen an jedem Umkehrpunkt.',
        84, 520, 520, 120, { fontSize: 22, lineHeight: 1.45, fx: { step: 5, enter: 'fade-up' } }),
      // airflow
      ...[0, 1, 2].map((k) => motif('M0 30C120 30 200 10 320 -10C420 -26 500 -10 560 0', [560, 60], [660, 220 + k * 40, 560, 60], {
        id: `flow${k}`, fill: 'none', stroke: '#7FA8C9', strokeWidth: 2.5, strokeStyle: 'dashed', opacity: 0.6,
      })),
      motif('M0 40C40 4 160 -6 300 14C380 26 440 40 470 50C380 44 240 40 120 52C60 58 10 58 0 40Z', [470, 60], [700, 380, 470, 60], { id: 'airfoil', fill: WING, stroke: WING_EDGE, strokeWidth: 3, rotation: 10 }),
      ...[0, 1, 2, 3].map((k) => {
        const w = swirl(k)
        return disc(w.x, w.y, 9, 9, {
          id: `swirl${k}`, fill: AMBER, opacity: 0.85,
          fx: { loop: { type: 'motion-path', path: w.path, duration: 0.9 + k * 0.18, trail: false } },
        })
      }),
      text('Vorderkanten-Wirbel', 700, 470, 300, 30, { fontSize: 18, fontWeight: 700, color: AMBER_TEXT }),
    ],
  })
}

function compare() {
  return slide({
    id: 'compare', name: 'Vergleich',
    notes: 'Quellen: Stechmücke > 800 Hz (Bomphrey u. a., Nature 2017); Honigbiene 230 Hz (Altshuler u. a., PNAS 2005); Fruchtfliege ~200 Hz (Altshuler, zitiert von UC ANR 2006); Hummel ~180 Hz und Hemaris-Schwärmer ~60 Hz (bioRxiv 2025). Die Frequenz hängt kaum an der Körpergröße. Das Diagramm ist an die Tabelle gebunden: Im Editor eine Zahl ändern, und die Balken passen sich an.',
    elements: [
      kicker('IM VERGLEICH'),
      title('Flügelschläge pro Sekunde'),
      {
        id: 'freq', type: 'table', x: 80, y: 170, w: 380, h: 330, rotation: 0, opacity: 1,
        columns: [{ w: 1.6 }, { w: 1 }], header: true,
        rows: [
          { cells: [{ html: 'Tier' }, { html: 'pro Sekunde', align: 'right' }] },
          ...[['Schwärmer (Hemaris)', 60], ['Hummel', 180], ['Fruchtfliege', 200], ['Honigbiene', 230], ['Stechmücke', 800]]
            .map(([n, v]) => ({ cells: [{ html: n }, { html: String(v), align: 'right' }] })),
        ],
        style: { headerBg: INK, headerColor: CREAM, zebra: '#FBEFD6', borderColor: '#E7D3AE', borderWidth: 1, cellPadX: 12, cellPadY: 10, fontSize: 18, fontFamily: font, color: INK, radius: 12 },
      },
      text('Zahl in der Tabelle ändern — das Diagramm folgt.', 80, 512, 380, 60, { fontSize: 17, color: GREY, lineHeight: 1.35 }),
      {
        id: 'chart', type: 'chart', preset: 'bar', source: { tableId: 'freq' }, x: 500, y: 160, w: 700, h: 440, rotation: 0, opacity: 1, fx: { enter: 'fade-up' },
        alt: 'Balkendiagramm: Schwärmer 60, Hummel 180, Fruchtfliege 200, Honigbiene 230, Stechmücke 800 Flügelschläge pro Sekunde',
        option: {
          grid: { left: 56, right: 16, top: 24, bottom: 40 },
          xAxis: { type: 'category', data: ['Schwärmer', 'Hummel', 'Fruchtfliege', 'Honigbiene', 'Stechmücke'] },
          yAxis: { type: 'value' },
          color: [HONEY],
          tooltip: { trigger: 'item', formatter: '{b}: {c} pro Sekunde' },
          series: [{ type: 'bar', data: [60, 180, 200, 230, 800], itemStyle: { color: HONEY, borderRadius: 10 }, barWidth: 60 }],
        },
      },
      text('Größe sagt wenig: Der Schwärmer ist so groß wie eine Hummel — und schlägt dreimal langsamer.', 80, 620, 1000, 40, { fontSize: 20, color: GREY }),
    ],
  })
}

function warmup() {
  const tx = 860
  const level = (id, top, color, fx) => rect(tx + 14, top, 32, 560 - top, { id, fill: color, radius: 16, fx })
  return slide({
    id: 'warmup', name: 'Aufwärmen', transition: 'wipe',
    notes: 'Unter ~10 °C kann die Biene ihre Flugmuskeln kaum heizen. Sie „zittert“: Die Muskelpaare arbeiten gegeneinander, die Flügel bleiben still. Beim Schwarmstart hatten alle Bienen mindestens 35 °C in der Brust (Seeley u. a. 2003). → drei Klicks, das Thermometer steigt.',
    elements: [
      kicker('VOR DEM START'),
      title('Erst aufwärmen, dann abheben'),
      text('<div><b>Unter ~10 °C</b>: Die Flugmuskeln kommen kaum in Gang.</div><div><b>Zittern</b>: Die Muskeln arbeiten gegeneinander, die Flügel bleiben still — das heizt die Brust.</div><div><b>Ab ~35 °C</b> in der Brust: Abflug.</div>',
        80, 180, 640, 360, { fontSize: 26, lineHeight: 1.55, color: GREY, fx: { byParagraph: true, step: 1, enter: 'fade-up' } }),
      rect(tx, 170, 60, 420, { id: 'tube', fill: PAPER, stroke: INK, strokeWidth: 4, radius: 30 }),
      level('merc-cold', 470, '#6FA8DC', { exitStep: 2 }),
      level('merc-warm', 360, AMBER, { step: 2, exitStep: 3, enter: 'fade' }),
      level('merc-hot', 210, RED, { step: 3, enter: 'fade' }),
      disc(tx + 30, 600, 92, 92, { id: 'bulb', fill: RED, stroke: INK, strokeWidth: 4 }),
      ...[['10 °C', 470], ['25 °C', 360], ['35 °C', 210]].map(([t, y], k) => text(t, tx + 80, y - 16, 120, 32, { id: `tick${k}`, fontSize: 22, fontWeight: 700 })),
      // and off it goes
      ...bee(1130, 230, 0.55, { flap: false }).map((e) => ({ ...e, id: `mini-${e.id}`, fx: { step: 3, enter: 'slide-up' } })),
    ],
  })
}

function colony() {
  const cell = (html, o = {}) => ({ html, ...o })
  return slide({
    id: 'colony', name: 'Das Volk', transition: 'cover', transitionDir: 'bottom',
    notes: 'Arbeiterinnen: 20.000–80.000 je Volk; im Sommer leben sie 4–6 Wochen, im Winter Monate. Königin 2–5 Jahre, Drohnen etwa 8 Wochen — vor dem Winter werden sie aus dem Stock gedrängt.',
    elements: [
      kicker('DAS VOLK'),
      title('Ein Volk, drei Rollen'),
      text('bis zu', 80, 170, 300, 34, { fontSize: 24, color: GREY }),
      text('80.000', 80, 200, 420, 110, { fontSize: 96, fontWeight: 900, letterSpacing: -3, color: HONEY_TEXT, lineHeight: 1, fx: { countUp: true } }),
      text('Arbeiterinnen in einem Volk', 84, 312, 380, 40, { fontSize: 22, fontWeight: 700 }),
      ...[[200, 470], [262, 506], [200, 542], [262, 578], [138, 506], [138, 578]].map(([x, y], k) => hex(x, y, 64, { id: `cell${k}`, fill: HONEY, stroke: INK, strokeWidth: 3, opacity: 0.25 + (k % 3) * 0.2 })),
      {
        id: 'roles', type: 'table', x: 520, y: 170, w: 680, h: 420, rotation: 0, opacity: 1, fx: { enter: 'fade-up' },
        columns: [{ w: 1.1 }, { w: 1.2 }, { w: 1.3 }, { w: 1.8 }],
        header: true,
        rows: [
          { cells: [cell('Rolle'), cell('Anzahl'), cell('Lebensdauer'), cell('Aufgabe')] },
          { cells: [cell('<b>Königin</b>'), cell('1'), cell('2–5 Jahre'), cell('legt die Eier')] },
          { cells: [cell('<b>Arbeiterin</b>'), cell('20.000–80.000'), cell('4–6 Wochen (Sommer), Monate (Winter)'), cell('Brutpflege, Wabenbau, Sammeln, Verteidigung')] },
          { cells: [cell('<b>Drohne</b>'), cell('einige Hundert, nur im Sommer'), cell('ca. 8 Wochen'), cell('Paarung mit jungen Königinnen')] },
        ],
        style: { headerBg: INK, headerColor: CREAM, zebra: '#FBEFD6', borderColor: '#E7D3AE', borderWidth: 1, cellPadX: 14, cellPadY: 12, fontSize: 19, fontFamily: font, color: INK, radius: 12 },
      },
    ],
  })
}

function dance() {
  const ox = 520
  const oy = 470
  const deg = 40
  const r = 170
  const ex = Math.round(Math.sin((deg * Math.PI) / 180) * r)
  const ey = -Math.round(Math.cos((deg * Math.PI) / 180) * r)
  const combs = []
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) combs.push([300 + col * 78 + (row % 2) * 39, 250 + row * 68])
  }
  return slide({
    id: 'dance', name: 'Schwänzeltanz',
    notes: 'Karl von Frisch entschlüsselte den Tanz (Nobelpreis 1973). Richtung: Der Winkel der Schwänzelstrecke zur Senkrechten auf der Wabe entspricht dem Winkel zwischen Sonne und Futterquelle. Entfernung: die Dauer — 2,5 s Schwänzeln ≈ 2.625 m (NC State Extension). Unter ~50 m tanzen Bienen nur einen Rundtanz.',
    elements: [
      kicker('KOMMUNIKATION'),
      title('Der Schwänzeltanz'),
      ...combs.map(([x, y], k) => hex(x, y, 80, { id: `wab${k}`, fill: '#F7DFA5', stroke: '#E0B860', strokeWidth: 2 })),
      // the sun, straight up the comb
      disc(ox, 190, 56, 56, { id: 'sun', fill: '#FFD34D', stroke: AMBER, strokeWidth: 3 }),
      motif('M50 0L54 18L46 18Z M100 50L82 54L82 46Z M50 100L46 82L54 82Z M0 50L18 46L18 54Z M85 15L76 30L70 24Z M85 85L70 76L76 70Z M15 85L24 70L30 76Z M15 15L30 24L24 30Z', [100, 100], [ox - 50, 140, 100, 100],
        { id: 'rays', fill: AMBER }),
      line(ox, oy, ox, 236, { id: 'vertical', fill: GREY, strokeWidth: 3, strokeStyle: 'dashed', opacity: 0.7 }),
      line(ox, oy, ox + ex * 1.35, oy + ey * 1.35, { id: 'heading', fill: RED, strokeWidth: 4, strokeStyle: 'dashed', lineEnd: 'arrow' }),
      text(`${deg}°`, ox + 18, oy - 140, 80, 40, { id: 'angle', fontSize: 28, fontWeight: 800, color: RED }),
      // the dancer: waggle run, loop back left, waggle run, loop back right
      disc(ox, oy, 26, 18, {
        id: 'dancer', fill: HONEY, stroke: INK, strokeWidth: 3,
        fx: { loop: { type: 'motion-path', duration: 5, trail: false, path: `M0 0L${ex} ${ey}C${ex - 70} ${ey - 50} -110 -40 0 0L${ex} ${ey}C${ex + 110} ${ey + 10} 90 60 0 0` } },
      }),
      text('<div><b>Richtung</b>: Winkel zur Senkrechten = Winkel zur Sonne.</div><div><b>Entfernung</b>: die Dauer des Schwänzelns — 2,5 s ≈ 2,6 km.</div><div>Unter ~50 m: nur ein <b>Rundtanz</b>, ohne Richtung.</div>',
        820, 200, 400, 360, { fontSize: 23, lineHeight: 1.5, color: GREY, fx: { byParagraph: true, step: 1, enter: 'fade-up' } }),
    ],
  })
}

function range() {
  const cx = 380
  const cy = 440
  const px = (km) => 16 + km * 17
  const ring = (id, km, label) => [
    disc(cx, cy, px(km) * 2, px(km) * 2, { id, fill: HONEY, opacity: 0.12, stroke: AMBER, strokeWidth: 3 }),
    text(label, cx + px(km) * 0.72 - 10, cy - px(km) * 0.72 - 30, 220, 30, { id: `${id}-l`, fontSize: 18, fontWeight: 700, color: GREY }),
  ]
  return slide({
    id: 'range', name: 'Reichweite',
    notes: 'Visscher & Seeley (1982): Median 1,7 km, 95 % der Sammelflüge innerhalb von 6 km. Bis zu ~14 km sind möglich, aber selten. Reisetempo um 15 mph (~24 km/h) laut „The Hive and the Honey Bee“.',
    elements: [
      kicker('UNTERWEGS'),
      title('Wie weit fliegt sie?'),
      ...ring('r14', 14, 'max. ~14 km'),
      ...ring('r6', 6, '95 %: bis 6 km'),
      ...ring('r17', 1.7, 'Median 1,7 km'),
      hex(cx, cy, 34, { id: 'hive', fill: AMBER, stroke: INK, strokeWidth: 3 }),
      disc(cx, cy, 12, 9, { id: 'forager', fill: INK, fx: { loop: { type: 'motion-path', duration: 6, ease: 'sine.inOut', trail: false, path: 'M0 0C40 -60 120 -110 150 -60C170 -20 90 30 0 0' } } }),
      text('24', 760, 190, 200, 100, { fontSize: 96, fontWeight: 900, color: HONEY_TEXT, lineHeight: 1, letterSpacing: -3, fx: { countUp: true } }),
      text('km/h Reisetempo', 770, 292, 380, 34, { fontSize: 24, fontWeight: 700 }),
      text('6', 760, 360, 200, 100, { fontSize: 96, fontWeight: 900, color: HONEY_TEXT, lineHeight: 1, fx: { countUp: true } }),
      text('km — darin liegen 95 % aller Sammelflüge', 770, 462, 420, 70, { fontSize: 24, fontWeight: 700, lineHeight: 1.3 }),
      text('Die meisten Flüge sind viel kürzer: die Hälfte unter 1,7 km.', 770, 560, 420, 70, { fontSize: 20, color: GREY, lineHeight: 1.4 }),
    ],
  })
}

function summary() {
  const tile = (id, target, x, label) => [
    { id, type: 'zoom', target: { slide: target }, x, y: 200, w: 340, h: 191, rotation: 0, opacity: 1, stroke: INK, strokeWidth: 3, radius: 14 },
    text(label, x, 404, 340, 30, { id: `${id}-l`, fontSize: 20, fontWeight: 700, align: 'center' }),
  ]
  const a = (href, label) => `<a href="${href}">${label}</a>`
  return slide({
    id: 'summary', name: 'Zusammenfassung', transition: 'zoom',
    notes: 'Die Kacheln sind Zoom-Elemente: Ein Klick fliegt in die Folie hinein und wieder heraus.',
    elements: [
      kicker('ZUSAMMENGEFASST'),
      title('Kurz, schnell, verwirbelt'),
      ...tile('z-anatomy', 'anatomy', 80, 'Der Motor in der Brust'),
      ...tile('z-lift', 'lift', 470, 'Wirbel statt Tragfläche'),
      ...tile('z-dance', 'dance', 860, 'Der Tanz als Landkarte'),
      text(`<b>Quellen</b> · ${a('https://resolver.caltech.edu/CaltechAUTHORS:ALTpnas05', 'Altshuler u. a., PNAS 2005')} · ${a('https://ora.ox.ac.uk/objects/uuid:48b29550-fb5f-486d-a366-dcb981c19be7', 'Bomphrey u. a., Nature 2017')} · ${a('https://content.ces.ncsu.edu/honey-bee-dance-language', 'NC State: Dance Language')} · ${a('https://link.springer.com/article/10.1007/BF00165845', 'Visscher & Seeley 1982')} · ${a('https://ucanr.edu/blog/bug-squad/article/how-fast-can-honey-bee-fly', 'UC ANR Bug Squad')} · ${a('https://en.wikipedia.org/wiki/Antoine_Magnan', 'Antoine Magnan')}`,
        80, 500, 1120, 90, { id: 'sources', fontSize: 16, lineHeight: 1.6, color: GREY }),
    ],
  })
}

/** The last slide: what this deck is, underneath. */
function asJson() {
  const snippet = [
    '{',
    '  "id": "bee-thorax",',
    '  "type": "shape", "shape": "ellipse",',
    '  "x": 633.6, "y": 323.2,',
    '  "w": 172.8, "h": 153.6,',
    '  "fill": "#6B4A22", "stroke": "#2B1D0E",',
    '  "group": "brust"',
    '}',
  ].join('\n')
  return slide({
    id: 'json', name: 'Unter der Haube', transition: 'fade',
    notes: 'Jede Folie ist JSON im Dokument — dieses Deck wurde von einem Skript erzeugt (scripts/lib/bee-deck.mjs). Ein KI-Assistent schreibt und ändert es genauso.',
    elements: [
      kicker('UNTER DER HAUBE'),
      title('So sieht eine KI diese Folien'),
      text('Jede Form, jeder Text, jede Animation ist ein Eintrag im Dokument — lesbar, änderbar, ohne Plugin. Diese Präsentation wurde komplett so geschrieben.', 80, 170, 460, 200, { fontSize: 24, lineHeight: 1.5, color: GREY }),
      { id: 'code', type: 'code', x: 600, y: 170, w: 600, h: 300, rotation: 0, opacity: 1, fontSize: 21, fontFamily: MONO, align: 'left', valign: 'top', lineHeight: 1.5, color: INK, content: snippet, grammarName: 'js', fx: { enter: 'fade-up' } },
      text('Die Brust der Biene — als Daten.', 600, 486, 600, 30, { fontSize: 18, color: GREY }),
      pageNo(),
    ],
  })
}

/** The deck. `fontFamily` = the theme's body font. */
export function beeDeck({ fontFamily = 'system-ui, sans-serif' } = {}) {
  font = fontFamily
  seq = 0
  return {
    format: 'slidomingo/slides', version: 1, title: 'Wie fliegt eine Biene?',
    size: { width: 1280, height: 720 },
    theme: { background: CREAM, color: INK, accent: AMBER, fontFamily },
    present: { morphSeconds: 1.2, slideNumber: false },
    // chapters: the outline, the progress and section zooms follow them
    sections: [
      { id: 'sec-flug', name: 'Der Flug', startSlideId: 'cover' },
      { id: 'sec-volk', name: 'Das Volk', startSlideId: 'colony' },
      { id: 'sec-ende', name: 'Zum Schluss', startSlideId: 'summary' },
    ],
    slides: [cover(), myth(), stall(), anatomy(), thoraxState(), wingbeat(), lift(), compare(), warmup(), colony(), dance(), range(), summary(), asJson()]
      // every content slide carries the page number field
      .map((sl) => (sl.id === 'cover' || sl.elements.some((e) => e.id === 'pageno') ? sl : { ...sl, elements: [...sl.elements, pageNo()] })),
  }
}
