#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Code Mode with several writers (subagents) on one deck
// (desktop/src/main/programrun.ts keyedQueue / writeBlocked).
//
//   node scripts/test-program-queue.ts
//
// Programs on one deck run one at a time, in arrival order, and a second one
// waits instead of being refused; one that waits too long gives up without
// holding up the ones behind it; a program that throws lets the next go;
// decks do not wait for each other. While a program runs, only its own calls
// write to that deck (its rollback would otherwise take another agent's edit
// with it); reads always pass. The MCP server's wait for `execute` must allow
// for the queue.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRead, keyedQueue, writeBlocked } from '../desktop/src/main/programrun.ts'

const root = join(import.meta.dirname, '..')
let failures = 0
let checks = 0
function ok(cond: boolean, msg: string, got?: unknown) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
  else console.log(`  ok    ${msg}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log('-- one at a time per deck, in arrival order --')
{
  const run = keyedQueue(5000)
  const log: string[] = []
  let inside = 0, most = 0
  const job = (name: string, ms: number) => async () => {
    inside++; most = Math.max(most, inside); log.push(`${name}>`)
    await sleep(ms)
    log.push(`<${name}`); inside--
    return name
  }
  const results = await Promise.all([run(1, job('a', 60)), run(1, job('b', 10)), run(1, job('c', 30))])
  ok(results.join() === 'a,b,c', 'every job runs and returns its own value', results)
  ok(log.join(' ') === 'a> <a b> <b c> <c' && most === 1, 'never two at once, in the order they came', log.join(' '))
}

console.log('-- decks do not wait for each other --')
{
  const run = keyedQueue(5000)
  const t = Date.now()
  await Promise.all([run(1, () => sleep(80)), run(2, () => sleep(80))])
  ok(Date.now() - t < 150, 'two decks run side by side', Date.now() - t)
}

console.log('-- waiting too long, and throwing --')
{
  const run = keyedQueue(50)
  const first = run(1, async () => { await sleep(150); return 'first' })
  const second = run(1, async () => 'second')
  await sleep(120) // second has given up (50 ms); first ends at 150 ms
  const third = run(1, async () => 'third')
  const [a, b] = await Promise.all([first, second])
  ok(a === 'first' && b === 'late', 'a job that waits past the limit is not run (late)', [a, b])
  ok(await third === 'third', 'a job queued behind a late one runs once the job before it ends', await third)
  const run2 = keyedQueue(5000)
  const boom = run2(7, async () => { throw new Error('boom') }).catch((e) => `caught ${(e as Error).message}`)
  const next = run2(7, async () => 'next')
  ok(await boom === 'caught boom' && await next === 'next', 'a job that throws still lets the next one run')
}

console.log('-- the write gate --')
{
  const write = { verb: 'slide_html', args: { op: 'write', slideId: 's1' } }
  ok(writeBlocked(true, false, 'agent-action', write), 'during a program, another agent\'s write is refused')
  ok(!writeBlocked(true, true, 'agent-action', write), 'the program\'s own write passes')
  ok(!writeBlocked(false, false, 'agent-action', write), 'no program: writes pass')
  ok(!writeBlocked(true, false, 'agent-query', { verb: 'outline' }) && !writeBlocked(true, false, 'slide-request', {}), 'reads pass during a program')
  ok(['read', 'search', 'help'].every((op) => isRead('agent-action', { verb: 'icons', args: { op } })), 'read, search and help ops are reads')
  ok(!isRead('agent-action', { verb: 'deck', args: { op: 'add' } }) && !isRead('slide-write', {}), 'add and slide writes are writes')
}

console.log('-- the server waits long enough --')
{
  const exec = readFileSync(join(root, 'desktop/src/main/agentexec.ts'), 'utf8')
  const server = readFileSync(join(root, 'desktop/src/mcp/slides-mcp-server.mjs'), 'utf8')
  const q = Number(/export const QUEUE_MAX_S = (\d+)/.exec(exec)?.[1])
  const s = Number(/const PROGRAM_QUEUE_S = (\d+)/.exec(server)?.[1])
  ok(q > 0 && q === s, 'agentexec QUEUE_MAX_S equals the server\'s PROGRAM_QUEUE_S', { q, s })
  ok(/\(seconds \+ 20 \+ PROGRAM_QUEUE_S\) \* 1000/.test(server), 'the server\'s execute wait includes the queue')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
