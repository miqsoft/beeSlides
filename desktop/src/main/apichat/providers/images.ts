// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Text-only models (many local / vLLM ones, e.g. GLM): review_slide and
// render_preview return screenshots, and such a server rejects the whole
// request ("… is not a multimodal model"). A profile marked "Text-only" never
// sends images; for any other one, the first such 400 is recognised, remembered
// per server and model, and the request retried without them. The tool result
// keeps a note so the model knows to judge layout from the element list.
import type { ChatMsg, Provider } from '../types.ts'

export const IMAGE_OMITTED_NOTE = '[screenshot omitted: this model cannot read images; judge the layout from the element list and the check_layout findings]'

/** The transcript with every screenshot replaced by IMAGE_OMITTED_NOTE. */
export function withoutImages(messages: ChatMsg[]): ChatMsg[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.images?.length) return { role: 'user', text: `${m.text}\n${IMAGE_OMITTED_NOTE}`, ...(m.shown !== undefined ? { shown: m.shown } : {}) }
    if (m.role === 'tool' && m.results.some((r) => r.images.length)) {
      return { ...m, results: m.results.map((r) => (r.images.length ? { ...r, text: `${r.text}\n${IMAGE_OMITTED_NOTE}`.trim(), images: [] } : r)) }
    }
    return m
  })
}

const hasImages = (messages: ChatMsg[]): boolean => messages.some((m) => (m.role === 'tool' && m.results.some((r) => r.images.length)) || (m.role === 'user' && !!m.images?.length))

/** Whether a 400 says the model cannot take image input.
 *  - vLLM (also through LiteLLM): "nvidia/GLM-5.3-NVFP4 is not a multimodal model"
 *  - OpenAI-style: "Invalid content type. image_url is only supported by certain models."
 *  - others: "This model does not support image input", "vision is not supported" … */
export function isImageReject(e: unknown): boolean {
  const err = e as { status?: number; message?: string }
  if (err?.status !== 400 || typeof err.message !== 'string') return false
  const m = err.message
  return /not a multimodal model/i.test(m)
    || /image_url is only supported/i.test(m)
    || /(?:does not|doesn't|not) support(?:s|ed)?\s+(?:image|vision|multimodal)/i.test(m)
    || /(?:image|vision|multimodal)[\w\s-]{0,30}(?:is |are )?not (?:supported|enabled|available)/i.test(m)
}

const textOnly = new Set<string>()

/** Whether this server/model was found to reject images (this run of the app). */
export const knownTextOnly = (baseUrl: string, model: string): boolean => textOnly.has(`${baseUrl}\n${model}`)

export function withImageFallback(inner: Provider): Provider {
  return {
    async complete(o) {
      const key = `${o.baseUrl}\n${o.model}`
      if (o.images === false || textOnly.has(key)) return inner.complete({ ...o, images: false })
      try { return await inner.complete(o) } catch (e) {
        if (!hasImages(o.messages) || !isImageReject(e) || o.signal.aborted) throw e
        textOnly.add(key)
        return inner.complete({ ...o, images: false })
      }
    },
  }
}
