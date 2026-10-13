// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// AI chat profiles — the pure half (no electron import, so
// scripts/test-ai-profiles.ts can run it): the data model, validation of
// everything a renderer may send, `$VAR` env resolution and the parsing of the
// user's shell functions. The electron-bound half (settings storage, the
// encrypted key file, IPC) is aiprofilesStore.ts.

export type ApiWire = 'anthropic' | 'openai'

/** How hard a reasoning model thinks (absent = the server's default). Sent as
 *  `reasoning_effort`, or `output_config.effort` on api.anthropic.com. */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface ClaudeCodeProfile {
  id: string
  name: string
  kind: 'claude-code'
  /** `claude`, a shell function such as `claude-work`, or an absolute path.
   *  It is spliced into a shell command line, hence the strict whitelist. */
  command: string
  /** CLAUDE_CONFIG_DIR for this profile — trust prompt + chat-history lookup. */
  configDir?: string
  /** Extra pty env. A value of `$NAME` is taken from the login shell. */
  env?: Record<string, string>
  /** A settings file the command itself passes with `--settings` (a shell
   *  function like claude-work). `claude` keeps only the LAST --settings,
   *  so ours would silently replace it; main merges this file into the
   *  per-session settings.json instead. */
  settingsFile?: string
}

export interface ApiProfile {
  id: string
  name: string
  kind: 'api'
  wire: ApiWire
  baseUrl: string
  model: string
  maxTokens?: number
  /** Reasoning effort to ask for; absent = leave it to the server (apichat/providers/reasoning.ts). */
  reasoning?: ReasoningEffort
  /** Model context window in tokens (default 200k anthropic / 128k openai); compaction starts at 75 %. */
  contextWindow?: number
  /** Login-shell variable holding the key (MY_GATEWAY_API_KEY, …). */
  apiKeyEnv?: string
  /** A key typed into Settings is kept encrypted in main, never sent back. */
  hasStoredKey?: boolean
  /** The model cannot read images: screenshots are left out (apichat/providers/images.ts). */
  textOnly?: boolean
  // Settings ▸ AI ▸ Advanced — other profiles for parts of the work (absent = this one):
  /** API profile the `task` subagents run on. */
  subagentProfileId?: string
  /** API profile that writes the summaries when a long chat is compacted. */
  summaryProfileId?: string
  /** Profile (an API one that can read images, or Claude Code) that answers
   *  look_at_slide for a text-only model. */
  visionProfileId?: string
  /** `--model` for a Claude Code vision profile (e.g. sonnet). */
  visionModel?: string
  /** How many `task` subagents of one turn run at the same time (default 4). */
  maxParallelTasks?: number
}

export type AiProfile = ClaudeCodeProfile | ApiProfile

export const DEFAULT_PROFILE_ID = 'claude-code-default'

export function seedProfiles(): AiProfile[] {
  return [{ id: DEFAULT_PROFILE_ID, name: 'Claude Code', kind: 'claude-code', command: 'claude' }]
}

const COMMAND_RE = /^[A-Za-z0-9._/-]{1,200}$/
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
/** A `--model` value spliced into a command line: an alias or id, nothing else. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/

/** Only these may reach the pty command line: no spaces, quotes, `;`, `$`… */
export function isValidCommand(command: unknown): command is string {
  return typeof command === 'string' && COMMAND_RE.test(command) && !command.startsWith('-')
}

export function isValidEnvName(name: unknown): name is string {
  return typeof name === 'string' && ENV_NAME_RE.test(name)
}

const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.length <= max ? v.trim() : undefined)

function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

/** Normalises one profile coming from the renderer; null when unusable.
 *  Unknown fields are dropped, so nothing unvetted is ever persisted. */
export function sanitizeProfile(raw: unknown): AiProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id, 64)
  const name = str(r.name, 80)
  if (!id || !ID_RE.test(id) || !name) return null
  if (r.kind === 'claude-code') {
    if (!isValidCommand(r.command)) return null
    const p: ClaudeCodeProfile = { id, name, kind: 'claude-code', command: r.command }
    const configDir = str(r.configDir, 500)
    if (configDir) p.configDir = configDir
    const settingsFile = str(r.settingsFile, 500)
    if (settingsFile) p.settingsFile = settingsFile
    if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (isValidEnvName(k) && typeof v === 'string' && v.length <= 2000) env[k] = v
      }
      if (Object.keys(env).length) p.env = env
    }
    return p
  }
  if (r.kind === 'api') {
    if (r.wire !== 'anthropic' && r.wire !== 'openai') return null
    const baseUrl = str(r.baseUrl, 500)
    const model = str(r.model, 200)
    if (!baseUrl || !isHttpUrl(baseUrl) || !model) return null
    const p: ApiProfile = { id, name, kind: 'api', wire: r.wire, baseUrl: baseUrl.replace(/\/+$/, ''), model }
    if (typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens) && r.maxTokens >= 16 && r.maxTokens <= 200000) p.maxTokens = Math.round(r.maxTokens)
    if (REASONING_EFFORTS.includes(r.reasoning as ReasoningEffort)) p.reasoning = r.reasoning as ReasoningEffort
    if (typeof r.contextWindow === 'number' && Number.isFinite(r.contextWindow) && r.contextWindow >= 4000 && r.contextWindow <= 10_000_000) p.contextWindow = Math.round(r.contextWindow)
    if (r.textOnly === true) p.textOnly = true
    for (const k of ['subagentProfileId', 'summaryProfileId', 'visionProfileId'] as const) {
      const v = str(r[k], 64)
      if (v && ID_RE.test(v) && v !== id) p[k] = v
    }
    if (typeof r.maxParallelTasks === 'number' && Number.isInteger(r.maxParallelTasks) && r.maxParallelTasks >= 1 && r.maxParallelTasks <= 16) p.maxParallelTasks = r.maxParallelTasks
    const visionModel = str(r.visionModel, 100)
    if (visionModel && MODEL_RE.test(visionModel)) p.visionModel = visionModel
    if (r.apiKeyEnv !== undefined && r.apiKeyEnv !== '') {
      if (!isValidEnvName(r.apiKeyEnv)) return null
      p.apiKeyEnv = r.apiKeyEnv
    }
    return p
  }
  return null
}

/** Sanitises a whole list: drops bad entries and duplicate ids. */
export function sanitizeProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AiProfile[] = []
  for (const item of raw) {
    const p = sanitizeProfile(item)
    if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p) }
  }
  return out
}

/** Resolves a profile's env: `$NAME` (or `${NAME}`) values come from
 *  `lookup` (the login shell), anything else is literal. An unresolved
 *  reference is omitted rather than passed as the literal text `$NAME`. */
export function resolveEnv(env: Record<string, string> | undefined, lookup: (name: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!isValidEnvName(k)) continue
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v)
    if (!m) { out[k] = v; continue }
    const value = lookup(m[1])
    if (value !== undefined && value !== '') out[k] = value
  }
  return out
}

/** Names of the `$VAR` references in a profile's env (to pre-fetch them). */
export function referencedVars(env: Record<string, string> | undefined): string[] {
  const names = new Set<string>()
  for (const v of Object.values(env ?? {})) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v)
    if (m) names.add(m[1])
  }
  return [...names]
}

/** The shell command that lists the user's `claude*` functions. zsh and bash
 *  differ; anything else gets none (the user can still type a command). */
export function listFunctionsCommand(shell: string): { args: string[] } | null {
  const name = shell.split('/').pop() ?? ''
  if (name === 'zsh') return { args: ['-lic', 'print -l ${(k)functions[(I)claude*]}'] }
  if (name === 'bash') return { args: ['-lic', 'compgen -A function claude'] }
  return null
}

/** One function name per line → the valid, de-duplicated names. */
export function parseFunctionList(output: string): string[] {
  const names = new Set<string>()
  for (const line of output.split('\n')) {
    const n = line.trim()
    if (n.startsWith('claude') && isValidCommand(n)) names.add(n)
  }
  return [...names].sort()
}

/** Whether a shell function's body runs the `claude` binary — `claude-work-stop`
 *  matches the name pattern but is no launcher. */
export function invokesClaude(body: string): boolean {
  const lines = body.split('\n').slice(1) // the first line is the function's own header
  return /(?:^|[\s;&|(`])claude(?=[\s"']|$)/m.test(lines.join('\n'))
}

/** A function body's `--settings <file>` argument, with `$HOME`/`~`
 *  expanded; null when it has none or uses anything fancier than a literal
 *  path (the profile then still works, just without the merged settings). */
export function settingsFileFromFunction(body: string, home: string): string | null {
  const m = /--settings[= ]\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(body)
  const raw = m?.[1] ?? m?.[2] ?? m?.[3]
  if (!raw) return null
  const path = raw.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home).replace(/^\$\{HOME\}(?=\/)/, home)
  if (!path.startsWith('/') || /[$`\\]/.test(path)) return null
  return path
}

/** Env assignments in front of a function's `command claude`, e.g.
 *  `CLAUDE_CONFIG_DIR="$HOME/.claude-work"` → configDir. Only that one
 *  variable is lifted: the rest (tokens) stays inside the function. */
export function configDirFromFunction(body: string, home: string): string | null {
  const m = /CLAUDE_CONFIG_DIR=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(body)
  const raw = m?.[1] ?? m?.[2] ?? m?.[3]
  if (!raw) return null
  const path = raw.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home).replace(/^\$\{HOME\}(?=\/)/, home)
  if (!path.startsWith('/') || /[$`\\]/.test(path)) return null
  return path
}

/** Humanises `claude-work` → `Claude · work`. */
export function nameForFunction(fn: string): string {
  const rest = fn.replace(/^claude[-_]?/, '')
  return rest ? `Claude · ${rest}` : 'Claude'
}

export interface ApiPreset { key: string; label: string; wire: ApiWire; baseUrl: string; apiKeyEnv: string; model: string }

export const API_PRESETS: ApiPreset[] = [
  { key: 'anthropic', label: 'Anthropic', wire: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  { key: 'anthropic-compatible', label: 'Anthropic-compatible', wire: 'anthropic', baseUrl: '', apiKeyEnv: '', model: '' },
  { key: 'openai', label: 'OpenAI-compatible', wire: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: '' },
]

/** Tab label: the profile name, with " · API" appended for an API profile
 *  that does not already say so. */
export function tabLabel(p: AiProfile): string {
  return p.kind === 'api' && !/api/i.test(p.name) ? `${p.name} · API` : p.name
}

type Json = Record<string, unknown>

/** Our per-session settings.json (the hooks) laid over a settings file the
 *  profile's command passes itself. `claude` honours only the LAST
 *  `--settings`, so without this the function's own settings (its model, env,
 *  permissions) would be dropped. Hook lists are concatenated per event; any
 *  other key comes from `base`. */
export function mergeSettings(base: unknown, ours: Json): Json {
  const b: Json = base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Json) } : {}
  const baseHooks: Json = b.hooks && typeof b.hooks === 'object' && !Array.isArray(b.hooks) ? (b.hooks as Json) : {}
  const ourHooks: Json = ours.hooks && typeof ours.hooks === 'object' ? (ours.hooks as Json) : {}
  const hooks: Json = { ...baseHooks }
  for (const [event, list] of Object.entries(ourHooks)) {
    const prior = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    hooks[event] = [...prior, ...(Array.isArray(list) ? list : [])]
  }
  return { ...b, ...ours, hooks }
}
