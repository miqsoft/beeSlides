// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// look_at_slide: a text-only model's eyes. The slide is screenshotted (via
// review_slide) and handed to ANOTHER model that can see — an API profile
// with image input, or Claude Code through its CLI (aiprofilesStore.ts) —
// with the asking model's question; only that model's text answer comes back.
// Settings ▸ AI ▸ Advanced ▸ "Image checks" picks the helper.
import type { ApiProfile } from '../aiprofiles.ts'
import { providerFor } from './providers/index.ts'
import { DEFAULT_MAX_TOKENS } from './providers/outputcap.ts'
import type { Provider, ToolImage } from './types.ts'

export interface VisionHelper {
  /** Shown in the result ("<label> looked at the slide"). */
  label: string
  /** The helper's answer to `prompt` about `image`; throws on failure. */
  describe(image: ToolImage, prompt: string, signal: AbortSignal): Promise<string>
}

export const LOOK_TOOL_NAME = 'look_at_slide'

export const LOOK_TOOL = {
  name: LOOK_TOOL_NAME,
  description: 'You cannot see images: this asks a model that can. It gets a screenshot of the slide (shown in the editor first if needed) plus your question, and answers in text. Use it for what numbers cannot tell: visual balance, crowding, colour and contrast, whether pictures, charts and diagrams look right. Call it once per finished slide, after review_slide\'s numbers look right, not after every small write.',
  inputSchema: {
    type: 'object',
    properties: {
      slideId: { type: 'string', description: 'Deck slide to look at.' },
      question: { type: 'string', description: 'What to check, e.g. "Is the diagram balanced and are the six steps easy to follow?". Optional: a general design review.' },
    },
    required: ['slideId'],
  },
}

export const VISION_SYSTEM = 'You review presentation slides for another AI assistant that edits them but cannot see images. Look at the screenshot and answer its question concretely: what is wrong, where, and how to fix it (move, resize, align, recolour, shorten). Name elements by the ids in the element list when you can tell which one you mean. If the slide looks fine, say so in one sentence. Do not describe what is fine at length. At most 150 words.'

export function visionPrompt(elements: string, question: string | undefined): string {
  const q = question?.trim() || 'Give a short design review: crowding, alignment, balance, contrast, anything that looks broken.'
  return `Question: ${q}\n\nElement list of this slide (ids, frames in slide px, text):\n${elements}`
}

/** An API profile as the helper (it must accept image input). */
export function apiVisionHelper(profile: ApiProfile, apiKey: string | undefined, provider: Provider = providerFor(profile)): VisionHelper {
  return {
    label: profile.name,
    async describe(image, prompt, signal) {
      const c = await provider.complete({
        baseUrl: profile.baseUrl, model: profile.model, maxTokens: profile.maxTokens ?? DEFAULT_MAX_TOKENS, apiKey,
        system: VISION_SYSTEM, tools: [], messages: [{ role: 'user', text: prompt, images: [image] }], signal, onText: () => {},
      })
      const text = c.text.trim()
      if (!text) throw new Error(`${profile.name} returned no answer`)
      return text
    },
  }
}

/** The shell command line for a Claude Code vision helper. `command` is a
 *  whitelisted profile command (isValidCommand) and `model` matched MODEL_RE,
 *  so neither can carry shell syntax; the model is still quoted, as `[1m]`
 *  style suffixes would be glob patterns to zsh. The prompt goes on stdin. */
export function claudeVisionCommand(command: string, model: string | undefined): string {
  return [command, '-p', '--output-format', 'json', ...(model ? ['--model', `'${model}'`] : []), '--allowedTools', 'Read'].join(' ')
}

/** The prompt for the CLI: it reads the screenshot itself with its Read tool. */
export function claudeVisionPrompt(file: string, prompt: string): string {
  return `${VISION_SYSTEM}\n\nFirst read the image file ./${file} (a screenshot of the slide) with the Read tool, then answer.\n\n${prompt}`
}

/** `claude -p --output-format json` → its answer. The login shell may print
 *  rc-file noise around it, so the LAST line that parses as a result wins. */
export function parseClaudeResult(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: { type?: string; result?: unknown; is_error?: boolean; subtype?: string }
    try { r = JSON.parse(lines[i]) } catch { continue }
    if (r.type !== 'result') continue
    const text = typeof r.result === 'string' ? r.result.trim() : ''
    if (r.is_error || !text) throw new Error(text || `Claude Code stopped (${r.subtype ?? 'error'})`)
    return text
  }
  throw new Error(`no answer from Claude Code${stdout.trim() ? `: ${stdout.trim().slice(-300)}` : ''}`)
}
