---
title: The file format
description: What is inside a .beeslides.html file, and why old files keep opening.
sidebar: { order: 2 }
---

A `.beeslides.html` file is an ordinary web page made of three parts:

1. **The document**: a plaintext JSON block, `<script type="application/json" id="beeslides-doc">`,
   near the top of the file. It holds every slide, element, note and comment.
   Pictures and fonts sit in an asset store beside it.
2. **A preview**: a static picture of the first slide, so file managers and
   browsers with JavaScript switched off still show something.
3. **The app**: the compressed viewer, presenter and editor.

When you save, only the document block is rewritten. Everything else stays
byte-for-byte the same.

## Promises the format keeps

- The document block is always plaintext and always found by the same id.
  Old files and outside tools can always read and replace it.
- A document's `docId` never changes.
- Unknown keys are ignored, never fatal. A newer file that needs features an
  older app lacks opens read-only rather than getting mangled.
- An encrypted deck carries no plaintext preview.

Files saved before October 2026 use BeeSlides' original working name inside
the file (`slidomingo/slides`, `#slidomingo-doc`). They still open, and take
the new names the next time they are saved.

## Specs

- [Format reference](https://github.com/miqsoft/beeslides/blob/main/docs/format.md):
  every element type, slide, state and layout. This is the normative spec.
- [Architecture](https://github.com/miqsoft/beeslides/blob/main/docs/architecture.md):
  how a file is built and how the runtime is laid out.
- [Security](https://github.com/miqsoft/beeslides/blob/main/docs/security.md):
  the file as the security boundary, encryption, offline mode.
