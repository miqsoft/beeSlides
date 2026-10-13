// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The equation palette's CONTENT and its text surgery — pure, no DOM, so
// scripts/test-math-palette.ts can prove every snippet typesets and every
// caret lands where it should. The widget that shows it is
// mathpalettebar.ts; the hosts are the equation popover (matheditor.ts), the
// equation panel's TeX field, and a live text or table-cell edit.
//
// A SLOT is an empty brace group `{}` in a snippet. Inserting a snippet puts
// the caret in its first slot (wrapping any selected text into it), and Tab
// walks to the next empty slot — the way Word's equation editor and
// MathType move between the boxes of a fraction.
//
// Labels are ENGLISH i18n keys, translated where they are shown (never call
// t() at module scope). A snippet without a label is its own tooltip: TeX is
// the same in every language.

export interface MathSnippet {
  /** what is inserted; `{}` marks a slot */
  tex: string
  /** what the palette button shows, when the slots would render as nothing */
  preview?: string
  /** English i18n key for the tooltip; absent = the TeX itself */
  label?: string
}

export interface MathGroup {
  id: string
  /** English i18n key */
  label: string
  /** TeX drawn on the group's tab */
  icon: string
  items: MathSnippet[]
  /** items are whole formulas: one per row, not a grid of glyphs */
  wide?: boolean
}

const sym = (...tex: string[]): MathSnippet[] => tex.map((t) => ({ tex: t }))

export const MATH_PALETTE: MathGroup[] = [
  {
    id: 'structures', label: 'Structures', icon: '\\frac{a}{b}',
    items: [
      { tex: '\\frac{}{}', preview: '\\frac{a}{b}', label: 'Fraction' },
      { tex: '{}^{}', preview: 'x^{n}', label: 'Superscript' },
      { tex: '{}_{}', preview: 'x_{i}', label: 'Subscript' },
      { tex: '{}_{}^{}', preview: 'x_{i}^{n}', label: 'Subscript and superscript' },
      { tex: '\\sqrt{}', preview: '\\sqrt{x}', label: 'Square root' },
      { tex: '\\sqrt[{}]{}', preview: '\\sqrt[n]{x}', label: 'Root' },
      { tex: '\\binom{}{}', preview: '\\binom{n}{k}', label: 'Binomial coefficient' },
      { tex: '\\left( {} \\right)', preview: '\\left( x \\right)', label: 'Parentheses' },
      { tex: '\\left[ {} \\right]', preview: '\\left[ x \\right]', label: 'Brackets' },
      { tex: '\\left\\{ {} \\right\\}', preview: '\\left\\{ x \\right\\}', label: 'Braces' },
      { tex: '\\left| {} \\right|', preview: '\\left| x \\right|', label: 'Absolute value' },
      { tex: '\\left\\| {} \\right\\|', preview: '\\left\\| x \\right\\|', label: 'Norm' },
      { tex: '\\overline{}', preview: '\\overline{x}', label: 'Overline' },
      { tex: '\\hat{}', preview: '\\hat{x}', label: 'Hat' },
      { tex: '\\vec{}', preview: '\\vec{v}', label: 'Vector' },
      { tex: '\\dot{}', preview: '\\dot{x}', label: 'Dot' },
      { tex: '\\tilde{}', preview: '\\tilde{x}', label: 'Tilde' },
      { tex: '\\underbrace{}_{}', preview: '\\underbrace{a+b}_{n}', label: 'Underbrace' },
      { tex: '\\overbrace{}^{}', preview: '\\overbrace{a+b}^{n}', label: 'Overbrace' },
      { tex: '\\text{}', preview: '\\text{abc}', label: 'Text' },
      { tex: '\\boxed{}', preview: '\\boxed{x}', label: 'Box' },
      { tex: '\\begin{cases} {} & {} \\\\ {} & {} \\end{cases}', preview: '\\begin{cases} a & x>0 \\\\ b & x\\le 0 \\end{cases}', label: 'Cases' },
      { tex: '\\begin{aligned} {} &= {} \\\\ &= {} \\end{aligned}', preview: '\\begin{aligned} a &= b \\\\ &= c \\end{aligned}', label: 'Aligned equations' },
    ],
  },
  {
    id: 'operators', label: 'Big operators', icon: '\\sum',
    items: [
      { tex: '\\sum_{}^{}', preview: '\\sum_{i=1}^{n}', label: 'Sum' },
      { tex: '\\prod_{}^{}', preview: '\\prod_{i=1}^{n}', label: 'Product' },
      { tex: '\\int_{}^{}', preview: '\\int_{a}^{b}', label: 'Integral' },
      { tex: '\\iint_{}', preview: '\\iint_{D}', label: 'Double integral' },
      { tex: '\\oint_{}', preview: '\\oint_{C}', label: 'Contour integral' },
      { tex: '\\lim_{{} \\to {}}', preview: '\\lim_{x \\to 0}', label: 'Limit' },
      { tex: '\\bigcup_{}^{}', preview: '\\bigcup_{i=1}^{n}', label: 'Union' },
      { tex: '\\bigcap_{}^{}', preview: '\\bigcap_{i=1}^{n}', label: 'Intersection' },
      { tex: '\\max_{}', preview: '\\max_{x}', label: 'Maximum' },
      { tex: '\\min_{}', preview: '\\min_{x}', label: 'Minimum' },
      { tex: '\\sup_{}', preview: '\\sup_{x}' },
      { tex: '\\inf_{}', preview: '\\inf_{x}' },
      { tex: '\\frac{d}{d{}}', preview: '\\frac{d}{dx}', label: 'Derivative' },
      { tex: '\\frac{\\partial}{\\partial {}}', preview: '\\frac{\\partial}{\\partial x}', label: 'Partial derivative' },
    ],
  },
  {
    id: 'matrices', label: 'Matrices', icon: '\\left(\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}\\right)',
    items: [
      { tex: '\\begin{pmatrix} {} & {} \\\\ {} & {} \\end{pmatrix}', preview: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
      { tex: '\\begin{bmatrix} {} & {} \\\\ {} & {} \\end{bmatrix}', preview: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
      { tex: '\\begin{vmatrix} {} & {} \\\\ {} & {} \\end{vmatrix}', preview: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', label: 'Determinant' },
      { tex: '\\begin{pmatrix} {} & {} & {} \\\\ {} & {} & {} \\\\ {} & {} & {} \\end{pmatrix}', preview: '\\begin{pmatrix} a & b & c \\\\ d & e & f \\\\ g & h & i \\end{pmatrix}' },
      { tex: '\\begin{pmatrix} {} \\\\ {} \\end{pmatrix}', preview: '\\begin{pmatrix} x \\\\ y \\end{pmatrix}', label: 'Column vector' },
      { tex: '\\begin{pmatrix} {} \\\\ {} \\\\ {} \\end{pmatrix}', preview: '\\begin{pmatrix} x \\\\ y \\\\ z \\end{pmatrix}', label: 'Column vector' },
      { tex: '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}', label: 'Identity matrix' },
      ...sym('\\cdots', '\\vdots', '\\ddots', '\\ldots'),
    ],
  },
  {
    id: 'greek', label: 'Greek', icon: '\\alpha',
    items: sym(
      '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon', '\\zeta', '\\eta',
      '\\theta', '\\vartheta', '\\iota', '\\kappa', '\\lambda', '\\mu', '\\nu', '\\xi',
      '\\pi', '\\rho', '\\sigma', '\\tau', '\\upsilon', '\\phi', '\\varphi', '\\chi',
      '\\psi', '\\omega',
      '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi', '\\Sigma', '\\Upsilon',
      '\\Phi', '\\Psi', '\\Omega',
    ),
  },
  {
    id: 'relations', label: 'Operators & relations', icon: '\\pm',
    items: sym(
      '+', '-', '\\pm', '\\mp', '\\times', '\\div', '\\cdot', '\\ast', '\\circ', '\\bullet',
      '=', '\\neq', '\\approx', '\\equiv', '\\sim', '\\simeq', '\\cong', '\\propto',
      '<', '>', '\\leq', '\\geq', '\\ll', '\\gg', '\\infty', '\\partial', '\\nabla', '\\hbar',
      '^{\\circ}', '\\%', '\\mid', '\\parallel', '\\perp', '\\angle',
    ),
  },
  {
    id: 'sets', label: 'Sets & logic', icon: '\\in',
    items: [
      ...sym(
        '\\in', '\\notin', '\\ni', '\\subset', '\\subseteq', '\\supset', '\\supseteq', '\\cup',
        '\\cap', '\\setminus', '\\emptyset', '\\varnothing', '\\forall', '\\exists', '\\nexists', '\\neg',
        '\\land', '\\lor', '\\implies', '\\iff', '\\therefore', '\\because',
        '\\mathbb{N}', '\\mathbb{Z}', '\\mathbb{Q}', '\\mathbb{R}', '\\mathbb{C}',
      ),
      { tex: '\\{ {} \\mid {} \\}', preview: '\\{ x \\mid x>0 \\}', label: 'Set-builder notation' },
    ],
  },
  {
    id: 'arrows', label: 'Arrows', icon: '\\to',
    items: [
      ...sym(
        '\\to', '\\gets', '\\leftrightarrow', '\\Rightarrow', '\\Leftarrow', '\\Leftrightarrow',
        '\\mapsto', '\\uparrow', '\\downarrow', '\\updownarrow', '\\nearrow', '\\searrow',
        '\\longrightarrow', '\\Longrightarrow', '\\hookrightarrow', '\\rightleftharpoons',
      ),
      { tex: '\\xrightarrow{}', preview: '\\xrightarrow{f}' },
    ],
  },
  {
    id: 'functions', label: 'Functions', icon: '\\sin',
    items: [
      ...sym(
        '\\sin', '\\cos', '\\tan', '\\cot', '\\sec', '\\csc', '\\arcsin', '\\arccos', '\\arctan',
        '\\sinh', '\\cosh', '\\tanh', '\\log', '\\ln', '\\exp', '\\det', '\\dim', '\\ker', '\\gcd',
      ),
      { tex: '\\log_{}', preview: '\\log_{b}' },
      { tex: '\\operatorname{}', preview: '\\operatorname{f}', label: 'Named operator' },
    ],
  },
  {
    id: 'formulas', label: 'Formulas', icon: 'e^{i\\pi}', wide: true,
    items: [
      { tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', label: 'Quadratic formula' },
      { tex: 'a^2 + b^2 = c^2', label: 'Pythagorean theorem' },
      { tex: 'e^{i\\pi} + 1 = 0', label: 'Euler’s identity' },
      { tex: 'E = mc^2', label: 'Mass–energy equivalence' },
      { tex: 'A = \\pi r^2', label: 'Area of a circle' },
      { tex: '(x+y)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{k} y^{n-k}', label: 'Binomial theorem' },
      { tex: 'f\'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}', label: 'Derivative' },
      { tex: 'f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x-a)^n', label: 'Taylor series' },
      { tex: '\\sum_{n=0}^{\\infty} r^n = \\frac{1}{1-r}', label: 'Geometric series' },
      { tex: '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}', label: 'Gaussian integral' },
      { tex: 'f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}', label: 'Normal distribution' },
      { tex: 'P(A \\mid B) = \\frac{P(B \\mid A) \\, P(A)}{P(B)}', label: 'Bayes’ theorem' },
      { tex: '\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i', label: 'Mean' },
      { tex: '\\sigma^2 = \\frac{1}{n} \\sum_{i=1}^{n} (x_i - \\bar{x})^2', label: 'Variance' },
      { tex: '\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x) \\, e^{-2\\pi i x \\xi} \\, dx', label: 'Fourier transform' },
      { tex: 'i\\hbar \\frac{\\partial}{\\partial t} \\Psi = \\hat{H} \\Psi', label: 'Schrödinger equation' },
    ],
  },
]

/** An empty brace group at `i`: `{` (not the escaped `\{`), only spaces, `}`. */
function slotAt(text: string, i: number): number {
  if (text[i] !== '{' || isEscaped(text, i)) return -1
  let j = i + 1
  while (text[j] === ' ') j++
  return text[j] === '}' ? j : -1
}

/** Is the character at `i` escaped by an ODD run of backslashes before it? */
function isEscaped(text: string, i: number): boolean {
  let n = 0
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++
  return n % 2 === 1
}

export interface Slot { start: number; end: number }

/** Every empty slot, as the range INSIDE its braces (start === end for `{}`). */
export function slots(text: string): Slot[] {
  const out: Slot[] = []
  for (let i = 0; i < text.length; i++) {
    const close = slotAt(text, i)
    if (close >= 0) out.push({ start: i + 1, end: close })
  }
  return out
}

/**
 * The next empty slot after the caret at `from` (Tab), or before it
 * (Shift+Tab), wrapping round the ends. The slot the caret is IN never
 * counts — Tab always moves. Null when there is no other empty slot.
 */
export function nextSlot(text: string, from: number, back = false): Slot | null {
  const all = slots(text).filter((s) => !(from >= s.start && from <= s.end))
  if (!all.length) return null
  if (back) return [...all].reverse().find((s) => s.end < from) ?? all[all.length - 1]
  return all.find((s) => s.start > from) ?? all[0]
}

export interface Edit { text: string; selStart: number; selEnd: number }

const endsInControlWord = (s: string) => /(^|[^\\])(\\\\)*\\[a-zA-Z]+$/.test(s)
const startsWithLetter = (s: string) => /^[a-zA-Z]/.test(s)

/**
 * Insert `snippet` over the selection [selStart, selEnd) of `text`. A
 * non-empty selection is wrapped into the snippet's first slot (select `x`,
 * pick √ → `\sqrt{x}`). The caret lands in the first slot still empty, else
 * after the snippet. A space keeps a control word from swallowing a letter
 * on either side (`\alpha` + `x` must not become `\alphax`).
 */
export function insertSnippet(text: string, selStart: number, selEnd: number, snippet: string): Edit {
  const a = Math.max(0, Math.min(selStart, selEnd, text.length))
  const b = Math.min(text.length, Math.max(selStart, selEnd))
  const before = text.slice(0, a)
  const after = text.slice(b)
  const picked = text.slice(a, b)
  let body = snippet
  const first = slots(body)[0]
  if (picked && first) body = body.slice(0, first.start) + picked + body.slice(first.end)
  if (startsWithLetter(body) && endsInControlWord(before)) body = ' ' + body
  if (endsInControlWord(body) && startsWithLetter(after)) body = body + ' '
  const out = before + body + after
  const empty = slots(body)[0]
  const caret = empty ? before.length + empty.start : before.length + body.length
  return { text: out, selStart: caret, selEnd: caret }
}

/**
 * Is `offset` inside `$…$` / `$$…$$` math in `text`? Walks the delimiters
 * the way render.ts's resolveMath reads them: `\$` is a literal dollar, `$$`
 * opens and closes display math, and a single `$` opens inline math only
 * when it is not followed by whitespace (so "costs $ 5" stays prose). The
 * caret straight after an opening `$` counts as inside.
 */
export function mathContextAt(text: string, offset: number): 'inline' | 'display' | null {
  let state: 'inline' | 'display' | null = null
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c !== '$') continue
    if (text[i + 1] === '$' && state !== 'inline' && i + 1 < end) {
      state = state === 'display' ? null : 'display'
      i++
      continue
    }
    if (state === 'display') continue
    if (state === 'inline') { state = null; continue }
    const next = text[i + 1]
    if (next === undefined || i + 1 >= end || !/\s/.test(next)) state = 'inline'
  }
  return state
}

/** What a palette pick inserts into PROSE (a text box or a table cell): the
 *  snippet wrapped as inline math, unless the caret is already in math. */
export function proseSnippet(snippet: string, inMath: boolean): { text: string; caretBack: number } {
  if (inMath) {
    const s = slots(snippet)[0]
    return { text: snippet, caretBack: s ? snippet.length - s.start : 0 }
  }
  const wrapped = `$${snippet}$`
  const s = slots(wrapped)[0]
  // no slot: the caret goes inside the closing `$`, ready to keep typing math
  return { text: wrapped, caretBack: s ? wrapped.length - s.start : 1 }
}
