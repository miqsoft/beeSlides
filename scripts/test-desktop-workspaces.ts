#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Claude workspace rig.   node scripts/test-desktop-workspaces.ts
//
// The Claude panel runs in an app-owned folder per deck, not the deck's folder
// (desktop/src/main/workspaces.ts). Each check is one way that could go wrong:
// a deck mapped to a shared/unsafe folder, a live or recent workspace swept
// away, or the sweep touching ~/.claude.json entries that are not ours.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkill } from '../desktop/src/main/apichat/skills.ts'
import { ensureWorkspace, isUntitledKey, sweepWorkspaces, workspaceKey, WORKSPACE_MAX_AGE_MS } from '../desktop/src/main/workspaces.ts'
import { ensureClaudeTrust, removeClaudeTrust } from '../desktop/src/main/claudeTrust.ts'
import { backfillChats, loadRecords, projectDirName } from '../desktop/src/main/chathistory.ts'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'slidomingo-ws-'))
const root = join(tmp, 'claude-workspaces')
const config = join(tmp, 'claude.json')
writeFileSync(config, JSON.stringify({ numStartups: 3, projects: {} }))

// keys
ok(workspaceKey('abc-123_X', 4) === 'abc-123_X', 'a docId is the workspace key')
ok(workspaceKey(null, 4) === 'untitled-4', 'no docId → per-window untitled key')
ok(workspaceKey('../../etc', 4) === 'untitled-4', 'a path-like docId never becomes a path')
ok(workspaceKey('a/b', 4) === 'untitled-4' && workspaceKey('', 4) === 'untitled-4', 'separators/empty rejected')
ok(isUntitledKey('untitled-4') && !isUntitledKey('abc'), 'untitled detection')

// ensure + sweep
const day = 24 * 3600 * 1000
const deckWs = ensureWorkspace(root, 'deck-fresh', 'a.beeslides.html', true)
ok(existsSync(join(deckWs, 'CLAUDE.md')) && readFileSync(join(deckWs, 'CLAUDE.md'), 'utf8').includes('a.beeslides.html'), 'workspace created with an orientation CLAUDE.md')
const old = ensureWorkspace(root, 'deck-old', null, false)
const live = ensureWorkspace(root, 'deck-live-old', null, false)
const untitled = ensureWorkspace(root, 'untitled-9', null, false)
const past = new Date(Date.now() - WORKSPACE_MAX_AGE_MS - day)
for (const d of [old, live]) utimesSync(d, past, past)
writeFileSync(join(root, 'stray-file'), 'x')

const other = join(tmp, 'elsewhere')
mkdirSync(other)
for (const d of [deckWs, old, live, untitled]) ensureClaudeTrust(d, config)
ensureClaudeTrust(other, config)

const removed = sweepWorkspaces(root, { inUse: new Set(['deck-live-old']), configPath: config })
ok(!existsSync(old), 'a workspace untouched > 30 days is removed')
ok(!existsSync(untitled), 'untitled workspaces are removed at startup')
ok(existsSync(deckWs), 'a recent workspace stays')
ok(existsSync(live), 'a workspace with a live panel stays even if old')
ok(existsSync(join(root, 'stray-file')), 'stray files are left alone')
ok(removed.length === 2, `sweep reports what it removed (${removed.length})`)
const projects = JSON.parse(readFileSync(config, 'utf8')).projects as Record<string, unknown>
ok(!(old in projects) && !(untitled in projects), 'trust entries of removed workspaces are pruned')
ok(deckWs in projects && live in projects, 'trust entries of kept workspaces stay')
ok(other in projects, 'a trust entry outside our workspaces is never touched')

// removeClaudeTrust edge cases
removeClaudeTrust(['/nonexistent'], config)
ok(other in (JSON.parse(readFileSync(config, 'utf8')).projects as object), 'removing an unknown path is a no-op')
removeClaudeTrust(['/x'], join(tmp, 'missing.json'))
ok(true, 'a missing config is tolerated')

// ~/.claude.json is read by live `claude` processes while we write it: it is
// replaced by rename (a reader never sees a truncated, half-written file —
// Claude Code resets a config it can't parse), keeping its permission bits.
{
  chmodSync(config, 0o600)
  const before = statSync(config).ino
  const fresh = join(tmp, 'fresh-trust')
  mkdirSync(fresh)
  ensureClaudeTrust(fresh, config)
  ok(statSync(config).ino !== before, 'the trust write replaces the config by rename, never in place')
  ok((statSync(config).mode & 0o777) === 0o600, 'the config keeps its 0600 mode')
  ok(fresh in (JSON.parse(readFileSync(config, 'utf8')).projects as object), 'and the new entry is in it')
  const mid = statSync(config).ino
  removeClaudeTrust([fresh], config)
  ok(statSync(config).ino !== mid && !(fresh in (JSON.parse(readFileSync(config, 'utf8')).projects as object)), 'removing an entry is a rename too')
}

// backfill across several cwds (workspace + legacy deck folder)
const configDir = join(tmp, 'claude-config')
const store = join(tmp, 'chats.json')
const legacyCwd = join(tmp, 'deckfolder'); mkdirSync(legacyCwd)
const id1 = '11111111-1111-4111-8111-111111111111'
const id2 = '22222222-2222-4222-8222-222222222222'
for (const [cwd, id] of [[deckWs, id1], [legacyCwd, id2]] as const) {
  const dir = join(configDir, 'projects', projectDirName(cwd)); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), `{"timestamp":"2026-10-01T10:00:00Z","text":"doc-xyz"}\n`)
}
const n = backfillChats(store, configDir, [deckWs, legacyCwd], { docId: 'doc-xyz', path: null }, new Map())
ok(n === 2 && loadRecords(store).length === 2, 'backfill claims transcripts from the workspace and the legacy deck folder')

// project skills: /customize-ui in every Claude workspace, from the API chat's own text
{
  const skillMd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../desktop/src/main/apichat/skills/customize-ui.md'), 'utf8')
  const ws = ensureWorkspace(root, 'deck-skills', null, false, { 'customize-ui': skillMd, '../escape': 'x', 'Bad Name': 'x' })
  const file = join(ws, '.claude', 'skills', 'customize-ui', 'SKILL.md')
  ok(existsSync(file) && readFileSync(file, 'utf8') === skillMd, 'the customize-ui skill is written as a Claude Code project skill')
  const parsed = parseSkill(readFileSync(file, 'utf8'), 'x')
  ok(parsed?.name === 'customize-ui' && !!parsed.description && parsed.body.includes('ui_profile'), 'with the frontmatter Claude Code needs (name, description) and the ui_profile workflow')
  ok(!existsSync(join(ws, '.claude', 'escape')) && !existsSync(join(ws, '.claude', 'skills', 'Bad Name')), 'a skill name can never become a path')
  ensureWorkspace(root, 'deck-skills', null, false, { 'customize-ui': skillMd + '\n' })
  ok(readFileSync(file, 'utf8') === skillMd + '\n', 'a newer app version refreshes the skill text')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
