#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//   node scripts/test-dashmarch.ts
import { dashTarget, dashTravel } from '../slides/src/dashmarch.ts'
const FAILS: string[] = []
const check = (n: string, c: boolean) => { if (!c) FAILS.push(n); console.log(`${c ? '  ok  ' : ' FAIL '} ${n}`) }

// fake svg: defs>marker>path precedes the line, as render.ts emits for lineEnd:'arrow'
const mk = (tag: string, inMarker: boolean) => ({ tag, closest: (sel: string) => (inMarker && sel.includes('marker') ? {} : null) })
const path = mk('path', true), line = mk('line', false)
const svg: any = { querySelectorAll: () => [path, line] }
check('dash target skips the marker path', dashTarget(svg) === (line as any))
check('no target when only marker geometry', dashTarget({ querySelectorAll: () => [path] } as any) === null)

check('positive distance snaps to period', dashTravel(18, [6, 4]) === 20)
check('negative distance keeps sign', dashTravel(-18, [6, 4]) === -20)
check('odd dasharray doubles the period', dashTravel(18, [6]) === 12 * Math.round(18 / 12))
check('tiny distance still one period', dashTravel(-1, [6, 4]) === -10)
check('no dasharray: raw distance', dashTravel(-18, []) === -18)
if (FAILS.length) { console.error(`\n${FAILS.length} failed`); process.exit(1) }
