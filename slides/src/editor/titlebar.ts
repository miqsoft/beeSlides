// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: the single merged title-bar row that replaces the OS
// title bar (Electron `titleBarStyle: 'hiddenInset'` — see
// desktop/src/main/windows.ts) instead of stacking a second bar below it.
//
// Pure layout, like ribbon.ts: every node it arranges is already built and
// wired by Editor.buildDesktopChrome() (where `this` is available); this
// file never imports Editor's type or calls a private method.

export interface TitlebarOpts {
  /** Left cluster, next to the traffic-light gap — e.g. [saveGroup, undoB, redoB]. */
  quickAccess: HTMLElement[]
  /** The deck-title <input> Editor already built and wired (live remote-sync
   *  reflect, commit-on-change) — handed over as a finished element so that
   *  wiring is never duplicated. */
  titleInput: HTMLElement
  /** Right cluster, before the logo — e.g. [avatarsBox, shareDropdown, presentButton, updatesChip]. */
  rightCluster: HTMLElement[]
  /** The shrunk 20×20 logo mark, click already wired to open About — the
   *  wordmark text is dropped, but this stays the one surviving entry point
   *  to it (Help's '?' opens shortcuts, not About). */
  logo: HTMLElement
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

/** Builds the title-bar row into `container` and returns it. */
export function buildTitlebar(container: HTMLElement, opts: TitlebarOpts): HTMLElement {
  const bar = div('ed-titlebar')

  const quick = div('ed-titlebar-quick')
  quick.append(...opts.quickAccess)

  const titleWrap = div('ed-titlebar-title')
  titleWrap.appendChild(opts.titleInput)

  const right = div('ed-titlebar-right')
  right.append(...opts.rightCluster, opts.logo)

  bar.append(quick, titleWrap, right)
  container.appendChild(bar)
  return bar
}
