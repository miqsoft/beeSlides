// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Live steps of a continuous edit (a colour drag, a gradient-stop drag,
// typing in a chart cell): every step mutates the model and emits 'doc', so
// the value shows while it changes. Redrawing the whole canvas — and the
// props panel — on every one of those steps costs a full render per input
// event, and input events can arrive faster than frames.
//
// A burst editor runs each NON-final step's notification inside `liveStep`;
// the expensive redraw listeners (SlideCanvas.render, PropsPanel.rebuild) ask
// `inLiveStep()` and, if so, schedule their redraw for the next animation
// frame instead of doing it now — at most one per frame. Everything else
// stays synchronous:
//   - the FINAL step of a burst and every ordinary commit/undo are not live
//     steps, so code that reads the DOM right after a commit still sees it;
//   - a synchronous redraw cancels a scheduled one (the frame never draws
//     stale state over fresh), and selection/slide switches flush it.
// The model itself is always current; only the drawing waits for the frame.

let depth = 0

/** Run `notify` (the burst editor's store.touch()) as a live step unless
 *  `final`. A final step runs it plainly — the synchronous path. */
export function liveStep(final: boolean, notify: () => void): void {
  if (final) { notify(); return }
  depth++
  try { notify() } finally { depth-- }
}

/** True while a live (non-final) step's 'doc' listeners run. */
export function inLiveStep(): boolean {
  return depth > 0
}

/** One redraw, at most once per animation frame: `schedule` draws at the next
 *  frame, `cancel` drops a scheduled draw (the synchronous draw calls it
 *  first), `pending` says one is waiting. */
export class FrameCoalescer {
  private frame = 0

  constructor(private draw: () => void) {}

  get pending(): boolean {
    return this.frame !== 0
  }

  schedule(): void {
    // a hidden page gets no animation frames at all: draw now, as before
    if (document.visibilityState === 'hidden') { this.cancel(); this.draw(); return }
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  /** Drop a scheduled redraw — call this at the top of the synchronous draw. */
  cancel(): void {
    if (!this.frame) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }
}
