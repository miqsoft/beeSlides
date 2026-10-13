// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Skills: playbooks the model loads on demand (use_skill) or the user invokes
// as `/name …`. Same layout as Claude Code: `<name>/SKILL.md` with `name` and
// `description` frontmatter and a markdown body. Built-ins ship with the app
// (skills/index.ts); the user's live in userData/api-skills/ and win by name.
// Pure Node — no electron, so scripts/test-ai-profiles.ts can run it.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface Skill {
  name: string
  description: string
  body: string
  /** The skill's folder — only user skills have one (they can hold extra files). */
  dir?: string
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** `---\nkey: value\n---\nbody`; only flat `key: value` lines are understood. */
export function parseSkill(raw: string, fallbackName: string, dir?: string): Skill | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const fm: Record<string, string> = {}
  let body = text
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4)
    if (end >= 0) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
        if (m) fm[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
      }
      body = text.slice(end + 4).replace(/^\n/, '')
    }
  }
  const name = fm.name || fallbackName
  if (!NAME_RE.test(name) || !body.trim()) return null
  return { name, description: fm.description ?? '', body: body.trim(), ...(dir ? { dir } : {}) }
}

/** Reads every `<dir>/<name>/SKILL.md`; unreadable entries are skipped. */
export function loadUserSkills(dir: string): Skill[] {
  const out: Skill[] = []
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const folder = join(dir, e)
    try {
      if (!statSync(folder).isDirectory()) continue
      const file = join(folder, 'SKILL.md')
      if (!existsSync(file)) continue
      const s = parseSkill(readFileSync(file, 'utf8'), e, folder)
      if (s) out.push(s)
    } catch { /* skip */ }
  }
  return out
}

/** Merged by name; user skills win. Sorted by name. */
export function mergeSkills(builtin: Skill[], user: Skill[]): Skill[] {
  const byName = new Map<string, Skill>()
  for (const s of builtin) byName.set(s.name, s)
  for (const s of user) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The `use_skill` tool: SKILL.md, or another .md/.txt file of the skill's folder. */
export function readSkill(skills: Skill[], name: unknown, file: unknown): { text: string; isError: boolean } {
  const err = (text: string) => ({ text: `Error: ${text}`, isError: true })
  if (typeof name !== 'string') return err('name is required.')
  const skill = skills.find((s) => s.name === name)
  if (!skill) return err(`unknown skill "${name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}.`)
  if (file === undefined || file === null || file === '') return { text: skill.body, isError: false }
  if (typeof file !== 'string') return err('file must be a string.')
  if (!skill.dir) return err(`the built-in skill "${name}" has no extra files.`)
  const ext = extname(file).toLowerCase()
  if (ext !== '.md' && ext !== '.txt') return err('only .md and .txt files can be read.')
  try {
    const root = realpathSync(skill.dir)
    const target = realpathSync(resolve(root, file))
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return err('the file must be inside the skill folder.')
    return { text: readFileSync(target, 'utf8'), isError: false }
  } catch { return err(`${file} was not found in the skill "${name}".`) }
}

/** `/name rest…` → the skill body plus the rest; null when not a skill call. */
export function expandSlash(text: string, skills: Skill[]): string | null {
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m || m[1] === 'compact') return null
  const skill = skills.find((s) => s.name === m[1])
  if (!skill) return null
  const rest = (m[2] ?? '').trim()
  return `Follow this skill ("${skill.name}"):\n\n${skill.body}${rest ? `\n\nThe user's request: ${rest}` : ''}`
}

export const USE_SKILL_TOOL = {
  name: 'use_skill',
  description: 'Load a skill: a playbook for a kind of task (see the Skills list in the system prompt). Returns its instructions, which you then follow. `file` optionally names another .md/.txt file in the skill\'s folder that the instructions refer to.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name.' },
      file: { type: 'string', description: 'Optional extra file inside the skill folder.' },
    },
    required: ['name'],
  },
}
