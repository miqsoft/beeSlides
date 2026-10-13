import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Document windows never build their own UI: every document window loads a
// real .beeslides.html file (or the slides/ dev server in dev mode) directly —
// the document IS the app, per BeeSlides's format. See src/main.
//
// The one narrow exception is `renderer/terminal`: chrome AROUND the
// document (same category as the native menu), not a document renderer —
// the Claude Code terminal panel's own bespoke UI (xterm.js + a small
// pop-out/dock/close header bar).
export default defineConfig({
  main: {
    // node-pty is a native addon (a .node file loaded via a runtime,
    // path-relative require) — Rollup bundling it into one file breaks that
    // require. externalizeDepsPlugin leaves node_modules deps as real
    // `require()`s instead, which is what a native addon needs.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: 'src/main/index.ts' },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: 'src/preload/index.ts', terminal: 'src/preload/terminal.ts' } },
    },
  },
  renderer: {
    root: 'src/renderer/terminal',
    build: {
      outDir: 'out/renderer/terminal',
      rollupOptions: { input: 'src/renderer/terminal/index.html' },
    },
  },
})
