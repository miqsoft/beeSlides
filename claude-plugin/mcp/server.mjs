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
// keeps in <agentDir>, and the app is started if it isn't running — unless
// BEESLIDES_NO_LAUNCH=1: the Claude Code plugin's launcher (plugin-launch.mjs)
// decides itself what runs, and never starts the visible app from a terminal.
// BEESLIDES_BACKGROUND=1 (also the launcher's): the app is a hidden instance
// (main/background.ts) that opens the deck named with open_deck.
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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
/** The chat app's own name (MCP initialize clientInfo), shown in BeeSlides'
 *  "allow this app?" question; BEESLIDES_CLIENT overrides it. */
let clientName = ''

/** What a refused or failed link tells the model, in words it can pass on. */
const LINK_ERRORS = {
  'not-set-up': 'BeeSlides is not set up for AI apps outside it. Ask the user to open BeeSlides, go to Settings ▸ AI chat ▸ Advanced and turn on "Allow AI apps outside BeeSlides", then try again.',
  denied: 'BeeSlides did not allow this app to connect. Ask the user to try again and choose Allow when BeeSlides asks.',
  'bad-token': 'BeeSlides refused the connection: its access was switched off and on again since this chat connected. Try again; if it keeps failing, restart this chat.',
  'not-running': process.env.BEESLIDES_BACKGROUND === '1'
    ? 'The hidden BeeSlides instance that works on the deck is not running. Try the call again; if it keeps failing, restart this chat.'
    : process.env.BEESLIDES_NO_LAUNCH === '1'
      ? 'BeeSlides is not running. Ask the user to open it (with the deck), then try again.'
      : 'BeeSlides is not running and could not be started',
}

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
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', token, client: process.env.BEESLIDES_CLIENT || clientName || 'mcp' }) + '\n'))
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
          else {
            try { process.stderr.write(`[slides-mcp] endpoint refused: ${msg.error}\n`) } catch { /* log is best effort */ }
            socket.destroy()
            // an answer, not a failure to reach the app: no relaunch, no retry
            resolve({ refused: msg.error === 'denied' ? 'denied' : 'bad-token' })
          }
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
  if (process.env.BEESLIDES_NO_LAUNCH === '1') return false
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

/** The link, or why there is none: { refused: key of LINK_ERRORS }. */
async function ensureLink() {
  if (link) return link
  // Never switched on (or switched off since): nothing to connect to or start.
  if (!readEndpoint()) return { refused: 'not-set-up' }
  linking ??= (async () => {
    let l = await tryConnect()
    if (!l && launchApp()) {
      const deadline = Date.now() + LAUNCH_WAIT_MS
      while (!l && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300))
        l = await tryConnect()
      }
    }
    return l ?? { refused: 'not-running' }
  })()
  let l
  try { l = await linking } finally { linking = null }
  if (!l.refused) link = l
  return l
}

async function socketRoundTrip(channel, payload, timeoutMs) {
  const id = randomUUID()
  const started = Date.now()
  try {
    const l = await ensureLink()
    if (l.refused) return { requestId: id, ok: false, error: LINK_ERRORS[l.refused] }
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
const AGENT_AREAS = [{"def":{"name":"deck","description":"Deck structure, one undo step per call (theme, size, slideshow, header & footer: deck_settings). ops: add{after?,slideType?,count?,names?}: new slides; returns their ids; duplicate{slideIds}: copy slides with their states; returns the new ids; delete{slideIds,userAsked?}: delete slides and their states; move{slideIds,before?,after?,to?}: move slides with their states; hide{slideIds,hidden?}: hide slides from the show; rename{slideId,name}: name a slide; transition{slideIds,kind,dir?}: transition into slides; background{slideIds,background}: slide background; notes{slideId,text,append?}: speaker notes; section_add{slideId,name}: start a section at a slide; section_rename{sectionId,name}: rename a section; section_remove{sectionId}: remove a section (slides stay); state_add{slideId,linkFrom?,name?}: interactive state: a copy opened by clicking linkFrom; returns its id; state_sync{slideId}: pull new parent elements into a state; hover{slideId,type,dim?,revealDefault?}: hover group (focus-group or reveal); properties{title?,author?,company?,subject?,…}: document title and properties. op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["add","duplicate","delete","move","hide","rename","transition","background","notes","section_add","section_rename","section_remove","state_add","state_sync","hover","properties","help"]},"after":{"type":"string","description":"Slide id to insert after (default: the end of the deck)."},"slideType":{"type":"string","description":"A slide type id from doc_info.slideTypes (the new slides follow it) or a built-in layout: layout-title, layout-title-content, layout-two-col, layout-comparison, layout-section, layout-picture-caption, layout-blank. Default: the type of the slide in front, else layout-title-content."},"count":{"type":"integer","description":"How many (1-30, default 1)."},"names":{"type":"array","items":{"type":"string"},"description":"Optional slide names, one per new slide."},"slideIds":{"type":"array","items":{"type":"string"},"description":"Deck slide ids (from outline)."},"userAsked":{"type":"boolean","description":"true only when the user asked to delete these slides. Without it, only slides added or duplicated by an agent in this session can be deleted."},"before":{"type":"string","description":"Slide id to move in front of."},"to":{"type":"string","description":"start or end.","enum":["start","end"]},"hidden":{"type":"boolean","description":"false shows the slides again (default true)."},"slideId":{"type":"string","description":"Deck slide id (from outline)."},"name":{"type":"string","description":"The new name (\"\" removes it)."},"kind":{"type":"string","description":"Transition kind.","enum":["none","fade","slide","zoom","morph","push","wipe","cover","split"]},"dir":{"type":"string","description":"Direction for push/wipe/cover/split/slide (left, right, up, down, …); see help."},"background":{"type":"string","description":"A CSS colour (#RRGGBB, rgba()) or linear-/radial-gradient()."},"text":{"type":"string","description":"Plain text; new lines are kept."},"append":{"type":"boolean","description":"Add below the existing notes instead of replacing them."},"sectionId":{"type":"string","description":"Section id (doc_info.sections)."},"linkFrom":{"type":"string","description":"Element id on that slide that will link to the new state (click → state)."},"type":{"type":"string","description":"none switches it off.","enum":["none","focus-group","reveal"]},"dim":{"type":"number","description":"focus-group: opacity of the non-hovered elements (0..1, default 0.15)."},"revealDefault":{"type":"string","description":"reveal: the showOnHover set shown when nothing is hovered."},"title":{"type":"string","description":"Document title."},"author":{"type":"string","description":"Author (\"\" clears)."},"company":{"type":"string","description":"Company (\"\" clears)."},"subject":{"type":"string","description":"Subject (\"\" clears)."},"event":{"type":"string","description":"Event (\"\" clears)."},"keywords":{"type":"string","description":"Keywords (\"\" clears)."},"language":{"type":"string","description":"Language the document is written in, a BCP-47 code like \"de\". Picks which translation {{term:Name}} shows and formats {{date}} (\"\" clears)."},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"Deck structure, one undo step per call (theme, size, slideshow, header & footer: deck_settings).\n\ndeck op \"add\": new slides; returns their ids.\n  after? (string): Slide id to insert after (default: the end of the deck).\n  slideType? (string): A slide type id from doc_info.slideTypes (the new slides follow it) or a built-in layout: layout-title, layout-title-content, layout-two-col, layout-comparison, layout-section, layout-picture-caption, layout-blank. Default: the type of the slide in front, else layout-title-content.\n  count? (integer 1..30): How many (1-30, default 1).\n  names? (string[]): Optional slide names, one per new slide.\nBuild a deck by adding ALL its slides first (one call with count), then fill them; hand each subagent the ids it owns.\n\ndeck op \"duplicate\": copy slides with their states; returns the new ids.\n  slideIds (string[]): Deck slide ids (from outline).\nCopies keep element ids, so a copy with transition \"morph\" morphs from the original.\n\ndeck op \"delete\": delete slides and their states.\n  slideIds (string[]): Deck slide ids (from outline).\n  userAsked? (boolean): true only when the user asked to delete these slides. Without it, only slides added or duplicated by an agent in this session can be deleted.\nLinks to deleted slides are cleared and zoom tiles into them removed. A deck always keeps at least one slide.\n\ndeck op \"move\": move slides with their states.\n  slideIds (string[]): Deck slide ids (from outline).\n  before? (string): Slide id to move in front of.\n  after? (string): Slide id to insert after (default: the end of the deck).\n  to? (string one of start|end): start or end.\nGive exactly one of before, after, to. Moved slides keep their relative order; interactive states move with their slide.\n\ndeck op \"hide\": hide slides from the show.\n  slideIds (string[]): Deck slide ids (from outline).\n  hidden? (boolean): false shows the slides again (default true).\nA hidden slide right after a normal one is that slide's extra: reachable by link, skipped in the show.\n\ndeck op \"rename\": name a slide.\n  slideId (string): Deck slide id (from outline).\n  name (string): The new name (\"\" removes it).\nNames show in the outline and in link pickers.\n\ndeck op \"transition\": transition into slides.\n  slideIds (string[]): Deck slide ids (from outline).\n  kind (string one of none|fade|slide|zoom|morph|push|wipe|cover|split): Transition kind.\n  dir? (string): Direction for push/wipe/cover/split/slide (left, right, up, down, …); see help.\nmorph animates elements with the same id from the previous slide; use duplicate to get matching ids.\n\ndeck op \"background\": slide background.\n  slideIds (string[]): Deck slide ids (from outline).\n  background (string): A CSS colour (#RRGGBB, rgba()) or linear-/radial-gradient().\n\ndeck op \"notes\": speaker notes.\n  slideId (string): Deck slide id (from outline).\n  text (string): Plain text; new lines are kept.\n  append? (boolean): Add below the existing notes instead of replacing them.\n\ndeck op \"section_add\": start a section at a slide.\n  slideId (string): Deck slide id (from outline).\n  name (string): The section name.\ndoc_info lists sections (id, name, startSlideId).\n\ndeck op \"section_rename\": rename a section.\n  sectionId (string): Section id (doc_info.sections).\n  name (string): The new name.\n\ndeck op \"section_remove\": remove a section (slides stay).\n  sectionId (string): Section id (doc_info.sections).\n\ndeck op \"state_add\": interactive state: a copy opened by clicking linkFrom; returns its id.\n  slideId (string): Deck slide id (from outline).\n  linkFrom? (string): Element id on that slide that will link to the new state (click → state).\n  name? (string): The new name (\"\" removes it).\nThe state keeps the element ids (transition morph), so change what differs with update_element on the state. States of a state share one parent. A state element links back with update_element link: <parent id>.\n\ndeck op \"state_sync\": pull new parent elements into a state.\n  slideId (string): Deck slide id (from outline).\n\ndeck op \"hover\": hover group (focus-group or reveal).\n  slideId (string): Deck slide id (from outline).\n  type (string one of none|focus-group|reveal): none switches it off.\n  dim? (number 0..1): focus-group: opacity of the non-hovered elements (0..1, default 0.15).\n  revealDefault? (string): reveal: the showOnHover set shown when nothing is hovered.\nfocus-group dims the elements not hovered; reveal shows one showOnHover set per hovered trigger. Members are set per element with update_element: group (focus-group membership) and showOnHover (the element shown while its trigger is hovered).\n\ndeck op \"properties\": document title and properties.\n  title? (string): Document title.\n  author? (string): Author (\"\" clears).\n  company? (string): Company (\"\" clears).\n  subject? (string): Subject (\"\" clears).\n  event? (string): Event (\"\" clears).\n  keywords? (string): Keywords (\"\" clears).\n  language? (string): Language the document is written in, a BCP-47 code like \"de\". Picks which translation {{term:Name}} shows and formats {{date}} (\"\" clears).\n\nNot available to agents yet (tell the user to do it in the app): custom document properties (File ▸ Properties ▸ Custom); editing the translated-terms table (it belongs to the layout: Document properties ▸ Language & terms in the layout window).","add":"deck op \"add\": new slides; returns their ids.\n  after? (string): Slide id to insert after (default: the end of the deck).\n  slideType? (string): A slide type id from doc_info.slideTypes (the new slides follow it) or a built-in layout: layout-title, layout-title-content, layout-two-col, layout-comparison, layout-section, layout-picture-caption, layout-blank. Default: the type of the slide in front, else layout-title-content.\n  count? (integer 1..30): How many (1-30, default 1).\n  names? (string[]): Optional slide names, one per new slide.\nBuild a deck by adding ALL its slides first (one call with count), then fill them; hand each subagent the ids it owns.","duplicate":"deck op \"duplicate\": copy slides with their states; returns the new ids.\n  slideIds (string[]): Deck slide ids (from outline).\nCopies keep element ids, so a copy with transition \"morph\" morphs from the original.","delete":"deck op \"delete\": delete slides and their states.\n  slideIds (string[]): Deck slide ids (from outline).\n  userAsked? (boolean): true only when the user asked to delete these slides. Without it, only slides added or duplicated by an agent in this session can be deleted.\nLinks to deleted slides are cleared and zoom tiles into them removed. A deck always keeps at least one slide.","move":"deck op \"move\": move slides with their states.\n  slideIds (string[]): Deck slide ids (from outline).\n  before? (string): Slide id to move in front of.\n  after? (string): Slide id to insert after (default: the end of the deck).\n  to? (string one of start|end): start or end.\nGive exactly one of before, after, to. Moved slides keep their relative order; interactive states move with their slide.","hide":"deck op \"hide\": hide slides from the show.\n  slideIds (string[]): Deck slide ids (from outline).\n  hidden? (boolean): false shows the slides again (default true).\nA hidden slide right after a normal one is that slide's extra: reachable by link, skipped in the show.","rename":"deck op \"rename\": name a slide.\n  slideId (string): Deck slide id (from outline).\n  name (string): The new name (\"\" removes it).\nNames show in the outline and in link pickers.","transition":"deck op \"transition\": transition into slides.\n  slideIds (string[]): Deck slide ids (from outline).\n  kind (string one of none|fade|slide|zoom|morph|push|wipe|cover|split): Transition kind.\n  dir? (string): Direction for push/wipe/cover/split/slide (left, right, up, down, …); see help.\nmorph animates elements with the same id from the previous slide; use duplicate to get matching ids.","background":"deck op \"background\": slide background.\n  slideIds (string[]): Deck slide ids (from outline).\n  background (string): A CSS colour (#RRGGBB, rgba()) or linear-/radial-gradient().","notes":"deck op \"notes\": speaker notes.\n  slideId (string): Deck slide id (from outline).\n  text (string): Plain text; new lines are kept.\n  append? (boolean): Add below the existing notes instead of replacing them.","section_add":"deck op \"section_add\": start a section at a slide.\n  slideId (string): Deck slide id (from outline).\n  name (string): The section name.\ndoc_info lists sections (id, name, startSlideId).","section_rename":"deck op \"section_rename\": rename a section.\n  sectionId (string): Section id (doc_info.sections).\n  name (string): The new name.","section_remove":"deck op \"section_remove\": remove a section (slides stay).\n  sectionId (string): Section id (doc_info.sections).","state_add":"deck op \"state_add\": interactive state: a copy opened by clicking linkFrom; returns its id.\n  slideId (string): Deck slide id (from outline).\n  linkFrom? (string): Element id on that slide that will link to the new state (click → state).\n  name? (string): The new name (\"\" removes it).\nThe state keeps the element ids (transition morph), so change what differs with update_element on the state. States of a state share one parent. A state element links back with update_element link: <parent id>.","state_sync":"deck op \"state_sync\": pull new parent elements into a state.\n  slideId (string): Deck slide id (from outline).","hover":"deck op \"hover\": hover group (focus-group or reveal).\n  slideId (string): Deck slide id (from outline).\n  type (string one of none|focus-group|reveal): none switches it off.\n  dim? (number 0..1): focus-group: opacity of the non-hovered elements (0..1, default 0.15).\n  revealDefault? (string): reveal: the showOnHover set shown when nothing is hovered.\nfocus-group dims the elements not hovered; reveal shows one showOnHover set per hovered trigger. Members are set per element with update_element: group (focus-group membership) and showOnHover (the element shown while its trigger is hovered).","properties":"deck op \"properties\": document title and properties.\n  title? (string): Document title.\n  author? (string): Author (\"\" clears).\n  company? (string): Company (\"\" clears).\n  subject? (string): Subject (\"\" clears).\n  event? (string): Event (\"\" clears).\n  keywords? (string): Keywords (\"\" clears).\n  language? (string): Language the document is written in, a BCP-47 code like \"de\". Picks which translation {{term:Name}} shows and formats {{date}} (\"\" clears)."}},{"def":{"name":"deck_settings","description":"Deck-wide settings: theme colours and fonts, slide size, the slideshow (counter, progress, auto-advance, loop), per-slide timing, header & footer, slide numbering. Each call is one undo step; doc_info shows the current values. ops: theme{background?,color?,accent?,accent2?,…}: set theme colours and fonts; colours picked from the theme follow; size{preset?,width?,height?}: set the slide size (preset or width/height in px); present{counter?,progress?,arrows?,numberHidden?,…}: slideshow settings: counter, progress bar, corner arrows, numbering hidden slides, auto-advance, loop, morph speed; slide_timing{slideIds,advanceAfter?,autoBuild?,every?,…}: per-slide timing: advance after N seconds, auto-play the click builds; header_footer{date?,dateText?,showSlideNumber?,showFooter?,…}: deck-wide header & footer: date, slide number, footer text, hide on title slides; footer_elements{slideType,roles}: add the standard date / slide number / footer text boxes to a slide type (its slides follow); slide_footer{slideIds,role,visible}: show or hide one footer item on particular slides; layout_grid{columns?,rows?,gutter?,marginX?,marginY?}: the deck's column grid: columns (and rows) inside margins that people see and snap to; numbering{slideIds,exclude}: leave slides out of the slide numbering (or count them again). op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["theme","size","present","slide_timing","header_footer","footer_elements","slide_footer","layout_grid","numbering","help"]},"background":{"type":"string","description":"Default slide background (CSS colour)."},"color":{"type":"string","description":"Text colour (CSS colour)."},"accent":{"type":"string","description":"Accent 1 (CSS colour)."},"accent2":{"type":"string","description":"Accent 2 (CSS colour)."},"accent3":{"type":"string","description":"Accent 3 (CSS colour)."},"accent4":{"type":"string","description":"Accent 4 (CSS colour)."},"accent5":{"type":"string","description":"Accent 5 (CSS colour)."},"accent6":{"type":"string","description":"Accent 6 (CSS colour)."},"fontFamily":{"type":"string","description":"Body font family, e.g. \"Inter\"."},"headingFamily":{"type":"string","description":"Heading font family (\"\" = same as the body font)."},"preset":{"type":"string","description":"A page size.","enum":["16:9","4:3","1:1","9:16","a4-landscape","a4-portrait"]},"width":{"type":"integer","description":"px (320..4000)."},"height":{"type":"integer","description":"px (320..4000)."},"counter":{"type":"boolean","description":"The slide counter in the show's corner (default on)."},"progress":{"type":"boolean","description":"The progress bar (default on)."},"arrows":{"type":"boolean","description":"Corner arrows for mouse navigation (default off)."},"numberHidden":{"type":"boolean","description":"Hidden slides keep their number (default off)."},"loop":{"type":"boolean","description":"Wrap from the last slide to the first (default off)."},"autoAdvance":{"type":"number","description":"Seconds per slide for a self-running show; 0 = manual."},"morphSeconds":{"type":"number","description":"Morph transition length in seconds (0.1..6); 0 = default."},"slideIds":{"type":"array","items":{"type":"string"},"description":"Deck slide ids (from outline)."},"advanceAfter":{"type":"number","description":"Seconds before the show moves on from these slides; 0 = off."},"autoBuild":{"type":"boolean","description":"Play the slide's click builds by themselves."},"every":{"type":"number","description":"autoBuild: seconds between steps (0.1..3600, default 2)."},"hold":{"type":"number","description":"autoBuild: seconds to hold the last step (default 2)."},"buildLoop":{"type":"boolean","description":"autoBuild: start over after the last step (default true)."},"date":{"type":"string","description":"off, live (today) or fixed (dateText).","enum":["off","live","fixed"]},"dateText":{"type":"string","description":"date fixed: the text to show."},"showSlideNumber":{"type":"boolean","description":"Show the slide-number boxes."},"showFooter":{"type":"boolean","description":"Show the footer boxes."},"footerText":{"type":"string","description":"The footer text ({{footer}})."},"hideOnTitle":{"type":"boolean","description":"Hide all of them on title slides."},"slideType":{"type":"string","description":"Slide type id (doc_info.slideTypes)."},"roles":{"type":"array","items":{"type":"string"},"description":"Which boxes: date, slideNumber, footer."},"role":{"type":"string","description":"Which footer item.","enum":["date","slideNumber","footer"]},"visible":{"type":"boolean","description":"false hides it on these slides."},"columns":{"type":"integer","description":"Columns (1-24); 0 removes the grid."},"rows":{"type":"integer","description":"Rows (0-24; 0 = columns only)."},"gutter":{"type":"number","description":"px between columns (and rows)."},"marginX":{"type":"number","description":"Left and right margin, px."},"marginY":{"type":"number","description":"Top and bottom margin, px."},"exclude":{"type":"boolean","description":"false counts them again."},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"Deck-wide settings: theme colours and fonts, slide size, the slideshow (counter, progress, auto-advance, loop), per-slide timing, header & footer, slide numbering. Each call is one undo step; doc_info shows the current values.\n\ndeck_settings op \"theme\": set theme colours and fonts; colours picked from the theme follow.\n  background? (string): Default slide background (CSS colour).\n  color? (string): Text colour (CSS colour).\n  accent? (string): Accent 1 (CSS colour).\n  accent2? (string): Accent 2 (CSS colour).\n  accent3? (string): Accent 3 (CSS colour).\n  accent4? (string): Accent 4 (CSS colour).\n  accent5? (string): Accent 5 (CSS colour).\n  accent6? (string): Accent 6 (CSS colour).\n  fontFamily? (string): Body font family, e.g. \"Inter\".\n  headingFamily? (string): Heading font family (\"\" = same as the body font).\nElements whose colours were picked from the theme palette (themeRefs) follow; literal colours stay. Fonts apply to all text without its own font. A stored chart palette is re-derived from a new accent. Use fonts the viewer has, or tell the user to embed them.\n\ndeck_settings op \"size\": set the slide size (preset or width/height in px).\n  preset? (string one of 16:9|4:3|1:1|9:16|a4-landscape|a4-portrait): A page size.\n  width? (integer 320..4000): px (320..4000).\n  height? (integer 320..4000): px (320..4000).\nAs in the app, elements keep their positions: nothing is rescaled. Review the slides afterwards and move what now falls outside.\n\ndeck_settings op \"present\": slideshow settings: counter, progress bar, corner arrows, numbering hidden slides, auto-advance, loop, morph speed.\n  counter? (boolean): The slide counter in the show's corner (default on).\n  progress? (boolean): The progress bar (default on).\n  arrows? (boolean): Corner arrows for mouse navigation (default off).\n  numberHidden? (boolean): Hidden slides keep their number (default off).\n  loop? (boolean): Wrap from the last slide to the first (default off).\n  autoAdvance? (number 0..86400): Seconds per slide for a self-running show; 0 = manual.\n  morphSeconds? (number 0..6): Morph transition length in seconds (0.1..6); 0 = default.\n\ndeck_settings op \"slide_timing\": per-slide timing: advance after N seconds, auto-play the click builds.\n  slideIds (string[]): Deck slide ids (from outline).\n  advanceAfter? (number 0..86400): Seconds before the show moves on from these slides; 0 = off.\n  autoBuild? (boolean): Play the slide's click builds by themselves.\n  every? (number 0.1..3600): autoBuild: seconds between steps (0.1..3600, default 2).\n  hold? (number 0..3600): autoBuild: seconds to hold the last step (default 2).\n  buildLoop? (boolean): autoBuild: start over after the last step (default true).\n\ndeck_settings op \"header_footer\": deck-wide header & footer: date, slide number, footer text, hide on title slides.\n  date? (string one of off|live|fixed): off, live (today) or fixed (dateText).\n  dateText? (string): date fixed: the text to show.\n  showSlideNumber? (boolean): Show the slide-number boxes.\n  showFooter? (boolean): Show the footer boxes.\n  footerText? (string): The footer text ({{footer}}).\n  hideOnTitle? (boolean): Hide all of them on title slides.\nThese switch text boxes tagged as date / slide number / footer, usually on slide types. The result says which exist; add missing ones with footer_elements.\n\ndeck_settings op \"footer_elements\": add the standard date / slide number / footer text boxes to a slide type (its slides follow).\n  slideType (string): Slide type id (doc_info.slideTypes).\n  roles (string[]): Which boxes: date, slideNumber, footer.\nPlaced along the bottom edge, readable on the slide type's background; a role the type already has is skipped.\n\ndeck_settings op \"slide_footer\": show or hide one footer item on particular slides.\n  slideIds (string[]): Deck slide ids (from outline).\n  role (string one of date|slideNumber|footer): Which footer item.\n  visible (boolean): false hides it on these slides.\n\ndeck_settings op \"layout_grid\": the deck's column grid: columns (and rows) inside margins that people see and snap to.\n  columns? (integer 0..24): Columns (1-24); 0 removes the grid.\n  rows? (integer 0..24): Rows (0-24; 0 = columns only).\n  gutter? (number 0..400): px between columns (and rows).\n  marginX? (number 0..2000): Left and right margin, px.\n  marginY? (number 0..2000): Top and bottom margin, px.\nUnset values are kept (a new grid starts at 12 columns, a 24 px gutter and 96/64 px margins, scaled to the page). doc_info.layoutGrid lists every column's x and w; elements arrange takes within \"columns 7-12\" (or \"columns 1-6 rows 2-3\") to fill exactly that span. The grid is saved with the deck and every slide shares it.\n\ndeck_settings op \"numbering\": leave slides out of the slide numbering (or count them again).\n  slideIds (string[]): Deck slide ids (from outline).\n  exclude (boolean): false counts them again.\n\nNot available to agents yet (tell the user to do it in the app): default text styles of the deck (styleDefaults); embedding font files.","theme":"deck_settings op \"theme\": set theme colours and fonts; colours picked from the theme follow.\n  background? (string): Default slide background (CSS colour).\n  color? (string): Text colour (CSS colour).\n  accent? (string): Accent 1 (CSS colour).\n  accent2? (string): Accent 2 (CSS colour).\n  accent3? (string): Accent 3 (CSS colour).\n  accent4? (string): Accent 4 (CSS colour).\n  accent5? (string): Accent 5 (CSS colour).\n  accent6? (string): Accent 6 (CSS colour).\n  fontFamily? (string): Body font family, e.g. \"Inter\".\n  headingFamily? (string): Heading font family (\"\" = same as the body font).\nElements whose colours were picked from the theme palette (themeRefs) follow; literal colours stay. Fonts apply to all text without its own font. A stored chart palette is re-derived from a new accent. Use fonts the viewer has, or tell the user to embed them.","size":"deck_settings op \"size\": set the slide size (preset or width/height in px).\n  preset? (string one of 16:9|4:3|1:1|9:16|a4-landscape|a4-portrait): A page size.\n  width? (integer 320..4000): px (320..4000).\n  height? (integer 320..4000): px (320..4000).\nAs in the app, elements keep their positions: nothing is rescaled. Review the slides afterwards and move what now falls outside.","present":"deck_settings op \"present\": slideshow settings: counter, progress bar, corner arrows, numbering hidden slides, auto-advance, loop, morph speed.\n  counter? (boolean): The slide counter in the show's corner (default on).\n  progress? (boolean): The progress bar (default on).\n  arrows? (boolean): Corner arrows for mouse navigation (default off).\n  numberHidden? (boolean): Hidden slides keep their number (default off).\n  loop? (boolean): Wrap from the last slide to the first (default off).\n  autoAdvance? (number 0..86400): Seconds per slide for a self-running show; 0 = manual.\n  morphSeconds? (number 0..6): Morph transition length in seconds (0.1..6); 0 = default.","slide_timing":"deck_settings op \"slide_timing\": per-slide timing: advance after N seconds, auto-play the click builds.\n  slideIds (string[]): Deck slide ids (from outline).\n  advanceAfter? (number 0..86400): Seconds before the show moves on from these slides; 0 = off.\n  autoBuild? (boolean): Play the slide's click builds by themselves.\n  every? (number 0.1..3600): autoBuild: seconds between steps (0.1..3600, default 2).\n  hold? (number 0..3600): autoBuild: seconds to hold the last step (default 2).\n  buildLoop? (boolean): autoBuild: start over after the last step (default true).","header_footer":"deck_settings op \"header_footer\": deck-wide header & footer: date, slide number, footer text, hide on title slides.\n  date? (string one of off|live|fixed): off, live (today) or fixed (dateText).\n  dateText? (string): date fixed: the text to show.\n  showSlideNumber? (boolean): Show the slide-number boxes.\n  showFooter? (boolean): Show the footer boxes.\n  footerText? (string): The footer text ({{footer}}).\n  hideOnTitle? (boolean): Hide all of them on title slides.\nThese switch text boxes tagged as date / slide number / footer, usually on slide types. The result says which exist; add missing ones with footer_elements.","footer_elements":"deck_settings op \"footer_elements\": add the standard date / slide number / footer text boxes to a slide type (its slides follow).\n  slideType (string): Slide type id (doc_info.slideTypes).\n  roles (string[]): Which boxes: date, slideNumber, footer.\nPlaced along the bottom edge, readable on the slide type's background; a role the type already has is skipped.","slide_footer":"deck_settings op \"slide_footer\": show or hide one footer item on particular slides.\n  slideIds (string[]): Deck slide ids (from outline).\n  role (string one of date|slideNumber|footer): Which footer item.\n  visible (boolean): false hides it on these slides.","layout_grid":"deck_settings op \"layout_grid\": the deck's column grid: columns (and rows) inside margins that people see and snap to.\n  columns? (integer 0..24): Columns (1-24); 0 removes the grid.\n  rows? (integer 0..24): Rows (0-24; 0 = columns only).\n  gutter? (number 0..400): px between columns (and rows).\n  marginX? (number 0..2000): Left and right margin, px.\n  marginY? (number 0..2000): Top and bottom margin, px.\nUnset values are kept (a new grid starts at 12 columns, a 24 px gutter and 96/64 px margins, scaled to the page). doc_info.layoutGrid lists every column's x and w; elements arrange takes within \"columns 7-12\" (or \"columns 1-6 rows 2-3\") to fill exactly that span. The grid is saved with the deck and every slide shares it.","numbering":"deck_settings op \"numbering\": leave slides out of the slide numbering (or count them again).\n  slideIds (string[]): Deck slide ids (from outline).\n  exclude (boolean): false counts them again."}},{"def":{"name":"icons","description":"The icon library the user set up in Settings ▸ Icon library (an icon server or a folder of SVG/PNG files). Search it and insert real icons instead of drawing your own SVG. In an icon set, plan writes the icons to draw and style adds a look the whole set is painted in. ops: search{query,limit?}: find icons by keyword; returns refs to insert; insert{slideId,ref,x?,y?,…}: put a found icon on a slide; returns its element id; plan{icons,replace?}: icon sets only: write a plan of icons as empty, named icons for the user to review; style{name,weight?,color?,cap?,…}: icon sets only: add (or update, by name) a style the whole set is also shown and exported in — nothing is redrawn; tweak{style,slideId,elementIds,fill?,…}: icon sets only: paint some shapes of ONE icon their own way in one style (fill, line colour, hidden), or reset them — the drawing and the other styles stay. op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["search","insert","plan","style","tweak","help"]},"query":{"type":"string","description":"One or two plain keywords, e.g. \"cloud\", \"user\", \"shield\" (\"\" lists some)."},"limit":{"type":"integer","description":"How many to list (1-30, default 12)."},"slideId":{"type":"string","description":"Deck slide id (from outline)."},"ref":{"type":"string","description":"A ref from search (e.g. \"i3\")."},"x":{"type":"number","description":"Left edge in slide px (default: centred)."},"y":{"type":"number","description":"Top edge in slide px (default: centred)."},"size":{"type":"number","description":"Width and height in px (default 96)."},"alt":{"type":"string","description":"Alt text (\"\" = decorative, the default)."},"icons":{"type":"array","items":{"type":"object"},"description":"The planned icons: [{name, prompt, keywords}] — name a short noun phrase (\"evidence bag\"), prompt one line of what it shows, keywords 2-5 search words."},"replace":{"type":"boolean","description":"true: remove still-empty icons this plan does not name (drawn or commented ones stay)."},"name":{"type":"string","description":"The style's name, two or three words (\"Comic yellow\")."},"weight":{"type":"number","description":"Outline weight × the set stroke width (1 = the same, 1.5 = bold)."},"color":{"type":"string","description":"Outline colour, CSS hex (default: the set ink)."},"cap":{"type":"string","description":"Line ends.","enum":["round","square","butt"]},"join":{"type":"string","description":"Corners.","enum":["round","bevel","miter"]},"body":{"type":"string","description":"Fill of the body parts (the main silhouette), CSS hex; omit for none."},"bodyOpacity":{"type":"number","description":"Opacity of the body fill (0.05-1, default 1)."},"detail":{"type":"string","description":"Fill of closed detail parts, CSS hex; omit for none."},"accent":{"type":"string","description":"Fill of the accent part (one highlight per icon), CSS hex; omit for none."},"knockout":{"type":"boolean","description":"Details inside a filled body are cut out of it (a solid icon)."},"shadowX":{"type":"number","description":"Hard shadow offset right, grid units (e.g. 0.9); with shadowY."},"shadowY":{"type":"number","description":"Hard shadow offset down, grid units."},"shadowColor":{"type":"string","description":"Shadow colour, CSS hex (default black)."},"halo":{"type":"number","description":"Sticker border width around the whole icon, grid units (e.g. 1.5)."},"haloColor":{"type":"string","description":"Sticker border colour (default white)."},"sketch":{"type":"number","description":"Hand-drawn wobble, 0-1."},"tile":{"type":"string","description":"A badge behind the icon.","enum":["none","circle","square","rounded"]},"tileColor":{"type":"string","description":"Badge colour, CSS hex."},"style":{"type":"string","description":"The style's name (doc_info iconset.variants)."},"elementIds":{"type":"array","items":{"type":"string"},"description":"The icon's shapes to change (element ids from read_slide)."},"fill":{"type":"string","description":"Their fill in this style: CSS hex, \"none\" (not filled) or \"style\" (as the style paints the part)."},"fillOpacity":{"type":"number","description":"Opacity of that fill (0.05-1, default 1)."},"stroke":{"type":"string","description":"Their line colour in this style: CSS hex or \"style\"."},"hide":{"type":"boolean","description":"true: left out of this style; false: shown again."},"reset":{"type":"boolean","description":"true: drop every own change of these shapes in this style first."},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"The icon library the user set up in Settings ▸ Icon library (an icon server or a folder of SVG/PNG files). Search it and insert real icons instead of drawing your own SVG. In an icon set, plan writes the icons to draw and style adds a look the whole set is painted in.\n\nicons op \"search\": find icons by keyword; returns refs to insert.\n  query (string): One or two plain keywords, e.g. \"cloud\", \"user\", \"shield\" (\"\" lists some).\n  limit? (integer 1..30): How many to list (1-30, default 12).\nSearch per concept with short, concrete nouns (several searches are cheap); a folder source matches file names only. Refs stay valid for this editor session.\n\nicons op \"insert\": put a found icon on a slide; returns its element id.\n  slideId (string): Deck slide id (from outline).\n  ref (string): A ref from search (e.g. \"i3\").\n  x? (number): Left edge in slide px (default: centred).\n  y? (number): Top edge in slide px (default: centred).\n  size? (number 8..2000): Width and height in px (default 96).\n  alt? (string): Alt text (\"\" = decorative, the default).\nThe icon becomes an ordinary svg (or image) element, square at size; move or resize it later with elements edit. Icons keep their own colours: check they read on the slide background (look_at_slide / review_slide). The icon's source and license are recorded on the element. One icon per call.\n\nicons op \"plan\": icon sets only: write a plan of icons as empty, named icons for the user to review.\n  icons (object[]): The planned icons: [{name, prompt, keywords}] — name a short noun phrase (\"evidence bag\"), prompt one line of what it shows, keywords 2-5 search words.\n  replace? (boolean): true: remove still-empty icons this plan does not name (drawn or commented ones stay).\nOnly in an icon set (doc_info kind \"iconset\"). An icon already there by name gets the new prompt and keywords; blank starter icons are filled first; the rest are added. Draws nothing: the user reviews the plan and presses Draw with AI. Call it again to revise the plan.\n\nicons op \"style\": icon sets only: add (or update, by name) a style the whole set is also shown and exported in — nothing is redrawn.\n  name (string): The style's name, two or three words (\"Comic yellow\").\n  weight? (number 0.25..4): Outline weight × the set stroke width (1 = the same, 1.5 = bold).\n  color? (string): Outline colour, CSS hex (default: the set ink).\n  cap? (string one of round|square|butt): Line ends.\n  join? (string one of round|bevel|miter): Corners.\n  body? (string): Fill of the body parts (the main silhouette), CSS hex; omit for none.\n  bodyOpacity? (number 0.05..1): Opacity of the body fill (0.05-1, default 1).\n  detail? (string): Fill of closed detail parts, CSS hex; omit for none.\n  accent? (string): Fill of the accent part (one highlight per icon), CSS hex; omit for none.\n  knockout? (boolean): Details inside a filled body are cut out of it (a solid icon).\n  shadowX? (number -4..4): Hard shadow offset right, grid units (e.g. 0.9); with shadowY.\n  shadowY? (number -4..4): Hard shadow offset down, grid units.\n  shadowColor? (string): Shadow colour, CSS hex (default black).\n  halo? (number 0..4): Sticker border width around the whole icon, grid units (e.g. 1.5).\n  haloColor? (string): Sticker border colour (default white).\n  sketch? (number 0..1): Hand-drawn wobble, 0-1.\n  tile? (string one of none|circle|square|rounded): A badge behind the icon.\n  tileColor? (string): Badge colour, CSS hex.\nOnly in an icon set. Every icon is painted in the style from its own drawing: each path is a body, detail or accent part (its iconPart, else guessed: big closed shapes are body, lines and small shapes detail). The user sees the styles in the panel and the export writes one folder per style. A style with the same name is replaced. A style only repaints: a look that needs other shapes (hand-drawn, more detail, other proportions) is a change of the set's drawing style (brief, examples) plus a redraw, not a style.\n\nicons op \"tweak\": icon sets only: paint some shapes of ONE icon their own way in one style (fill, line colour, hidden), or reset them — the drawing and the other styles stay.\n  style (string): The style's name (doc_info iconset.variants).\n  slideId (string): The icon: its slide id (from outline).\n  elementIds (string[]): The icon's shapes to change (element ids from read_slide).\n  fill? (string): Their fill in this style: CSS hex, \"none\" (not filled) or \"style\" (as the style paints the part).\n  fillOpacity? (number 0.05..1): Opacity of that fill (0.05-1, default 1).\n  stroke? (string): Their line colour in this style: CSS hex or \"style\".\n  hide? (boolean): true: left out of this style; false: shown again.\n  reset? (boolean): true: drop every own change of these shapes in this style first.\nFor a comment written \"in the style X\" that concerns one icon only. A change for every icon belongs in the style itself (op style); a wrong drawing is fixed in the shapes (write_slide), which changes every style. The user sees own changes as a dot on the style chip above the canvas.\n\nNot available to agents yet (tell the user to do it in the app): recolouring an inserted icon; changing the icon library settings (the user does that in Settings ▸ Icon library).","search":"icons op \"search\": find icons by keyword; returns refs to insert.\n  query (string): One or two plain keywords, e.g. \"cloud\", \"user\", \"shield\" (\"\" lists some).\n  limit? (integer 1..30): How many to list (1-30, default 12).\nSearch per concept with short, concrete nouns (several searches are cheap); a folder source matches file names only. Refs stay valid for this editor session.","insert":"icons op \"insert\": put a found icon on a slide; returns its element id.\n  slideId (string): Deck slide id (from outline).\n  ref (string): A ref from search (e.g. \"i3\").\n  x? (number): Left edge in slide px (default: centred).\n  y? (number): Top edge in slide px (default: centred).\n  size? (number 8..2000): Width and height in px (default 96).\n  alt? (string): Alt text (\"\" = decorative, the default).\nThe icon becomes an ordinary svg (or image) element, square at size; move or resize it later with elements edit. Icons keep their own colours: check they read on the slide background (look_at_slide / review_slide). The icon's source and license are recorded on the element. One icon per call.","plan":"icons op \"plan\": icon sets only: write a plan of icons as empty, named icons for the user to review.\n  icons (object[]): The planned icons: [{name, prompt, keywords}] — name a short noun phrase (\"evidence bag\"), prompt one line of what it shows, keywords 2-5 search words.\n  replace? (boolean): true: remove still-empty icons this plan does not name (drawn or commented ones stay).\nOnly in an icon set (doc_info kind \"iconset\"). An icon already there by name gets the new prompt and keywords; blank starter icons are filled first; the rest are added. Draws nothing: the user reviews the plan and presses Draw with AI. Call it again to revise the plan.","style":"icons op \"style\": icon sets only: add (or update, by name) a style the whole set is also shown and exported in — nothing is redrawn.\n  name (string): The style's name, two or three words (\"Comic yellow\").\n  weight? (number 0.25..4): Outline weight × the set stroke width (1 = the same, 1.5 = bold).\n  color? (string): Outline colour, CSS hex (default: the set ink).\n  cap? (string one of round|square|butt): Line ends.\n  join? (string one of round|bevel|miter): Corners.\n  body? (string): Fill of the body parts (the main silhouette), CSS hex; omit for none.\n  bodyOpacity? (number 0.05..1): Opacity of the body fill (0.05-1, default 1).\n  detail? (string): Fill of closed detail parts, CSS hex; omit for none.\n  accent? (string): Fill of the accent part (one highlight per icon), CSS hex; omit for none.\n  knockout? (boolean): Details inside a filled body are cut out of it (a solid icon).\n  shadowX? (number -4..4): Hard shadow offset right, grid units (e.g. 0.9); with shadowY.\n  shadowY? (number -4..4): Hard shadow offset down, grid units.\n  shadowColor? (string): Shadow colour, CSS hex (default black).\n  halo? (number 0..4): Sticker border width around the whole icon, grid units (e.g. 1.5).\n  haloColor? (string): Sticker border colour (default white).\n  sketch? (number 0..1): Hand-drawn wobble, 0-1.\n  tile? (string one of none|circle|square|rounded): A badge behind the icon.\n  tileColor? (string): Badge colour, CSS hex.\nOnly in an icon set. Every icon is painted in the style from its own drawing: each path is a body, detail or accent part (its iconPart, else guessed: big closed shapes are body, lines and small shapes detail). The user sees the styles in the panel and the export writes one folder per style. A style with the same name is replaced. A style only repaints: a look that needs other shapes (hand-drawn, more detail, other proportions) is a change of the set's drawing style (brief, examples) plus a redraw, not a style.","tweak":"icons op \"tweak\": icon sets only: paint some shapes of ONE icon their own way in one style (fill, line colour, hidden), or reset them — the drawing and the other styles stay.\n  style (string): The style's name (doc_info iconset.variants).\n  slideId (string): The icon: its slide id (from outline).\n  elementIds (string[]): The icon's shapes to change (element ids from read_slide).\n  fill? (string): Their fill in this style: CSS hex, \"none\" (not filled) or \"style\" (as the style paints the part).\n  fillOpacity? (number 0.05..1): Opacity of that fill (0.05-1, default 1).\n  stroke? (string): Their line colour in this style: CSS hex or \"style\".\n  hide? (boolean): true: left out of this style; false: shown again.\n  reset? (boolean): true: drop every own change of these shapes in this style first.\nFor a comment written \"in the style X\" that concerns one icon only. A change for every icon belongs in the style itself (op style); a wrong drawing is fixed in the shapes (write_slide), which changes every style. The user sees own changes as a dot on the style chip above the canvas."}},{"def":{"name":"elements","description":"Several elements in ONE call, and layout by intent: say how things should sit (a row, a grid in the free space, aligned, evenly spaced) and the app computes the frames. Each call is one undo step; the result lists the new frames and whether the slide is clean, so no review call is needed just to check. Use it instead of one call per element. ops: edit{slideId,changes,reflow?}: any mix of property changes, moves and deletes; delete{slideId,elementIds}: remove elements; arrange{slideId,elementIds,as,within?,…}: lay elements out as a row, column or grid; the app computes every frame; align{slideId,elementIds,edge,to?}: align elements to an edge or centre; distribute{slideId,elementIds,axis,gap?}: equal gaps between elements along an axis; match_size{slideId,elementIds,dim,to?}: give elements the same width and/or height. op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["edit","delete","arrange","align","distribute","match_size","help"]},"slideId":{"type":"string","description":"The slide, slide type or reusable object the elements are on."},"changes":{"type":"array","items":{"type":"object"},"description":"[{id, …props}] sets props (as update_element; x/y/w/h/rotation move it; null removes an optional prop), [{id, delete:true}] removes the element. Up to 200."},"reflow":{"type":"boolean","description":"Default true: afterwards the app keeps text fitting, neighbours spaced and arrows attached. false = exactly as given."},"elementIds":{"type":"array","items":{"type":"string"},"description":"Element ids to remove."},"as":{"type":"string","description":"row, column or grid.","enum":["row","column","grid"]},"within":{"type":"string","description":"\"bounds\" (default: where they are now), \"space\" (the largest free area once they are lifted out: use the empty space), \"columns 7-12\" / \"columns 1-6 rows 2-3\" (a span of the deck's layout grid, doc_info.layoutGrid), or an element id (inside that box). Or give x, y, w, h."},"x":{"type":"number","description":"Explicit region: left (with y, w, h)."},"y":{"type":"number","description":"Explicit region: top."},"w":{"type":"number","description":"Explicit region: width."},"h":{"type":"number","description":"Explicit region: height."},"cols":{"type":"integer","description":"grid: columns (default: what suits the region; 7 items become 4+3)."},"gap":{"type":"number","description":"px between items (default: the gap they use now)."},"size":{"type":"string","description":"fill = items take the cell size (default for space/region); equal = all the same (median) size; keep = own sizes. Default in bounds: equal when the sizes are nearly equal, else keep.","enum":["fill","equal","keep"]},"align":{"type":"string","description":"equal/keep: where an item sits across its row (default start = tops aligned).","enum":["start","center","end"]},"edge":{"type":"string","description":"Which edge (or centre line) to line up.","enum":["left","centerX","right","top","middleY","bottom"]},"to":{"type":"string","description":"\"selection\" (default: their common box), \"slide\" (the content margins), or an element id."},"axis":{"type":"string","description":"x = horizontally, y = vertically.","enum":["x","y"]},"dim":{"type":"string","description":"w, h or both.","enum":["w","h","both"]},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"Several elements in ONE call, and layout by intent: say how things should sit (a row, a grid in the free space, aligned, evenly spaced) and the app computes the frames. Each call is one undo step; the result lists the new frames and whether the slide is clean, so no review call is needed just to check. Use it instead of one call per element.\n\nelements op \"edit\": any mix of property changes, moves and deletes.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  changes (object[]): [{id, …props}] sets props (as update_element; x/y/w/h/rotation move it; null removes an optional prop), [{id, delete:true}] removes the element. Up to 200.\n  reflow? (boolean): Default true: afterwards the app keeps text fitting, neighbours spaced and arrows attached. false = exactly as given.\nExample: changes [{id:\"t1\", color:\"#1F3A5F\", fontWeight:700}, {id:\"c4\", x:40, y:300}, {id:\"n2\", delete:true}]. All changes are checked first; one bad change refuses the whole call, nothing half-applied.\n\nelements op \"delete\": remove elements.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids to remove.\nWhen the removed elements leave a large empty area, the result says so: rebalance what is left with arrange (within \"space\"), unless the space is wanted.\n\nelements op \"arrange\": lay elements out as a row, column or grid; the app computes every frame.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  as (string one of row|column|grid): row, column or grid.\n  within? (string): \"bounds\" (default: where they are now), \"space\" (the largest free area once they are lifted out: use the empty space), \"columns 7-12\" / \"columns 1-6 rows 2-3\" (a span of the deck's layout grid, doc_info.layoutGrid), or an element id (inside that box). Or give x, y, w, h.\n  x? (number): Explicit region: left (with y, w, h).\n  y? (number): Explicit region: top.\n  w? (number 1..): Explicit region: width.\n  h? (number 1..): Explicit region: height.\n  cols? (integer 1..12): grid: columns (default: what suits the region; 7 items become 4+3).\n  gap? (number 0..400): px between items (default: the gap they use now).\n  size? (string one of fill|equal|keep): fill = items take the cell size (default for space/region); equal = all the same (median) size; keep = own sizes. Default in bounds: equal when the sizes are nearly equal, else keep.\n  align? (string one of start|center|end): equal/keep: where an item sits across its row (default start = tops aligned).\nItems are taken in reading order (rows top to bottom, left to right); a short last row is centred. Text inside a resized card keeps its font size and grows to fit; arrows between the items follow. To use space freed by a delete: arrange the remaining cards with within \"space\".\n\nelements op \"align\": align elements to an edge or centre.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  edge (string one of left|centerX|right|top|middleY|bottom): Which edge (or centre line) to line up.\n  to? (string): \"selection\" (default: their common box), \"slide\" (the content margins), or an element id.\n\nelements op \"distribute\": equal gaps between elements along an axis.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  axis (string one of x|y): x = horizontally, y = vertically.\n  gap? (number 0..400): Fixed gap in px: the first stays, the rest follow at this gap. Default: first and last stay, the gaps between become equal.\n\nelements op \"match_size\": give elements the same width and/or height.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  dim (string one of w|h|both): w, h or both.\n  to? (string): largest (default), smallest, average, first, or an element id.\nTop-left corners stay; follow with distribute or arrange to re-space them.\n\nNot available to agents yet (tell the user to do it in the app): grouping elements (G) and element containers; remembering a layout so it holds when items are added later.","edit":"elements op \"edit\": any mix of property changes, moves and deletes.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  changes (object[]): [{id, …props}] sets props (as update_element; x/y/w/h/rotation move it; null removes an optional prop), [{id, delete:true}] removes the element. Up to 200.\n  reflow? (boolean): Default true: afterwards the app keeps text fitting, neighbours spaced and arrows attached. false = exactly as given.\nExample: changes [{id:\"t1\", color:\"#1F3A5F\", fontWeight:700}, {id:\"c4\", x:40, y:300}, {id:\"n2\", delete:true}]. All changes are checked first; one bad change refuses the whole call, nothing half-applied.","delete":"elements op \"delete\": remove elements.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids to remove.\nWhen the removed elements leave a large empty area, the result says so: rebalance what is left with arrange (within \"space\"), unless the space is wanted.","arrange":"elements op \"arrange\": lay elements out as a row, column or grid; the app computes every frame.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  as (string one of row|column|grid): row, column or grid.\n  within? (string): \"bounds\" (default: where they are now), \"space\" (the largest free area once they are lifted out: use the empty space), \"columns 7-12\" / \"columns 1-6 rows 2-3\" (a span of the deck's layout grid, doc_info.layoutGrid), or an element id (inside that box). Or give x, y, w, h.\n  x? (number): Explicit region: left (with y, w, h).\n  y? (number): Explicit region: top.\n  w? (number 1..): Explicit region: width.\n  h? (number 1..): Explicit region: height.\n  cols? (integer 1..12): grid: columns (default: what suits the region; 7 items become 4+3).\n  gap? (number 0..400): px between items (default: the gap they use now).\n  size? (string one of fill|equal|keep): fill = items take the cell size (default for space/region); equal = all the same (median) size; keep = own sizes. Default in bounds: equal when the sizes are nearly equal, else keep.\n  align? (string one of start|center|end): equal/keep: where an item sits across its row (default start = tops aligned).\nItems are taken in reading order (rows top to bottom, left to right); a short last row is centred. Text inside a resized card keeps its font size and grows to fit; arrows between the items follow. To use space freed by a delete: arrange the remaining cards with within \"space\".","align":"elements op \"align\": align elements to an edge or centre.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  edge (string one of left|centerX|right|top|middleY|bottom): Which edge (or centre line) to line up.\n  to? (string): \"selection\" (default: their common box), \"slide\" (the content margins), or an element id.","distribute":"elements op \"distribute\": equal gaps between elements along an axis.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  axis (string one of x|y): x = horizontally, y = vertically.\n  gap? (number 0..400): Fixed gap in px: the first stays, the rest follow at this gap. Default: first and last stay, the gaps between become equal.","match_size":"elements op \"match_size\": give elements the same width and/or height.\n  slideId (string): The slide, slide type or reusable object the elements are on.\n  elementIds (string[]): Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.\n  dim (string one of w|h|both): w, h or both.\n  to? (string): largest (default), smallest, average, first, or an element id.\nTop-left corners stay; follow with distribute or arrange to re-space them."}},{"def":{"name":"slide_html","description":"Write a whole slide as ordinary HTML and CSS — flexbox, grid, padding, gap — and the app lays it out in the browser and turns every box into slide elements: no frames to compute. read gives a slide back as HTML to change and write again. The best way to create or restructure a slide; small changes stay with update_element / elements. Each write is one undo step. ops: write{slideId?,html?,slides?,css?,reflow?}: replace a slide's content with HTML (+ CSS); elements keep their id, so a rewrite updates them in place. slides writes several slides with one shared stylesheet; read{slideId}: a slide as HTML: the source it was written from while nothing changed since, else generated from the slide (flex rows/columns where exact, absolute positions elsewhere). op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["write","read","help"]},"slideId":{"type":"string","description":"The slide (or slide type / reusable object) to write."},"html":{"type":"string","description":"The slide's body HTML. The body IS the slide (doc.size, usually 1280×720)."},"slides":{"type":"array","items":{"type":"object"},"description":"Instead of slideId and html: [{slideId, html}, …], several slides in one call sharing css — a deck written as one document with one stylesheet."},"css":{"type":"string","description":"A stylesheet for it (or put <style> in html); with slides, shared by all of them."},"reflow":{"type":"boolean","description":"Default true: text that does not fit grows afterwards. false = exactly as laid out."},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"Write a whole slide as ordinary HTML and CSS — flexbox, grid, padding, gap — and the app lays it out in the browser and turns every box into slide elements: no frames to compute. read gives a slide back as HTML to change and write again. The best way to create or restructure a slide; small changes stay with update_element / elements. Each write is one undo step.\n\nslide_html op \"write\": replace a slide's content with HTML (+ CSS); elements keep their id, so a rewrite updates them in place. slides writes several slides with one shared stylesheet.\n  slideId? (string): The slide (or slide type / reusable object) to write.\n  html? (string): The slide's body HTML. The body IS the slide (doc.size, usually 1280×720).\n  slides? (object[]): Instead of slideId and html: [{slideId, html}, …], several slides in one call sharing css — a deck written as one document with one stylesheet.\n  css? (string): A stylesheet for it (or put <style> in html); with slides, shared by all of them.\n  reflow? (boolean): Default true: text that does not fit grows afterwards. false = exactly as laid out.\nThe body is the slide: lay it out with normal CSS. Theme variables: --bs-bg, --bs-text, --bs-accent (…--bs-accent6), --bs-muted (secondary text), --bs-line (hairlines), --bs-tint (a pale accent panel), --bs-font, --bs-heading-font, --bs-w, --bs-h, --bs-margin (96px side margin). The diagram components use the same muted, line and tint colours. Defaults: box-sizing border-box, body font var(--bs-font) 24px/1.2, headings var(--bs-heading-font). Keep content inside the 96px side margins.\nWhat becomes what: a box with a background, border or shadow → a rect (border-radius 50% → ellipse; one-sided borders → thin bars); a block holding only text (inline b/i/u/s/code/a/span/br, or a ul/ol list) → a text element on its content box, with bold, italics, colour, size, typeface, weight and letter spacing of inline runs kept; <img> → picture (src: a data: URI, asset:<key> or element:<id of a picture already in the deck>; no downloads); <table> → table (thead or th = header row; cell padding, border, colours, zebra, colspan/rowspan read from CSS); <pre> → code; <hr> → line; <div data-chart='{\"preset\":\"bar\",\"option\":{…ECharts…}}'> → chart; an inline <svg> drawing → native shapes, paths and text (as Convert to objects; one group); a self-contained <iframe srcdoc> → an embed (sandboxed widget); a full-slide root box or body background → the slide background (colour or gradient). transform: rotate() is kept. Effects: filter blur()/drop-shadow(), backdrop-filter blur() (frosted glass), mix-blend-mode, gradient text (background-clip:text), several background layers (stacked shapes <id>-layer2…), a radial gradient fading out (a soft blurred ellipse <id>-glow2), clip-path polygon() (a path shape), ::before/::after (elements <id>-before/-after), background: url(data:) (a picture behind the content), -webkit-text-stroke (outline text), list-style:none (lines, no bullets), writing-mode vertical (a text turned a quarter), outline (a stroke shape <id>-outline). Left out and listed in the result: scripts, video, forms, frames with an outside src, url() other than data:, repeating background patterns (the colour under them stays), masks, scale/skew transforms, other filters, CSS animations (use fx), text columns, ellipsis, double borders, wavy underlines. Icons from the library: the icons tool after writing.\nIds: give every element an id. The id becomes the element id: a rewrite with the same ids updates those elements in place and keeps what HTML cannot say (animations fx, links, locks, comments); an element whose id is gone is removed. The same id on the next slide + transition morph = it morphs. A box with text in it gets two elements: <id> (the box) and <id>-text. data-role=\"title|subtitle|body\" sets the role (the first <h1> is the title). data-valign=\"middle\" centres text vertically (so does a flex box centring its text). <div id=\"x\" data-keep> keeps the existing element x (any kind, e.g. an icon) at the place this box takes.\nComponents — a diagram as data, far less to write: <div id=\"x\" data-component=\"…\" style=\"position:absolute;left;top;width;height\"> fills its box in the deck colours; its parts get ids from x (x-dot2, x-m3), so the same component on the next slide morphs. steps: data-items [\"…\"] or [{title,text}], data-active (1-based: done/current/upcoming). sequence: data-actors [\"Client\",\"Server\"] (2-5), data-messages [{from,to,label,note}] (actor name or 1-based index), data-show (first n; reveal one by one, nothing moves), data-active. cards: data-items [{title,text,badge}], data-columns, data-active. compare: data-columns [{title,items:[…]}] (2-4), data-active. flow: data-nodes [\"…\"] or [{title,text}] (2-6), data-labels (one per arrow), data-active. data-size=\"s|l\" scales text. <hr data-arrow=\"end|start|both\"> is an arrow line.\nThe result lists what was made, what was left out, and the layout check. To change part of a slide: read it, edit the HTML, write it back.\n\nslide_html op \"read\": a slide as HTML: the source it was written from while nothing changed since, else generated from the slide (flex rows/columns where exact, absolute positions elsewhere).\n  slideId (string): The slide (or slide type / reusable object) to read.\nThe generated HTML is verified: laid out again it gives the slide's exact frames, so writing it back unchanged changes nothing. Elements HTML cannot show (icons, lines, arrows, media, …) appear as <div id=… data-keep> placeholders: move or resize the placeholder to move them, delete it to remove them. Pictures appear as src=\"element:<id>\" so the bytes are not repeated.\n\nNot available to agents yet (tell the user to do it in the app): icons from the user's library inside the HTML (insert them with the icons tool after writing); animations in CSS (set fx with update_element or elements edit).","write":"slide_html op \"write\": replace a slide's content with HTML (+ CSS); elements keep their id, so a rewrite updates them in place. slides writes several slides with one shared stylesheet.\n  slideId? (string): The slide (or slide type / reusable object) to write.\n  html? (string): The slide's body HTML. The body IS the slide (doc.size, usually 1280×720).\n  slides? (object[]): Instead of slideId and html: [{slideId, html}, …], several slides in one call sharing css — a deck written as one document with one stylesheet.\n  css? (string): A stylesheet for it (or put <style> in html); with slides, shared by all of them.\n  reflow? (boolean): Default true: text that does not fit grows afterwards. false = exactly as laid out.\nThe body is the slide: lay it out with normal CSS. Theme variables: --bs-bg, --bs-text, --bs-accent (…--bs-accent6), --bs-muted (secondary text), --bs-line (hairlines), --bs-tint (a pale accent panel), --bs-font, --bs-heading-font, --bs-w, --bs-h, --bs-margin (96px side margin). The diagram components use the same muted, line and tint colours. Defaults: box-sizing border-box, body font var(--bs-font) 24px/1.2, headings var(--bs-heading-font). Keep content inside the 96px side margins.\nWhat becomes what: a box with a background, border or shadow → a rect (border-radius 50% → ellipse; one-sided borders → thin bars); a block holding only text (inline b/i/u/s/code/a/span/br, or a ul/ol list) → a text element on its content box, with bold, italics, colour, size, typeface, weight and letter spacing of inline runs kept; <img> → picture (src: a data: URI, asset:<key> or element:<id of a picture already in the deck>; no downloads); <table> → table (thead or th = header row; cell padding, border, colours, zebra, colspan/rowspan read from CSS); <pre> → code; <hr> → line; <div data-chart='{\"preset\":\"bar\",\"option\":{…ECharts…}}'> → chart; an inline <svg> drawing → native shapes, paths and text (as Convert to objects; one group); a self-contained <iframe srcdoc> → an embed (sandboxed widget); a full-slide root box or body background → the slide background (colour or gradient). transform: rotate() is kept. Effects: filter blur()/drop-shadow(), backdrop-filter blur() (frosted glass), mix-blend-mode, gradient text (background-clip:text), several background layers (stacked shapes <id>-layer2…), a radial gradient fading out (a soft blurred ellipse <id>-glow2), clip-path polygon() (a path shape), ::before/::after (elements <id>-before/-after), background: url(data:) (a picture behind the content), -webkit-text-stroke (outline text), list-style:none (lines, no bullets), writing-mode vertical (a text turned a quarter), outline (a stroke shape <id>-outline). Left out and listed in the result: scripts, video, forms, frames with an outside src, url() other than data:, repeating background patterns (the colour under them stays), masks, scale/skew transforms, other filters, CSS animations (use fx), text columns, ellipsis, double borders, wavy underlines. Icons from the library: the icons tool after writing.\nIds: give every element an id. The id becomes the element id: a rewrite with the same ids updates those elements in place and keeps what HTML cannot say (animations fx, links, locks, comments); an element whose id is gone is removed. The same id on the next slide + transition morph = it morphs. A box with text in it gets two elements: <id> (the box) and <id>-text. data-role=\"title|subtitle|body\" sets the role (the first <h1> is the title). data-valign=\"middle\" centres text vertically (so does a flex box centring its text). <div id=\"x\" data-keep> keeps the existing element x (any kind, e.g. an icon) at the place this box takes.\nComponents — a diagram as data, far less to write: <div id=\"x\" data-component=\"…\" style=\"position:absolute;left;top;width;height\"> fills its box in the deck colours; its parts get ids from x (x-dot2, x-m3), so the same component on the next slide morphs. steps: data-items [\"…\"] or [{title,text}], data-active (1-based: done/current/upcoming). sequence: data-actors [\"Client\",\"Server\"] (2-5), data-messages [{from,to,label,note}] (actor name or 1-based index), data-show (first n; reveal one by one, nothing moves), data-active. cards: data-items [{title,text,badge}], data-columns, data-active. compare: data-columns [{title,items:[…]}] (2-4), data-active. flow: data-nodes [\"…\"] or [{title,text}] (2-6), data-labels (one per arrow), data-active. data-size=\"s|l\" scales text. <hr data-arrow=\"end|start|both\"> is an arrow line.\nThe result lists what was made, what was left out, and the layout check. To change part of a slide: read it, edit the HTML, write it back.","read":"slide_html op \"read\": a slide as HTML: the source it was written from while nothing changed since, else generated from the slide (flex rows/columns where exact, absolute positions elsewhere).\n  slideId (string): The slide (or slide type / reusable object) to read.\nThe generated HTML is verified: laid out again it gives the slide's exact frames, so writing it back unchanged changes nothing. Elements HTML cannot show (icons, lines, arrows, media, …) appear as <div id=… data-keep> placeholders: move or resize the placeholder to move them, delete it to remove them. Pictures appear as src=\"element:<id>\" so the bytes are not repeated."}},{"def":{"name":"variants","description":"The designs offered with propose_variants: what the user did with them, pictures of them, and picking one when the user tells you which. ops: status{slideId?}: per slide: pending (not decided yet), picked \"<label>\" or kept; previews{slideId}: a picture of each pending design of a slide, numbered as in the compare view; pick{slideId,index?,keep?}: use design `index` (1 = the first) or keep the current slide, as the compare view's Use / Keep buttons do. op \"help\" (about: an op) explains one op, or lists them all.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["status","previews","pick","help"]},"slideId":{"type":"string","description":"Only this slide (default: every slide with designs this session)."},"index":{"type":"integer","description":"The design to use, 1-6, as numbered in the compare view and the previews."},"keep":{"type":"boolean","description":"true keeps the current slide and drops the designs."},"about":{"type":"string","description":"help only: the op to explain."}},"required":["op"]}},"help":{"*":"The designs offered with propose_variants: what the user did with them, pictures of them, and picking one when the user tells you which.\n\nvariants op \"status\": per slide: pending (not decided yet), picked \"<label>\" or kept.\n  slideId? (string): Only this slide (default: every slide with designs this session).\nAsk this instead of asking the user which design they took. \"pending\" means they have not decided yet: carry on with other work and look again later; do not wait in a loop.\n\nvariants op \"previews\": a picture of each pending design of a slide, numbered as in the compare view.\n  slideId (string): Deck slide id (from outline).\nCall it right after propose_variants: the pictures show in the BeeSlides pane of Claude Code, where the user can pick one, and you see what you proposed. In the BeeSlides app the same designs are in its compare view.\n\nvariants op \"pick\": use design `index` (1 = the first) or keep the current slide, as the compare view's Use / Keep buttons do.\n  slideId (string): Deck slide id (from outline).\n  index? (integer 1..6): The design to use, 1-6, as numbered in the compare view and the previews.\n  keep? (boolean): true keeps the current slide and drops the designs.\nOnly when the user told you which design they want (or to keep the slide). Give exactly one of index and keep. Using a design is one undo step.","status":"variants op \"status\": per slide: pending (not decided yet), picked \"<label>\" or kept.\n  slideId? (string): Only this slide (default: every slide with designs this session).\nAsk this instead of asking the user which design they took. \"pending\" means they have not decided yet: carry on with other work and look again later; do not wait in a loop.","previews":"variants op \"previews\": a picture of each pending design of a slide, numbered as in the compare view.\n  slideId (string): Deck slide id (from outline).\nCall it right after propose_variants: the pictures show in the BeeSlides pane of Claude Code, where the user can pick one, and you see what you proposed. In the BeeSlides app the same designs are in its compare view.","pick":"variants op \"pick\": use design `index` (1 = the first) or keep the current slide, as the compare view's Use / Keep buttons do.\n  slideId (string): Deck slide id (from outline).\n  index? (integer 1..6): The design to use, 1-6, as numbered in the compare view and the previews.\n  keep? (boolean): true keeps the current slide and drops the designs.\nOnly when the user told you which design they want (or to keep the slide). Give exactly one of index and keep. Using a design is one undo step."}}]

const TOOLS = [
  {
    name: 'get_slide',
    description:
      'One slide. view "summary": one line per element (id, type, frame, full ' +
      'text) plus notes, about a tenth of the size; enough to read the content ' +
      'and address elements by id. Default "full": the whole JSON (styles, ' +
      'background, ...), needed before write_slide or to copy exact styling. ' +
      'Skip it when outline (or, in the app, the editing context) already says enough; ' +
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
      'restructuring a slide (slide_html write is easier); use update_element, ' +
      'elements or insert_elements for smaller edits. Shape: agents.md quick reference.',
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
      'label and a one-line note on what it does differently. To offer ' +
      'LOOKS for the whole deck, give each design a theme: it is laid out ' +
      'and previewed under it (diagram components take their colours from ' +
      'the theme, not from your CSS) and becomes the deck theme when picked. ' +
      'Applies nothing; the result lists any design that could not be made. ' +
      'variants {op:"status"} tells you later what the user picked. A new ' +
      'call replaces an unpicked set.',
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
              theme: {
                type: 'object',
                description: 'Only for a look offered for the whole deck: the theme it needs (as deck_settings theme). Set on the deck when this design is picked.',
                properties: {
                  background: { type: 'string' }, color: { type: 'string' }, accent: { type: 'string' },
                  accent2: { type: 'string' }, accent3: { type: 'string' }, accent4: { type: 'string' }, accent5: { type: 'string' }, accent6: { type: 'string' },
                  fontFamily: { type: 'string' }, headingFamily: { type: 'string' },
                },
              },
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

// An outside app names the deck it works on; main answers both itself
// (main/agentdecks.ts). Not for the panel: its chat belongs to its window.
// ui_profile customizes the app's own UI (the panel's customize-ui skill):
// nothing an outside app's deck job needs. set_frame and delete_element are
// what elements edit does too: one tool less to choose between.
if (endpointDir) {
  for (const name of ['ui_profile', 'set_frame', 'delete_element']) TOOLS.splice(TOOLS.findIndex((t) => t.name === name), 1)
  TOOLS.push(
    {
      name: 'open_deck',
      description:
        'Open a deck file to work on; every later call works on it. create:true makes a new, empty 16:9 deck at path ' +
        'first. In the BeeSlides app it opens in a window; without the app (doc_info background) it opens hidden and ' +
        'every change is saved to the file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The deck file, ending in .beeslides.html (relative = to the current folder).' },
          create: { type: 'boolean', description: 'Make a new deck there when no file exists.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'close_deck',
      description: 'Save and close a deck you opened with open_deck (default: the one you work on).',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The deck file (default: the current one).' } } },
    },
  )
}

/** A path the model gave, as main needs it: absolute, ~ expanded. */
function absolutePath(p) {
  if (typeof p !== 'string' || !p.trim()) return p
  const t = p.trim()
  const home = t === '~' || t.startsWith('~/') ? join(homedir(), t.slice(1)) : t
  return isAbsolute(home) ? home : resolve(process.cwd(), home)
}

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
  // Never listed: the BeeSlides pane of the Claude Code plugin calls it for
  // the user (claude-mod, $.mcp.call) to add, accept or reopen a comment; a
  // model sees only listed tools, so its one comment write stays resolve_comment.
  'pane_comment',
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
    // variants previews: one picture per design, numbered like the labels
    const images = Array.isArray(result.images) ? result.images.filter((im) => im?.data) : []
    if (images.length) {
      const labels = Array.isArray(result.labels) ? result.labels : []
      return { content: [{ type: 'text', text: result.summary ?? 'Done.' }, ...images.flatMap((im, i) => [
        { type: 'text', text: `Design ${i + 1}${labels[i] ? `: ${labels[i]}` : ''}` },
        { type: 'image', data: im.data, mimeType: im.mimeType ?? 'image/png' },
      ])] }
    }
    return { content: [{ type: 'text', text: result.summary ?? 'Done.' }] }
  }
  if (endpointDir && (name === 'open_deck' || name === 'close_deck')) {
    const a = { ...(args ?? {}) }
    if (a.path !== undefined) a.path = absolutePath(a.path)
    // opening waits for the deck to boot (a new instance's first deck too)
    const result = await roundTrip('agent-action', 'agent-action-result', { verb: name, args: a }, 45000)
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
    if (typeof params?.clientInfo?.name === 'string') clientName = params.clientInfo.name.slice(0, 80)
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
