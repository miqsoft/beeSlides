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

/** Designs waiting for a pick (variants previews). */
export type Choice = { slideId: string; labels: string[]; pngs: string[] }

/** One comment thread of the slide in view that is not done: open (Claude
 *  has it to do) or waiting for the user's check (Claude marked it fixed). */
export type Thread = { id: string; text: string; check: boolean; reply: string }

/** A comment of the user's that Claude has not been told about yet. `id`
 *  absent: the app could not save it in the deck, it goes as words only. */
export type Pending = { kind: 'add' | 'reopen'; slideId: string; text: string; id?: string }

declare module 'claude-code' {
  interface PluginState {
    beeslides: {
      deck: Shaped<Deck | null>
      /** slide id → its latest picture (PNG, base64). */
      shots: Shaped<Record<string, string>>
      /** The slide pictured last: the pane shows it unless one is chosen. */
      latest: Shaped<string | null>
      /** The slide the user swapped to; null = follow the latest. */
      view: Shaped<string | null>
      /** The deck's slide ids in order, from outline. */
      order: Shaped<string[]>
      /** The open threads of one slide (the one in view). */
      threads: Shaped<{ slideId: string; items: Thread[] } | null>
      /** The thread the comment field reopens, or null for a new comment. */
      reopening: Shaped<string | null>
      pending: Shaped<Pending[]>
      choice: Shaped<Choice | null>
      /** One line after a pick or a comment, or why it failed. */
      note: Shaped<string>
      /** What the agent did, oldest first: the pane's progress list. */
      log: Shaped<string[]>
    }
  }
}
