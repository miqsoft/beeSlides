#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One command from a fresh clone to an installed BeeSlides app.
//
//   npm run setup                    build everything, install the app
//   npm run setup -- --uninstall     remove the installed app (keeps your data)
//   npm run setup -- --dest <dir>    install into <dir> instead (macOS/Linux; tests)
//
// Run it again after `git pull` to update. Needs only Node and npm on macOS
// and Windows; Linux also needs a C/C++ toolchain, because node-pty (the
// terminal panel) has no prebuilt Linux binary.
//
// Where it installs:
//   macOS    /Applications/BeeSlides.app (~/Applications if that isn't writable)
//   Windows  the per-user installer: %LOCALAPPDATA%\Programs\BeeSlides,
//            Start menu entry, uninstall via Settings ▸ Apps
//   Linux    ~/.local/share/beeslides, a menu entry and ~/.local/bin/beeslides
//
// Nothing here is signed: an app you build yourself never carries the
// download quarantine, so macOS and Windows open it without a warning. The
// macOS bundle is ad-hoc signed, which Apple silicon requires to run at all.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The oldest Node every step supports: @electron/rebuild (Linux's node-pty
// build) needs 22.12; macOS happens to build on 20.19 too.
const MIN_NODE = [22, 12]
const APP = 'BeeSlides'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const slides = join(root, 'slides')
const desktop = join(root, 'desktop')
const release = join(desktop, 'release')
const win = process.platform === 'win32'
const mac = process.platform === 'darwin'
const linux = process.platform === 'linux'

const args = process.argv.slice(2)
const destArg = args.includes('--dest') ? args[args.indexOf('--dest') + 1] : null

function fail(msg) {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}

function step(n, total, what) {
  console.log(`\n[${n}/${total}] ${what}`)
}

/** Runs a command with live output; stops setup when it fails. */
function run(cmd, cmdArgs, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: win, env: { ...process.env, ...extraEnv } })
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (in ${cwd})`)
}

/** Runs a command quietly; true when it exits 0. */
function ok(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { stdio: 'ignore', shell: win }).status === 0
}

function has(tool) {
  return win ? ok('where', [tool]) : ok('sh', ['-c', `command -v ${tool}`])
}

// --- prerequisites -----------------------------------------------------------

function checkPrerequisites() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    fail(`BeeSlides needs Node ${MIN_NODE.join('.')} or newer; this is Node ${process.versions.node}.\n  Get the current LTS from https://nodejs.org (or \`nvm install\` here, which reads .nvmrc).`)
  }
  if (linux) {
    const missing = ['make', 'g++', 'python3'].filter((t) => !has(t))
    if (missing.length) {
      fail(`Missing ${missing.join(', ')} — needed to compile the terminal panel (node-pty).\n` +
        '  Debian/Ubuntu: sudo apt install build-essential python3\n' +
        '  Fedora:        sudo dnf install gcc-c++ make python3')
    }
  }
}

// --- install locations -------------------------------------------------------

function macAppsDir() {
  if (destArg) return resolve(destArg)
  try {
    accessSync('/Applications', constants.W_OK)
    return '/Applications'
  } catch {
    return join(homedir(), 'Applications')
  }
}

const linuxPaths = () => {
  const base = destArg ? resolve(destArg) : join(homedir(), '.local')
  return {
    appDir: join(base, 'share', 'beeslides'),
    bin: join(base, 'bin', 'beeslides'),
    desktopFile: join(base, 'share', 'applications', 'beeslides.desktop'),
  }
}

const winInstallDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', APP)

function dataDir() {
  if (mac) return join(homedir(), 'Library', 'Application Support', APP)
  if (win) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP)
}

/** Refuses to replace an app that is running: copying over a live bundle
 *  leaves it half old, half new. */
function ensureNotRunning(executable) {
  const running = win
    ? spawnSync('tasklist', ['/FI', `IMAGENAME eq ${APP}.exe`, '/NH'], { encoding: 'utf8', shell: true }).stdout?.includes(`${APP}.exe`)
    : ok('pgrep', ['-f', executable])
  if (running) fail(`${APP} is running. Quit it, then run this again.`)
}

// --- install -----------------------------------------------------------------

function installMac() {
  const built = readdirSync(release).filter((d) => d.startsWith('mac')).map((d) => join(release, d, `${APP}.app`)).find((p) => existsSync(p))
  if (!built) fail(`electron-builder produced no ${APP}.app in ${release}`)
  const appsDir = macAppsDir()
  const dest = join(appsDir, `${APP}.app`)
  ensureNotRunning(join(dest, 'Contents', 'MacOS'))
  mkdirSync(appsDir, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  run('ditto', [built, dest], root)
  // Apple silicon refuses to run code without a valid signature; ad-hoc
  // ("-") is enough for an app built on this machine.
  if (!ok('codesign', ['--verify', '--deep', dest])) run('codesign', ['--force', '--deep', '--sign', '-', dest], root)
  // Make Spotlight/Launchpad and "Open With" see it right away — but not a
  // --dest test copy, which would otherwise show up in "Open With".
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  if (!destArg && existsSync(lsregister)) ok(lsregister, ['-f', dest])
  return `${dest}\n  Open it from Launchpad, Spotlight or Finder ▸ Applications.`
}

function installLinux() {
  const built = readdirSync(release).map((d) => join(release, d)).find((p) => p.endsWith('-unpacked') && existsSync(join(p, 'beeslides')))
  if (!built) fail(`electron-builder produced no linux-unpacked app in ${release}`)
  const { appDir, bin, desktopFile } = linuxPaths()
  ensureNotRunning(join(appDir, 'beeslides'))
  rmSync(appDir, { recursive: true, force: true })
  mkdirSync(dirname(appDir), { recursive: true })
  cpSync(built, appDir, { recursive: true, verbatimSymlinks: true })
  cpSync(join(desktop, 'build', 'icon.png'), join(appDir, 'beeslides.png'))
  mkdirSync(dirname(bin), { recursive: true })
  rmSync(bin, { force: true })
  symlinkSync(join(appDir, 'beeslides'), bin)
  mkdirSync(dirname(desktopFile), { recursive: true })
  writeFileSync(desktopFile, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP}`,
    'Comment=Slides in one self-contained HTML file',
    `Exec="${join(appDir, 'beeslides')}" %F`,
    `Icon=${join(appDir, 'beeslides.png')}`,
    'Terminal=false',
    'Categories=Office;Presentation;',
    'MimeType=text/html;',
    `StartupWMClass=${APP}`,
    '',
  ].join('\n'))
  if (has('update-desktop-database')) ok('update-desktop-database', [dirname(desktopFile)])
  let note = `${appDir}\n  Find it in your applications menu, or run \`beeslides\` (${bin}).`
  // Chromium's sandbox needs either unprivileged user namespaces or a
  // setuid-root helper. Ubuntu 23.10+ restricts the former, and only root
  // can make the latter — say so instead of running sudo behind your back.
  const sandbox = join(appDir, 'chrome-sandbox')
  const restricted = (() => { try { return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1' } catch { return false } })()
  const setuidRoot = (() => { try { const s = statSync(sandbox); return s.uid === 0 && (s.mode & 0o4000) !== 0 } catch { return false } })()
  if (restricted && !setuidRoot) {
    note += `\n\n  This system restricts Chromium's sandbox. Once, as root:\n    sudo chown root:root "${sandbox}" && sudo chmod 4755 "${sandbox}"`
  }
  return note
}

function installWindows() {
  const installer = readdirSync(release).find((f) => f.endsWith('.exe') && f.includes('Setup'))
  if (!installer) fail(`electron-builder produced no installer in ${release}`)
  ensureNotRunning(`${APP}.exe`)
  // A one-click per-user installer: /S runs it silently.
  run(join(release, installer), ['/S'], release)
  return `${winInstallDir()}\n  Open it from the Start menu.`
}

// --- uninstall ---------------------------------------------------------------

function uninstall() {
  if (mac) {
    const dest = join(macAppsDir(), `${APP}.app`)
    if (!existsSync(dest)) fail(`${APP} is not installed in ${dirname(dest)}.`)
    ensureNotRunning(join(dest, 'Contents', 'MacOS'))
    rmSync(dest, { recursive: true, force: true })
  } else if (linux) {
    const { appDir, bin, desktopFile } = linuxPaths()
    ensureNotRunning(join(appDir, 'beeslides'))
    for (const p of [appDir, bin, desktopFile]) rmSync(p, { recursive: true, force: true })
  } else if (win) {
    const uninstaller = join(winInstallDir(), `Uninstall ${APP}.exe`)
    if (!existsSync(uninstaller)) fail(`${APP} is not installed in ${winInstallDir()}.`)
    ensureNotRunning(`${APP}.exe`)
    run(uninstaller, ['/S'], winInstallDir())
  }
  console.log(`\n✔ ${APP} is uninstalled. Your settings, drafts and backups are still in\n  ${dataDir()}\n  Delete that folder too to remove everything.`)
}

// --- main --------------------------------------------------------------------

if (!mac && !linux && !win) fail(`No installer for ${process.platform} yet.`)

if (args.includes('--uninstall')) {
  uninstall()
} else {
  const total = 5
  step(1, total, 'Checking prerequisites')
  checkPrerequisites()
  console.log(`  Node ${process.versions.node} on ${process.platform}-${process.arch}`)

  step(2, total, 'Installing dependencies')
  run('npm', ['ci', '--no-audit', '--no-fund'], slides)
  run('npm', ['ci', '--no-audit', '--no-fund'], desktop)

  step(3, total, 'Building the editor (the single-file BeeSlides.beeslides.html)')
  run('npm', ['run', 'build:single'], slides)

  step(4, total, 'Building the desktop app')
  run('npm', ['run', 'build'], desktop)
  rmSync(release, { recursive: true, force: true })
  // electronDist: package the Electron that `npm ci` just downloaded
  // instead of fetching it a second time.
  const target = win ? ['--win', 'nsis'] : ['--dir']
  run('npx', ['electron-builder', ...target, '--publish', 'never', '-c.electronDist=node_modules/electron/dist'], desktop, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })

  step(5, total, `Installing ${APP}`)
  const where = mac ? installMac() : linux ? installLinux() : installWindows()
  console.log(`\n✔ ${APP} is installed: ${where}`)
  console.log(`\n  The single-file editor is also at\n  ${join(slides, 'dist-single', 'BeeSlides.beeslides.html')}\n  — open it in any browser, no install needed.`)
  console.log('\n  To update: git pull, then npm run setup again. To remove: npm run setup -- --uninstall')
}
