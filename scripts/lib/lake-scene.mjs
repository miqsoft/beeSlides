// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Ein Tag am See" — the counterpart of seasons-scene.mjs built ONLY from
// ordinary, editable elements (shapes, paths, text; about fifty of them, no
// svg artwork). Four slides — morning, noon, evening, night — share every
// element id, so Morph blends colours (solid and gradient fills, text) and
// moves what travels (the sun turning into the moon, the balloon), while the
// generic loops keep the scene alive: wiggle about the foot (`origin:
// 'bottom'`) for the tree crown, spin for the windmill, float for clouds and
// the balloon, blink for stars, pulse for the glow, dash-march for ripples,
// motion paths for birds and fireflies.

const shape = (o) => ({ type: 'shape', rotation: 0, opacity: 1, stroke: 'none', strokeWidth: 0, ...o })
/** a path drawn in slide coordinates: its box is its frame */
const path = (id, d, box, o) => shape({ id, shape: 'path', d, pathBox: box, x: box[0], y: box[1], w: box[2], h: box[3], ...o })
/** a path drawn in its own design box (0 0 dw dh), placed at `frame` */
const motif = (id, d, [dw, dh], frame, o) => shape({ id, shape: 'path', d, pathBox: [0, 0, dw, dh], x: frame[0], y: frame[1], w: frame[2], h: frame[3], ...o })
const grad = (top, bottom) => ({ angle: 180, stops: [{ at: 0, color: top }, { at: 1, color: bottom }] })
/** an ellipse centred on (cx, cy) */
const disc = (id, cx, cy, w, h, o) => shape({ id, shape: 'ellipse', x: cx - w / 2, y: cy - h / 2, w, h, ...o })

const CLOUD = 'M20 70C0 70 0 45 22 42C20 20 50 10 66 26C76 6 116 4 126 30C150 18 182 30 176 52C196 56 196 70 178 70Z'
const scaled = (d, sx, sy, dx, dy) => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_m, x, y) =>
  `${Math.round((Number(x) * sx + dx) * 10) / 10} ${Math.round((Number(y) * sy + dy) * 10) / 10}`)
const cloud = (id, x, y, w, h, o) => path(id, scaled(CLOUD, w / 200, h / 80, x, y), [x, y, w, h], o)

const BALLOON = 'M45 0C75 0 90 25 90 48C90 75 62 92 52 104L38 104C28 92 0 75 0 48C0 25 15 0 45 0Z'
const STRIPE = 'M45 0C58 0 64 25 64 48C64 75 52 92 48 104L42 104C38 92 26 75 26 48C26 25 32 0 45 0Z'
const BIRD = 'M0 8Q8 0 16 6Q24 0 32 8Q24 4 16 10Q8 4 0 8Z'
const SAILS = 'M76 80L70 4L90 4L84 80Z M80 76L156 70L156 90L80 84Z M84 80L90 156L70 156L76 80Z M80 84L4 90L4 70L80 76Z'

export const TIMES = [
  {
    id: 'morning', name: 'Morning', line: 'The sun comes up', ink: '#1b2440',
    sky: ['#7f9be0', '#ffd0b0'], sun: '#ffcf73', sunAt: [480, 330], sunSize: 110, glow: '#ffb067', glowOp: 0.45,
    cloud: '#fff0e6', cloudOp: 0.95, mtn: ['#a3a9d1', '#8288b8'], lake: ['#f2c3b0', '#6f86c4'],
    meadow: ['#7bb661', '#6aa957'], trunk: '#6b4a35', crown: ['#6fb35a', '#5ea24d', '#84c46c'],
    wall: '#efe2d0', roof: '#c0583f', window: '#44506a', tower: '#f1e8db', sails: '#fbf7ef',
    balloon: ['#ff6b6b', '#ffd166'], balloonAt: [520, 300], balloonOp: 1, birds: 1, stars: 0, flies: 0,
    ripple: 0.5, refl: 0.5,
  },
  {
    id: 'noon', name: 'Noon', line: 'Wind across the lake', ink: '#0d2741',
    sky: ['#2a7de1', '#bfe6ff'], sun: '#fff1a8', sunAt: [640, 110], sunSize: 110, glow: '#fff3a0', glowOp: 0.5,
    cloud: '#ffffff', cloudOp: 1, mtn: ['#93b3d3', '#6f94b8'], lake: ['#8fd0ff', '#1f6fb2'],
    meadow: ['#5fae45', '#4f9e3a'], trunk: '#5a3d2b', crown: ['#3f8f3a', '#2f7d32', '#5cae47'],
    wall: '#f4ece0', roof: '#c0583f', window: '#44506a', tower: '#f4efe6', sails: '#ffffff',
    balloon: ['#ff6b6b', '#ffd166'], balloonAt: [470, 150], balloonOp: 1, birds: 1, stars: 0, flies: 0,
    ripple: 0.65, refl: 0.35,
  },
  {
    id: 'evening', name: 'Evening', line: 'Golden hour', ink: '#ffffff',
    sky: ['#2d2a6b', '#ff8a4f'], sun: '#ff6a3a', sunAt: [1010, 410], sunSize: 110, glow: '#ff4f3a', glowOp: 0.55,
    cloud: '#ff9f80', cloudOp: 0.95, mtn: ['#6c4e86', '#4b3a6e'], lake: ['#ff9a62', '#3f2f6e'],
    meadow: ['#4a6e3a', '#3f5f33'], trunk: '#4a3427', crown: ['#4f7a3a', '#3e6630', '#64904a'],
    wall: '#d8b8a0', roof: '#8a3d30', window: '#ffcf6a', tower: '#e3c8b5', sails: '#f5e3d3',
    balloon: ['#ff5a5a', '#ffc04d'], balloonAt: [650, 230], balloonOp: 1, birds: 0.9, stars: 0, flies: 0,
    ripple: 0.5, refl: 0.75,
  },
  {
    id: 'night', name: 'Night', line: 'Fireflies and stars', ink: '#ffffff',
    sky: ['#070b1f', '#1d2b5c'], sun: '#f3f0dd', sunAt: [1000, 120], sunSize: 84, glow: '#b9c8ff', glowOp: 0.22,
    cloud: '#2a3560', cloudOp: 0.8, mtn: ['#1e2648', '#141a35'], lake: ['#1f2d5c', '#070b1f'],
    meadow: ['#17301f', '#132a1b'], trunk: '#241c1a', crown: ['#1c3a2a', '#163022', '#24483a'],
    wall: '#3e4360', roof: '#262840', window: '#ffd36a', tower: '#505879', sails: '#6f7799',
    balloon: ['#ff5a5a', '#ffc04d'], balloonAt: [700, 210], balloonOp: 0, birds: 0, stars: 1, flies: 1,
    ripple: 0.25, refl: 0.4,
  },
]

const STARS = [[90, 60, 5], [210, 140, 4], [330, 40, 6], [460, 110, 4], [600, 50, 5], [760, 150, 4], [860, 40, 6], [1130, 70, 5], [1210, 170, 4], [1060, 250, 4]]
const RIPPLES = [[420, 500, 200], [700, 538, 180], [610, 600, 170], [980, 520, 200]]
const FLIES = [
  [140, 560, 'M0 0C20 -24 44 8 10 26C-24 30 -26 -10 0 0'], [300, 600, 'M0 0C-26 -18 -40 14 -8 24C22 30 28 -6 0 0'],
  [430, 540, 'M0 0C18 18 -8 40 -22 16C-34 -6 -14 -20 0 0'], [220, 640, 'M0 0C30 -10 30 24 6 28C-20 30 -18 -4 0 0'],
  [380, 650, 'M0 0C-14 -22 16 -36 24 -12C30 8 12 14 0 0'],
]

function elements(t, i, font) {
  const [sx, sy] = t.sunAt
  const [bx, by] = t.balloonAt
  return [
    shape({ id: 'sky', shape: 'rect', x: 0, y: 0, w: 1280, h: 720, fill: t.sky[0], fillGradient: grad(...t.sky) }),
    ...STARS.map(([x, y, r], k) => disc(`star${k}`, x, y, r, r, {
      fill: '#ffffff', opacity: t.stars, fx: { loop: { type: 'blink', amount: 0.75, duration: 1.4 + (k % 4) * 0.5, delay: (k % 3) * 0.4 } },
    })),
    disc('glow', sx, sy, t.sunSize * 2.2, t.sunSize * 2.2, { fill: t.glow, opacity: t.glowOp, blur: 38, fx: { loop: { type: 'pulse', amount: 0.08, duration: 4 } } }),
    disc('sun', sx, sy, t.sunSize, t.sunSize, { fill: t.sun }),
    cloud('cloud0', 470, 180, 180, 72, { fill: t.cloud, opacity: t.cloudOp, fx: { loop: { type: 'float', amount: 8, duration: 7 } } }),
    cloud('cloud1', 790, 64, 250, 100, { fill: t.cloud, opacity: t.cloudOp, fx: { loop: { type: 'float', amount: 10, duration: 9, delay: 1 } } }),
    cloud('cloud2', 1060, 210, 160, 64, { fill: t.cloud, opacity: t.cloudOp, fx: { loop: { type: 'float', amount: 6, duration: 6, delay: 2 } } }),
    motif('bird0', BIRD, [32, 10], [560, 112, 34, 11], { fill: '#26303a', opacity: t.birds, fx: { loop: { type: 'motion-path', path: 'M0 0C200 -40 420 30 760 -20', duration: 16, trail: false } } }),
    motif('bird1', BIRD, [32, 10], [604, 138, 26, 9], { fill: '#26303a', opacity: t.birds, fx: { loop: { type: 'motion-path', path: 'M0 0C220 -30 460 40 720 -10', duration: 19, delay: 2, trail: false } } }),
    path('mtnFar', 'M0 470L0 400L120 330L230 395L360 300L480 390L600 340L700 400L820 310L960 400L1080 335L1200 390L1280 360L1280 470Z', [0, 300, 1280, 170], { fill: t.mtn[0] }),
    path('mtnNear', 'M0 470L0 430L140 380L260 440L400 370L540 445L680 395L800 450L940 385L1100 445L1280 400L1280 470Z', [0, 370, 1280, 100], { fill: t.mtn[1] }),
    shape({ id: 'lake', shape: 'rect', x: 0, y: 468, w: 1280, h: 252, fill: t.lake[0], fillGradient: grad(...t.lake) }),
    disc('reflection', sx, 494, 190, 20, { fill: t.sun, opacity: t.refl }),
    ...RIPPLES.map(([x, y, w], k) => shape({
      id: `ripple${k}`, shape: 'line', x, y, w, h: 6, fill: '#ffffff', strokeWidth: 2, strokeStyle: 'dashed', opacity: t.ripple,
      fx: { loop: { type: 'dash-march', distance: k % 2 ? -24 : 24, duration: 2.2 + k * 0.4 } },
    })),
    path('meadow', 'M0 560C120 520 300 520 460 560C520 575 560 600 600 640L600 720L0 720Z', [0, 520, 600, 200], { fill: t.meadow[0] }),
    path('hill', 'M820 720C860 640 960 600 1080 590C1180 585 1240 600 1280 610L1280 720Z', [820, 588, 460, 132], { fill: t.meadow[1] }),
    // the house on the hill
    shape({ id: 'wall', shape: 'rect', x: 900, y: 604, w: 84, h: 52, fill: t.wall }),
    shape({ id: 'roof', shape: 'triangle', x: 890, y: 562, w: 104, h: 44, fill: t.roof }),
    shape({ id: 'window0', shape: 'rect', x: 914, y: 618, w: 18, h: 16, radius: 2, fill: t.window }),
    shape({ id: 'window1', shape: 'rect', x: 950, y: 618, w: 18, h: 16, radius: 2, fill: t.window }),
    // the windmill
    path('tower', 'M1092 604L1100 470L1120 470L1128 604Z', [1092, 470, 36, 134], { fill: t.tower }),
    motif('sails', SAILS, [160, 160], [1030, 390, 160, 160], { fill: t.sails, fx: { loop: { type: 'spin', duration: 9 } } }),
    disc('hub', 1110, 470, 16, 16, { fill: t.roof }),
    // the tree on the meadow
    path('trunk', 'M246 605C248 560 250 520 244 470L258 470C254 520 256 560 262 605Z', [244, 470, 18, 135], { fill: t.trunk }),
    disc('crown0', 300, 420, 180, 150, { fill: t.crown[1], fx: { loop: { type: 'wiggle', amount: 2.5, duration: 4.2, origin: 'bottom' } } }),
    disc('crown1', 215, 425, 170, 140, { fill: t.crown[0], fx: { loop: { type: 'wiggle', amount: 3, duration: 3.6, origin: 'bottom', delay: 0.4 } } }),
    disc('crown2', 262, 360, 150, 130, { fill: t.crown[2], fx: { loop: { type: 'wiggle', amount: 3.5, duration: 3.1, origin: 'bottom', delay: 0.8 } } }),
    // the balloon (it floats AND travels between slides)
    motif('balloon', BALLOON, [90, 104], [bx, by, 90, 104], { fill: t.balloon[0], opacity: t.balloonOp, fx: { loop: { type: 'float', amount: 12, duration: 5 } } }),
    motif('stripe', STRIPE, [90, 104], [bx, by, 90, 104], { fill: t.balloon[1], opacity: t.balloonOp, fx: { loop: { type: 'float', amount: 12, duration: 5 } } }),
    shape({ id: 'basket', shape: 'rect', x: bx + 36, y: by + 110, w: 18, h: 14, radius: 2, fill: '#8a5a3a', opacity: t.balloonOp, fx: { loop: { type: 'float', amount: 12, duration: 5 } } }),
    // fireflies
    ...FLIES.map(([x, y, d], k) => disc(`fly${k}`, x, y, 6, 6, {
      fill: '#fff3a0', opacity: t.flies, fx: { loop: { type: 'motion-path', path: d, duration: 4 + k * 0.7, ease: 'sine.inOut', trail: false } },
    })),
    // text and the time-of-day indicator
    { id: 'title', type: 'text', html: t.name, x: 72, y: 56, w: 480, h: 100, rotation: 0, opacity: 1, fontSize: 80, fontFamily: font, fontWeight: 800, color: t.ink, align: 'left', valign: 'top', lineHeight: 1.05, letterSpacing: -1 },
    { id: 'line', type: 'text', html: t.line, x: 76, y: 156, w: 480, h: 44, rotation: 0, opacity: 0.85, fontSize: 28, fontFamily: font, fontWeight: 500, color: t.ink, align: 'left', valign: 'top', lineHeight: 1.2 },
    ...[0, 1, 2, 3].map((k) => shape({ id: `dot${k}`, shape: 'rect', x: 78 + k * 26, y: 222, w: 12, h: 12, radius: 6, fill: t.ink, opacity: 0.35 })),
    shape({ id: 'pill', shape: 'rect', x: 74 + i * 26, y: 222, w: 20, h: 12, radius: 6, fill: t.ink }),
  ]
}

/** The demo deck on top of an editor's base doc. */
export function lakeDeck(base) {
  const d = JSON.parse(JSON.stringify(base))
  d.title = 'A Day at the Lake'
  d.present = { ...(d.present ?? {}), morphSeconds: 2.4 }
  const font = d.theme?.fontFamily ?? 'system-ui, sans-serif'
  d.slides = TIMES.map((t, i) => ({
    id: t.id, background: '#000000', transition: i === 0 ? 'fade' : 'morph', name: t.name,
    notes: 'Every part is an ordinary shape or text you can select and edit. The four slides share element ids: Morph blends the colours and moves the sun and the balloon; the loops keep it alive.',
    elements: elements(t, i, font),
  }))
  return d
}
