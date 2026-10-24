// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ AI: the profiles a chat can open with (desktop only — the
// storage, validation and secrets live in desktop/src/main/aiprofiles*.ts;
// this is just the editor for them). Two kinds: a Claude Code profile (which
// command to run, e.g. one of your `claude-*` shell functions) and an API
// profile (a native chat that calls an LLM API directly).
import { t } from '../i18n'

type ClaudeCodeProfile = {
  id: string; name: string; kind: 'claude-code'; command: string
  configDir?: string; env?: Record<string, string>; settingsFile?: string
}
type ApiProfile = {
  id: string; name: string; kind: 'api'; wire: 'anthropic' | 'openai'; baseUrl: string; model: string
  maxTokens?: number; reasoning?: 'low' | 'medium' | 'high'; contextWindow?: number; apiKeyEnv?: string; hasStoredKey?: boolean; textOnly?: boolean
  subagentProfileId?: string; summaryProfileId?: string; visionProfileId?: string; visionModel?: string; maxParallelTasks?: number
}
type Profile = ClaudeCodeProfile | ApiProfile

interface AiBridge {
  getAiProfiles(): Promise<{ profiles: Profile[]; defaultId: string }>
  saveAiProfiles(profiles: Profile[], defaultId: string): Promise<{ profiles: Profile[]; defaultId: string }>
  setAiProfileKey(id: string, key: string | null): Promise<{ ok: boolean; error?: string }>
  importAiShellFunctions(): Promise<{ profiles: ClaudeCodeProfile[]; error?: string }>
  testAiProfile(profile: Profile): Promise<{ ok: boolean; message: string }>
  openAiSkillsFolder?(): Promise<{ ok: boolean; path: string; error?: string }>
  getCodeMode?(): Promise<{ on: boolean; forced: boolean }>
  setCodeMode?(on: boolean): Promise<{ on: boolean; forced: boolean }>
  getAgentEndpoint?(): Promise<EndpointState>
  setAgentEndpoint?(on: boolean): Promise<EndpointState>
  forgetAgentClients?(): Promise<EndpointState>
}

type EndpointState = { on: boolean; forced: boolean; clients: string[] }

const bridge = (): AiBridge | null => {
  const d = (window as unknown as { slidomingoDesktop?: Partial<AiBridge> }).slidomingoDesktop
  return d?.getAiProfiles ? (d as AiBridge) : null
}

/** Whether this build can edit AI profiles (the desktop app only). */
export const aiSettingsAvailable = (): boolean => bridge() !== null

const PRESETS: Array<{ key: string; label: string; wire: 'anthropic' | 'openai'; baseUrl: string; apiKeyEnv: string; model: string }> = [
  { key: 'anthropic', label: 'Anthropic', wire: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  { key: 'anthropic-compatible', label: 'Anthropic-compatible', wire: 'anthropic', baseUrl: '', apiKeyEnv: '', model: '' },
  { key: 'openai', label: 'OpenAI-compatible', wire: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: '' },
]

const newId = (): string => `p-${Math.random().toString(36).slice(2, 10)}`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', 'ed-about-row ed-ai-field')
  row.style.cssText = 'display:flex;flex-direction:column;gap:3px;align-items:stretch'
  row.append(el('span', undefined, label), input)
  if (hint) row.append(el('span', 'ed-hint', hint))
  return row
}

/** A checkbox with its label on the same line (field() stacks them). */
function checkField(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const row = el('div', 'ed-about-row ed-ai-field')
  row.style.cssText = 'display:flex;flex-direction:column;gap:3px;align-items:stretch'
  const line = el('label')
  line.style.cssText = 'display:flex;gap:6px;align-items:center'
  line.append(input, el('span', undefined, label))
  row.append(line)
  if (hint) row.append(el('span', 'ed-hint', hint))
  return row
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const i = el('input')
  i.type = 'text'
  i.value = value
  i.placeholder = placeholder
  return i
}

const envToText = (env?: Record<string, string>): string => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return env
}

export function renderAiCategory(host: HTMLElement, toast: (msg: string) => void): void {
  const api = bridge()
  if (!api) return
  let profiles: Profile[] = []
  let defaultId = ''

  const persist = async (): Promise<void> => {
    const saved = await api.saveAiProfiles(profiles, defaultId)
    profiles = saved.profiles
    defaultId = saved.defaultId
  }

  const renderList = (): void => {
    host.replaceChildren()
    const title = el('div', 'ed-about-h', t('AI chat'))
    const hint = el('p', 'ed-hint', t('Profiles for the chat panel: pick one when opening a chat (the + menu), or make one the default. A Claude Code profile runs the claude command; an API profile is a built-in chat that calls a model directly.'))
    host.append(title, hint)

    for (const p of profiles) {
      const row = el('div', 'ed-about-row')
      row.style.cssText = 'display:flex;gap:8px;align-items:center'
      const info = el('div')
      info.style.cssText = 'flex:1;min-width:0'
      const name = el('div', undefined, p.name + (p.id === defaultId ? `  ·  ${t('default')}` : ''))
      name.style.fontWeight = '600'
      const sub = el('div', 'ed-hint', p.kind === 'api' ? `${p.model} · ${p.baseUrl}` : p.command + (p.configDir ? ` · ${p.configDir}` : ''))
      sub.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      info.append(name, sub)
      row.append(info)
      if (p.id !== defaultId) {
        const def = el('button', 'ed-btn', t('Set default'))
        def.addEventListener('click', () => { defaultId = p.id; void persist().then(renderList) })
        row.append(def)
      }
      const edit = el('button', 'ed-btn', t('Edit'))
      edit.addEventListener('click', () => renderForm(p))
      row.append(edit)
      if (profiles.length > 1) {
        const del = el('button', 'ed-btn', t('Delete'))
        del.addEventListener('click', () => {
          profiles = profiles.filter((x) => x.id !== p.id)
          if (defaultId === p.id) defaultId = profiles[0].id
          void persist().then(renderList)
        })
        row.append(del)
      }
      host.append(row)
    }

    const actions = el('div', 'ed-about-row')
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center'
    const addCc = el('button', 'ed-btn', t('Add Claude Code profile'))
    addCc.addEventListener('click', () => renderForm({ id: newId(), name: '', kind: 'claude-code', command: 'claude' }, true))
    const presetSel = el('select')
    presetSel.append(new Option(t('Add API profile…'), ''))
    for (const pr of PRESETS) presetSel.append(new Option(pr.label, pr.key))
    presetSel.addEventListener('change', () => {
      const pr = PRESETS.find((x) => x.key === presetSel.value)
      if (!pr) return
      renderForm({ id: newId(), name: pr.label, kind: 'api', wire: pr.wire, baseUrl: pr.baseUrl, model: pr.model, apiKeyEnv: pr.apiKeyEnv || undefined }, true)
    })
    const imp = el('button', 'ed-btn', t('Import shell functions'))
    imp.title = t('Finds your claude-* shell functions (claude-work, …) and offers each as a profile')
    imp.addEventListener('click', async () => {
      imp.disabled = true
      const r = await api.importAiShellFunctions()
      imp.disabled = false
      if (r.error) { toast(r.error); return }
      if (r.profiles.length === 0) { toast(t('No new claude-* shell functions found')); return }
      profiles = [...profiles, ...r.profiles]
      await persist()
      toast(t('{n} profile(s) imported', { n: String(r.profiles.length) }))
      renderList()
    })
    const skillsBtn = el('button', 'ed-btn', t('Open skills folder'))
    skillsBtn.title = t('Your own skills for API chats: one folder per skill with a SKILL.md (name and description at the top). Changes apply on the next message.')
    skillsBtn.addEventListener('click', async () => {
      const r = await api.openAiSkillsFolder?.()
      if (!r?.ok) toast(r?.error ?? t('Could not open the skills folder'))
    })
    actions.append(addCc, presetSel, imp, skillsBtn)
    host.append(actions)

    // Advanced: app-wide agent switches (desktop/src/main/agentexec.ts,
    // agentendpoint.ts).
    const advanced = el('details')
    const adv = el('summary', undefined, t('Advanced'))
    adv.style.cssText = 'cursor:pointer;margin:6px 0'
    advanced.append(adv)
    if (api.getCodeMode && api.setCodeMode) {
      const setCodeMode = api.setCodeMode
      const codeMode = el('input')
      codeMode.type = 'checkbox'
      codeMode.disabled = true
      advanced.append(checkField(t('Code Mode (experimental)'), codeMode,
        t('Claude Code chats may write one short program that does a multi-slide job in a single step, instead of many separate tool calls. Applies to chats opened after the change.')))
      void api.getCodeMode().then((r) => {
        codeMode.checked = r.on
        codeMode.disabled = r.forced
        if (r.on) advanced.open = true
      })
      codeMode.addEventListener('change', async () => {
        const r = await setCodeMode(codeMode.checked)
        codeMode.checked = r.on
      })
    }
    if (api.getAgentEndpoint && api.setAgentEndpoint && api.forgetAgentClients) {
      const { setAgentEndpoint, forgetAgentClients } = api
      const outside = el('input')
      outside.type = 'checkbox'
      outside.disabled = true
      const allowed = el('div', 'ed-hint')
      const forget = el('button', 'ed-btn', t('Forget allowed apps'))
      forget.style.alignSelf = 'flex-start'
      const show = (r: EndpointState): void => {
        outside.checked = r.on
        outside.disabled = r.forced
        allowed.textContent = r.clients.length ? t('Allowed: {apps}', { apps: r.clients.join(', ') }) : t('No app allowed yet: each one asks the first time it connects.')
        forget.disabled = r.clients.length === 0
        if (r.on) advanced.open = true
      }
      const field = checkField(t('Allow AI apps outside BeeSlides'), outside,
        t('Claude Code in your own terminal, Claude Desktop or Cursor may work on the decks open here, through the BeeSlides plugin or MCP server. Each app asks once before it connects. For Claude Code: /plugin marketplace add miqsoft/beeslides, then /plugin install beeslides@beeslides.'))
      field.append(allowed, forget)
      advanced.append(field)
      void api.getAgentEndpoint().then(show)
      outside.addEventListener('change', async () => show(await setAgentEndpoint(outside.checked)))
      forget.addEventListener('click', async () => show(await forgetAgentClients()))
    }
    if (advanced.childElementCount > 1) host.append(advanced)
  }

  const renderForm = (orig: Profile, isNew = false): void => {
    host.replaceChildren()
    host.append(el('div', 'ed-about-h', isNew ? t('New profile') : t('Edit profile')))
    const name = textInput(orig.name, t('e.g. Claude · work'))
    host.append(field(t('Name'), name))

    let collect: () => Profile
    let keyInput: HTMLInputElement | null = null
    let clearKey = false

    if (orig.kind === 'claude-code') {
      const command = textInput(orig.command, 'claude')
      const configDir = textInput(orig.configDir ?? '', '~/.claude-work')
      const env = el('textarea')
      env.rows = 3
      env.value = envToText(orig.env)
      env.placeholder = 'ANTHROPIC_AUTH_TOKEN=$MY_GATEWAY_API_KEY'
      host.append(
        field(t('Command'), command, t('claude, one of your shell functions (claude-work), or an absolute path. Letters, digits and . _ / - only.')),
        field(t('Config folder (optional)'), configDir, t('CLAUDE_CONFIG_DIR of this profile: where its trust settings and chat history live.')),
        field(t('Environment (optional)'), env, t('One NAME=value per line. A value of $NAME is read from your login shell, so keys never need to be typed here.')),
      )
      collect = () => ({
        id: orig.id, name: name.value.trim() || command.value.trim(), kind: 'claude-code', command: command.value.trim(),
        ...(configDir.value.trim() ? { configDir: configDir.value.trim() } : {}),
        ...(Object.keys(textToEnv(env.value)).length ? { env: textToEnv(env.value) } : {}),
        ...(orig.settingsFile ? { settingsFile: orig.settingsFile } : {}),
      })
    } else {
      const wire = el('select')
      wire.append(new Option('Anthropic Messages API', 'anthropic'), new Option('OpenAI Chat Completions', 'openai'))
      wire.value = orig.wire
      const baseUrl = textInput(orig.baseUrl, 'https://…')
      const model = textInput(orig.model, 'model id')
      const maxTokens = textInput(orig.maxTokens ? String(orig.maxTokens) : '', '32000')
      const reasoning = el('select')
      reasoning.append(new Option(t('Default'), ''), new Option(t('Low'), 'low'), new Option(t('Medium'), 'medium'), new Option(t('High'), 'high'))
      reasoning.value = orig.reasoning ?? ''
      const contextWindow = textInput(orig.contextWindow ? String(orig.contextWindow) : '', orig.wire === 'openai' ? '128000' : '200000')
      const textOnly = el('input')
      textOnly.type = 'checkbox'
      textOnly.checked = !!orig.textOnly
      const keyEnv = textInput(orig.apiKeyEnv ?? '', 'MY_GATEWAY_API_KEY')
      keyInput = el('input')
      keyInput.type = 'password'
      keyInput.autocomplete = 'off'
      keyInput.placeholder = orig.hasStoredKey ? t('A key is stored — type to replace it') : t('Optional: paste a key to store it encrypted')
      host.append(
        field(t('API style'), wire),
        field(t('Base URL'), baseUrl, t('Anthropic-style: https://api.anthropic.com or your gateway (without /v1/messages). OpenAI-style: ends in /v1.')),
        field(t('Model'), model),
        field(t('Reasoning'), reasoning, t('How hard the model thinks before it answers. Low is usually enough for routine slide edits and is much faster on reasoning models such as GLM or DeepSeek. Servers that do not know the setting ignore it.')),
        field(t('Max tokens (optional)'), maxTokens),
        field(t('Context window (optional)'), contextWindow, t('Tokens the model can hold. The chat summarizes itself at 75 % of it. Default 200000 (Anthropic style) or 128000 (OpenAI style).')),
        checkField(t('Text-only model (cannot read images)'), textOnly, t('Slide screenshots are left out; the model checks layout from element positions and sizes instead. Detected automatically when the server rejects images.')),
        field(t('API key variable'), keyEnv, t('Name of a variable in your login shell that holds the key. Used when no key is stored below.')),
        field(t('API key'), keyInput, t('Stored encrypted by the operating system; never shown again.')),
      )
      // Advanced: other profiles doing parts of the work (aiprofiles.ts ApiProfile).
      const others = profiles.filter((x) => x.id !== orig.id)
      const roleSelect = (value: string | undefined, none: string, pick: (x: Profile) => boolean): HTMLSelectElement => {
        const s = el('select')
        s.append(new Option(none, ''))
        for (const x of others.filter(pick)) s.append(new Option(x.kind === 'api' ? `${x.name} · ${x.model}` : x.name, x.id))
        s.value = value && others.some((x) => x.id === value && pick(x)) ? value : ''
        return s
      }
      const subagentSel = roleSelect(orig.subagentProfileId, t('This profile'), (x) => x.kind === 'api')
      const summarySel = roleSelect(orig.summaryProfileId, t('This profile'), (x) => x.kind === 'api')
      const visionSel = roleSelect(orig.visionProfileId, t('None'), (x) => x.kind === 'claude-code' || !x.textOnly)
      const visionModel = textInput(orig.visionModel ?? '', 'sonnet')
      const parallel = textInput(orig.maxParallelTasks ? String(orig.maxParallelTasks) : '', '4')
      const advanced = el('details')
      advanced.open = !!(orig.subagentProfileId || orig.summaryProfileId || orig.visionProfileId || orig.maxParallelTasks)
      const adv = el('summary', undefined, t('Advanced'))
      adv.style.cssText = 'cursor:pointer;margin:6px 0'
      advanced.append(
        adv,
        field(t('Model for subagents'), subagentSel, t('The model the task subagents run on. A faster or cheaper one is often enough for searching and translating.')),
        field(t('Parallel subagents (optional)'), parallel, t('How many subagents run at the same time (1–16, default 4). A local server can often take more; a hosted API may hit its rate limit.')),
        field(t('Model for summaries'), summarySel, t('The model that summarizes a long chat when it gets close to the context window.')),
        field(t('Model for image checks'), visionSel, t('Lets a text-only model ask a model that can see to look at a slide. Slide screenshots go to that model, so pick one you trust with the deck’s content.')),
        field(t('Claude model for image checks (optional)'), visionModel, t('Only when image checks use a Claude Code profile: passed as --model, e.g. sonnet. Empty: its default model.')),
      )
      if (orig.hasStoredKey) {
        const rm = el('button', 'ed-btn', t('Remove stored key'))
        rm.type = 'button'
        rm.addEventListener('click', () => { clearKey = true; rm.disabled = true; rm.textContent = t('Key will be removed on save') })
        host.append(rm)
      }
      host.append(advanced)
      collect = () => ({
        id: orig.id, name: name.value.trim() || model.value.trim(), kind: 'api', wire: wire.value as 'anthropic' | 'openai',
        baseUrl: baseUrl.value.trim(), model: model.value.trim(),
        ...(Number(maxTokens.value) > 0 ? { maxTokens: Number(maxTokens.value) } : {}),
        ...(reasoning.value ? { reasoning: reasoning.value as 'low' | 'medium' | 'high' } : {}),
        ...(Number(contextWindow.value) > 0 ? { contextWindow: Number(contextWindow.value) } : {}),
        ...(textOnly.checked ? { textOnly: true } : {}),
        ...(subagentSel.value ? { subagentProfileId: subagentSel.value } : {}),
        ...(summarySel.value ? { summaryProfileId: summarySel.value } : {}),
        ...(visionSel.value ? { visionProfileId: visionSel.value } : {}),
        ...(visionModel.value.trim() ? { visionModel: visionModel.value.trim() } : {}),
        ...(Number.isInteger(Number(parallel.value)) && Number(parallel.value) >= 1 && Number(parallel.value) <= 16 ? { maxParallelTasks: Number(parallel.value) } : {}),
        ...(keyEnv.value.trim() ? { apiKeyEnv: keyEnv.value.trim() } : {}),
      })
    }

    const result = el('div', 'ed-hint')
    const bar = el('div', 'ed-about-row')
    bar.style.cssText = 'display:flex;gap:8px;align-items:center'
    const test = el('button', 'ed-btn', t('Test'))
    test.addEventListener('click', async () => {
      test.disabled = true
      result.textContent = t('Testing…')
      // A typed key must be stored before the main process can use it for the test.
      if (keyInput?.value) await api.setAiProfileKey(orig.id, keyInput.value)
      const r = await api.testAiProfile(collect())
      result.textContent = (r.ok ? '✓ ' : '✗ ') + r.message
      test.disabled = false
    })
    const save = el('button', 'ed-btn ed-btn-primary', t('Save'))
    save.addEventListener('click', async () => {
      const p = collect()
      const next = isNew ? [...profiles, p] : profiles.map((x) => (x.id === p.id ? p : x))
      const before = profiles
      profiles = next
      await persist()
      if (!profiles.some((x) => x.id === p.id)) { profiles = before; toast(t('The profile is incomplete — check the command, URL and model')); renderForm(orig, isNew); return }
      if (keyInput?.value) {
        const r = await api.setAiProfileKey(p.id, keyInput.value)
        if (!r.ok) toast(r.error ?? t('Could not store the key'))
      } else if (clearKey) await api.setAiProfileKey(p.id, null)
      await persist()
      renderList()
    })
    const cancel = el('button', 'ed-btn', t('Cancel'))
    cancel.addEventListener('click', () => {
      // a key stored only for Test must not outlive a cancelled new profile
      if (isNew) void api.setAiProfileKey(orig.id, null)
      renderList()
    })
    bar.append(test, save, cancel)
    host.append(bar, result)
  }

  void api.getAiProfiles().then((r) => { profiles = r.profiles; defaultId = r.defaultId; renderList() })
}
