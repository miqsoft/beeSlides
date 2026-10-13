#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Attached-folders rig.
//
//   node scripts/test-desktop-attachedfolders.ts
//
// WHAT THIS PROVES. A deck's AI chats can be given extra folders to read
// (desktop/src/main/attachedfolders.ts, apichat/filetools.ts, the launch line
// in claudeLaunch.ts). Each check is one way that could go wrong: a folder
// listed under the wrong deck or lost when the deck is saved/renamed, a path
// reaching the shell command line, a symlink or `..` leading out of an
// attached folder, a secret file or binary being read, or the list ending up
// somewhere a shared deck could carry it.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFolder, existingFolders, listFolders, MAX_FOLDERS, removeFolder, retargetFolders, validateFolder } from '../desktop/src/main/attachedfolders.ts'
import { ADD_DIR_ENV_PREFIX, claudeLaunchCommand } from '../desktop/src/main/claudeLaunch.ts'
import { FILE_TOOLS, foldersNote, runFileTool } from '../desktop/src/main/apichat/filetools.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'attachedfolders-')))
const store = join(root, 'attached-folders.json')
const dir = (...p: string[]): string => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d }

// ---- the store -------------------------------------------------------------
console.log('store')
const research = dir('research')
const notes = dir('research', 'notes')
const data = dir('data')
const A = { docId: 'doc-a', path: '/decks/a.beeslides.html' }
const B = { docId: 'doc-b', path: '/decks/b.beeslides.html' }

ok(listFolders(store, A).length === 0, 'a deck with nothing attached lists nothing (and a missing store is fine)')
ok(validateFolder(research).ok, 'an existing folder validates')
ok(!validateFolder(join(root, 'nope')).ok, 'a missing folder is refused')
ok(!validateFolder(join(root, 'research', '..', 'research', 'x.txt')).ok, 'a path that is not a folder is refused')
ok(!validateFolder('relative/dir').ok && !validateFolder('').ok && !validateFolder(42).ok, 'relative, empty and non-string paths are refused')
ok(!validateFolder('/').ok, 'the filesystem root is refused')
const link = join(root, 'link-to-data')
symlinkSync(data, link)
const viaLink = validateFolder(link)
ok(viaLink.ok && viaLink.path === data, 'a symlinked folder is stored as its real path')

ok(addFolder(store, A, research).ok && listFolders(store, A).join() === research, 'a folder is attached to its deck')
ok(listFolders(store, B).length === 0, "…and is not on another deck")
ok(addFolder(store, A, research).ok && listFolders(store, A).length === 1, 'attaching the same folder twice is a no-op')
ok(addFolder(store, A, notes).ok && listFolders(store, A).length === 1, 'a folder inside an attached one is a no-op')
addFolder(store, A, data)
addFolder(store, A, root)
ok(listFolders(store, A).join() === root, 'attaching a parent absorbs its children')
removeFolder(store, A, root)
ok(listFolders(store, A).length === 0, 'a folder can be detached')
ok(!addFolder(store, { docId: null, path: null }, research).ok, 'a deck with no identity yet cannot take a folder')
for (let i = 0; i < MAX_FOLDERS; i++) addFolder(store, B, dir('many', String(i)))
const over = addFolder(store, B, dir('many', 'one-too-many'))
ok(!over.ok && listFolders(store, B).length === MAX_FOLDERS, `at most ${MAX_FOLDERS} folders per deck`)

// identity: a draft (path only) is saved and gets a docId + a new path
const draft = { docId: null, path: '/userData/Drafts/untitled.beeslides.html' }
addFolder(store, draft, research)
ok(listFolders(store, draft).join() === research, 'a draft keeps its folders by its bound path')
const saved = { docId: 'doc-d', path: '/decks/saved.beeslides.html' }
ok(listFolders(store, saved).length === 0, 'before the identity is reported the saved deck does not see them')
retargetFolders(store, { docId: 'doc-d', path: draft.path })
ok(listFolders(store, saved).join() === research, 'once the docId is reported, the folders follow the deck')
const renamed = { docId: 'doc-d', path: '/decks/renamed.beeslides.html' }
ok(listFolders(store, renamed).join() === research, 'a rename or move (same docId) keeps them')

// the file is local metadata: it names no deck CONTENT and lives apart from any deck
const raw = readFileSync(store, 'utf8')
ok(raw.includes(research), 'the store is where the absolute paths live')
ok(existingFolders([research, join(root, 'gone')]).join() === research, 'a folder that vanished is listed but not launched with')

// ---- the launch line -------------------------------------------------------
console.log('launch line')
const chat = { id: '11111111-1111-4111-8111-111111111111', resume: false }
const line = claudeLaunchCommand('ctx', 'ctx/session-1', chat, undefined, true, 'claude', 2)
ok(line.includes(`--add-dir "$${ADD_DIR_ENV_PREFIX}1"`) && line.includes(`--add-dir "$${ADD_DIR_ENV_PREFIX}2"`), 'each folder is its own --add-dir, expanded from an env var')
ok(!line.includes(`$${ADD_DIR_ENV_PREFIX}3`), '…exactly as many as there are folders')
ok(!line.includes(root), 'no path is ever spliced into the command line')
ok(!claudeLaunchCommand('c', 'c/s', chat).includes(ADD_DIR_ENV_PREFIX), 'no attached folders: no extra flags (existing behaviour unchanged)')
ok(!claudeLaunchCommand('c', 'c/s', chat, undefined, false, 'claude', -3).includes(ADD_DIR_ENV_PREFIX), 'a nonsense count adds nothing')

// ---- the file tools --------------------------------------------------------
console.log('file tools')
const attached = dir('attached')
const outside = dir('outside')
writeFileSync(join(attached, 'brief.md'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}${i === 700 ? ' needle-here' : ''}`).join('\n'))
writeFileSync(join(attached, '.env'), 'API_KEY=hunter2')
writeFileSync(join(attached, 'server.pem'), 'PRIVATE')
writeFileSync(join(attached, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
mkdirSync(join(attached, 'sub'))
writeFileSync(join(attached, 'sub', 'a.txt'), 'alpha needle\nbeta')
mkdirSync(join(attached, 'node_modules'))
writeFileSync(join(attached, 'node_modules', 'skip.txt'), 'needle in node_modules')
writeFileSync(join(outside, 'secret.txt'), 'outside needle')
symlinkSync(outside, join(attached, 'escape'))
symlinkSync(join(outside, 'secret.txt'), join(attached, 'escape-file'))
const F = [attached]

ok(FILE_TOOLS.map((t) => t.name).join() === 'list_dir,read_file,grep_files', 'three tools, all read-only (no write/shell tool exists)')
ok(runFileTool(F, 'list_dir', {}).text.includes(attached), 'list_dir with no path shows the attached folders')
const ls = runFileTool(F, 'list_dir', { path: attached })
ok(ls.text.includes('brief.md') && ls.text.includes('sub/'), 'list_dir lists files and marks folders')

const r1 = runFileTool(F, 'read_file', { path: join(attached, 'brief.md') })
ok(!r1.isError && r1.text.startsWith('line 1\n') && r1.text.includes('call read_file again with offset 401'), 'read_file returns a window and says how to continue')
const r2 = runFileTool(F, 'read_file', { path: join(attached, 'brief.md'), offset: 701 })
ok(r2.text.startsWith('line 701 needle-here'), 'read_file continues at the given 1-based offset')
ok(runFileTool(F, 'read_file', { path: 'sub/a.txt' }).text.startsWith('alpha'), 'a relative path is taken from the first attached folder')

ok(runFileTool(F, 'read_file', { path: join(outside, 'secret.txt') }).isError, 'a file outside the attached folders is refused')
ok(runFileTool(F, 'read_file', { path: join(attached, '..', 'outside', 'secret.txt') }).isError, 'a ".." path out of the folder is refused')
ok(runFileTool(F, 'read_file', { path: join(attached, 'escape-file') }).isError, 'a symlink to a file outside is refused')
ok(runFileTool(F, 'list_dir', { path: join(attached, 'escape') }).isError, 'a symlink to a folder outside is refused')
ok(runFileTool(F, 'read_file', { path: join(attached, '.env') }).isError, '.env is refused (secrets go to a third-party model)')
ok(runFileTool(F, 'read_file', { path: join(attached, 'server.pem') }).isError, 'key files are refused')
ok(/binary/.test(runFileTool(F, 'read_file', { path: join(attached, 'logo.png') }).text), 'a binary file is refused')
ok(runFileTool(F, 'read_file', { path: 123 as unknown as string }).isError, 'a non-string path is refused')

const g = runFileTool(F, 'grep_files', { pattern: 'NEEDLE' })
ok(g.text.includes('brief.md:701') && g.text.includes('a.txt:1'), 'grep_files finds matches, case-insensitively, with file:line')
ok(!g.text.includes('node_modules') && !g.text.includes('outside needle') && !g.text.includes('hunter2'), '…skipping node_modules, symlinks out, and secret files')
ok(runFileTool(F, 'grep_files', { pattern: 'needle', path: outside }).isError, 'grep_files outside the folders is refused')
ok(runFileTool(F, 'grep_files', { pattern: '(' }).isError, 'a bad regular expression is an error, not a crash')
ok(runFileTool(F, 'grep_files', { pattern: 'zzzz-nothing' }).text === 'No matches.', 'no match says so')
ok(runFileTool([], 'list_dir', {}).isError && runFileTool([join(root, 'gone')], 'list_dir', {}).isError, 'with no (live) attached folder every tool errors')
ok(foldersNote(F).includes(attached) && /never write/.test(foldersNote(F)), 'the system-prompt note names the folders and says read-only')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
