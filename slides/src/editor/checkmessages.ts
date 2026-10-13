// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The user-facing face of validateDoc(). `validate.ts` is the AGENT API — its
// codes and English messages are written for someone authoring the JSON, and
// `window.slidomingo.validate()`, the MCP verbs and scripts/test-validate.ts all
// depend on them staying put. The Check slides dialog is for a person editing
// slides, so it maps each code to plain wording and a group here instead.
//
// Anything a person cannot act on from the canvas (a stray JSON key, a
// duplicate id, a stale theme reference …) is 'technical' and tucked behind a
// disclosure — and so is every code this table does not know, so a check added
// to validate.ts later can never leak developer wording into the main list.

import type { Finding } from '../validate'
import { t } from '../i18n'

export type CheckGroup = 'problem' | 'warning' | 'tip' | 'technical'

export interface FriendlyFinding {
  group: CheckGroup
  /** plain, translated one-liner; null for 'technical' (the dialog shows the
   *  validator's own message there) */
  text: string | null
}

/** Called per render — never cache: t() must run after the locale is set. */
export function friendlyFinding(f: Finding): FriendlyFinding {
  switch (f.code) {
    // problems: the file is broken in a way a reader will notice
    case 'missing-asset': return { group: 'problem', text: t('A picture or font is missing from this file') }
    case 'broken-link': return { group: 'problem', text: t('A link points to a slide that no longer exists') }

    // warnings: it will look or behave wrong
    case 'text-overflow': return { group: 'warning', text: t('Text doesn’t fit its box') }
    case 'out-of-canvas':
      // Non-text bleeding off the slide is a deliberate idiom (info) — not the
      // user's problem.
      return f.severity === 'warning'
        ? { group: 'warning', text: t('Text runs off the slide and gets cut off when presenting') }
        : { group: 'technical', text: null }
    case 'dangling-connector': return { group: 'warning', text: t('A connector is attached to something that was deleted') }
    case 'overridden-enter-fx': return { group: 'warning', text: t('This element morphs in from the previous slide, so its entrance animation is skipped') }
    case 'entrance-on-motion-path': return { group: 'warning', text: t('An entrance animation and a motion path conflict — the element can freeze. Use only one') }
    case 'step-on-morph': return { group: 'warning', text: t('This element morphs in from the previous slide, so its click-to-appear step is skipped') }
    case 'exit-before-enter': return { group: 'warning', text: t('This element is set to disappear before it appears') }
    case 'by-paragraph-not-text': return { group: 'warning', text: t('“Bullets one by one” only works on text') }
    case 'dash-march-no-dash': return { group: 'warning', text: t('The marching-dashes effect needs a dashed line') }
    case 'loop-scale-clash': return { group: 'warning', text: t('The looping scale effect conflicts with another scale effect on this element') }
    case 'low-contrast': return { group: 'warning', text: t('Text is hard to read against what’s behind it — make it darker or lighter') }

    // tips: worth a look, fine to ignore
    case 'past-margin': return { group: 'tip', text: t('Text crosses the side margin') }
    case 'font-not-embedded': return { group: 'tip', text: t('This font isn’t embedded, so other computers may show a different font') }
    case 'unreachable-hidden-slide': return { group: 'tip', text: t('Hidden slide that nothing links to') }
    case 'missing-alt': return f.layout
      // slide-type chrome: alt typed on a slide's copy would not last (the
      // next resync rebuilds it from the slide type), so send them there
      ? { group: 'tip', text: t('No alt text on part of the slide type — describe it once in the Layout Manager and every slide gets it') }
      : { group: 'tip', text: t('No alt text — describe this for people who can’t see it, or mark it decorative (Alt text section)') }
    case 'unlicensed-artwork': return { group: 'tip', text: t('This picture’s source is recorded but not its license — set one under “Source & license”, or replace it') }
    case 'missing-title': return { group: 'tip', text: t('Slide has no title — type one, or set its heading’s Role to “title” (Advanced section)') }

    default: return { group: 'technical', text: null }
  }
}
