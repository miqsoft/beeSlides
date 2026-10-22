// Hand-rolled, dependency-free stdio MCP server exposing get_slide/write_slide
// as thin wrappers around the terminal panel's existing file-watch write-back
// substrate (see ../main/terminalPanel.ts) — no new RPC transport, no
// @modelcontextprotocol/sdk dependency (Node built-ins only), consistent with
// this codebase's preference for small hand-rolled engines over heavy deps.
//
// Framing is newline-delimited JSON, one JSON-RPC 2.0 message per line on
// stdin/stdout — that is what the MCP spec's stdio transport (and Claude
// Code's client) actually speaks, NOT LSP-style Content-Length framing.
//
// This file is bundled straight into desktop's built main.js via a `?raw`
// import (terminalPanel.ts) and written out into each window's contextDir at
// panel-open time; process.argv[2] is that contextDir, absolute, passed only
// through mcp-config.json — never shell-interpolated.
//
// `--endpoint <agentDir>` instead is how an AI app outside BeeSlides (Claude
// Desktop, Claude Code in a terminal, …) runs it: requests then go over the
// app's local socket (main/agentendpoint.ts), whose address and token the app
// keeps in <agentDir>, and the app is started if it isn't running.
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const endpointDir = process.argv[2] === '--endpoint' ? process.argv[3] : null
const contextDir = endpointDir ? null : process.argv[2]
if (!contextDir && !endpointDir) {
  process.stderr.write('slides-mcp-server: missing contextDir argument\n')
  process.exit(1)
}

// fs.watch on contextDir is the primary wakeup; this poll only covers an
// event the watcher misses (it is best effort on some filesystems).
const POLL_MS = 25

// The timing log below is best effort: a closed stderr pipe surfaces as an
// async 'error' event (EPIPE), not a throw, and must never kill the server.
process.stderr.on('error', () => {})
const TIMEOUT_MS = 5000
// The icons tool waits on the user's icon server (or a first folder walk).
const NETWORK_TIMEOUT_MS = 20000
// area tools that may take longer than a round trip: icons wait on the
// network, slide_html lays HTML out (fonts, pictures) and checks it
const SLOW_AREAS = new Set(['icons', 'slide_html'])

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** A wakeup for `filename` appearing in contextDir: `next()` resolves on the
 *  first fs.watch event naming it (or an unnamed one), or after `ms` —
 *  whichever comes first — so a response is picked up within a few ms of
 *  landing instead of up to a whole poll interval later. Armed BEFORE the
 *  request is written, so even an instant response cannot slip past it. */
function fileWaker(filename, ms) {
  let wake = null
  let watcher = null
  try {
    watcher = watch(contextDir, (_event, name) => { if (!name || name === filename) wake?.() })
    watcher.on('error', () => { /* poll fallback still runs */ })
  } catch { /* unwatchable — the poll alone still works */ }
  return {
    next: () => new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve() }, ms)
      wake = () => { clearTimeout(timer); wake = null; resolve() }
    }),
    close: () => { try { watcher?.close() } catch { /* already closed */ } },
  }
}

/**
 * Writes `${reqPrefix}-<uuid>.json`, waits (fs.watch + short poll) for `${resPrefix}-<uuid>.json`,
 * deletes both once read (best effort — the app's own IPC handler already
 * deletes the request file once it forwards it, so that unlink is usually a
 * no-op), and returns the parsed response. Fails fast with a structured
 * `panel-closed` error if contextDir itself disappears mid-poll (the app
 * closed the window/panel) rather than waiting out the full timeout.
 */
function roundTrip(reqPrefix, resPrefix, payload, timeoutMs = TIMEOUT_MS) {
  return endpointDir ? socketRoundTrip(reqPrefix, payload, timeoutMs) : fileRoundTrip(reqPrefix, resPrefix, payload, timeoutMs)
}

async function fileRoundTrip(reqPrefix, resPrefix, payload, timeoutMs) {
  const id = randomUUID()
  const reqPath = join(contextDir, `${reqPrefix}-${id}.json`)
  const resPath = join(contextDir, `${resPrefix}-${id}.json`)
  const resName = `${resPrefix}-${id}.json`
  const started = Date.now()
  const waker = fileWaker(resName, POLL_MS)
  // Write-then-rename: the app forwards a request the moment its file
  // appears (no debounce), so it must never see a half-written one. The
  // dot-prefixed tmp name matches none of the app's request regexes.
  const tmpPath = join(contextDir, `.${reqPrefix}-${id}.json.tmp`)

  try {
    writeFileSync(tmpPath, JSON.stringify({ requestId: id, ...payload }), 'utf8')
    renameSync(tmpPath, reqPath)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!existsSync(contextDir)) return { requestId: id, ok: false, error: 'panel-closed' }
      if (existsSync(resPath)) {
        try {
          return JSON.parse(readFileSync(resPath, 'utf8'))
        } catch {
          return { requestId: id, ok: false, error: 'bad-response' }
        }
      }
      await waker.next()
    }
    return { requestId: id, ok: false, error: 'timeout' }
  } finally {
    waker.close()
    // stderr lands in Claude Code's MCP log — separates transport time from
    // model time when a tool call "feels slow".
    const verb = payload.verb ?? (reqPrefix === 'slide-request' ? 'get_slide' : reqPrefix === 'slide-write' ? 'write_slide' : reqPrefix)
    try { process.stderr.write(`[slides-mcp] ${verb} ${Date.now() - started}ms\n`) } catch { /* log is best effort */ }
    try { rmSync(tmpPath, { force: true }) } catch { /* renamed away, the normal case */ }
    try { rmSync(reqPath, { force: true }) } catch { /* already consumed by the app, or never written */ }
    try { rmSync(resPath, { force: true }) } catch { /* already consumed, or never existed */ }
  }
}

// ---- --endpoint mode: the app's local socket ----------------------------------
// One JSON object per line each way. The first line is a hello carrying the
// token from <agentDir>/token; every request after it is answered by a
// response line with the same requestId (main/agentendpoint.ts).

/** How long a call waits for BeeSlides to start before giving up. */
const LAUNCH_WAIT_MS = 30000

let link = null // { socket, waiting: Map<requestId, resolve> } once connected
let linking = null // the connect in progress

function readEndpoint() {
  try { return JSON.parse(readFileSync(join(endpointDir, 'endpoint.json'), 'utf8')) } catch { return null }
}

/** One attempt: connect, say hello, resolve the link — or null. */
function tryConnect() {
  const ep = readEndpoint()
  let token = ''
  try { token = readFileSync(join(endpointDir, 'token'), 'utf8').trim() } catch { /* the app writes it on first start */ }
  if (!ep?.socket || !token) return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = connect(ep.socket)
    const waiting = new Map()
    let helloDone = false
    let buf = ''
    const fail = () => { if (!helloDone) { helloDone = true; resolve(null) } }
    socket.setEncoding('utf8')
    socket.on('error', fail)
    socket.on('close', () => {
      fail()
      if (link?.socket === socket) link = null
      for (const done of waiting.values()) done({ ok: false, error: 'app-closed' })
      waiting.clear()
    })
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', token, client: process.env.BEESLIDES_CLIENT || 'mcp' }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.type === 'hello') {
          helloDone = true
          if (msg.ok) resolve({ socket, waiting })
          else { try { process.stderr.write(`[slides-mcp] endpoint refused: ${msg.error}\n`) } catch { /* log is best effort */ } socket.destroy(); resolve(null) }
        } else if (msg.type === 'response' && msg.result?.requestId) {
          const done = waiting.get(msg.result.requestId)
          waiting.delete(msg.result.requestId)
          done?.(msg.result)
        }
      }
    })
  })
}

/** Starts BeeSlides the way endpoint.json says it was started, detached, so
 *  it outlives this process. */
function launchApp() {
  const launch = readEndpoint()?.launch
  if (!launch?.command) return false
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE // this process may be the app's binary run as node
    spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], { detached: true, stdio: 'ignore', env }).unref()
    return true
  } catch {
    return false
  }
}

async function ensureLink() {
  if (link) return link
  linking ??= (async () => {
    let l = await tryConnect()
    if (!l && launchApp()) {
      const deadline = Date.now() + LAUNCH_WAIT_MS
      while (!l && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300))
        l = await tryConnect()
      }
    }
    return l
  })()
  try { link = await linking } finally { linking = null }
  return link
}

async function socketRoundTrip(channel, payload, timeoutMs) {
  const id = randomUUID()
  const started = Date.now()
  try {
    const l = await ensureLink()
    if (!l) return { requestId: id, ok: false, error: 'BeeSlides is not running and could not be started' }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { l.waiting.delete(id); resolve({ requestId: id, ok: false, error: 'timeout' }) }, timeoutMs)
      l.waiting.set(id, (result) => { clearTimeout(timer); resolve(result) })
      l.socket.write(JSON.stringify({ type: 'request', channel, payload: { requestId: id, ...payload } }) + '\n')
    })
  } finally {
    try { process.stderr.write(`[slides-mcp] ${payload.verb ?? channel} ${Date.now() - started}ms\n`) } catch { /* log is best effort */ }
  }
}

// Tool definitions stay in Claude's context for the whole session, so every
// description here is kept to what a caller needs to pick the verb and fill
// its arguments. The rationale (locks, variants, change patterns, slide-type
// tree semantics) lives in agents.md, which Claude reads on demand.
//
// Every slideId below also accepts a reusable object's id
// (list_reusable_objects) or a slide type's id (doc_info slideTypes); a write
// to a slide type carries over to every deck slide using it.
const SLIDE_ID = { type: 'string', description: 'Slide, reusable object or slide type id.' }
/** render_preview / review_slide: screenshot only part of the slide. */
const CAPTURE_REGION = {
  elementIds: { type: 'array', items: { type: 'string' }, description: 'Screenshot only these elements (with a margin around them).' },
  area: {
    type: 'object', description: 'Screenshot only this part of the slide, in slide px.',
    properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
    required: ['x', 'y', 'w', 'h'],
  },
}

// Grouped op tools (`deck`, …): generated from slides/src/agentops/spec.ts and
// filled in by the app when it writes this file out
// (desktop/src/main/agenttools.ts). Each is { def, help }.
const AGENT_AREAS = /*@AGENT_AREAS@*/[]

const TOOLS = [
  {
    name: 'get_slide',
    description:
      'One slide. view "summary": one line per element (id, type, frame, full ' +
      'text) plus notes, about a tenth of the size; enough to read the content ' +
      'and address elements by id. Default "full": the whole JSON (styles, ' +
      'background, ...), needed before write_slide or to copy exact styling. ' +
      'Skip it when the attached editing context or outline already says enough; ' +
      'to locate content use find_text, not one get_slide per slide.',
    inputSchema: { type: 'object', properties: { slideId: SLIDE_ID, view: { type: 'string', enum: ['summary', 'full'] } }, required: ['slideId'] },
  },
  {
    name: 'find_text',
    description:
      'Search the whole deck (element text, table cells, chart labels, alt ' +
      'text, slide names, speaker notes) case-insensitively. Several ' +
      'alternatives: "a|b". Returns slideId, slide index, elementId and a ' +
      'snippet per hit. The cheap way to find which slide talks about something.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find; "|" separates alternatives.' },
        limit: { type: 'number', description: 'Max hits (default 40).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_slide',
    description:
      'Replace one slide wholesale (slide.id must equal slideId). Only for ' +
      'restructuring a slide; use update_element/insert_elements/set_frame ' +
      'for smaller edits. Shape: agents.md quick reference.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        slide: { type: 'object', description: 'Full replacement Slide JSON.' },
        reflow: { type: 'boolean', description: 'Default true: the app keeps neighbours/arrows/text fitting around the edit. false = place exactly, only report.' },
      },
      required: ['slideId', 'slide'],
    },
  },
  // --- cheap read verbs (progressive disclosure — check before you commit) --
  {
    name: 'doc_info',
    description: 'Deck summary: title, size, theme, meta, slideCount, slideTypes [{id,name,parentId,placeholders,contentArea}]. Start here. A slide type\'s placeholders [{id,role,frame}] are filled by giving an element of slide_html that id, placed at its frame to keep the template\'s look (#<id>{position:absolute;left:<x>px;top:<y>px;width:<w>px}); its other elements stay as they are. contentArea [x,y,w,h] is the free space below its header and above its footer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'outline',
    description: 'One row per slide: id, index, name, hidden, stateOf, elementCount, roles, text preview.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_reusable_objects',
    description: 'One row per reusable object: id, index, name, elementCount.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'measure',
    description:
      'Height text needs, from the real renderer. Give elementId or spec. ' +
      'Returns {height,width,lines,fits?,overflow?}. Use before writing multi-line text.',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        spec: { type: 'object', description: '{html, w, h?, fontSize?, fontFamily?, fontWeight?, lineHeight?, letterSpacing?}' },
      },
    },
  },
  {
    name: 'validate',
    description: 'Lint the deck: unknown keys, text overflow, off-canvas/past-margin, dead effects, broken refs.',
    inputSchema: {
      type: 'object',
      properties: {
        measure: { type: 'boolean', description: 'Include text overflow (default true, slower).' },
        margin: { type: 'number', description: 'Side margin px; 0 disables.' },
      },
    },
  },
  {
    name: 'comments',
    description: 'Review comment threads (anchor, author, text, replies, resolved, forAgent = flagged "@ai").',
    inputSchema: {
      type: 'object',
      properties: { resolved: { type: 'boolean' }, forAgent: { type: 'boolean' }, slideId: { type: 'string' } },
    },
  },
  {
    name: 'recent_changes',
    description: 'Recent per-element changes (changed fields with before/after), newest first.',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string' }, slideId: { type: 'string' }, limit: { type: 'number', description: 'Default 20.' } },
    },
  },
  {
    name: 'render_preview',
    description:
      'PNG of a slide: the one on the editing canvas, or slideId (rendered ' +
      'off screen; the user\'s view does not move). elementIds or area ' +
      'shows just that part, zoomed in.',
    inputSchema: { type: 'object', properties: { slideId: { type: 'string' }, ...CAPTURE_REGION } },
  },
  {
    name: 'check_layout',
    description:
      'Layout problems on a slide as it is now: overlapping boxes, text that ' +
      'overflows its box, text off the canvas. Call after fixing a LAYOUT ' +
      'banner until it reports clean.',
    inputSchema: {
      type: 'object',
      properties: { slideId: SLIDE_ID, elementIds: { type: 'array', items: { type: 'string' }, description: 'Only overlaps involving these.' } },
    },
  },
  {
    name: 'review_slide',
    description:
      'Design review in one call: a screenshot of just the slide, every ' +
      'element as id/type/frame/text, and check_layout findings. Works for ' +
      'any deck slide; the user\'s view does not move. elementIds or area: the ' +
      'screenshot shows just that part, zoomed in (small details, one icon).',
    inputSchema: { type: 'object', properties: { slideId: SLIDE_ID, ...CAPTURE_REGION } },
  },
  // --- write verbs -----------------------------------------------------------
  // Round-trip through agent-action files; the app dispatches on `verb`
  // (editor.ts applyAgentAction). One undo step per call, a per-slide lock per
  // session, and `warnings` (validate() findings for the touched slide) on
  // success; a text-overflow finding is raised as a banner (formatWarnings).
  {
    name: 'update_element',
    description:
      'Patch properties of one element, e.g. {color:"#c00"} or {fontSize:40, ' +
      'html:"New"}. Shallow merge; null removes an optional prop; id/type are ' +
      'fixed. The default for a one-element edit; several elements: elements ' +
      '{op:"edit"} in one call. ' +
      '{locked:true} makes an element click-through in the editor; ' +
      '{hidden:true} removes it from every output.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        elementId: { type: 'string' },
        props: { type: 'object', description: 'Element props to set (format.md names).' },
        reflow: { type: 'boolean', description: 'Default true: the app keeps neighbours/arrows/text fitting around the edit. false = place exactly, only report.' },
      },
      required: ['slideId', 'elementId', 'props'],
    },
  },
  {
    name: 'insert_elements',
    description:
      'Insert element specs (ids optional, reminted) onto a slide, like a ' +
      'paste. For icons use the icons tool (the user\'s icon library); svg elements with markup of your own are refused (compose rect/ellipse/line/path shapes and text instead). Returns elementIds. nudge:false keeps exact coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        elements: { type: 'array', items: { type: 'object' } },
        assets: { type: 'object', description: 'asset-key -> data URI (pictures). SVG markup is refused.' },
        fonts: { type: 'array', items: { type: 'object' } },
        nudge: { type: 'boolean', description: 'Default true (+20,+20 like a paste).' },
        reflow: { type: 'boolean', description: 'Default true: the app keeps neighbours/arrows/text fitting around the edit. false = place exactly, only report.' },
      },
      required: ['slideId', 'elements'],
    },
  },
  {
    name: 'set_frame',
    description: 'Move/resize/rotate one element; omitted fields stay. To place several (a row, a grid, aligned, evenly spaced) use elements {op:"arrange"|"align"|"distribute"}: one call, the app computes the frames.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        elementId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number' }, h: { type: 'number' },
        rotation: { type: 'number' },
        reflow: { type: 'boolean', description: 'Default true: the app keeps neighbours/arrows/text fitting around the edit. false = place exactly, only report.' },
      },
      required: ['slideId', 'elementId'],
    },
  },
  {
    name: 'duplicate_element',
    description: 'Duplicate one element on its slide; x/y place the copy. Returns elementId.',
    inputSchema: {
      type: 'object',
      properties: { slideId: SLIDE_ID, elementId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
      required: ['slideId', 'elementId'],
    },
  },
  {
    name: 'delete_element',
    description: 'Delete one element. Several: elements {op:"delete", elementIds} in one call (it also reports space the delete freed).',
    inputSchema: {
      type: 'object',
      properties: { slideId: SLIDE_ID, elementId: { type: 'string' } },
      required: ['slideId', 'elementId'],
    },
  },
  {
    name: 'reorder_element',
    description: 'Change z-order: front/back, or one step forward/backward.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        elementId: { type: 'string' },
        to: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] },
      },
      required: ['slideId', 'elementId', 'to'],
    },
  },
  {
    name: 'apply_change_pattern',
    description:
      'Copy the last recorded change of sourceElementId onto the listed ' +
      'same-type targets ("do that to the others too"). Returns applied/skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        sourceElementId: { type: 'string' },
        targetElementIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['slideId', 'sourceElementId', 'targetElementIds'],
    },
  },
  {
    name: 'create_reusable_object',
    description: 'Create a blank reusable object; returns objectId. Fill it with insert_elements.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'promote_to_reusable_object',
    description: 'Copy elements from a slide into a new reusable object; returns objectId.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: SLIDE_ID,
        elementIds: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
      },
      required: ['slideId', 'elementIds'],
    },
  },
  {
    name: 'create_slide_type',
    description:
      'Create a slide type; returns layoutId. mode blank, parent (empty child ' +
      'inheriting sourceId) or basis (independent copy of sourceId).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        mode: { type: 'string', enum: ['blank', 'parent', 'basis'] },
        sourceId: { type: 'string', description: 'Existing slide type id; required for parent/basis.' },
      },
      required: ['name', 'mode'],
    },
  },
  {
    name: 'slide_type',
    description:
      'Manage an existing slide type. op rename {name}; reorder {to: index ' +
      'among siblings}; move {parentId|null, beforeId?} (reparent: inherits ' +
      'the new parent); detach (drop the parent, keep the look); relink ' +
      '{slideId} makes that slide follow layoutId (null = unlink, keeps its ' +
      'look) and returns the fit verdict + ids of content left floating.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['rename', 'reorder', 'move', 'detach', 'relink'] },
        layoutId: { type: ['string', 'null'] },
        slideId: { type: 'string' },
        name: { type: 'string' },
        to: { type: 'number' },
        parentId: { type: ['string', 'null'] },
        beforeId: { type: 'string' },
      },
      required: ['op', 'layoutId'],
    },
  },
  {
    name: 'resolve_comment',
    description:
      'Mark a review comment thread done once you have fixed what it asked (id from `comments`). ' +
      'It closes the thread AND flags it for the user to check (they Accept or Reopen it with feedback). ' +
      'Optional short reply is added as "Claude". Undoable by the user.',
    inputSchema: {
      type: 'object',
      properties: { commentId: { type: 'string' }, reply: { type: 'string' } },
      required: ['commentId'],
    },
  },
  {
    name: 'propose_variants',
    description:
      'Offer the user 2-6 different designs for one slide; they compare them ' +
      'side by side with the current slide and pick one or keep it. Write ' +
      'each as HTML + CSS exactly like slide_html write (same rules, ids ' +
      'merge into the slide), or as a whole slide (write_slide shape). Make ' +
      'them differ in layout and emphasis, not just colour; give each a short ' +
      'label and a one-line note on what it does differently. Applies ' +
      'nothing; the result lists any design that could not be made. You ' +
      'never learn the pick. A new call replaces an unpicked set.',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string' },
        variants: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              html: { type: 'string', description: 'The slide body as HTML (as in slide_html write).' },
              css: { type: 'string' },
              slide: { type: 'object', description: 'Instead of html: a whole slide (write_slide shape, same id).' },
              label: { type: 'string', description: 'A few words, e.g. "Three cards".' },
              note: { type: 'string', description: 'One line: what this design does differently.' },
            },
          },
        },
        assets: { type: 'object' },
        fonts: { type: 'array', items: { type: 'object' } },
      },
      required: ['slideId', 'variants'],
    },
  },
  // The editor's per-install UI profile — answered by the desktop app itself
  // (terminalPanel.ts), not the open deck. Kept identical to UI_PROFILE_TOOL
  // in ../main/uiprofiletool.ts (scripts/test-ai-profiles.ts compares them).
  {
    name: 'ui_profile',
    description:
      'Customize THIS install of the editor, not the deck: ribbon tabs and buttons, the right-click menu and the quick-format ' +
      'bar, toolbar buttons, shortcuts (incl. taking over built-in keys), saved styles and presets, chrome colours and density. ' +
      'ops: get, catalog (no section = an index; then ask for the sections you need — each says how to write that part), ' +
      'patch (RFC 7386 merge patch; needs summary), set, history, revert {rev}, reset. Writes are validated: on errors nothing ' +
      'changes. See the customize-ui skill.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'catalog', 'patch', 'set', 'history', 'revert', 'reset'] },
        patch: { type: 'object', description: 'patch: merge patch onto the current profile (null removes a key).' },
        profile: { type: 'object', description: 'set: a whole profile.' },
        summary: { type: 'string', description: 'One short line for the user: what changed.' },
        dryRun: { type: 'boolean', description: 'Validate only.' },
        rev: { type: 'number', description: 'revert: revision to go back to (0 = none).' },
        section: { type: 'string', enum: ['index', 'all', 'schema', 'commands', 'ribbon', 'menus', 'toolbar', 'panel', 'shortcuts', 'styles', 'tokens', 'icons', 'defaults'] },
      },
      required: ['op'],
    },
  },
]
TOOLS.push(...AGENT_AREAS.map((a) => a.def))

// ---- Code Mode (prototype): execute + api_search ---------------------------
// Filled in (true) by the app when BEESLIDES_CODE_MODE=1
// (desktop/src/main/agenttools.ts serverWithCodeMode). The program runs in the
// app (main/agentexec.ts), whose `deck` object this reference describes.
const CODE_MODE = /*@CODE_MODE@*/false
const MAX_PROGRAM_S = 300
/** How long a program waits for those queued before it (agentexec.ts QUEUE_MAX_S). */
const PROGRAM_QUEUE_S = 120

const API_REFERENCE = [
  {
    title: 'overview',
    body: `execute runs a JavaScript program against the open deck: the body of an async function, so use await and end with return.
- \`deck\` reads and edits the deck (below). \`console.log\` output comes back with the result.
- Return something JSON-able and small: counts, ids, the findings you need, not whole slides.
- ALL edits of one run are ONE undo step. If the program throws or runs out of time (timeoutSeconds, default 60, max 300) NOTHING changes: every edit of the run is rolled back.
- A real DOM is there (DOMParser, document, querySelector) to build and edit slide HTML. No network, no files, no timers you need.
- Plain JavaScript, not TypeScript. Calls are async: await them; Promise.all runs reads together.
- Use execute for work on several slides or many steps; one small edit is still a plain tool call.
- Look at the result afterwards with review_slide / render_preview: a program cannot see.`,
  },
  {
    title: 'deck',
    body: `deck.info()                     → doc_info: title, size {width,height}, theme, slideCount, slideTypes
deck.outline()                  → [{id, index, name, hidden, stateOf, elementCount, roles, text}] one row per slide
deck.slides()                   → the outline rows, each with .ref = deck.slide(id)
deck.slide(id)                  → a slide ref (see "slide"); also a slide type's or reusable object's id
deck.find(query, limit?)        → find_text hits [{slideId, index, elementId, field, snippet}]; "a|b" = either
deck.validate({measure?, margin?}) → findings [{code, severity, message, slide?, element?}]
deck.measure(spec)              → {height, width, lines, fits?} for {html, w, fontSize?, lineHeight?, …}
deck.comments()                 → comment threads
deck.op(tool, op, args)         → any grouped tool op (deck, deck_settings, icons, elements, slide_html): resolves to its result ({summary, …}); throws on an error
deck.query(verb, args) / deck.action(verb, args) → any other read / write tool by name (e.g. action('insert_elements', {...}))
deck.parse(html, css?)          → a Document of slide HTML;  deck.esc(text) → text escaped for HTML`,
  },
  {
    title: 'slide',
    body: `const s = deck.slide('s3')
await s.get()                   → the slide JSON (elements, background, notes, …)
await s.elements()              → its elements
await s.html()                  → {html, css}: the slide as HTML (slide_html read; verified: writing it back unchanged changes nothing)
await s.dom()                   → that HTML as a Document to edit with DOM methods (its css is a <style> in head)
await s.write(html, css?)       → slide_html write; also s.write(document) or s.write({html, css}); {reflow:false} as 3rd arg. Resolves to the write report (layout check included)
await s.update(elementId, props) → update_element: patch one element ({color:'#c00'}, {fontSize: 40}, {html:'New'})
await s.check()                 → check_layout findings for the slide`,
  },
  {
    title: 'html',
    body: `Slides are written as HTML exactly as with the slide_html tool (slide_html {op:"help", about:"write"} for the rules: theme variables --bs-*, ids are identity, data-keep, data-role, what becomes what).
Edit an existing slide through the DOM:
  const d = await deck.slide('s4').dom()
  d.querySelector('#c3')?.remove()
  d.querySelector('.cards').style.gap = '40px'
  return await deck.slide('s4').write(d)
Build several slides from ONE function, so they share spacing and sizes, and keep ids stable across slides so transition:"morph" pairs them:
  const css = '.slide{width:100%;height:100%;padding:72px var(--bs-margin);display:flex;flex-direction:column;gap:24px} .dot{width:28px;height:28px;border-radius:50%;background:#ccc} .dot.on{background:var(--bs-accent)} .track{display:flex;gap:16px}'
  const step = (i, title, text) => '<main class="slide"><h1 id="title">' + deck.esc(title) + '</h1><div class="track">' +
    [0, 1, 2].map((k) => '<div id="dot' + k + '" class="dot' + (k === i ? ' on' : '') + '"></div>').join('') +
    '</div><p id="body">' + deck.esc(text) + '</p></main>'
  for (const [i, s] of steps.entries()) await deck.slide(ids[i]).write(step(i, s.title, s.text), css)
Text from the deck or the user goes through deck.esc() before it goes into HTML.
Diagrams are components: data instead of markup (slide_html {op:"help", about:"write"} lists them):
  const q = (v) => JSON.stringify(v).replace(/'/g, '&#39;')   // JSON inside a single-quoted attribute
  const seq = (show) => '<div id="hs" data-component="sequence" data-show="' + show + '" style="position:absolute;left:50px;top:149px;width:1180px;height:479px"'
    + " data-actors='" + q(['Client', 'Server']) + "' data-messages='" + q(msgs) + "'></div>"
  for (const [i, id] of ids.entries()) await deck.slide(id).write(title(i) + seq(i + 1))   // one message more per slide; with transition morph it builds up`,
  },
  {
    title: 'examples',
    body: `Restyle every title:
  let n = 0
  for (const row of await deck.outline()) {
    const t = (await deck.slide(row.id).elements()).find((e) => e.role === 'title')
    if (t) { await deck.slide(row.id).update(t.id, { fontSize: 40, color: '#1a2b5c' }); n++ }
  }
  return { changed: n }
New slides, then content (every op: api_search "deck"):
  const { slideIds } = await deck.op('deck', 'add', { count: 2, names: ['Plan', 'Risks'] })
  for (const id of slideIds) await deck.slide(id).write('<h1 id="title">…</h1>')
Find and fix overflowing text:
  const over = (await deck.validate()).filter((w) => w.code === 'text-overflow')
  for (const w of over) await deck.slide(w.slide).update(w.element, { fontSize: 20 })
  return over.map((w) => w.slide + '/' + w.element)`,
  },
]

/** api_search: the reference sections and every grouped tool's op help,
 *  ranked by how many query words they contain. */
function apiSearch(query) {
  const words = String(query ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1)
  const entries = [
    ...API_REFERENCE.map((s) => ({ title: s.title, body: s.body })),
    ...AGENT_AREAS.flatMap((a) => Object.entries(a.help).filter(([op]) => op !== '*').map(([op, body]) => ({ title: `deck.op('${a.def.name}', '${op}', …)`, body }))),
  ]
  if (!words.length) {
    return `${API_REFERENCE[0].body}\n\nSections: ${API_REFERENCE.map((s) => s.title).join(', ')}; and every grouped tool op, e.g. api_search "slide_html write" or "deck add".`
  }
  const scored = entries
    .map((e) => {
      const hay = `${e.title}\n${e.body}`.toLowerCase()
      return { e, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 + (e.title.toLowerCase().includes(w) ? 2 : 0) : 0), 0) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  if (!scored.length) return `Nothing about "${query}". Sections: ${API_REFERENCE.map((s) => s.title).join(', ')}.`
  return scored.map(({ e }) => `## ${e.title}\n${e.body}`).join('\n\n')
}

const CODE_MODE_INSTRUCTIONS =
  'Code Mode is on: the execute tool runs a JavaScript program against the open deck. ' +
  'Any job that touches several slides or would take more than about three write calls ' +
  '(building or extending a deck, restyling, translating, fixing every slide) is ONE execute program, ' +
  'or a few for a large deck, not a chain of tool calls: add the slides, write each slide\'s HTML from shared ' +
  'functions, set notes and transitions, and return the new ids and any warnings. ' +
  'Reading to decide, one small edit, and looking at the result (review_slide, render_preview) stay plain tool calls. ' +
  'If a program throws, nothing changed: fix it and run it again.\n\n' +
  'Fast programs: write a slide whole (s.write) and fill its slide type\'s placeholders by their ids, placed at their frames, and lay content out in its contentArea (doc_info slideTypes); ' +
  'set many elements at once with deck.op("elements", "edit", {slideId, changes: [{id, fx: …}, …]}) — one call per slide, ' +
  'not deck.slide(id).update per element. Reads, and writes to different slides, can run together: await Promise.all([...]). ' +
  'Diagrams (steps, sequence, cards, compare, flow) are slide_html components: a few hundred characters of data per slide instead of hand-made markup.\n\n' +
  // the core of the reference, so the first program needs no lookups; api_search has the rest
  `The deck API (api_search has the grouped ops' arguments, slide HTML rules and examples):\n` +
  API_REFERENCE.filter((e) => e.title === 'deck' || e.title === 'slide').map((e) => e.body).join('\n')

if (CODE_MODE) {
  TOOLS.push(
    {
      name: 'execute',
      description:
        'Run a JavaScript program against the open deck: multi-step or multi-slide work in ONE call. ' +
        '`deck` reads and edits it (deck.outline(), deck.slide(id).dom() / .write(html | document) / .update(elementId, props), ' +
        'deck.op(tool, op, args) for every grouped tool; api_search for the reference). A real DOM is there for slide HTML; no network. ' +
        'All edits of a run are ONE undo step; if the program throws or times out NOTHING changes. Programs on one deck run one at a time (a second waits its turn), so subagents can each run their own. ' +
        'Return a small JSON-able value; it comes back with console.log output. Plain JavaScript, await allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The body of an async function: await the deck calls, end with return.' },
          timeoutSeconds: { type: 'number', description: `Default 60, at most ${MAX_PROGRAM_S}.` },
        },
        required: ['code'],
      },
    },
    {
      name: 'api_search',
      description: 'Look up the `deck` API execute programs use: functions, slide HTML, the grouped tools\' ops, examples. Empty query = overview.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words, e.g. "slide write", "add slides", "examples".' } } },
    },
  )
}

const QUERY_VERBS = new Set(['doc_info', 'outline', 'find_text', 'list_reusable_objects', 'measure', 'validate', 'comments', 'recent_changes', 'check_layout'])
const ACTION_VERBS = new Set([
  'update_element', 'insert_elements', 'set_frame', 'duplicate_element', 'delete_element', 'reorder_element',
  'apply_change_pattern', 'propose_variants', 'resolve_comment', 'create_reusable_object',
  'create_slide_type', 'promote_to_reusable_object',
])
// slide_type({op}) is one tool for Claude but still five verbs in the app.
const SLIDE_TYPE_OPS = new Set(['rename', 'reorder', 'move', 'detach', 'relink'])

/**
 * write_slide and the agent-action write verbs above both return `warnings`:
 * the existing validateDoc() findings for the touched slide (editor.ts
 * `warningsForSlide` — no new detection logic here, just formatting). Left
 * as one more entry in a generic array, a `text-overflow` finding is easy
 * for a calling agent to skim past, and unlike most other findings it means
 * the write just produced BROKEN output — text that will visibly collide
 * with whatever is below it — not a stylistic nit. Split it out and put it
 * FIRST, unmissably flagged, rather than buried at the end of the response.
 */
function formatWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings : []
  const overflow = list.filter((w) => w && w.code === 'text-overflow')
  const rest = list.filter((w) => !(w && w.code === 'text-overflow'))
  if (!overflow.length) return { banner: '', rest }
  const items = overflow
    .map((w) => `  - slide "${w.slide}" element "${w.element}": ${w.message}`)
    .join('\n')
  const banner =
    `⚠ TEXT OVERFLOW — ${overflow.length} element(s) do NOT fit their box and will ` +
    `visibly collide with whatever is below them:\n${items}\n` +
    `Fix this before moving on: call measure() with the same width/fontSize/lineHeight to ` +
    `see the height this text actually needs, then grow the box or shorten the text.\n\n`
  return { banner, rest }
}

/**
 * The layout guard's report on a write (editor.ts commitAgentWrite →
 * layoutguard.ts): what the app already fixed around the edit, and what it
 * could not decide. Both go FIRST, as banners, for the same reason as the
 * overflow banner — buried in JSON they get skimmed past. `text-overflow`
 * issues are left to formatWarnings, which already raises them.
 */
/** Rich-text html → plain text (tags dropped, <br>/block ends as spaces,
 *  the common entities decoded). Node has no DOM; this is for reading only. */
function plainText(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** get_slide view "summary": the slide as lines, like review_slide's element
 *  list but with the whole text (capped per element), table cells, chart
 *  labels and notes — what a model needs to read a slide, not rewrite it. */
function summarizeSlide(slide) {
  if (!slide || typeof slide !== 'object') return 'Error: no slide'
  const r = (n) => (typeof n === 'number' ? Math.round(n) : '?')
  const head = [`Slide "${slide.id}"`]
  if (slide.name) head.push(`name="${slide.name}"`)
  if (slide.layoutId) head.push(`slideType=${slide.layoutId}`)
  if (slide.stateOf) head.push(`stateOf=${slide.stateOf}`)
  if (slide.hidden) head.push('hidden')
  const lines = [`${head.join(' ')} — ${Array.isArray(slide.elements) ? slide.elements.length : 0} elements in paint order (get_slide view "full" for styles):`]
  for (const e of Array.isArray(slide.elements) ? slide.elements : []) {
    let line = `  ${e.id} ${e.type === 'shape' ? `shape:${e.shape}` : e.type}${e.role ? ` role=${e.role}` : ''} @${r(e.x)},${r(e.y)} ${r(e.w)}x${r(e.h)}`
    if (e.rotation) line += ` rot=${r(e.rotation)}`
    if (e.parentId) line += ` in=${e.parentId}`
    if (e.type === 'shape' && (e.from || e.to)) line += ` ${e.from?.el ?? '·'}→${e.to?.el ?? '·'}`
    if (typeof e.fontSize === 'number') line += ` ${e.fontSize}px`
    if (e.locked) line += ' locked'
    const text = typeof e.html === 'string' ? plainText(e.html) : e.type === 'code' ? String(e.content ?? '') : e.type === 'math' ? String(e.tex ?? '') : ''
    if (text) line += ` "${clip(text.replace(/\s+/g, ' '), 400)}"`
    if (e.type === 'table' && Array.isArray(e.rows)) {
      const cols = Array.isArray(e.columns) ? e.columns.length : (e.rows[0]?.cells?.length ?? 0)
      line += ` ${e.rows.length}x${cols}`
      lines.push(line)
      for (const row of e.rows.slice(0, 12)) lines.push(`    | ${(Array.isArray(row?.cells) ? row.cells : []).map((c) => clip(plainText(c?.html), 40)).join(' | ')} |`)
      if (e.rows.length > 12) lines.push(`    … ${e.rows.length - 12} more rows`)
      continue
    }
    if (e.type === 'chart') {
      const o = e.option ?? {}
      const title = Array.isArray(o.title) ? o.title[0]?.text : o.title?.text
      const series = (Array.isArray(o.series) ? o.series : []).map((x) => x?.name).filter(Boolean)
      const xs = Array.isArray(o.xAxis) ? o.xAxis[0]?.data : o.xAxis?.data
      line += `${e.preset ? ` ${e.preset}` : ''}${title ? ` title="${clip(String(title), 80)}"` : ''}${series.length ? ` series=${clip(series.join(', '), 120)}` : ''}${Array.isArray(xs) ? ` x=${clip(xs.join(', '), 120)}` : ''}`
    }
    if (typeof e.alt === 'string' && e.alt) line += ` alt="${clip(e.alt, 120)}"`
    lines.push(line)
  }
  const notes = plainText(slide.notes ?? '')
  if (notes) lines.push(`Notes: ${clip(notes, 600)}`)
  const comments = Array.isArray(slide.comments) ? slide.comments.filter((c) => !c.resolved).length : 0
  if (comments) lines.push(`${comments} open comment(s): call comments for them.`)
  return lines.join('\n')
}

function formatLayout(layout) {
  if (!layout || typeof layout !== 'object') return ''
  let out = ''
  const adjusted = Array.isArray(layout.adjusted) ? layout.adjusted : []
  const issues = (Array.isArray(layout.issues) ? layout.issues : []).filter((i) => i && i.code !== 'text-overflow')
  if (adjusted.length) {
    out += `↻ LAYOUT ADJUSTED — the app kept the slide consistent around your edit (same undo step):\n` +
      adjusted.map((a) => `  - ${a.message}`).join('\n') + '\n\n'
  }
  if (issues.length) {
    out += `⚠ LAYOUT — ${issues.length} issue(s) the app left for you:\n` +
      issues.map((i) => `  - ${i.severity === 'info' ? '(minor) ' : ''}${i.message}`).join('\n') +
      `\nFix and call check_layout until clean (at most 3 rounds).\n\n`
  }
  return out
}

/** check_layout's result as a few lines instead of JSON. */
function formatCheck(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : []
  if (!issues.length) return `✓ clean — no overlaps, overflowing or off-canvas text on slide "${result?.slideId}".`
  return `${issues.length} layout issue(s) on slide "${result?.slideId}":\n` +
    issues.map((i) => `  - [${i.code}] ${i.message}`).join('\n')
}

async function callTool(name, args) {
  if (name === 'get_slide') {
    const result = await roundTrip('slide-request', 'slide-response', { slideId: args?.slideId })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    if (args?.view === 'summary') return { content: [{ type: 'text', text: summarizeSlide(result.slide) }] }
    // Compact, not pretty-printed: indentation alone is ~30% of a slide's tokens.
    return { content: [{ type: 'text', text: JSON.stringify(result.slide) }] }
  }
  if (name === 'write_slide') {
    const result = await roundTrip('slide-write', 'slide-write-result', { slideId: args?.slideId, slide: args?.slide, reflow: args?.reflow })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    const { banner, rest } = formatWarnings(result.warnings)
    const tail = rest.length ? `\n\nOther validate() findings (${rest.length}): ${JSON.stringify(rest)}` : ''
    return { content: [{ type: 'text', text: `${formatLayout(result.layout)}${banner}${result.summary ?? 'Slide updated.'}${tail}` }] }
  }
  if (name === 'render_preview') {
    const result = await roundTrip('agent-query', 'agent-query-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    const image = result.result?.image
    if (!image?.data) return { content: [{ type: 'text', text: 'Error: no image data returned' }], isError: true }
    return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' }] }
  }
  if (name === 'review_slide') {
    const result = await roundTrip('agent-query', 'agent-query-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    const r = result.result ?? {}
    const size = r.size ? ` (${r.size.width}x${r.size.height})` : ''
    const text = `Slide "${r.slideId}"${size} — elements in paint order:\n` +
      (Array.isArray(r.elements) ? r.elements : []).map((l) => `  ${l}`).join('\n') +
      `\n\n${formatCheck(r)}` +
      (Array.isArray(r.comments) && r.comments.length
        ? `\n\nOpen comments for you on this slide (fix, then resolve_comment):\n` +
          r.comments.map((c) => {
            const a = c.anchor ?? {}
            const where = a.type === 'area'
              ? `area @${a.x},${a.y} ${a.w}x${a.h} -> [${(a.elementIds ?? []).join(', ')}] (outlined in the screenshot)`
              : a.type === 'element' ? `element ${a.elementId}` : a.type === 'point' ? `point @${a.x},${a.y}` : 'slide'
            return `  ${c.id} ${where} "${c.text}"`
          }).join('\n')
        : '')
    const content = [{ type: 'text', text: r.area ? `${text}\n\nScreenshot: area @${r.area.x},${r.area.y} ${r.area.w}x${r.area.h} of the slide.` : text }]
    if (r.image?.data) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType ?? 'image/png' })
    else content.push({ type: 'text', text: '(no screenshot of this slide)' })
    return { content }
  }
  if (name === 'check_layout') {
    const result = await roundTrip('agent-query', 'agent-query-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    return { content: [{ type: 'text', text: formatCheck(result.result) }] }
  }
  if (CODE_MODE && name === 'api_search') return { content: [{ type: 'text', text: apiSearch(args?.query) }] }
  if (CODE_MODE && name === 'execute') {
    const seconds = Math.min(MAX_PROGRAM_S, Math.max(1, Number(args?.timeoutSeconds) || 60))
    // a program may first wait for the ones queued before it on this deck
    const result = await roundTrip('agent-action', 'agent-action-result', { verb: 'execute', args: args ?? {} }, (seconds + 20 + PROGRAM_QUEUE_S) * 1000)
    const logs = Array.isArray(result.logs) && result.logs.length ? `\n\nconsole:\n${result.logs.join('\n')}` : ''
    if (!result.ok) return { content: [{ type: 'text', text: `The program failed. ${result.error ?? 'unknown error'}${logs}` }], isError: true }
    const stats = `\n\n(${result.calls ?? 0} deck call(s)${result.writes ? `, ${result.writes} of them edits — one undo step` : ', nothing changed'})`
    return { content: [{ type: 'text', text: `Result: ${result.value ?? 'null'}${logs}${stats}` }] }
  }
  const area = AGENT_AREAS.find((a) => a.def.name === name)
  if (area) {
    if (args?.op === 'help') {
      const about = typeof args.about === 'string' ? args.about : ''
      return { content: [{ type: 'text', text: area.help[about] ?? `${about ? `No op "${about}".\n\n` : ''}${area.help['*']}` }] }
    }
    const result = await roundTrip('agent-action', 'agent-action-result', { verb: name, args: args ?? {} }, SLOW_AREAS.has(name) ? NETWORK_TIMEOUT_MS : TIMEOUT_MS)
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    return { content: [{ type: 'text', text: result.summary ?? 'Done.' }] }
  }
  if (name === 'find_text') {
    const result = await roundTrip('agent-query', 'agent-query-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    const r = result.result ?? {}
    const hits = Array.isArray(r.hits) ? r.hits : []
    if (!hits.length) return { content: [{ type: 'text', text: `No match for "${args?.query ?? ''}" in ${r.slideCount ?? '?'} slides.` }] }
    const text = `${r.total} hit(s)${r.total > hits.length ? `, first ${hits.length}` : ''} for "${args?.query ?? ''}":\n` +
      hits.map((h) => `  ${h.slideId} #${h.index}${h.slideName ? ` "${h.slideName}"` : ''} ${h.elementId ?? `(${h.field})`}${h.elementId && h.field !== 'text' ? ` ${h.field}` : ''}: "${h.snippet}"`).join('\n')
    return { content: [{ type: 'text', text }] }
  }
  if (QUERY_VERBS.has(name)) {
    const result = await roundTrip('agent-query', 'agent-query-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify(result.result) }] }
  }
  if (name === 'ui_profile') {
    const result = await roundTrip('agent-action', 'agent-action-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    return { content: [{ type: 'text', text: String(result.text ?? '') }], ...(result.isError ? { isError: true } : {}) }
  }
  if (name === 'slide_type') {
    const { op, ...rest } = args ?? {}
    if (!SLIDE_TYPE_OPS.has(op)) return { content: [{ type: 'text', text: 'Error: op must be rename, reorder, move, detach or relink.' }], isError: true }
    return callTool(`${op}_slide_type`, rest)
  }
  if (ACTION_VERBS.has(name) || /^(rename|reorder|move|detach|relink)_slide_type$/.test(name)) {
    const result = await roundTrip('agent-action', 'agent-action-result', { verb: name, args: args ?? {} })
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }], isError: true }
    // eslint-disable-next-line no-unused-vars
    const { requestId, ok, layout, ...rest } = result
    const { banner } = formatWarnings(rest.warnings)
    return { content: [{ type: 'text', text: `${formatLayout(layout)}${banner}${JSON.stringify(rest)}` }] }
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
}

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // not a valid JSON-RPC line — ignore rather than crash the server
  }
  const { id, method, params } = msg

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'beeslides', version: '1.0.0' },
      // The client puts this in the model's system prompt; without it nothing
      // tells the model when execute beats a chain of tool calls.
      ...(CODE_MODE ? { instructions: CODE_MODE_INSTRUCTIONS } : {}),
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return // notifications carry no id and expect no response
  }
  if (method === 'tools/list') {
    respond(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    callTool(params?.name, params?.arguments)
      .then((result) => respond(id, result))
      .catch((err) => respondError(id, -32000, String(err?.message ?? err)))
    return
  }
  if (id != null) respondError(id, -32601, `Method not found: ${method}`)
})

// Self-terminate whenever stdio goes away, for any reason (parent process
// exit, crash, or pty.kill() tearing down the whole tree) — never rely on
// signal propagation through claude's own process tree to reap this.
process.stdin.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
