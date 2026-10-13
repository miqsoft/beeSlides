// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
import type { ApiProfile } from '../../aiprofiles.ts'
import type { Provider } from '../types.ts'
import { anthropicProvider } from './anthropic.ts'
import { withImageFallback } from './images.ts'
import { openaiProvider } from './openai.ts'
import { withOutputCap } from './outputcap.ts'
import { withReasoningFallback } from './reasoning.ts'

const anthropicCapped = withImageFallback(withOutputCap(withReasoningFallback(anthropicProvider)))
const openaiCapped = withImageFallback(withOutputCap(withReasoningFallback(openaiProvider)))

export const providerFor = (p: ApiProfile): Provider => (p.wire === 'openai' ? openaiCapped : anthropicCapped)
