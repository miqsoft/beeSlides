// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The `ui` a clip scenario drives the editor with, built on a raw CDP session
// so it runs the same in the desktop app and in the browser (lib/apps.mjs).
// Everything is done so a VIEWER can follow along: a cursor that glides to
// its target, a ripple on every click, a badge for every shortcut. Neither
// app draws a cursor into a screencast, so OVERLAY paints one; it is
// pointer-events:none in a shadow root and marked transient, so the app
// never sees it and never saves it.
//
// Targets are a CSS selector, or { css, text } for the first visible match
// whose text contains `text` (e.g. a menu row).

export const OVERLAY = `(() => {
  if (window.__beeOverlay) return; window.__beeOverlay = true
  const host = document.createElement('div')
  host.setAttribute('data-slidomingo-transient', '')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = \`<style>
    .cur{position:fixed;left:-40px;top:-40px;width:22px;height:22px;transform:translate(-3px,-2px);
      filter:drop-shadow(0 1px 2px rgb(0 0 0/.5));transition:transform .06s}
    .cur.down{transform:translate(-3px,-2px) scale(.88)}
    .rip{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
      border:3px solid #FFC233;animation:rip .5s ease-out forwards}
    @keyframes rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
    .keys{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);display:flex;gap:6px;
      transition:opacity .25s;opacity:0}
    .keys.on{opacity:1}
    .keys kbd{font:600 18px/1 system-ui,sans-serif;color:#17120A;background:#FFF6E0;
      border:1px solid #D97F00;border-bottom-width:3px;border-radius:7px;padding:8px 12px}
  </style>
  <svg class="cur" viewBox="0 0 22 22"><path d="M3 2l14 8.5-6.2 1.3L7.6 18z" fill="#fff" stroke="#17120A" stroke-width="1.4" stroke-linejoin="round"/></svg>
  <div class="keys"></div>\`
  document.documentElement.append(host)
  const cur = root.querySelector('.cur'), keys = root.querySelector('.keys')
  const at = (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px' }
  addEventListener('mousemove', at, true)
  addEventListener('mousedown', (e) => {
    at(e); cur.classList.add('down')
    const r = document.createElement('div'); r.className = 'rip'
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'
    root.append(r); setTimeout(() => r.remove(), 600)
  }, true)
  addEventListener('mouseup', () => cur.classList.remove('down'), true)
  let hide
  window.__beeKeys = (label) => {
    keys.innerHTML = label.split('+').map((k) => '<kbd>' + k + '</kbd>').join('')
    keys.classList.add('on'); clearTimeout(hide)
    hide = setTimeout(() => keys.classList.remove('on'), 1300)
  }
})()`

const KEY_LABEL = { Meta: '⌘', Control: 'Ctrl', Shift: '⇧', Alt: '⌥', Enter: '↵', Backspace: '⌫',
  ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' }
const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const NAMED = {
  Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'],
  Delete: [46, 'Delete'], ' ': [32, 'Space', ' '], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'],
  ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], F5: [116, 'F5'],
}
const keyInfo = (key) => {
  if (NAMED[key]) { const [vk, code, text] = NAMED[key]; return { key, code, vk, text } }
  if (key.length !== 1) throw new Error(`ui.press: unknown key "${key}"`)
  const up = key.toUpperCase()
  const code = /[A-Z]/.test(up) ? `Key${up}` : /[0-9]/.test(key) ? `Digit${key}` : ''
  return { key, code, vk: up.charCodeAt(0), text: key }
}

/** The driver handed to every step's run(). `pace` scales every pause; a
 *  --check run uses a fraction of real speed but never zero, or a step races
 *  the editor's re-render (a nudge landing on the slide before a duplicate). */
export function makeUi(cdp, { pace = 1, app, platform = process.platform, attachView } = {}) {
  let x = 640, y = 360
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = (ms) => (pace ? sleep(ms * pace) : Promise.resolve())

  async function evaluate(fn, arg) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text)
    return result.value
  }
  async function waitFor(fn, arg, { timeout = 8000, what = 'condition' } = {}) {
    const end = Date.now() + timeout
    for (;;) {
      const v = await evaluate(fn, arg)
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(60)
    }
  }
  /** Centre of the first visible match, scrolled into view. */
  const box = (target) => waitFor((t) => {
    const { css, text } = typeof t === 'string' ? { css: t } : t
    for (const el of document.querySelectorAll(css)) {
      if (text && !el.textContent.includes(text)) continue
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      if (r.width && r.height && getComputedStyle(el).visibility !== 'hidden') return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return null
  }, target, { what: JSON.stringify(target) })

  const mouse = (type, mx, my, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: mx, y: my, button: 'left', ...extra })
  const glide = async (tx, ty) => {
    const steps = pace ? Math.max(8, Math.round(Math.hypot(tx - x, ty - y) / 18)) : 3
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x + (tx - x) * i / steps, y + (ty - y) * i / steps, { button: 'none' })
      if (pace) await sleep(12)
    }
    x = tx; y = ty
  }
  const clickAt = async (cx, cy, count = 1) => {
    for (let c = 1; c <= count; c++) {
      await mouse('mousePressed', cx, cy, { clickCount: c, buttons: 1 })
      await mouse('mouseReleased', cx, cy, { clickCount: c, buttons: 0 })
    }
  }
  const realKey = (k) => (k === 'Mod' ? (platform === 'darwin' ? 'Meta' : 'Control') : k)
  // Modifiers go down and up as keys of their own, like a real keyboard: the
  // editor's selection tracks Shift from its keydown/keyup, so a Shift flag
  // without a Shift keyup leaves the next click a shift-click.
  const MOD_KEY = { Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91] }
  async function key(combo) {
    const parts = combo.split('+').map(realKey)
    const main = parts.pop()
    let modifiers = 0
    for (const m of parts) {
      modifiers |= MOD_BIT[m] ?? 0
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key: m, code: MOD_KEY[m][0], windowsVirtualKeyCode: MOD_KEY[m][1] })
    }
    const k = keyInfo(main)
    const text = modifiers & (MOD_BIT.Control | MOD_BIT.Meta) ? undefined : (parts.includes('Shift') ? k.text?.toUpperCase() : k.text)
    const base = { modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...base })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    for (const m of parts.reverse()) {
      modifiers &= ~(MOD_BIT[m] ?? 0)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: m, code: MOD_KEY[m][0], windowsVirtualKeyCode: MOD_KEY[m][1] })
    }
  }
  const badge = (combo) => pace && evaluate((l) => window.__beeKeys?.(l),
    combo.split('+').map(realKey).map((k) => KEY_LABEL[k] ?? k.toUpperCase()).join('+'))

  return {
    app, evaluate, waitFor, wait,
    /** Load a document into the open editor (setup, before recording). */
    async loadDoc(doc) {
      const ok = await evaluate((d) => window.slidomingo.loadDoc(JSON.stringify(d)), doc)
      if (!ok) throw new Error('window.slidomingo.loadDoc refused the scenario doc')
      await sleep(300)
    },
    async overlay() { await evaluate(`() => ${OVERLAY}`); await glide(x, y) },
    /** Glide to an element and click it. */
    async click(target, { hold = 350, count = 1 } = {}) {
      const p = await box(target)
      await glide(p.x, p.y); await wait(180)
      await clickAt(p.x, p.y, count); await wait(hold)
    },
    dblclick(target) { return this.click(target, { count: 2 }) },
    async hover(target, ms = 500) { const p = await box(target); await glide(p.x, p.y); await wait(ms) },
    /** Pick an option in a <select> (by value) after pointing at it. */
    async select(target, value) {
      const p = await box(target)
      await glide(p.x, p.y); await wait(300)
      await evaluate(({ t, v }) => {
        const { css, text } = typeof t === 'string' ? { css: t } : t
        const el = [...document.querySelectorAll(css)].find((e) => !text || e.textContent.includes(text))
        const sel = el?.matches('select') ? el : el?.querySelector('select')
        if (!sel) throw new Error('no <select> at ' + css)
        sel.value = v
        sel.dispatchEvent(new Event('input', { bubbles: true }))
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }, { t: target, v: value })
      await wait(500)
    },
    /** Select an element and slide it by (dx, dy) canvas px with ⇧+arrow
     *  nudges (10 px each). Use this to move ELEMENTS: synthetic drags do
     *  not drive the editor's Moveable control box
     *  (slides/src/editor/CLAUDE.md, "Testing the editor DOM"). */
    async nudge(target, dx, dy) {
      await this.click(target, { hold: 250 })
      for (const [n, k] of [[dx, dx < 0 ? 'ArrowLeft' : 'ArrowRight'], [dy, dy < 0 ? 'ArrowUp' : 'ArrowDown']]) {
        const times = Math.round(Math.abs(n) / 10)
        if (!times) continue
        await badge(`Shift+${k}`)
        for (let i = 0; i < times; i++) { await key(`Shift+${k}`); await wait(28) }
      }
      await wait(300)
    },
    /** Run a menu command by id (slides/src/editor/menumodel.ts) and show its
     *  path as a badge — e.g. command('play.inTab', 'Play ▸ Present in tab').
     *  For the desktop app's NATIVE menu, which no screencast can show; when a
     *  button or key does the job, click or press it instead. */
    async command(id, path, { hold = 600 } = {}) {
      if (pace) await evaluate((l) => window.__beeKeys?.(l), path)
      await wait(400)
      const ok = await evaluate((c) => window.slidomingo.menu.has(c) && (window.slidomingo.menu.run(c), true), id)
      if (!ok) throw new Error(`ui.command: no menu command ${id}`)
      await wait(hold)
    },
    /** Desktop: the Claude Code terminal panel as a second `ui` (type into it,
     *  read it). Open the panel first. The recorder records it too, beside
     *  the deck, from the moment it is attached. */
    async terminal() {
      if (!attachView) throw new Error('ui.terminal(): only in the desktop app')
      const tcdp = await attachView('terminal', (t) => t.url.includes('/renderer/terminal/'))
      const term = makeUi(tcdp, { pace, app, platform })
      // The panel's page may still be loading when its target appears.
      await term.waitFor(() => document.readyState === 'complete' && !!document.body, null, { timeout: 20000, what: 'the terminal page' })
      if (pace) await term.overlay()
      /** Text on screen in the terminal (xterm renders rows as DOM). */
      term.text = () => term.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? document.body.innerText)
      /** Wait for Claude Code to finish a turn: the screen has changed since
       *  the prompt was sent, then stayed still for quietMs. While Claude works
       *  its spinner and timers redraw every second, so stillness = idle (the
       *  TUI's own wording changes between versions; this doesn't). */
      term.waitForClaude = async ({ timeout = 600000, quietMs = 8000 } = {}) => {
        const end = Date.now() + timeout
        let last = await term.text(), started = false, stillSince = Date.now()
        while (Date.now() < end) {
          await sleep(500)
          const now = await term.text()
          if (now !== last) { started = true; last = now; stillSince = Date.now() }
          else if (started && Date.now() - stillSince >= quietMs) return
        }
        throw new Error('Claude did not finish in time')
      }
      return term
    },
    /** Press a shortcut ("Mod+D" = ⌘D on macOS, Ctrl+D elsewhere) and show it. */
    async press(combo, { hold = 600 } = {}) { await badge(combo); await key(combo); await wait(hold) },
    /** Type like a person would. */
    async type(text, { delay = 45 } = {}) {
      // insertText, not key events: punctuation has no reliable key code
      // (a "." sent as a key reads as Delete in a terminal).
      for (const ch of text) { await cdp.send('Input.insertText', { text: ch }); if (pace) await sleep(delay) }
      await wait(300)
    },
    /** Deselect everything so the panel shows the slide's settings. */
    async deselect() { await key('Escape'); await key('Escape'); await wait(300) },
    /** Move the cursor out of the way and let the result sit on screen. */
    async rest(ms = 600) {
      const { w, h } = await evaluate(() => ({ w: innerWidth, h: innerHeight }))
      await glide(w - 100, h - 40); await wait(ms)
    },
  }
}
