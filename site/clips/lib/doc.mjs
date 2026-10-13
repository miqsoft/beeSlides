// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Tiny builders for the decks a clip starts from (docs/format.md is the spec).
// A clip that starts from a prepared deck shows only the steps it teaches.

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const deck = (slides, title = 'Demo') => ({
  format: 'slidomingo/slides', version: 1, title,
  size: { width: 1280, height: 720 },
  theme: { background: '#17120A', color: '#FFF6E0', accent: '#FFC233', fontFamily: FONT },
  slides: slides.map((elements, i) => ({ id: `s${i + 1}`, background: '#17120A', transition: 'fade', notes: '', elements })),
})

export const text = (id, html, x, y, w, h, extra = {}) => ({
  id, type: 'text', x, y, w, h, rotation: 0, opacity: 1, html,
  fontSize: 56, fontFamily: FONT, fontWeight: 800, color: '#FFF6E0',
  align: 'left', valign: 'top', lineHeight: 1.1, ...extra,
})

export const shape = (id, shape, x, y, w, h, fill, extra = {}) => ({
  id, type: 'shape', shape, x, y, w, h, rotation: 0, opacity: 1, fill, stroke: 'none', strokeWidth: 0, ...extra,
})

/** Selector for an element on the editor canvas. */
export const el = (id) => `.ed-canvas-wrap [data-el-id="${id}"]`
