// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Per-app identity for the kernel. Every BeeSlides app calls configureApp() once,
// first thing at boot, before any kernel module is used.
//
// Only two values are app-specific across the whole kernel: the id used in
// window titles/save dialogs, and the display name. Everything else in the
// kernel is genuinely app-agnostic.
//
// Deliberately NOT a general "kernel init" — modules that need no config
// (anim, charts) take none, so there is no import-order trap and no false
// coupling for apps that skip a module. `autosave` is the one exception and
// reads appConfig() LAZILY, inside openDb(), for exactly that reason: its
// IndexedDB database is named per app, and resolving that at module scope
// would make importing it before configureApp() throw.

export interface AppConfig {
  /** Per-app id — used for autosave DB naming and elsewhere apps need a
   *  stable, distinct identity. */
  appId: string
  /** Human-facing product name: window title suffix, save-picker label. */
  appName: string
}

let config: AppConfig | null = null

/** Called once at boot, before kernel modules are used. */
export function configureApp(cfg: AppConfig): void {
  config = cfg
  announceRuntime()
}

declare const __APP_VERSION__: string

/** Version of the running app shell (baked in at build from package.json). */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

/**
 * Tell a HOST which BeeSlides runtime this document carries.
 *
 * A host that polyfills `showSaveFilePicker` (home/webext) must know whether
 * this document is old enough to predate `pickerIdFor` (#213). Before that,
 * every save — including "Save a copy…" — sent `beeslides-doc`, so acting on the id
 * there overwrites the open document. The host therefore refuses to write in
 * place unless the runtime says it is at least 1.0.15.
 *
 * The bug this fixes: the signal used to live in a per-app object assembled
 * by hand, and one app forgot it entirely, so its ⌘S fell back to a
 * destination prompt even with a folder granted. Every app calls
 * `configureApp`, so the version is announced here, once, and the next app
 * gets it without knowing this exists.
 *
 * Deliberately a plain string on `window`, not a getter or an object: a host
 * reads it from the page's world through a content script, and the simplest
 * possible value is the one least likely to be mangled crossing that boundary.
 */
function announceRuntime(): void {
  try {
    Object.defineProperty(window, '__slidomingoRuntime', {
      value: APP_VERSION, writable: false, configurable: true, enumerable: false,
    })
  } catch {
    /* already defined (a second configureApp in tests), or no window at all */
  }
}

/** The active app config. Throws if the app forgot to configure itself —
 *  a loud failure at boot beats silently misconfigured window titles. */
export function appConfig(): AppConfig {
  if (!config) throw new Error('slidomingo kernel: configureApp() was never called')
  return config
}
