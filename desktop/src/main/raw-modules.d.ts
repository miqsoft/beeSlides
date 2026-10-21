// electron-vite's main-process build goes through the same Vite pipeline as
// the renderer, so a `?raw` import (used by terminalPanel.ts to bundle
// docs/format.md + docs/agents.md straight into the built main.js — no
// separate copy-at-build step) resolves at build time. TypeScript itself
// doesn't know this suffix convention, hence this ambient declaration.
declare module '*.md?raw' {
  const content: string
  export default content
}

// Same trick, for terminalPanel.ts bundling ../mcp/slides-mcp-server.mjs
// straight into the built main.js and writing it out per-window.
declare module '*.mjs?raw' {
  const content: string
  export default content
}

// electron-vite: `import create from './x.ts?nodeWorker'` bundles x.ts as its
// own worker-thread entry and returns a factory (pictures.ts).
declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'
  export default function (options: WorkerOptions): Worker
}

// The selection digest is a standalone hook script that main also imports.
declare module '*selection-digest.mjs' {
  export function digest(ctx: unknown, self?: string): string
}
