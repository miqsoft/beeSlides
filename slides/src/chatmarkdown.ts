// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The chat panels' markdown: the desktop's API-chat tabs
// (desktop/src/renderer/terminal/chatView.ts) and Settings ▸ Customize's AI
// chat (editor/customize/chatpane.ts) render model text through this one
// function.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
}

/** A small markdown subset (fences, headings, lists, inline code/bold/italic).
 *  Everything is HTML-escaped first and only our own tags are added back, so
 *  model output can never inject markup. Links stay plain text on purpose: a
 *  click in this view must never navigate it. */
export function renderMarkdown(src: string): string {
  const out: string[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let list: 'ul' | 'ol' | null = null
  const closeList = (): void => { if (list) { out.push(`</${list}>`); list = null } }
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      closeList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      i++ // closing fence (or end of a still-streaming block)
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`) }
    else if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`)
    } else if (line.trim() === '') closeList()
    else {
      closeList()
      // consecutive plain lines form one paragraph
      const para = [line]
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i + 1])) para.push(lines[++i])
      out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    }
    i++
  }
  closeList()
  return out.join('')
}
