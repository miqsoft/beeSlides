// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// AI chat profiles — the electron-bound half (the pure half, with all the
// validation, is aiprofiles.ts): storage in app-settings.json, API keys typed
// into Settings (encrypted with safeStorage in userData/ai-keys.bin; write-only,
// they never travel to a renderer), shell-function import and the Test button.
import { app, safeStorage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'
import { loginShellEnv, shellVars } from './pty.ts'
import { readSettings, updateSettings } from './settings.ts'
import { providerFor } from './apichat/providers/index.ts'
import { handleFrom } from './ipcguard.ts'
import type { RoleModel, SessionRoles } from './apichat/session.ts'
import { apiVisionHelper, claudeVisionCommand, claudeVisionPrompt, parseClaudeResult, type VisionHelper } from './apichat/vision.ts'
import {
  DEFAULT_PROFILE_ID, MODEL_RE, configDirFromFunction, invokesClaude, isValidCommand, listFunctionsCommand, nameForFunction, parseFunctionList,
  referencedVars, resolveEnv, sanitizeProfile, sanitizeProfiles, seedProfiles, settingsFileFromFunction,
  type AiProfile, type ApiProfile, type ClaudeCodeProfile,
} from './aiprofiles.ts'

const keysPath = (): string => join(app.getPath('userData'), 'ai-keys.bin')

function readKeyFile(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(keysPath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function writeKeyFile(map: Record<string, string>): void {
  try { writeFileAtomic(keysPath(), JSON.stringify(map)) } catch { /* best effort */ }
}

function storedKey(profileId: string): string | null {
  const enc = readKeyFile()[profileId]
  if (!enc || !safeStorage.isEncryptionAvailable()) return null
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { return null }
}

/** The stored profiles (seeded on first use), as the renderer may see them. */
export function getProfiles(): { profiles: AiProfile[]; defaultId: string } {
  const s = readSettings()
  let profiles = sanitizeProfiles(s.aiProfiles)
  if (profiles.length === 0) profiles = seedProfiles()
  const keys = readKeyFile()
  const withKeys = profiles.map((p) => (p.kind === 'api' ? { ...p, hasStoredKey: !!keys[p.id] } : p))
  const defaultId = profiles.some((p) => p.id === s.defaultAiProfileId) ? s.defaultAiProfileId! : profiles[0].id
  return { profiles: withKeys, defaultId }
}

export function getProfile(id: string | undefined | null): AiProfile {
  const { profiles, defaultId } = getProfiles()
  return profiles.find((p) => p.id === id) ?? profiles.find((p) => p.id === defaultId) ?? profiles[0]
}

/** The key an API profile authenticates with: the one typed into Settings,
 *  else the login-shell variable it names. */
export async function apiKeyFor(p: ApiProfile): Promise<string | undefined> {
  const stored = storedKey(p.id)
  if (stored) return stored
  if (!p.apiKeyEnv) return undefined
  return (await shellVars([p.apiKeyEnv]))[p.apiKeyEnv] || undefined
}

function saveProfiles(rawProfiles: unknown, rawDefault: unknown): { profiles: AiProfile[]; defaultId: string } {
  const home = homedir()
  const expand = (v: string | undefined): string | undefined => (v ? v.replace(/^~(?=\/|$)/, home) : v)
  const profiles = sanitizeProfiles(rawProfiles).map((p) => {
    if (p.kind !== 'claude-code') return p
    const out = { ...p }
    if (out.configDir) out.configDir = expand(out.configDir)
    if (out.settingsFile) out.settingsFile = expand(out.settingsFile)
    return out
  })
  if (profiles.length === 0) profiles.push(...seedProfiles())
  const defaultId = typeof rawDefault === 'string' && profiles.some((p) => p.id === rawDefault) ? rawDefault : profiles[0].id
  updateSettings({ aiProfiles: profiles, defaultAiProfileId: defaultId })
  // Drop the keys of deleted profiles.
  const keys = readKeyFile()
  let changed = false
  for (const id of Object.keys(keys)) if (!profiles.some((p) => p.id === id && p.kind === 'api')) { delete keys[id]; changed = true }
  if (changed) writeKeyFile(keys)
  return getProfiles()
}

function setKey(profileId: unknown, key: unknown): { ok: boolean; error?: string } {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) return { ok: false, error: 'bad profile id' }
  const keys = readKeyFile()
  if (key === null || key === '') { delete keys[profileId]; writeKeyFile(keys); return { ok: true } }
  if (typeof key !== 'string' || key.length > 4000) return { ok: false, error: 'bad key' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encrypted storage is not available on this system; set the key as an environment variable in your shell instead.' }
  keys[profileId] = safeStorage.encryptString(key.trim()).toString('base64')
  writeKeyFile(keys)
  return { ok: true }
}

/** Runs a command through the user's interactive login shell, so functions
 *  and aliases defined in their rc files work. */
function runInShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (c: string): void => { if (out.length < 20000) out += c }
    child.stdout.setEncoding('utf8') // decodes across chunk boundaries
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: String(e.message) }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

/** The env a Claude Code profile's command runs with (as for a terminal tab). */
async function claudeEnv(p: ClaudeCodeProfile): Promise<Record<string, string>> {
  const env = { ...(await loginShellEnv()) }
  if (p.env) {
    const vars = await shellVars(referencedVars(p.env))
    Object.assign(env, resolveEnv(p.env, (n) => vars[n]))
  }
  if (p.configDir) env['CLAUDE_CONFIG_DIR'] = p.configDir
  return env
}

/** A Claude Code profile as look_at_slide's eyes: `claude -p` (headless, the
 *  user's own login and model access) reads the screenshot from a file in the
 *  chat's session folder. Slower than an API call (a CLI start each time). */
function claudeCodeVisionHelper(p: ClaudeCodeProfile, model: string | undefined, dir: string): VisionHelper {
  const m = model && MODEL_RE.test(model) ? model : undefined
  return {
    label: m ? `Claude (${m})` : p.name,
    async describe(image, prompt, signal) {
      const file = `look-${randomUUID()}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`
      writeFileSync(join(dir, file), Buffer.from(image.data, 'base64'))
      try {
        const shellPath = process.env.SHELL || '/bin/zsh'
        const out = await new Promise<string>((resolve, reject) => {
          void claudeEnv(p).then((env) => {
            const child = spawn(shellPath, ['-ilc', claudeVisionCommand(p.command, m)], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
            let stdout = ''
            let stderr = ''
            child.stdout.setEncoding('utf8')
            child.stderr.setEncoding('utf8')
            child.stdout.on('data', (c: string) => { if (stdout.length < 400000) stdout += c })
            child.stderr.on('data', (c: string) => { if (stderr.length < 20000) stderr += c })
            const kill = (): void => { try { child.kill() } catch { /* gone */ } }
            const timer = setTimeout(kill, 180000)
            signal.addEventListener('abort', kill, { once: true })
            child.on('error', (e) => { clearTimeout(timer); reject(e) })
            child.on('exit', (code) => {
              clearTimeout(timer)
              signal.removeEventListener('abort', kill)
              if (signal.aborted) reject(new Error('aborted'))
              else if (code !== 0 && !stdout.includes('"type":"result"')) reject(new Error(`${p.command} exited with ${code}: ${(stderr || stdout).trim().slice(-300)}`))
              else resolve(stdout)
            })
            child.stdin.on('error', () => { /* exited early: reported by exit */ })
            child.stdin.end(claudeVisionPrompt(file, prompt))
          }, reject)
        })
        return parseClaudeResult(out)
      } finally {
        try { rmSync(join(dir, file), { force: true }) } catch { /* best effort */ }
      }
    },
  }
}

/** The other profiles an API profile hands parts of the work to (Settings ▸
 *  AI ▸ Advanced). A missing or unsuitable one is simply not used: the chat
 *  then does that part itself (or, for image checks, goes without). */
export async function resolveRoles(p: ApiProfile, sessionDir: string): Promise<SessionRoles> {
  const { profiles } = getProfiles()
  const find = (id: string | undefined): AiProfile | undefined => (id && id !== p.id ? profiles.find((x) => x.id === id) : undefined)
  const api = async (id: string | undefined): Promise<RoleModel | undefined> => {
    const q = find(id)
    return q?.kind === 'api' ? { profile: q, apiKey: await apiKeyFor(q) } : undefined
  }
  const roles: SessionRoles = {}
  const subagent = await api(p.subagentProfileId)
  if (subagent) roles.subagent = subagent
  const summary = await api(p.summaryProfileId)
  if (summary) roles.summary = summary
  const v = find(p.visionProfileId)
  if (v?.kind === 'api' && !v.textOnly) roles.vision = apiVisionHelper(v, await apiKeyFor(v))
  else if (v?.kind === 'claude-code') roles.vision = claudeCodeVisionHelper(v, p.visionModel, sessionDir)
  return roles
}

async function importShellFunctions(existing: AiProfile[]): Promise<{ profiles: ClaudeCodeProfile[]; error?: string }> {
  const shell = process.env.SHELL || '/bin/zsh'
  const cmd = listFunctionsCommand(shell)
  if (!cmd) return { profiles: [], error: `Importing functions is supported for zsh and bash (your shell is ${shell}).` }
  const env = await loginShellEnv()
  const listed = await runInShell(cmd.args[1], env, 15000)
  const names = parseFunctionList(listed.out).filter((n) => !existing.some((p) => p.kind === 'claude-code' && p.command === n))
  if (names.length === 0) return { profiles: [] }
  // The bodies tell us the config dir / --settings file a function adds.
  const isZsh = shell.endsWith('/zsh')
  const dump = await runInShell(names.map((n) => `echo "@@FN ${n}"; ${isZsh ? 'functions' : 'declare -f'} ${n}`).join('; '), env, 15000)
  const bodies = new Map<string, string>()
  for (const chunk of dump.out.split('@@FN ').slice(1)) {
    const nl = chunk.indexOf('\n')
    bodies.set(chunk.slice(0, nl).trim(), chunk.slice(nl + 1))
  }
  const home = homedir()
  const profiles: ClaudeCodeProfile[] = []
  for (const n of names) {
    if (!isValidCommand(n)) continue
    const body = bodies.get(n) ?? ''
    if (body && !invokesClaude(body)) continue
    const p: ClaudeCodeProfile = { id: `fn-${n.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64), name: nameForFunction(n), kind: 'claude-code', command: n }
    const configDir = configDirFromFunction(body, home)
    if (configDir) p.configDir = configDir
    const settingsFile = settingsFileFromFunction(body, home)
    if (settingsFile) p.settingsFile = settingsFile
    profiles.push(p)
  }
  return { profiles }
}

async function testProfile(raw: unknown): Promise<{ ok: boolean; message: string }> {
  const p = sanitizeProfile(raw)
  if (!p) return { ok: false, message: 'The profile is incomplete.' }
  if (p.kind === 'claude-code') {
    const env = await claudeEnv(p)
    const r = await runInShell(`${p.command} --version`, env, 20000)
    const text = r.out.trim().split('\n').pop() ?? ''
    return r.code === 0 ? { ok: true, message: text || 'OK' } : { ok: false, message: text || `exit code ${r.code}` }
  }
  // A stored key is only ever sent to the address its profile was SAVED with:
  // the profile under test comes from the renderer, and pairing a saved id with
  // a new baseUrl would hand that key to whatever host the caller names. A
  // key stored for an id with no saved profile yet is one just typed into a
  // new, unsaved profile, for this test.
  const stored = storedKey(p.id)
  const saved = getProfiles().profiles.find((x) => x.id === p.id)
  if (stored && saved && (saved.kind !== 'api' || saved.baseUrl !== p.baseUrl)) {
    return { ok: false, message: 'The address changed: save the profile first, then test it with its stored key.' }
  }
  const key = stored ?? (p.apiKeyEnv ? (await shellVars([p.apiKeyEnv]))[p.apiKeyEnv] || undefined : undefined)
  if (!key && p.apiKeyEnv) return { ok: false, message: `No API key: ${p.apiKeyEnv} is not set in your login shell, and none is stored.` }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 25000)
  try {
    await providerFor(p).complete({
      baseUrl: p.baseUrl, model: p.model, maxTokens: 16, apiKey: key, system: 'Reply with the single word OK.',
      tools: [], messages: [{ role: 'user', text: 'ping' }], signal: abort.signal, onText: () => {},
    })
    return { ok: true, message: `${p.model} answered.` }
  } catch (e) {
    return { ok: false, message: abort.signal.aborted ? 'Timed out after 25 s.' : e instanceof Error ? e.message : String(e) }
  } finally { clearTimeout(timer) }
}

/** The user's own API-chat skills (apichat/skills.ts). */
export const apiSkillsDir = (): string => join(app.getPath('userData'), 'api-skills')

export function registerAiProfileIpc(): void {
  // Keys and profile settings answer only this build's own shell (never a
  // page a doc view was navigated to) — like every app-shell channel
  // (ipcguard.ts), whose refusals resolve, never reject.
  handleFrom('app-shell', 'slidomingo:ai-open-skills-folder', async () => {
    const dir = apiSkillsDir()
    try { mkdirSync(dir, { recursive: true }) } catch { /* openPath reports it */ }
    const err = await shell.openPath(dir)
    return { ok: !err, path: dir, ...(err ? { error: err } : {}) }
  })
  handleFrom('app-shell', 'slidomingo:ai-profiles-get', () => getProfiles())
  handleFrom('app-shell', 'slidomingo:ai-profiles-save', (_ev, profiles: unknown, defaultId: unknown) => saveProfiles(profiles, defaultId))
  handleFrom('app-shell', 'slidomingo:ai-profiles-set-key', (_ev, id: unknown, key: unknown) => setKey(id, key))
  handleFrom('app-shell', 'slidomingo:ai-profiles-import-shell', () => importShellFunctions(getProfiles().profiles))
  handleFrom('app-shell', 'slidomingo:ai-profiles-test', (_ev, profile: unknown) => testProfile(profile))
}

export { DEFAULT_PROFILE_ID }
