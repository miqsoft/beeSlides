// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The bench's tasks: fixture deck, the slide the user is looking at, what is
// selected (element ids clicked on the canvas, like the user would), the
// prompt, and a task-specific `verify(before, after)` that turns the final
// deck into a few comparable numbers. `prompt` may be a function of the
// checkout's AGENT_PROMPTS (the fix-comments button's real text).

const stripHtml = (h) => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const slideById = (doc, id) => doc.slides.find((s) => s.id === id)
const r1 = (n) => Math.round(n * 10) / 10

/** Text elements whose plain text starts with `label`. */
const findText = (slide, re) => (slide?.elements ?? []).filter((e) => e.type === 'text' && re.test(stripHtml(e.html)))

/** The visual frame of a card: its group's union box, else the smallest rect containing the title's centre. */
function cardFrame(slide, titleEl) {
  const members = titleEl.groupId ? slide.elements.filter((e) => e.groupId === titleEl.groupId) : []
  if (members.length > 1) return union(members)
  const cx = titleEl.x + titleEl.w / 2, cy = titleEl.y + titleEl.h / 2
  const boxes = slide.elements
    .filter((e) => e.type === 'shape' && e.shape === 'rect' && e.x <= cx && cx <= e.x + e.w && e.y <= cy && cy <= e.y + e.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)
  return boxes[0] ? { x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h } : { x: titleEl.x, y: titleEl.y, w: titleEl.w, h: titleEl.h }
}
function union(els) {
  const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
  return { x, y, w: Math.max(...els.map((e) => e.x + e.w)) - x, h: Math.max(...els.map((e) => e.y + e.h)) - y }
}
const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)

/** Row/grid regularity of a set of frames: tops, sizes and gaps. */
function regularity(frames) {
  if (!frames.length) return { n: 0 }
  // cluster into rows by top (tolerance 24px)
  const sorted = [...frames].sort((a, b) => a.y - b.y)
  const rows = []
  for (const f of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - f.y) < 24)
    if (row) row.push(f); else rows.push([f])
  }
  const gaps = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    for (let i = 1; i < row.length; i++) gaps.push(row[i].x - (row[i - 1].x + row[i - 1].w))
  }
  return {
    n: frames.length,
    rows: rows.map((r) => r.length).join('+'),
    topSpreadInRow: r1(Math.max(...rows.map((r) => spread(r.map((f) => f.y))))),
    widthSpread: r1(spread(frames.map((f) => f.w))),
    heightSpread: r1(spread(frames.map((f) => f.h))),
    gapSpread: r1(spread(gaps)),
    overlaps: frames.some((a, i) => frames.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)),
  }
}

function contentBox(slide) {
  const els = (slide?.elements ?? []).filter((e) => !e.hidden)
  return els.length ? union(els) : null
}

function apCards(slide) {
  return findText(slide, /^AP 11\.\d/).map((t) => cardFrame(slide, t))
}

export const TASKS = [
  {
    name: 'comment-delete-rebalance',
    fixture: 'comment-delete-rebalance',
    slideId: 's-status',
    select: [],
    prompt: (p) => p['fix-comments'],
    verify(before, after) {
      const s = slideById(after, 's-status')
      const lowerLeft = ['fin-bg', 'fin-title', 'fin-body', 'report-bg', 'report-title', 'report-body', 'arrow-fin-report', 'summary-bar', 'summary-text']
        .filter((id) => s?.elements.some((e) => e.id === id)).length
      const lowerTexts = findText(s, /Finale Zahlen|Abschlussbericht|Zusammenfassung/).length
      const c = s?.comments?.find((x) => x.id === 'c-area-lower')
      const box = contentBox(s)
      return {
        lowerElementsLeft: lowerLeft,
        lowerTextsLeft: lowerTexts,
        commentResolved: !!c?.resolved,
        commentReplies: c?.replies?.length ?? 0,
        apCardsLeft: findText(s, /^AP 11\.\d/).length,
        cards: regularity(apCards(s)),
        contentBottom: box ? Math.round(box.y + box.h) : null,
      }
    },
  },
  {
    name: 'realign-cards',
    fixture: 'realign-cards',
    slideId: 's-status',
    select: ['ap1-bg', 'ap2-bg', 'ap3-bg', 'ap4-bg', 'ap5-bg', 'ap6-bg', 'ap7-bg'],
    expectSelected: 21, // grouped cards: bg + title + body each
    prompt: 'the alignment of the AP cards looks weird, fix it',
    verify(before, after) {
      const b = regularity(apCards(slideById(before, 's-status')))
      const a = regularity(apCards(slideById(after, 's-status')))
      return { before: b, after: a, apCardsLeft: a.n }
    },
  },
  {
    name: 'grid-2x3',
    fixture: 'grid-2x3',
    slideId: 's-services',
    select: [],
    // rubber-band over the six boxes (not the title)
    marquee: [60, 104, 1220, 610],
    expectSelected: 18,
    prompt: 'arrange these in a tidy 2×3 grid',
    verify(before, after) {
      const s = slideById(after, 's-services')
      const frames = findText(s, /^(Beratung|Entwicklung|Testing|Betrieb|Schulung|Support)$/).map((t) => cardFrame(s, t))
      return { boxes: regularity(frames) }
    },
  },
  {
    name: 'fill-space',
    fixture: 'fill-space',
    slideId: 's-kpis',
    select: [],
    prompt: 'the slide looks unbalanced, use the space better',
    verify(before, after) {
      const s = slideById(after, 's-kpis')
      const box = contentBox(s)
      const frames = findText(s, /^(Umsatz|Kunden|Churn|NPS)$/).map((t) => cardFrame(s, t))
      return {
        contentBottom: box ? Math.round(box.y + box.h) : null,
        verticalFill: box ? r1((box.y + box.h) / 720) : null,
        kpiTextsLeft: frames.length,
        cards: regularity(frames),
      }
    },
  },
  {
    name: 'recolor-titles',
    fixture: 'recolor-titles',
    slideId: 's-teams',
    select: [],
    prompt: 'make all card titles dark blue (#1F3A5F) and bold',
    verify(before, after) {
      const s = slideById(after, 's-teams')
      const titles = findText(s, /^(Frontend|Backend|DevOps|QA|Data|Security)$/)
      const done = titles.filter((t) => String(t.color).toUpperCase() === '#1F3A5F' && (t.fontWeight >= 700 || /<b>|<strong>/i.test(t.html)))
      const bodies = findText(s, /React|APIs|CI\/CD|Testauto|Analytics|Pentests/)
      return {
        titlesRestyled: `${done.length}/${titles.length}`,
        bodiesTouched: bodies.filter((t) => String(t.color).toUpperCase() === '#1F3A5F').length,
        slideTitleTouched: String(s?.elements.find((e) => e.id === 'title')?.color).toUpperCase() === '#1F3A5F',
      }
    },
  },
  {
    name: 'delete-notes',
    fixture: 'delete-notes',
    slideId: 's-roadmap',
    select: [],
    prompt: 'remove the three grey notes',
    verify(before, after) {
      const s = slideById(after, 's-roadmap')
      const noteIds = ['note1-bg', 'note1-text', 'note2-bg', 'note2-text', 'note3-bg', 'note3-text']
      const keepIds = ['title', 'bullets', 'visual', 'visual-caption']
      return {
        noteElementsLeft: noteIds.filter((id) => s?.elements.some((e) => e.id === id)).length + findText(s, /TODO|Quelle\?|Grafik ersetzen/).filter((e) => !noteIds.includes(e.id)).length,
        contentKept: `${keepIds.filter((id) => s?.elements.some((e) => e.id === id)).length}/${keepIds.length}`,
      }
    },
  },
  {
    name: 'create-deck',
    fixture: 'create-deck',
    slideId: 's-1',
    select: [],
    prompt: 'build a 3-slide status deck about migrating our build server to GitHub Actions',
    verify(before, after) {
      return {
        slides: after.slides.length,
        elementsPerSlide: after.slides.map((s) => s.elements.length).join(','),
        emptySlides: after.slides.filter((s) => !s.elements.length).length,
      }
    },
  },
  {
    name: 'add-comparison',
    fixture: 'add-comparison',
    slideId: 's-requirements',
    select: [],
    prompt: 'add a slide comparing option A (self-hosted) and option B (cloud)',
    verify(before, after) {
      const added = after.slides.filter((s) => !before.slides.some((b) => b.id === s.id))
      const text = added.map((s) => s.elements.map((e) => stripHtml(e.html ?? '') + (e.rows ? JSON.stringify(e.rows) : '')).join(' ')).join(' ')
      return {
        slidesAdded: added.length,
        mentionsBothOptions: /self-hosted|selbst/i.test(text) && /cloud/i.test(text),
        originalSlidesKept: before.slides.every((b) => after.slides.some((s) => s.id === b.id)),
        newSlideIndex: added[0] ? after.slides.indexOf(added[0]) : null,
      }
    },
  },
]
