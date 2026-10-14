// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The four-season demo: ONE generated svg drawing whose every seasonal detail
// reads a var (DECISIONS 2026-10-13 "One drawing, many states"), and a deck
// that shows it four times with only `vars` changed and a morph between.
// Used by scripts/test-svg-vars-e2e.mjs (which can --save it as a deck).
//
// Rules the drawing follows, because the format makes them matter:
// - A colour that changes with the season sits on a SHAPE (fill/opacity via
//   var()), never inside a gradient, mask or filter: the same drawing on four
//   slides means four copies of every id, and `url(#x)` paints from the FIRST
//   copy — so paint servers here are constant (glows, haze, vignette).
// - Movement is endless CSS animation (runs on the show clock, so nothing
//   jumps at a slide change); its strength is var(--wind) inside @keyframes.
// - Deterministic: a seeded PRNG, so the markup is byte-identical every run.

const W = 1280
const H = 720

function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = prng(20261013)
const between = (a, b) => a + (b - a) * rand()
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const f = (n) => Math.round(n * 10) / 10

// ---- the tree ------------------------------------------------------------------

const TRUNK = { x: 740, y: 614 }

// Shared shapes are repeated as path data, not <use>: every <use> carries a
// shadow copy of what it references, which doubled the nodes a var change has
// to restyle (measured: morph frames spent ~30% in style recalc).
const LEAF = 'M0 0C3 -5 10 -6.6 16 0C10 6.6 3 5 0 0Z'
const ring = (cx, cy, rx, ry) => `M${f(cx - rx)} ${f(cy)}a${rx} ${ry} 0 1 0 ${f(2 * rx)} 0a${rx} ${ry} 0 1 0 ${f(-2 * rx)} 0`
const PETALS = [0, 1, 2, 3, 4].map((i) => {
  const a = (i * 72 * Math.PI) / 180
  return ring(Math.cos(a) * 3.4, Math.sin(a) * 3.4, 3.2, 3.2)
}).join('')
const MEADOW = ring(0, -3, 2.2, 3) + ring(3, 0, 3, 2.2) + ring(0, 3, 2.2, 3) + ring(-3, 0, 3, 2.2)
const MAX_DEPTH = 4

/** a tapered, slightly bent branch: outline path, top-edge (snow) path, shade path */
function branchPaths(x, y, ang, len, w0, w1) {
  const ex = x + Math.cos(ang) * len
  const ey = y + Math.sin(ang) * len
  const nx = -Math.sin(ang)
  const ny = Math.cos(ang)
  const bend = between(-0.1, 0.1) * len
  const cx = (x + ex) / 2 + nx * bend
  const cy = (y + ey) / 2 + ny * bend
  const wm = (w0 + w1) / 2
  const side = (s) => [
    [x + nx * s * w0 / 2, y + ny * s * w0 / 2],
    [cx + nx * s * wm / 2, cy + ny * s * wm / 2],
    [ex + nx * s * w1 / 2, ey + ny * s * w1 / 2],
  ]
  const a = side(1)
  const b = side(-1)
  const outline = `M${f(a[0][0])} ${f(a[0][1])}Q${f(a[1][0])} ${f(a[1][1])} ${f(a[2][0])} ${f(a[2][1])}` +
    `L${f(b[2][0])} ${f(b[2][1])}Q${f(b[1][0])} ${f(b[1][1])} ${f(b[0][0])} ${f(b[0][1])}Z`
  // snow lies on whichever edge is higher up
  const top = (a[1][1] < b[1][1]) ? a : b
  const snow = `M${f(top[0][0])} ${f(top[0][1])}Q${f(top[1][0])} ${f(top[1][1])} ${f(top[2][0])} ${f(top[2][1])}`
  // the side away from the light (the light comes from the left) is darker
  const dark = (a[1][0] > b[1][0]) ? a : b
  const shade = `M${f(x)} ${f(y)}Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}` +
    `L${f(dark[2][0])} ${f(dark[2][1])}Q${f(dark[1][0])} ${f(dark[1][1])} ${f(dark[0][0])} ${f(dark[0][1])}Z`
  return { ex, ey, outline, snow, shade }
}

function leafCluster(cx, cy, n, r) {
  const parts = []
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * r
    const set = rand() < 0.62 ? 'la' : 'lb'
    parts.push(`<path d="${LEAF}" class="${set} s${1 + Math.floor(rand() * 3)}" transform="translate(${f(cx + Math.cos(a) * d)} ${f(cy + Math.sin(a) * d * 0.8)}) rotate(${Math.round(between(0, 360))}) scale(${f(between(1.05, 1.7))})"/>`)
  }
  for (let i = 0; i < 4; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * r * 0.9
    parts.push(`<g class="bl" transform="translate(${f(cx + Math.cos(a) * d)} ${f(cy + Math.sin(a) * d * 0.8)}) scale(${f(between(0.8, 1.2))})"><path d="${PETALS}" fill="#ffd3e4"/><circle r="2" fill="#ffc94d"/></g>`)
  }
  if (rand() < 0.45) {
    const a = rand() * Math.PI * 2
    const d = rand() * r * 0.7
    const fx = f(cx + Math.cos(a) * d)
    const fy = f(cy + Math.sin(a) * d * 0.8 + 6)
    parts.push(`<g class="fr"><circle class="fruit" cx="${fx}" cy="${fy}" r="6.5"/><circle cx="${f(fx - 2.2)}" cy="${f(fy - 2.4)}" r="2" fill="#fff" opacity=".45"/></g>`)
  }
  const dur = f(between(1.4, 2.4))
  const delay = f(between(0, 3))
  return `<g class="fl" style="transform-origin:${f(cx)}px ${f(cy)}px;animation-duration:${dur}s;animation-delay:-${delay}s">${parts.join('')}</g>`
}

function branch(x, y, ang, len, w, depth) {
  const w1 = w * 0.64
  const p = branchPaths(x, y, ang, len, w, w1)
  let out = `<path class="bark" d="${p.outline}"/>`
  if (depth <= 2) out += `<path class="shade" d="${p.shade}"/>`
  if (depth >= 1) out += `<path class="bs" d="${p.snow}" stroke-width="${f(Math.max(1.6, w * 0.38))}"/>`
  if (depth < MAX_DEPTH) {
    const n = depth === 0 ? 3 : depth === 1 ? (rand() < 0.5 ? 3 : 2) : (rand() < 0.3 ? 3 : 2)
    const spread = depth === 0 ? 0.68 : 0.5
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1) - 0.5
      let a = ang + t * 2 * spread + between(-0.12, 0.12)
      a = a * 0.86 + (-Math.PI / 2) * 0.14 // reach for the light
      const outer = n === 3 && i !== 1 && depth === 0
      out += branch(p.ex, p.ey, a, len * (outer ? between(0.72, 0.8) : between(0.62, 0.72)), w1, depth + 1)
    }
    if (depth === 2) out += leafCluster(p.ex, p.ey, 8, 24)
    if (depth >= 3) out += leafCluster(p.ex, p.ey, 12, 30)
  } else {
    out += leafCluster(p.ex, p.ey, 24, 44)
  }
  if (depth <= 3) {
    const k = [0.6, 1.4, 2.2, 3][depth]
    const dur = f(between(4.2, 6.4))
    const delay = f(between(0, 6))
    return `<g class="sw" style="transform-origin:${f(x)}px ${f(y)}px;--k:${k};animation-duration:${dur}s;animation-delay:-${delay}s">${out}</g>`
  }
  return out
}

// ---- landscape -----------------------------------------------------------------

function mountains(baseY, minY, maxY, step, cls) {
  let body = ''
  let caps = ''
  let shade = ''
  for (let x = -120; x < W + 160; x += step * between(0.75, 1.25)) {
    const py = between(minY, maxY)
    const w = between(step * 0.9, step * 1.5)
    const h = baseY - py
    body += `M${f(x - w)} ${baseY}L${f(x)} ${f(py)}L${f(x + w)} ${baseY}Z`
    shade += `M${f(x)} ${f(py)}L${f(x + w)} ${baseY}L${f(x + w * 0.2)} ${baseY}Z`
    const cf = 0.3
    let cap = `M${f(x - w * cf)} ${f(py + h * cf)}L${f(x)} ${f(py)}L${f(x + w * cf)} ${f(py + h * cf)}`
    for (let i = 5; i >= 1; i--) {
      const t = i / 6
      cap += `L${f(x - w * cf + 2 * w * cf * t)} ${f(py + h * cf + (i % 2 ? -7 : 5))}`
    }
    caps += cap + 'Z'
  }
  return `<path class="${cls}" d="${body}"/><path class="mshade" d="${shade}"/><path class="cap" d="${caps}"/>`
}

function pine(x, y, s) {
  const tiers = [[0, 26, 18], [-14, 20, 14], [-26, 14, 10]]
  let body = ''
  let snow = ''
  for (const [dy, hw, h] of tiers) {
    const by = y + dy * s
    body += `M${f(x - hw * s / 2)} ${f(by)}L${f(x)} ${f(by - h * s)}L${f(x + hw * s / 2)} ${f(by)}Z`
    snow += `M${f(x - hw * s / 4)} ${f(by - h * s / 2)}L${f(x)} ${f(by - h * s)}L${f(x + hw * s / 4)} ${f(by - h * s / 2)}Z`
  }
  return `<rect class="bark" x="${f(x - 1.5 * s)}" y="${f(y)}" width="${f(3 * s)}" height="${f(6 * s)}"/><path class="pine" d="${body}"/><path class="psnow" d="${snow}"/>`
}

function cloud(y, scale, dur, delay) {
  const puffs = [[0, 0, 34], [36, -14, 40], [76, -4, 32], [104, 8, 24], [-30, 10, 24], [50, 14, 30]]
  const top = puffs.map(([x, yy, r]) => `<circle cx="${x}" cy="${yy}" r="${r}"/>`).join('')
  const under = puffs.map(([x, yy, r]) => `<circle cx="${x + 4}" cy="${yy + 8}" r="${r * 0.9}"/>`).join('')
  return `<g class="cloud" style="animation-duration:${dur}s;animation-delay:-${delay}s"><g transform="translate(0 ${y}) scale(${scale})"><g class="cshade">${under}</g><g class="ctop">${top}</g></g></g>`
}

function grassBlade(x, baseY, h, lean, cls) {
  return `<path class="${cls}" d="M${f(x - 2.2)} ${baseY}Q${f(x - 1 + lean * 0.4)} ${f(baseY - h * 0.55)} ${f(x + lean)} ${f(baseY - h)}Q${f(x + 1.2 + lean * 0.5)} ${f(baseY - h * 0.5)} ${f(x + 2.6)} ${baseY}Z"/>`
}

// ---- the drawing ---------------------------------------------------------------

export function seasonsScene() {
  const css = `
.sky-b{fill:var(--sky-bottom,#e6f3ff)}
.sky-t{fill:var(--sky-top,#7fb8ef)}
.stars{opacity:var(--stars,0)}
.tw{animation:twinkle 3s ease-in-out infinite alternate}
.sun{transform:translate(calc(var(--sun-x,1000) * 1px),calc(var(--sun-y,160) * 1px))}
.sun-disc{fill:var(--sun,#fff4c2)}
.sun-glow{opacity:var(--sun-glow,.8)}
.rays{opacity:var(--rays,.3);transform-box:view-box;transform-origin:0 0;animation:spin 160s linear infinite}
.clouds{opacity:var(--clouds,.8)}
.ctop{fill:var(--cloud,#fff)}
.cshade{fill:var(--cloud-shade,#dce9f5)}
.cloud{animation:drift 120s linear infinite}
.birds{opacity:var(--birds,0)}
.flock{animation:fly 34s linear infinite}
.wing{fill:none;stroke:#26303a;stroke-width:1.8;stroke-linecap:round;transform-box:fill-box;transform-origin:center;animation:flap .32s ease-in-out infinite alternate}
.m-far{fill:var(--mtn-far,#9db6cf)}
.m-near{fill:var(--mtn-near,#7f9fb8)}
.mshade{fill:#0b1a2a;opacity:.13}
.cap{fill:#fff;opacity:var(--peaks,.8)}
.haze{opacity:var(--haze,.5)}
.hill-far{fill:var(--hill-far,#9fd08a)}
.hill-near{fill:var(--hill-near,#79c060)}
.pine{fill:var(--pine,#3f7a4a)}
.psnow{fill:#fff;opacity:var(--snow,0)}
.snowfield{fill:#fff;opacity:var(--snow-ground,0)}
.snowshade{fill:#c9d6ea;opacity:var(--snow-ground,0)}
.win{fill:#ffd77a;opacity:var(--glow,0)}
.wglow{opacity:var(--glow,0)}
.smoke{opacity:var(--smoke,0)}
.puff{fill:#d7dbe4;transform-box:fill-box;transform-origin:center;animation:rise 7s ease-out infinite}
.bark{fill:var(--bark,#5a3d2b)}
.shade{fill:#000;opacity:.2}
.bs{fill:none;stroke:#fff;stroke-linecap:round;opacity:var(--snow,0)}
.sw{transform-box:view-box;animation:sway 5s ease-in-out infinite alternate}
.fl{transform-box:view-box;animation:flutter 2s ease-in-out infinite alternate}
.la{opacity:var(--leaves-a,1)}
.lb{opacity:var(--leaves-b,1)}
.s1{fill:var(--leaf1,#3f8f3a)}
.s2{fill:var(--leaf2,#2f7d32)}
.s3{fill:var(--leaf3,#5aab45)}
.bl{opacity:var(--blossom,0)}
.fr{opacity:var(--fruit,0)}
.fruit{fill:var(--fruit-c,#d8342c)}
.pile{opacity:var(--leafpile,0)}
.petals{opacity:var(--petals,0)}
.petal{fill:#ffc6dc;transform-box:fill-box;transform-origin:center;animation:petal 11s linear infinite}
.falling{opacity:var(--falling,0)}
.tumble{transform-box:fill-box;transform-origin:center;animation:tumble 10s linear infinite}
.snowfall{opacity:var(--snow,0)}
.flake{fill:#fff;animation:snow 12s linear infinite}
.motes{opacity:var(--motes,0)}
.mote{fill:#fff6c8;animation:mote 12s ease-in-out infinite}
.grass{opacity:var(--grass-op,1)}
.g1{fill:var(--grass,#6dbb4f)}
.g2{fill:var(--grass2,#8fd16a)}
.gr{transform-box:view-box;transform-origin:0 722px;animation:lean 3.6s ease-in-out infinite alternate}
.flowers{opacity:var(--flowers,0)}
.tint{fill:var(--tint,#fff);opacity:var(--tint-op,0)}
@keyframes sway{from{transform:rotate(calc(var(--wind,.5) * var(--k,1) * -1deg))}to{transform:rotate(calc(var(--wind,.5) * var(--k,1) * 1deg))}}
@keyframes flutter{from{transform:rotate(calc(var(--wind,.5) * -3deg))}to{transform:rotate(calc(var(--wind,.5) * 4deg))}}
@keyframes lean{from{transform:skewX(calc(var(--wind,.5) * -5deg))}to{transform:skewX(calc(var(--wind,.5) * 9deg))}}
@keyframes drift{from{transform:translateX(-320px)}to{transform:translateX(1620px)}}
@keyframes fly{from{transform:translate(-160px,40px)}to{transform:translate(1480px,-50px)}}
@keyframes flap{from{transform:scaleY(1)}to{transform:scaleY(-.5)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes twinkle{from{opacity:1}to{opacity:.25}}
@keyframes rise{0%{transform:translate(0,0) scale(.4);opacity:0}15%{opacity:.8}100%{transform:translate(-46px,-120px) scale(2.4);opacity:0}}
@keyframes petal{0%{transform:translate(0,0) rotate(0);opacity:0}8%{opacity:1}90%{opacity:1}100%{transform:translate(260px,420px) rotate(720deg);opacity:0}}
@keyframes tumble{0%{transform:translate(0,0) rotate(0);opacity:0}6%{opacity:1}30%{transform:translate(70px,120px) rotate(260deg)}60%{transform:translate(40px,250px) rotate(560deg)}92%{opacity:1}100%{transform:translate(150px,400px) rotate(900deg);opacity:0}}
@keyframes snow{0%{transform:translate(0,-760px)}25%{transform:translate(22px,-570px)}50%{transform:translate(-8px,-380px)}75%{transform:translate(24px,-190px)}100%{transform:translate(6px,0)}}
@keyframes mote{0%{transform:translate(0,0);opacity:0}20%{opacity:1}50%{transform:translate(30px,-40px)}80%{opacity:.8}100%{transform:translate(-10px,-90px);opacity:0}}
`

  const defs = `<defs>
<radialGradient id="sunGlow"><stop offset="0" stop-color="#fff8d8" stop-opacity=".95"/><stop offset=".35" stop-color="#fff2c0" stop-opacity=".35"/><stop offset="1" stop-color="#fff2c0" stop-opacity="0"/></radialGradient>
<radialGradient id="warm"><stop offset="0" stop-color="#ffcf6a" stop-opacity=".9"/><stop offset="1" stop-color="#ffcf6a" stop-opacity="0"/></radialGradient>
<linearGradient id="ray" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="hazeG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".7" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient>
<linearGradient id="skyFadeG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
<mask id="skyFade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="560"><rect width="${W}" height="560" fill="url(#skyFadeG)"/></mask>
<linearGradient id="groundG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>
<radialGradient id="vig" cx=".5" cy=".45" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/></radialGradient>
</defs>`

  // sky, stars, sun
  const stars = Array.from({ length: 90 }, () => {
    const tw = rand() < 0.4
    return `<circle${tw ? ` class="tw" style="animation-delay:-${f(between(0, 3))}s;animation-duration:${f(between(1.8, 4))}s"` : ''} cx="${f(between(0, W))}" cy="${f(between(0, 1) ** 1.6 * 340)}" r="${f(between(0.5, 1.7))}" fill="#fff"/>`
  }).join('')
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const wA = 0.06
    const L = 700
    return `<path d="M0 0L${f(Math.cos(a - wA) * L)} ${f(Math.sin(a - wA) * L)}L${f(Math.cos(a + wA) * L)} ${f(Math.sin(a + wA) * L)}Z" fill="url(#ray)"/>`
  }).join('')
  const sky = `<rect class="sky-b" width="${W}" height="${H}"/><rect class="sky-t" width="${W}" height="560" mask="url(#skyFade)"/>
<g class="stars">${stars}</g>
<g class="sun"><g class="rays">${rays}</g><circle class="sun-glow" r="190" fill="url(#sunGlow)"/><circle class="sun-disc" r="42"/><circle r="30" fill="#fff" opacity=".3"/></g>`

  const clouds = `<g class="clouds">${[
    cloud(110, 1.1, 150, 20), cloud(70, 0.8, 190, 95), cloud(170, 0.65, 130, 60),
    cloud(130, 1.3, 170, 140), cloud(210, 0.55, 110, 10), cloud(90, 0.9, 200, 175),
  ].join('')}</g>`

  const flock = (y, n, dur, delay, s) => {
    const birds = Array.from({ length: n }, (_, i) => {
      const bx = -i * 16 * s + (i % 2) * 4
      const by = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 9 * s
      return `<g transform="translate(${f(bx)} ${f(y + by)}) scale(${s})"><path class="wing" style="animation-delay:-${f(rand() * 0.3)}s" d="M-8 0Q-4 -5 0 0Q4 -5 8 0"/></g>`
    }).join('')
    return `<g class="flock" style="animation-duration:${dur}s;animation-delay:-${delay}s">${birds}</g>`
  }
  const birds = `<g class="birds">${flock(272, 7, 38, 5, 1)}${flock(300, 4, 30, 19, 0.8)}</g>`

  const land = `${mountains(520, 230, 320, 150, 'm-far')}${mountains(545, 320, 390, 120, 'm-near')}
<rect class="haze" y="240" width="${W}" height="330" fill="url(#hazeG)"/>`

  // far hill with pines and the cabin
  const hillFar = 'M0 520C180 486 400 506 600 486S1000 470 1280 492L1280 720L0 720Z'
  const pines = []
  for (let x = 30; x < W; x += between(26, 60)) {
    if (x > 560 && x < 940) continue // keep the tree's background clear
    const t = x / W
    const yy = 512 - Math.sin(t * Math.PI * 1.6) * 14 + between(-3, 6)
    pines.push(pine(x, yy, between(0.8, 1.3)))
  }
  const cabinX = 1040
  const cabinY = 470
  const puffs = Array.from({ length: 7 }, (_, i) =>
    `<circle class="puff" cx="${cabinX + 46}" cy="${cabinY - 32}" r="9" style="animation-delay:-${f(i)}s"/>`).join('')
  const cabin = `<g>
<circle class="wglow" cx="${cabinX + 30}" cy="${cabinY + 6}" r="70" fill="url(#warm)"/>
<rect x="${cabinX + 40}" y="${cabinY - 34}" width="10" height="22" fill="#4a3428"/>
<rect x="${cabinX}" y="${cabinY}" width="64" height="40" fill="#7a4e33"/>
<path d="M${cabinX - 8} ${cabinY + 2}L${cabinX + 32} ${cabinY - 26}L${cabinX + 72} ${cabinY + 2}Z" fill="#3e2a22"/>
<path class="psnow" d="M${cabinX - 9} ${cabinY}L${cabinX + 32} ${cabinY - 28}L${cabinX + 73} ${cabinY}L${cabinX + 64} ${cabinY - 3}L${cabinX + 32} ${cabinY - 22}L${cabinX} ${cabinY - 3}Z"/>
<rect x="${cabinX + 8}" y="${cabinY + 12}" width="14" height="12" fill="#2c2a33"/><rect class="win" x="${cabinX + 8}" y="${cabinY + 12}" width="14" height="12"/>
<rect x="${cabinX + 40}" y="${cabinY + 12}" width="14" height="12" fill="#2c2a33"/><rect class="win" x="${cabinX + 40}" y="${cabinY + 12}" width="14" height="12"/>
<rect x="${cabinX + 26}" y="${cabinY + 20}" width="10" height="20" fill="#3e2a22"/>
<g class="smoke">${puffs}</g>
</g>`
  const hills = `<path class="hill-far" d="${hillFar}"/>
<path class="snowshade" d="M0 528C180 494 400 514 600 494S1000 478 1280 500L1280 720L0 720Z" opacity=".5"/>
${pines.join('')}${cabin}`

  const hillNear = 'M0 604C260 566 520 600 760 584S1120 560 1280 590L1280 720L0 720Z'
  const near = `<path class="hill-near" d="${hillNear}"/><path d="${hillNear}" fill="url(#groundG)"/>
<path class="snowfield" d="M0 600C260 562 520 596 760 580S1120 556 1280 586L1280 720L0 720Z"/>
<path class="snowshade" d="M0 640C300 620 600 650 900 630S1200 625 1280 640L1280 720L0 720Z" opacity=".55"/>`

  // the tree, its shadow, the leaf pile
  const pile = Array.from({ length: 46 }, () =>
    `<path d="${LEAF}" class="s${1 + Math.floor(rand() * 3)}" transform="translate(${f(TRUNK.x + between(-170, 170) * Math.sqrt(rand()))} ${f(TRUNK.y + between(-6, 14))}) rotate(${Math.round(between(0, 360))}) scale(${f(between(0.8, 1.2))})"/>`).join('')
  const tree = `<ellipse cx="${TRUNK.x + 30}" cy="${TRUNK.y + 4}" rx="210" ry="16" fill="#0b1a10" opacity=".22"/>
<g class="pile">${pile}</g>
${branch(TRUNK.x, TRUNK.y + 4, -Math.PI / 2, 164, 36, 0)}`

  // particles
  const petals = Array.from({ length: 28 }, () =>
    `<ellipse class="petal" cx="${f(between(520, 960))}" cy="${f(between(170, 400))}" rx="4.2" ry="2.6" style="animation-duration:${f(between(9, 14))}s;animation-delay:-${f(between(0, 14))}s"/>`).join('')
  const falling = Array.from({ length: 30 }, () =>
    `<g transform="translate(${f(between(520, 980))} ${f(between(180, 380))})"><path d="${LEAF}" class="tumble s${1 + Math.floor(rand() * 3)}" style="animation-duration:${f(between(8, 13))}s;animation-delay:-${f(between(0, 13))}s"/></g>`).join('')
  const flakes = Array.from({ length: 110 }, () => {
    const layer = pick([0, 1, 1, 2, 2, 2])
    const r = [3.6, 2.4, 1.4][layer]
    const dur = [9, 12.5, 17][layer] * between(0.85, 1.15)
    return `<circle class="flake" cx="${f(between(0, W))}" cy="${f(between(0, H))}" r="${r}" opacity="${[1, 0.85, 0.6][layer]}" style="animation-duration:${f(dur)}s;animation-delay:-${f(between(0, 17))}s"/>`
  }).join('')
  const motes = Array.from({ length: 26 }, () =>
    `<circle class="mote" cx="${f(between(380, 1100))}" cy="${f(between(330, 640))}" r="${f(between(1.2, 2.6))}" style="animation-duration:${f(between(8, 14))}s;animation-delay:-${f(between(0, 14))}s"/>`).join('')

  // grass + meadow flowers, swaying in six groups
  const groups = Array.from({ length: 6 }, () => [])
  for (let x = -10; x < W + 10; x += between(3, 7)) {
    const g = Math.min(5, Math.floor(((x + 10) / (W + 20)) * 6))
    const h = between(26, 64)
    groups[g].push(grassBlade(x, 722, h, between(-6, 10), rand() < 0.5 ? 'g1' : 'g2'))
    if (rand() < 0.08) {
      const col = pick(['#ffffff', '#ffe066', '#c9a2ff', '#ff9fb8'])
      groups[g].push(`<g class="flowers"><path d="M${f(x)} 722L${f(x + 2)} ${f(722 - h * 0.8)}" stroke="#4e8f3a" stroke-width="1.3"/><g transform="translate(${f(x + 2)} ${f(722 - h * 0.8)}) scale(${f(between(0.9, 1.4))})"><path d="${MEADOW}" fill="${col}"/><circle r="1.7" fill="#ffd84a"/></g></g>`)
    }
  }
  const grass = `<g class="grass">${groups.map((g, i) =>
    `<g class="gr" style="animation-duration:${f(between(3, 4.4))}s;animation-delay:-${f(i * 0.45)}s">${g.join('')}</g>`).join('')}</g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<style>${css}</style>
${defs}
${sky}
${clouds}
${birds}
${land}
${hills}
${near}
<g class="motes">${motes}</g>
${tree}
<g class="petals">${petals}</g>
<g class="falling">${falling}</g>
${grass}
<g class="snowfall">${flakes}</g>
<rect class="tint" width="${W}" height="${H}"/>
<rect width="${W}" height="${H}" fill="url(#vig)"/>
</svg>`
}

// ---- the four states -------------------------------------------------------------

export const SEASONS = [
  {
    id: 'spring', name: 'Spring', line: 'The buds are opening', ink: '#14324f',
    vars: {
      'sky-top': '#5b9fe6', 'sky-bottom': '#e9f5ff', sun: '#fff4c2', 'sun-glow': 0.75, 'sun-x': 1070, 'sun-y': 165,
      rays: 0.35, stars: 0, cloud: '#ffffff', 'cloud-shade': '#d9e7f4', clouds: 0.95, birds: 0.6,
      'mtn-far': '#9cb6d0', 'mtn-near': '#7f9fba', peaks: 0.85, haze: 0.55,
      'hill-far': '#9fd38a', 'hill-near': '#7cc463', pine: '#3d7a4a', glow: 0, smoke: 0,
      bark: '#5a3d2b', leaf1: '#9ad663', leaf2: '#74c24d', leaf3: '#c2e88a', 'leaves-a': 0.6, 'leaves-b': 0.15,
      blossom: 1, fruit: 0, 'fruit-c': '#d8342c', leafpile: 0,
      petals: 1, falling: 0, snow: 0, 'snow-ground': 0, motes: 0,
      grass: '#6cbd4c', grass2: '#94d76c', 'grass-op': 1, flowers: 1,
      tint: '#ffd6ea', 'tint-op': 0.06, wind: 0.6,
    },
  },
  {
    id: 'summer', name: 'Summer', line: 'Full green, a warm wind', ink: '#0d2741',
    vars: {
      'sky-top': '#2f86de', 'sky-bottom': '#cfeaff', sun: '#fff7d6', 'sun-glow': 1, 'sun-x': 975, 'sun-y': 90,
      rays: 0.6, stars: 0, cloud: '#ffffff', 'cloud-shade': '#e1edf8', clouds: 0.7, birds: 1,
      'mtn-far': '#8eb0c9', 'mtn-near': '#6d92ad', peaks: 0.3, haze: 0.5,
      'hill-far': '#7abd5a', 'hill-near': '#58a83c', pine: '#2c6838', glow: 0, smoke: 0,
      bark: '#4f3526', leaf1: '#3f8f3a', leaf2: '#2d7a31', leaf3: '#5cae47', 'leaves-a': 1, 'leaves-b': 1,
      blossom: 0, fruit: 1, 'fruit-c': '#d8342c', leafpile: 0,
      petals: 0, falling: 0, snow: 0, 'snow-ground': 0, motes: 0.9,
      grass: '#4f9e36', grass2: '#6fbd4f', 'grass-op': 1, flowers: 0.8,
      tint: '#ffe7a0', 'tint-op': 0.07, wind: 0.35,
    },
  },
  {
    id: 'autumn', name: 'Autumn', line: 'The leaves are falling', ink: '#3a1d0a',
    vars: {
      'sky-top': '#6d97c6', 'sky-bottom': '#f7d6a4', sun: '#ffd086', 'sun-glow': 0.9, 'sun-x': 1150, 'sun-y': 238,
      rays: 0.3, stars: 0, cloud: '#fff1e0', 'cloud-shade': '#e3c4a2', clouds: 0.9, birds: 0.7,
      'mtn-far': '#a79a9c', 'mtn-near': '#8b7c81', peaks: 0.55, haze: 0.6,
      'hill-far': '#c9a14c', 'hill-near': '#b78a3a', pine: '#3c5c38', glow: 0, smoke: 0.4,
      bark: '#4a3122', leaf1: '#e27a2a', leaf2: '#c7461b', leaf3: '#f3b33c', 'leaves-a': 1, 'leaves-b': 0.3,
      blossom: 0, fruit: 0, 'fruit-c': '#b8321f', leafpile: 1,
      petals: 0, falling: 1, snow: 0, 'snow-ground': 0, motes: 0.25,
      grass: '#b59a44', grass2: '#caae58', 'grass-op': 0.9, flowers: 0,
      tint: '#ff9a3c', 'tint-op': 0.08, wind: 1.05,
    },
  },
  {
    id: 'winter', name: 'Winter', line: 'Quiet and snow', ink: '#ffffff',
    vars: {
      'sky-top': '#1c2a52', 'sky-bottom': '#f3a678', sun: '#ff8a4a', 'sun-glow': 0.95, 'sun-x': 1090, 'sun-y': 440,
      rays: 0, stars: 0.95, cloud: '#8d90b4', 'cloud-shade': '#5c6389', clouds: 0.55, birds: 0,
      'mtn-far': '#59699a', 'mtn-near': '#44547e', peaks: 1, haze: 0.3,
      'hill-far': '#dfe6f3', 'hill-near': '#eef3fb', pine: '#29405a', glow: 1, smoke: 1,
      bark: '#36261f', leaf1: '#8a6d4b', leaf2: '#6d5236', leaf3: '#a38662', 'leaves-a': 0, 'leaves-b': 0,
      blossom: 0, fruit: 0, 'fruit-c': '#b8321f', leafpile: 0,
      petals: 0, falling: 0, snow: 1, 'snow-ground': 1, motes: 0,
      grass: '#8b9a7c', grass2: '#9aa98b', 'grass-op': 0.3, flowers: 0,
      tint: '#4b5cff', 'tint-op': 0.07, wind: 0.8,
    },
  },
]

/** The demo deck on top of an editor's base doc (theme, fonts, ids it expects). */
export function seasonsDeck(base) {
  const d = JSON.parse(JSON.stringify(base))
  d.title = 'Seasons'
  d.assets = { ...(d.assets ?? {}), tree: seasonsScene() }
  d.present = { ...(d.present ?? {}), morphSeconds: 2.2 }
  const font = d.theme?.fontFamily ?? 'system-ui, sans-serif'
  d.slides = SEASONS.map((s, i) => ({
    id: s.id, background: '#000000', transition: i === 0 ? 'fade' : 'morph', name: s.name,
    notes: 'One drawing (asset "tree") on every slide; only its vars change. Morph blends them, the wind keeps its rhythm.',
    elements: [
      {
        id: 'scene', type: 'svg', asset: 'tree', vars: s.vars, alt: `A tree in ${s.id}`,
        x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1,
        provenance: { origin: 'BeeSlides demo (scripts/lib/seasons-scene.mjs)', license: 'AGPL-3.0-or-later' },
      },
      {
        id: 'title', type: 'text', html: s.name, x: 72, y: 56, w: 600, h: 100, rotation: 0, opacity: 1,
        fontSize: 80, fontFamily: font, fontWeight: 800, color: s.ink,
        align: 'left', valign: 'top', lineHeight: 1.05, letterSpacing: -1,
      },
      {
        id: 'line', type: 'text', html: s.line, x: 76, y: 156, w: 600, h: 44, rotation: 0, opacity: 0.85,
        fontSize: 28, fontFamily: font, fontWeight: 500, color: s.ink,
        align: 'left', valign: 'top', lineHeight: 1.2,
      },
      ...[0, 1, 2, 3].map((k) => ({
        id: `dot${k}`, type: 'shape', shape: 'rect', fill: s.ink, stroke: 'none', strokeWidth: 0, radius: 6,
        x: 78 + k * 26, y: 222, w: 12, h: 12, rotation: 0, opacity: 0.35,
      })),
      {
        id: 'pill', type: 'shape', shape: 'rect', fill: s.ink, stroke: 'none', strokeWidth: 0, radius: 6,
        x: 74 + i * 26, y: 222, w: 20, h: 12, rotation: 0, opacity: 1,
      },
    ],
  }))
  return d
}
