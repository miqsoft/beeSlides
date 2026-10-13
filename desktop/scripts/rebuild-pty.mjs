#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// desktop's postinstall: compile node-pty for Electron only where it has to be.
//
// node-pty 1.x is a Node-API addon and ships prebuilt binaries for macOS and
// Windows (node_modules/node-pty/prebuilds/<platform>-<arch>). Node-API is
// ABI-stable, so those load in Electron as they are, and a compiler (Xcode
// tools, Visual Studio Build Tools) is not needed there. Everywhere else
// (Linux) node-pty is compiled from source, against Electron.
//
// node-pty 1.1.0's npm package ships the macOS prebuilds' spawn-helper
// without its executable bit, and every terminal then fails with
// "posix_spawnp failed" — so restore it.

import { chmodSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const prebuild = join(desktop, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)

if (existsSync(join(prebuild, 'pty.node'))) {
  if (existsSync(join(prebuild, 'spawn-helper'))) chmodSync(join(prebuild, 'spawn-helper'), 0o755)
  console.log(`node-pty: using the prebuilt ${process.platform}-${process.arch} binary`)
} else {
  const r = spawnSync('electron-rebuild', ['-f', '-w', 'node-pty'], { cwd: desktop, stdio: 'inherit', shell: true })
  process.exit(r.status ?? 1)
}
