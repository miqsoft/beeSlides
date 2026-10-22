// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The grouped agent tools (`deck`, …) are declared once, in
// slides/src/agentops/spec.ts. slides-mcp-server.mjs is written out as ONE
// standalone file, so instead of importing the spec it carries a placeholder
// that the app fills with the generated tool definitions and help texts when
// it writes the server (terminalPanel.ts). Adding an op to the spec therefore
// reaches the API chat and Claude Code with no change here or in the server.
import { AGENT_AREAS, areaHelp, areaToolDef } from '../../../slides/src/agentops/spec.ts'

export const AGENT_AREAS_PLACEHOLDER = '/*@AGENT_AREAS@*/[]'

export interface AreaTool {
  def: ReturnType<typeof areaToolDef>
  /** `op:"help"` answers: one per op, `*` for the whole area. */
  help: Record<string, string>
}

export function agentAreaTools(): AreaTool[] {
  return AGENT_AREAS.map((area) => ({
    def: areaToolDef(area),
    help: Object.fromEntries([['*', areaHelp(area)], ...Object.keys(area.ops).map((op) => [op, areaHelp(area, op)])]),
  }))
}

/** The server source with the area tools filled in. Throws when the
 *  placeholder is gone, so a server edit that drops it fails loudly in
 *  scripts/test-agent-ops.ts instead of silently losing the tools. */
export function serverWithAgentAreas(source: string): string {
  if (!source.includes(AGENT_AREAS_PLACEHOLDER)) throw new Error('slides-mcp-server.mjs has no AGENT_AREAS placeholder')
  // A function replacement: a `$` in a help text must not act as a pattern.
  return source.replace(AGENT_AREAS_PLACEHOLDER, () => JSON.stringify(agentAreaTools()))
}

export const CODE_MODE_PLACEHOLDER = '/*@CODE_MODE@*/false'

/** The server source with Code Mode's execute/api_search tools switched on
 *  (agentexec.ts). Throws when the placeholder is gone, like the areas. */
export function serverWithCodeMode(source: string, on: boolean): string {
  if (!source.includes(CODE_MODE_PLACEHOLDER)) throw new Error('slides-mcp-server.mjs has no CODE_MODE placeholder')
  return on ? source.replace(CODE_MODE_PLACEHOLDER, 'true') : source
}
