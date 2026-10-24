// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides pane's values in $.state (hooks/register.tsx).

/** The deck the chat works on, from doc_info / open_deck. */
export type Deck = {
  title: string
  file: string
  /** A hidden BeeSlides instance (no window): the pane is all the user sees. */
  background: boolean
  /** Slide size, for the pictures' shape. */
  width: number
  height: number
}

/** The latest slide screenshot (review_slide, render_preview). */
export type Shot = { png: string; slideId: string }

/** Designs waiting for a pick (variants previews). */
export type Choice = { slideId: string; labels: string[]; pngs: string[] }

declare module 'claude-code' {
  interface PluginState {
    beeslides: {
      deck: Shaped<Deck | null>
      shot: Shaped<Shot | null>
      choice: Shaped<Choice | null>
      /** One line after a pick, or why it failed. */
      note: Shaped<string>
    }
  }
}
