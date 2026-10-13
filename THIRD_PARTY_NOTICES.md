# Third-party notices

BeeSlides is licensed under AGPL-3.0-or-later with an additional
permission for documents (© 2026 The BeeSlides authors; see `LICENSE` and
`LICENSING.md`). Code reused from Bento
(<https://github.com/nyblnet/bento>) remains under the MIT License (Copyright (c) 2026 The Bento authors; full
text in `LICENSING.md`). The shippable single-file shell (`BeeSlides.beeslides.html`) bundles the
following third-party open-source components. Their license terms require that
these notices accompany copies, so the same text is embedded as a `NOTICE`
comment near the top of every built shell and every saved BeeSlides document.

## Bundled runtime (ships inside the shell)

### reveal.js
- License: MIT
- Copyright (C) 2011-2024 Hakim El Hattab, http://hakim.se, and reveal.js contributors
- Project: https://revealjs.com / https://github.com/hakimel/reveal.js
- Use: powers the present-mode fullscreen slideshow overlay.

### Moveable
- License: MIT
- Copyright (c) 2019 Daybrush (Younkue Choi)
- Project: https://github.com/daybrush/moveable
- Use: on-canvas element manipulation (drag / resize / rotate handles). Pulls in
  the author's supporting modules (`@daybrush/*`, `@scena/*`, `@egjs/*`,
  `@cfcs/*`), all MIT, © Daybrush.

### Selecto
- License: MIT
- Copyright (c) 2020 Daybrush (Younkue Choi)
- Project: https://github.com/daybrush/selecto
- Use: marquee / rubber-band selection on the editing canvas.

### Temml
- License: MIT
- Copyright (c) 2020 Ron Kok
- Project: https://temml.org / https://github.com/ronkok/Temml
- Use: typesets LaTeX to MathML — `$…$` math in text and table cells and the
  equation element (`slides/src/math.ts`). Also in the viewer-only runtime.

## Desktop app only (not in the shell or in saved documents)

These ship only inside the desktop app (`desktop/`). A packaged build also
carries Electron's own `LICENSE` and `LICENSES.chromium.html` (the Chromium
and Node.js notices), which electron-builder copies in automatically.

### Electron
- License: MIT
- Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- Project: https://www.electronjs.org / https://github.com/electron/electron
- Use: the desktop shell.

### xterm.js (`@xterm/xterm`, `@xterm/addon-fit`)
- License: MIT
- Copyright (c) 2017-2019, The xterm.js authors; Copyright (c) 2014-2016,
  SourceLair Private Company
- Project: https://github.com/xtermjs/xterm.js
- Use: the terminal panel.

### node-pty
- License: MIT
- Copyright (c) 2012-2015, Christopher Jeffrey
- Project: https://github.com/microsoft/node-pty
- Use: the terminal panel's shell process. Pulls in `node-addon-api` (MIT).

### Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- License: MIT
- Copyright 2023 Anthropic, PBC.
- Project: https://github.com/anthropics/anthropic-sdk-typescript
- Use: the AI chat, for Anthropic-compatible endpoints. Pulls in
  `json-schema-to-ts`, `ts-algebra` and `@babel/runtime` (all MIT).

### OpenAI Node SDK (`openai`)
- License: Apache License 2.0
- Copyright 2026 OpenAI
- Project: https://github.com/openai/openai-node
- Use: the AI chat, for OpenAI-compatible endpoints. Pulls in
  `standardwebhooks`, `@stablelib/base64`, `base64-js` (MIT) and
  `fast-sha256` (Unlicense).

### undici
- License: MIT
- Copyright (c) Matteo Collina and Undici contributors
- Project: https://github.com/nodejs/undici
- Use: HTTP client used by the desktop main process.

### Zopfli (`@gfx/zopfli`)
- License: Apache License 2.0
- Copyright 2011 Google Inc. (Zopfli); 2017 FUJI Goro (the `@gfx/zopfli`
  WebAssembly build)
- Project: https://github.com/google/zopfli / https://github.com/gfx/universal-zopfli-js
- Use: re-packing PNG pixel data for "Optimize pictures (lossless)…".

## Bundled fonts (embedded as document assets in decks that use them)

### Fraunces
- License: SIL Open Font License 1.1
- Copyright 2020 The Fraunces Project Authors
- Project: https://github.com/undercasetype/Fraunces

### Instrument Sans
- License: SIL Open Font License 1.1
- Copyright 2022 The Instrument Sans Project Authors
- Project: https://github.com/Instrument/instrument-sans

---

Full MIT license text is reproduced in the shell's `NOTICE` comment and in the
`LICENSE` file. The SIL Open Font License 1.1 text is available at
https://openfontlicense.org.

Dev-only tooling (Vite, TypeScript, `vite-plugin-singlefile`, esbuild,
electron-vite, electron-builder, `fake-indexeddb`, `@types/*`) is used to build BeeSlides but is **not** bundled into the shipped shell
and is therefore not listed here.
