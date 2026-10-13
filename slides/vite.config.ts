import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base './' so builds open from file:// or any static host.
//
// VIEWER=1 → the viewer-only shell (src/viewer.ts instead of src/main.ts): same
// index.html (splash, doc block — one markup source), no editor. The desktop app
// saves every deck into this shell (DECISIONS 2026-10-07).
//
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the BeeSlides document format.
const viewerEntry = {
  name: 'slidomingo-viewer-entry',
  // 'pre': the entry <script> is collected before normal-order hooks run
  transformIndexHtml: { order: 'pre' as const, handler: (html: string) => html.replace('/src/main.ts', '/src/viewer.ts') },
}

export default defineConfig({
  base: './',
  // The app version baked into every shipped shell — what update checks
  // compare against the release manifest. Single source: package.json.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    ...(process.env.VIEWER ? [viewerEntry] : []),
    ...(process.env.SINGLEFILE ? [viteSingleFile()] : []),
  ],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a BeeSlides file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
