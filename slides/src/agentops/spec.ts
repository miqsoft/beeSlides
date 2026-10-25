// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Agent op areas: the ONE place a grouped agent tool is declared. Each area
// is one MCP tool (`deck`, …) taking `{op, …params}`; everything else is
// generated from this file:
//   - the MCP tool definition (desktop/src/main/agenttools.ts injects it into
//     slides-mcp-server.mjs when the app writes the server out), so the API
//     chat and Claude Code both get it,
//   - `op:"help"` (answered by the server, no app round trip),
//   - argument checking before a handler runs (editor/agentops.ts).
// Handlers live in editor/agentops.ts, typed `{[op in keyof ops]: …}`, so an
// op declared here without a handler does not compile.
//
// To add an op: add it to an area's `ops` below and its handler in
// editor/agentops.ts. To add an area (a new tool): add an AreaSpec to
// AGENT_AREAS and a handler map to AREA_HANDLERS. Keep this file free of
// imports: the desktop main process bundles it too.

export type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'string[]' | 'object[]'

export interface ParamSpec {
  type: ParamType
  description: string
  enum?: readonly string[]
  required?: boolean
  min?: number
  max?: number
}

export interface OpSpec {
  /** One line, shown in the tool description. */
  summary: string
  params: Readonly<Record<string, ParamSpec>>
  /** Longer guidance, only in `help`. */
  details?: string
}

export interface AreaSpec {
  tool: string
  /** What the tool is for — the first sentence of its description. */
  summary: string
  ops: Readonly<Record<string, OpSpec>>
  /** What the UI can do in this area that no op covers yet: `help` lists it
   *  so a model tells the user instead of hacking around it. */
  notYet: readonly string[]
}

export const TRANSITION_KINDS = ['none', 'fade', 'slide', 'zoom', 'morph', 'push', 'wipe', 'cover', 'split'] as const

export const BUILTIN_SLIDE_TYPES = ['layout-title', 'layout-title-content', 'layout-two-col', 'layout-comparison', 'layout-section', 'layout-picture-caption', 'layout-blank'] as const

/** The most slides one call may add or delete. */
export const MAX_SLIDES_PER_CALL = 30

const slideIds: ParamSpec = { type: 'string[]', description: 'Deck slide ids (from outline).', required: true }
const slideId: ParamSpec = { type: 'string', description: 'Deck slide id (from outline).', required: true }

export const DECK_AREA = {
  tool: 'deck',
  summary: 'Deck structure, one undo step per call (theme, size, slideshow, header & footer: deck_settings).',
  ops: {
    add: {
      summary: 'new slides; returns their ids',
      params: {
        after: { type: 'string', description: 'Slide id to insert after (default: the end of the deck).' },
        slideType: { type: 'string', description: `A slide type id from doc_info.slideTypes (the new slides follow it) or a built-in layout: ${BUILTIN_SLIDE_TYPES.join(', ')}. Default: the type of the slide in front, else layout-title-content.` },
        count: { type: 'integer', description: `How many (1-${MAX_SLIDES_PER_CALL}, default 1).`, min: 1, max: MAX_SLIDES_PER_CALL },
        names: { type: 'string[]', description: 'Optional slide names, one per new slide.' },
      },
      details: 'Build a deck by adding ALL its slides first (one call with count), then fill them; hand each subagent the ids it owns.',
    },
    duplicate: {
      summary: 'copy slides with their states; returns the new ids',
      params: { slideIds },
      details: 'Copies keep element ids, so a copy with transition "morph" morphs from the original.',
    },
    delete: {
      summary: 'delete slides and their states',
      params: {
        slideIds,
        userAsked: { type: 'boolean', description: 'true only when the user asked to delete these slides. Without it, only slides added or duplicated by an agent in this session can be deleted.' },
      },
      details: 'Links to deleted slides are cleared and zoom tiles into them removed. A deck always keeps at least one slide.',
    },
    move: {
      summary: 'move slides with their states',
      params: {
        slideIds,
        before: { type: 'string', description: 'Slide id to move in front of.' },
        after: { type: 'string', description: 'Slide id to insert after (default: the end of the deck).' },
        to: { type: 'string', description: 'start or end.', enum: ['start', 'end'] },
      },
      details: 'Give exactly one of before, after, to. Moved slides keep their relative order; interactive states move with their slide.',
    },
    hide: {
      summary: 'hide slides from the show',
      params: { slideIds, hidden: { type: 'boolean', description: 'false shows the slides again (default true).' } },
      details: 'A hidden slide right after a normal one is that slide\'s extra: reachable by link, skipped in the show.',
    },
    rename: {
      summary: 'name a slide',
      params: { slideId, name: { type: 'string', description: 'The new name ("" removes it).', required: true } },
      details: 'Names show in the outline and in link pickers.',
    },
    transition: {
      summary: 'transition into slides',
      params: {
        slideIds,
        kind: { type: 'string', description: 'Transition kind.', enum: TRANSITION_KINDS, required: true },
        dir: { type: 'string', description: 'Direction for push/wipe/cover/split/slide (left, right, up, down, …); see help.' },
      },
      details: 'morph animates elements with the same id from the previous slide; use duplicate to get matching ids.',
    },
    background: {
      summary: 'slide background',
      params: { slideIds, background: { type: 'string', description: 'A CSS colour (#RRGGBB, rgba()) or linear-/radial-gradient().', required: true } },
    },
    notes: {
      summary: 'speaker notes',
      params: {
        slideId,
        text: { type: 'string', description: 'Plain text; new lines are kept.', required: true },
        append: { type: 'boolean', description: 'Add below the existing notes instead of replacing them.' },
      },
    },
    section_add: {
      summary: 'start a section at a slide',
      params: { slideId, name: { type: 'string', description: 'The section name.', required: true } },
      details: 'doc_info lists sections (id, name, startSlideId).',
    },
    section_rename: {
      summary: 'rename a section',
      params: { sectionId: { type: 'string', description: 'Section id (doc_info.sections).', required: true }, name: { type: 'string', description: 'The new name.', required: true } },
    },
    section_remove: {
      summary: 'remove a section (slides stay)',
      params: { sectionId: { type: 'string', description: 'Section id (doc_info.sections).', required: true } },
    },
    state_add: {
      summary: 'interactive state: a copy opened by clicking linkFrom; returns its id',
      params: {
        slideId,
        linkFrom: { type: 'string', description: 'Element id on that slide that will link to the new state (click → state).' },
        name: { type: 'string', description: 'The new name ("" removes it).' },
      },
      details: 'The state keeps the element ids (transition morph), so change what differs with update_element on the state. States of a state share one parent. A state element links back with update_element link: <parent id>.',
    },
    state_sync: {
      summary: 'pull new parent elements into a state',
      params: { slideId },
    },
    hover: {
      summary: 'hover group (focus-group or reveal)',
      params: {
        slideId,
        type: { type: 'string', description: 'none switches it off.', enum: ['none', 'focus-group', 'reveal'], required: true },
        dim: { type: 'number', description: 'focus-group: opacity of the non-hovered elements (0..1, default 0.15).', min: 0, max: 1 },
        revealDefault: { type: 'string', description: 'reveal: the showOnHover set shown when nothing is hovered.' },
      },
      details: 'focus-group dims the elements not hovered; reveal shows one showOnHover set per hovered trigger. Members are set per element with update_element: group (focus-group membership) and showOnHover (the element shown while its trigger is hovered).',
    },
    properties: {
      summary: 'document title and properties',
      params: {
        title: { type: 'string', description: 'Document title.' },
        author: { type: 'string', description: 'Author ("" clears).' },
        company: { type: 'string', description: 'Company ("" clears).' },
        subject: { type: 'string', description: 'Subject ("" clears).' },
        event: { type: 'string', description: 'Event ("" clears).' },
        keywords: { type: 'string', description: 'Keywords ("" clears).' },
        language: { type: 'string', description: 'Language the document is written in, a BCP-47 code like "de". Picks which translation {{term:Name}} shows and formats {{date}} ("" clears).' },
      },
    },
  },
  notYet: [
    'custom document properties (File ▸ Properties ▸ Custom)',
    'editing the translated-terms table (it belongs to the layout: Document properties ▸ Language & terms in the layout window)',
  ],
} as const satisfies AreaSpec

const FOOTER_ROLE_LIST = ['date', 'slideNumber', 'footer'] as const

export const PAGE_SIZE_PRESETS = {
  '16:9': { w: 1280, h: 720 }, '4:3': { w: 960, h: 720 }, '1:1': { w: 1080, h: 1080 },
  '9:16': { w: 1080, h: 1920 }, 'a4-landscape': { w: 1123, h: 794 }, 'a4-portrait': { w: 794, h: 1123 },
} as const

const colour = (what: string): ParamSpec => ({ type: 'string', description: `${what} (CSS colour).` })

export const DECK_SETTINGS_AREA = {
  tool: 'deck_settings',
  summary: 'Deck-wide settings: theme colours and fonts, slide size, the slideshow (counter, progress, auto-advance, loop), per-slide timing, header & footer, slide numbering. Each call is one undo step; doc_info shows the current values.',
  ops: {
    theme: {
      summary: 'set theme colours and fonts; colours picked from the theme follow',
      params: {
        background: colour('Default slide background'),
        color: colour('Text colour'),
        accent: colour('Accent 1'),
        accent2: colour('Accent 2'), accent3: colour('Accent 3'), accent4: colour('Accent 4'), accent5: colour('Accent 5'), accent6: colour('Accent 6'),
        fontFamily: { type: 'string', description: 'Body font family, e.g. "Inter".' },
        headingFamily: { type: 'string', description: 'Heading font family ("" = same as the body font).' },
      },
      details: 'Elements whose colours were picked from the theme palette (themeRefs) follow; literal colours stay. Fonts apply to all text without its own font. A stored chart palette is re-derived from a new accent. Use fonts the viewer has, or tell the user to embed them.',
    },
    size: {
      summary: 'set the slide size (preset or width/height in px)',
      params: {
        preset: { type: 'string', description: 'A page size.', enum: Object.keys(PAGE_SIZE_PRESETS) },
        width: { type: 'integer', description: 'px (320..4000).', min: 320, max: 4000 },
        height: { type: 'integer', description: 'px (320..4000).', min: 320, max: 4000 },
      },
      details: 'As in the app, elements keep their positions: nothing is rescaled. Review the slides afterwards and move what now falls outside.',
    },
    present: {
      summary: 'slideshow settings: counter, progress bar, corner arrows, numbering hidden slides, auto-advance, loop, morph speed',
      params: {
        counter: { type: 'boolean', description: 'The slide counter in the show\'s corner (default on).' },
        progress: { type: 'boolean', description: 'The progress bar (default on).' },
        arrows: { type: 'boolean', description: 'Corner arrows for mouse navigation (default off).' },
        numberHidden: { type: 'boolean', description: 'Hidden slides keep their number (default off).' },
        loop: { type: 'boolean', description: 'Wrap from the last slide to the first (default off).' },
        autoAdvance: { type: 'number', description: 'Seconds per slide for a self-running show; 0 = manual.', min: 0, max: 86400 },
        morphSeconds: { type: 'number', description: 'Morph transition length in seconds (0.1..6); 0 = default.', min: 0, max: 6 },
      },
    },
    slide_timing: {
      summary: 'per-slide timing: advance after N seconds, auto-play the click builds',
      params: {
        slideIds,
        advanceAfter: { type: 'number', description: 'Seconds before the show moves on from these slides; 0 = off.', min: 0, max: 86400 },
        autoBuild: { type: 'boolean', description: 'Play the slide\'s click builds by themselves.' },
        every: { type: 'number', description: 'autoBuild: seconds between steps (0.1..3600, default 2).', min: 0.1, max: 3600 },
        hold: { type: 'number', description: 'autoBuild: seconds to hold the last step (default 2).', min: 0, max: 3600 },
        buildLoop: { type: 'boolean', description: 'autoBuild: start over after the last step (default true).' },
      },
    },
    header_footer: {
      summary: 'deck-wide header & footer: date, slide number, footer text, hide on title slides',
      params: {
        date: { type: 'string', description: 'off, live (today) or fixed (dateText).', enum: ['off', 'live', 'fixed'] },
        dateText: { type: 'string', description: 'date fixed: the text to show.' },
        showSlideNumber: { type: 'boolean', description: 'Show the slide-number boxes.' },
        showFooter: { type: 'boolean', description: 'Show the footer boxes.' },
        footerText: { type: 'string', description: 'The footer text ({{footer}}).' },
        hideOnTitle: { type: 'boolean', description: 'Hide all of them on title slides.' },
      },
      details: 'These switch text boxes tagged as date / slide number / footer, usually on slide types. The result says which exist; add missing ones with footer_elements.',
    },
    footer_elements: {
      summary: 'add the standard date / slide number / footer text boxes to a slide type (its slides follow)',
      params: {
        slideType: { type: 'string', description: 'Slide type id (doc_info.slideTypes).', required: true },
        roles: { type: 'string[]', description: `Which boxes: ${FOOTER_ROLE_LIST.join(', ')}.`, required: true },
      },
      details: 'Placed along the bottom edge, readable on the slide type\'s background; a role the type already has is skipped.',
    },
    slide_footer: {
      summary: 'show or hide one footer item on particular slides',
      params: {
        slideIds,
        role: { type: 'string', description: 'Which footer item.', enum: FOOTER_ROLE_LIST, required: true },
        visible: { type: 'boolean', description: 'false hides it on these slides.', required: true },
      },
    },
    layout_grid: {
      summary: 'the deck\'s column grid: columns (and rows) inside margins that people see and snap to',
      params: {
        columns: { type: 'integer', description: 'Columns (1-24); 0 removes the grid.', min: 0, max: 24 },
        rows: { type: 'integer', description: 'Rows (0-24; 0 = columns only).', min: 0, max: 24 },
        gutter: { type: 'number', description: 'px between columns (and rows).', min: 0, max: 400 },
        marginX: { type: 'number', description: 'Left and right margin, px.', min: 0, max: 2000 },
        marginY: { type: 'number', description: 'Top and bottom margin, px.', min: 0, max: 2000 },
      },
      details: 'Unset values are kept (a new grid starts at 12 columns, a 24 px gutter and 96/64 px margins, scaled to the page). doc_info.layoutGrid lists every column\'s x and w; elements arrange takes within "columns 7-12" (or "columns 1-6 rows 2-3") to fill exactly that span. The grid is saved with the deck and every slide shares it.',
    },
    numbering: {
      summary: 'leave slides out of the slide numbering (or count them again)',
      params: { slideIds, exclude: { type: 'boolean', description: 'false counts them again.', required: true } },
    },
  },
  notYet: [
    'default text styles of the deck (styleDefaults)',
    'embedding font files',
  ],
} as const satisfies AreaSpec

/** The most icons one search lists. */
export const MAX_ICON_RESULTS = 30

export const ICONS_AREA = {
  tool: 'icons',
  summary: 'The icon library the user set up in Settings ▸ Icon library (an icon server or a folder of SVG/PNG files). Search it and insert real icons instead of drawing your own SVG. In an icon set, plan writes the icons to draw and style adds a look the whole set is painted in.',
  ops: {
    search: {
      summary: 'find icons by keyword; returns refs to insert',
      params: {
        query: { type: 'string', description: 'One or two plain keywords, e.g. "cloud", "user", "shield" ("" lists some).', required: true },
        limit: { type: 'integer', description: `How many to list (1-${MAX_ICON_RESULTS}, default 12).`, min: 1, max: MAX_ICON_RESULTS },
      },
      details: 'Search per concept with short, concrete nouns (several searches are cheap); a folder source matches file names only. Refs stay valid for this editor session.',
    },
    insert: {
      summary: 'put a found icon on a slide; returns its element id',
      params: {
        slideId,
        ref: { type: 'string', description: 'A ref from search (e.g. "i3").', required: true },
        x: { type: 'number', description: 'Left edge in slide px (default: centred).' },
        y: { type: 'number', description: 'Top edge in slide px (default: centred).' },
        size: { type: 'number', description: 'Width and height in px (default 96).', min: 8, max: 2000 },
        alt: { type: 'string', description: 'Alt text ("" = decorative, the default).' },
      },
      details: 'The icon becomes an ordinary svg (or image) element, square at size; move or resize it later with elements edit. Icons keep their own colours: check they read on the slide background (look_at_slide / review_slide). The icon\'s source and license are recorded on the element. One icon per call.',
    },
    plan: {
      summary: 'icon sets only: write a plan of icons as empty, named icons for the user to review',
      params: {
        icons: { type: 'object[]', description: 'The planned icons: [{name, prompt, keywords}] — name a short noun phrase ("evidence bag"), prompt one line of what it shows, keywords 2-5 search words.', required: true },
        replace: { type: 'boolean', description: 'true: remove still-empty icons this plan does not name (drawn or commented ones stay).' },
      },
      details: 'Only in an icon set (doc_info kind "iconset"). An icon already there by name gets the new prompt and keywords; blank starter icons are filled first; the rest are added. Draws nothing: the user reviews the plan and presses Draw with AI. Call it again to revise the plan.',
    },
    style: {
      summary: 'icon sets only: add (or update, by name) a style the whole set is also shown and exported in — nothing is redrawn',
      params: {
        name: { type: 'string', description: 'The style\'s name, two or three words ("Comic yellow").', required: true },
        weight: { type: 'number', description: 'Outline weight × the set stroke width (1 = the same, 1.5 = bold).', min: 0.25, max: 4 },
        color: { type: 'string', description: 'Outline colour, CSS hex (default: the set ink).' },
        cap: { type: 'string', description: 'Line ends.', enum: ['round', 'square', 'butt'] },
        join: { type: 'string', description: 'Corners.', enum: ['round', 'bevel', 'miter'] },
        body: { type: 'string', description: 'Fill of the body parts (the main silhouette), CSS hex; omit for none.' },
        bodyOpacity: { type: 'number', description: 'Opacity of the body fill (0.05-1, default 1).', min: 0.05, max: 1 },
        detail: { type: 'string', description: 'Fill of closed detail parts, CSS hex; omit for none.' },
        accent: { type: 'string', description: 'Fill of the accent part (one highlight per icon), CSS hex; omit for none.' },
        knockout: { type: 'boolean', description: 'Details inside a filled body are cut out of it (a solid icon).' },
        shadowX: { type: 'number', description: 'Hard shadow offset right, grid units (e.g. 0.9); with shadowY.', min: -4, max: 4 },
        shadowY: { type: 'number', description: 'Hard shadow offset down, grid units.', min: -4, max: 4 },
        shadowColor: { type: 'string', description: 'Shadow colour, CSS hex (default black).' },
        halo: { type: 'number', description: 'Sticker border width around the whole icon, grid units (e.g. 1.5).', min: 0, max: 4 },
        haloColor: { type: 'string', description: 'Sticker border colour (default white).' },
        sketch: { type: 'number', description: 'Hand-drawn wobble, 0-1.', min: 0, max: 1 },
        tile: { type: 'string', description: 'A badge behind the icon.', enum: ['none', 'circle', 'square', 'rounded'] },
        tileColor: { type: 'string', description: 'Badge colour, CSS hex.' },
      },
      details: 'Only in an icon set. Every icon is painted in the style from its own drawing: each path is a body, detail or accent part (its iconPart, else guessed: big closed shapes are body, lines and small shapes detail). The user sees the styles in the panel and the export writes one folder per style. A style with the same name is replaced. A style only repaints: a look that needs other shapes (hand-drawn, more detail, other proportions) is a change of the set\'s drawing style (brief, examples) plus a redraw, not a style.',
    },
    tweak: {
      summary: 'icon sets only: paint some shapes of ONE icon their own way in one style (fill, line colour, hidden), or reset them — the drawing and the other styles stay',
      params: {
        style: { type: 'string', description: 'The style\'s name (doc_info iconset.variants).', required: true },
        slideId: { type: 'string', description: 'The icon: its slide id (from outline).', required: true },
        elementIds: { type: 'string[]', description: 'The icon\'s shapes to change (element ids from read_slide).', required: true },
        fill: { type: 'string', description: 'Their fill in this style: CSS hex, "none" (not filled) or "style" (as the style paints the part).' },
        fillOpacity: { type: 'number', description: 'Opacity of that fill (0.05-1, default 1).', min: 0.05, max: 1 },
        stroke: { type: 'string', description: 'Their line colour in this style: CSS hex or "style".' },
        hide: { type: 'boolean', description: 'true: left out of this style; false: shown again.' },
        reset: { type: 'boolean', description: 'true: drop every own change of these shapes in this style first.' },
      },
      details: 'For a comment written "in the style X" that concerns one icon only. A change for every icon belongs in the style itself (op style); a wrong drawing is fixed in the shapes (write_slide), which changes every style. The user sees own changes as a dot on the style chip above the canvas.',
    },
  },
  notYet: [
    'recolouring an inserted icon',
    'changing the icon library settings (the user does that in Settings ▸ Icon library)',
  ],
} as const satisfies AreaSpec

/** The most changes one `elements` edit may carry. */
export const MAX_ELEMENT_CHANGES = 200

const targetSlide: ParamSpec = { type: 'string', description: 'The slide, slide type or reusable object the elements are on.', required: true }
const unitIds: ParamSpec = { type: 'string[]', description: 'Element ids. A box brings what is inside it along (a card = its box), so pass the card boxes.', required: true }
const EDGES = ['left', 'centerX', 'right', 'top', 'middleY', 'bottom'] as const

export const ELEMENTS_AREA = {
  tool: 'elements',
  summary: 'Several elements in ONE call, and layout by intent: say how things should sit (a row, a grid in the free space, aligned, evenly spaced) and the app computes the frames. Each call is one undo step; the result lists the new frames and whether the slide is clean, so no review call is needed just to check. Use it instead of one call per element.',
  ops: {
    edit: {
      summary: 'any mix of property changes, moves and deletes',
      params: {
        slideId: targetSlide,
        changes: { type: 'object[]', description: `[{id, …props}] sets props (as update_element; x/y/w/h/rotation move it; null removes an optional prop), [{id, delete:true}] removes the element. Up to ${MAX_ELEMENT_CHANGES}.`, required: true },
        reflow: { type: 'boolean', description: 'Default true: afterwards the app keeps text fitting, neighbours spaced and arrows attached. false = exactly as given.' },
      },
      details: 'Example: changes [{id:"t1", color:"#1F3A5F", fontWeight:700}, {id:"c4", x:40, y:300}, {id:"n2", delete:true}]. All changes are checked first; one bad change refuses the whole call, nothing half-applied.',
    },
    delete: {
      summary: 'remove elements',
      params: { slideId: targetSlide, elementIds: { type: 'string[]', description: 'Element ids to remove.', required: true } },
      details: 'When the removed elements leave a large empty area, the result says so: rebalance what is left with arrange (within "space"), unless the space is wanted.',
    },
    arrange: {
      summary: 'lay elements out as a row, column or grid; the app computes every frame',
      params: {
        slideId: targetSlide,
        elementIds: unitIds,
        as: { type: 'string', description: 'row, column or grid.', enum: ['row', 'column', 'grid'], required: true },
        within: { type: 'string', description: '"bounds" (default: where they are now), "space" (the largest free area once they are lifted out: use the empty space), "columns 7-12" / "columns 1-6 rows 2-3" (a span of the deck\'s layout grid, doc_info.layoutGrid), or an element id (inside that box). Or give x, y, w, h.' },
        x: { type: 'number', description: 'Explicit region: left (with y, w, h).' },
        y: { type: 'number', description: 'Explicit region: top.' },
        w: { type: 'number', description: 'Explicit region: width.', min: 1 },
        h: { type: 'number', description: 'Explicit region: height.', min: 1 },
        cols: { type: 'integer', description: 'grid: columns (default: what suits the region; 7 items become 4+3).', min: 1, max: 12 },
        gap: { type: 'number', description: 'px between items (default: the gap they use now).', min: 0, max: 400 },
        size: { type: 'string', description: 'fill = items take the cell size (default for space/region); equal = all the same (median) size; keep = own sizes. Default in bounds: equal when the sizes are nearly equal, else keep.', enum: ['fill', 'equal', 'keep'] },
        align: { type: 'string', description: 'equal/keep: where an item sits across its row (default start = tops aligned).', enum: ['start', 'center', 'end'] },
      },
      details: 'Items are taken in reading order (rows top to bottom, left to right); a short last row is centred. Text inside a resized card keeps its font size and grows to fit; arrows between the items follow. To use space freed by a delete: arrange the remaining cards with within "space".',
    },
    align: {
      summary: 'align elements to an edge or centre',
      params: {
        slideId: targetSlide,
        elementIds: unitIds,
        edge: { type: 'string', description: 'Which edge (or centre line) to line up.', enum: EDGES, required: true },
        to: { type: 'string', description: '"selection" (default: their common box), "slide" (the content margins), or an element id.' },
      },
    },
    distribute: {
      summary: 'equal gaps between elements along an axis',
      params: {
        slideId: targetSlide,
        elementIds: unitIds,
        axis: { type: 'string', description: 'x = horizontally, y = vertically.', enum: ['x', 'y'], required: true },
        gap: { type: 'number', description: 'Fixed gap in px: the first stays, the rest follow at this gap. Default: first and last stay, the gaps between become equal.', min: 0, max: 400 },
      },
    },
    match_size: {
      summary: 'give elements the same width and/or height',
      params: {
        slideId: targetSlide,
        elementIds: unitIds,
        dim: { type: 'string', description: 'w, h or both.', enum: ['w', 'h', 'both'], required: true },
        to: { type: 'string', description: 'largest (default), smallest, average, first, or an element id.' },
      },
      details: 'Top-left corners stay; follow with distribute or arrange to re-space them.',
    },
  },
  notYet: [
    'grouping elements (G) and element containers',
    'remembering a layout so it holds when items are added later',
  ],
} as const satisfies AreaSpec

/** The longest html (+ css) one slide_html write takes, pictures included. */
export const MAX_SLIDE_HTML = 4_000_000

export const SLIDE_HTML_AREA = {
  tool: 'slide_html',
  summary: 'Write a whole slide as ordinary HTML and CSS — flexbox, grid, padding, gap — and the app lays it out in the browser and turns every box into slide elements: no frames to compute. read gives a slide back as HTML to change and write again. The best way to create or restructure a slide; small changes stay with update_element / elements. Each write is one undo step.',
  ops: {
    write: {
      summary: 'replace a slide\'s content with HTML (+ CSS); elements keep their id, so a rewrite updates them in place',
      params: {
        slideId: { type: 'string', description: 'The slide (or slide type / reusable object) to write.', required: true },
        html: { type: 'string', description: 'The slide\'s body HTML. The body IS the slide (doc.size, usually 1280×720).', required: true },
        css: { type: 'string', description: 'A stylesheet for it (or put <style> in html).' },
        reflow: { type: 'boolean', description: 'Default true: text that does not fit grows afterwards. false = exactly as laid out.' },
      },
      details: [
        'The body is the slide: lay it out with normal CSS. Theme variables: --bs-bg, --bs-text, --bs-accent (…--bs-accent6), --bs-muted (secondary text), --bs-line (hairlines), --bs-tint (a pale accent panel), --bs-font, --bs-heading-font, --bs-w, --bs-h, --bs-margin (96px side margin). The diagram components use the same muted, line and tint colours. Defaults: box-sizing border-box, body font var(--bs-font) 24px/1.2, headings var(--bs-heading-font). Keep content inside the 96px side margins.',
        'What becomes what: a box with a background, border or shadow → a rect (border-radius 50% → ellipse; one-sided borders → thin bars); a block holding only text (inline b/i/u/s/code/a/span/br, or a ul/ol list) → a text element on its content box, with bold, italics, colour and size of inline runs kept; <img> → picture (src: a data: URI, asset:<key> or element:<id of a picture already in the deck>; no downloads); <table> → table (thead or th = header row; cell padding, border, colours, zebra, colspan/rowspan read from CSS); <pre> → code; <hr> → line; <div data-chart=\'{"preset":"bar","option":{…ECharts…}}\'> → chart; an inline <svg> drawing → native shapes, paths and text (as Convert to objects; one group); a self-contained <iframe srcdoc> → an embed (sandboxed widget); a full-slide root box or body background → the slide background (colour or gradient). transform: rotate() is kept. Effects: filter blur()/drop-shadow(), backdrop-filter blur() (frosted glass), mix-blend-mode, gradient text (background-clip:text), several background layers (stacked shapes <id>-layer2…), a radial gradient fading out (a soft blurred ellipse <id>-glow2), clip-path polygon() (a path shape), ::before/::after (elements <id>-before/-after), background: url(data:) (a picture behind the content), -webkit-text-stroke (outline text), list-style:none (lines, no bullets), writing-mode vertical (a text turned a quarter), outline (a stroke shape <id>-outline). Left out and listed in the result: scripts, video, forms, frames with an outside src, url() other than data:, repeating background patterns, masks, scale/skew transforms, other filters, CSS animations (use fx), text columns, ellipsis, double borders, wavy underlines; a run inside a text keeps only bold, italics, colour and size (another typeface or a lighter weight needs its own element). Icons from the library: the icons tool after writing.',
        'Ids: give every element an id. The id becomes the element id: a rewrite with the same ids updates those elements in place and keeps what HTML cannot say (animations fx, links, locks, comments); an element whose id is gone is removed. The same id on the next slide + transition morph = it morphs. A box with text in it gets two elements: <id> (the box) and <id>-text. data-role="title|subtitle|body" sets the role (the first <h1> is the title). data-valign="middle" centres text vertically (so does a flex box centring its text). <div id="x" data-keep> keeps the existing element x (any kind, e.g. an icon) at the place this box takes.',
        'Components — a diagram as data, far less to write: <div id="x" data-component="…" style="position:absolute;left;top;width;height"> fills its box in the deck colours; its parts get ids from x (x-dot2, x-m3), so the same component on the next slide morphs. steps: data-items ["…"] or [{title,text}], data-active (1-based: done/current/upcoming). sequence: data-actors ["Client","Server"] (2-5), data-messages [{from,to,label,note}] (actor name or 1-based index), data-show (first n; reveal one by one, nothing moves), data-active. cards: data-items [{title,text,badge}], data-columns, data-active. compare: data-columns [{title,items:[…]}] (2-4), data-active. flow: data-nodes ["…"] or [{title,text}] (2-6), data-labels (one per arrow), data-active. data-size="s|l" scales text. <hr data-arrow="end|start|both"> is an arrow line.',
        'The result lists what was made, what was left out, and the layout check. To change part of a slide: read it, edit the HTML, write it back.',
      ].join('\n'),
    },
    read: {
      summary: 'a slide as HTML: the source it was written from while nothing changed since, else generated from the slide (flex rows/columns where exact, absolute positions elsewhere)',
      params: {
        slideId: { type: 'string', description: 'The slide (or slide type / reusable object) to read.', required: true },
      },
      details: 'The generated HTML is verified: laid out again it gives the slide\'s exact frames, so writing it back unchanged changes nothing. Elements HTML cannot show (icons, lines, arrows, media, …) appear as <div id=… data-keep> placeholders: move or resize the placeholder to move them, delete it to remove them. Pictures appear as src="element:<id>" so the bytes are not repeated.',
    },
  },
  notYet: [
    'icons from the user\'s library inside the HTML (insert them with the icons tool after writing)',
    'animations in CSS (set fx with update_element or elements edit)',
  ],
} as const satisfies AreaSpec

/** The most designs one propose_variants call offers (editor/variantpicker.ts). */
export const MAX_VARIANT_DESIGNS = 6

export const VARIANTS_AREA = {
  tool: 'variants',
  summary: 'The designs offered with propose_variants: what the user did with them, pictures of them, and picking one when the user tells you which.',
  ops: {
    status: {
      summary: 'per slide: pending (not decided yet), picked "<label>" or kept',
      params: { slideId: { type: 'string', description: 'Only this slide (default: every slide with designs this session).' } },
      details: 'Ask this instead of asking the user which design they took. "pending" means they have not decided yet: carry on with other work and look again later; do not wait in a loop.',
    },
    previews: {
      summary: 'a picture of each pending design of a slide, numbered as in the compare view',
      params: { slideId },
      details: 'Call it right after propose_variants: the pictures show in the BeeSlides pane of Claude Code, where the user can pick one, and you see what you proposed. In the BeeSlides app the same designs are in its compare view.',
    },
    pick: {
      summary: 'use design `index` (1 = the first) or keep the current slide, as the compare view\'s Use / Keep buttons do',
      params: {
        slideId,
        index: { type: 'integer', description: `The design to use, 1-${MAX_VARIANT_DESIGNS}, as numbered in the compare view and the previews.`, min: 1, max: MAX_VARIANT_DESIGNS },
        keep: { type: 'boolean', description: 'true keeps the current slide and drops the designs.' },
      },
      details: 'Only when the user told you which design they want (or to keep the slide). Give exactly one of index and keep. Using a design is one undo step.',
    },
  },
  notYet: [],
} as const satisfies AreaSpec

export const AGENT_AREAS = [DECK_AREA, DECK_SETTINGS_AREA, ICONS_AREA, ELEMENTS_AREA, SLIDE_HTML_AREA, VARIANTS_AREA] as const satisfies readonly AreaSpec[]

export type DeckOp = keyof typeof DECK_AREA.ops
export type DeckSettingsOp = keyof typeof DECK_SETTINGS_AREA.ops
export type IconsOp = keyof typeof ICONS_AREA.ops
export type ElementsOp = keyof typeof ELEMENTS_AREA.ops
export type SlideHtmlOp = keyof typeof SLIDE_HTML_AREA.ops
export type VariantsOp = keyof typeof VARIANTS_AREA.ops

// ---- generated views ---------------------------------------------------------

const PARAM_JSON: Record<ParamType, Record<string, unknown>> = {
  string: { type: 'string' },
  integer: { type: 'integer' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  'string[]': { type: 'array', items: { type: 'string' } },
  'object[]': { type: 'array', items: { type: 'object' } },
}

/** The params of every op, merged: one flat schema (like slide_type's).
 *  A name used by several ops must have the same type (test-agent-ops.ts);
 *  `about` is reserved for help. */
function mergedParams(area: AreaSpec): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const op of Object.values(area.ops)) {
    for (const [name, p] of Object.entries(op.params)) {
      if (out[name]) continue
      out[name] = { ...PARAM_JSON[p.type], description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}) }
    }
  }
  return out
}

const signature = (op: OpSpec): string => {
  const ps = Object.entries(op.params).map(([n, p]) => `${n}${p.required ? '' : '?'}`)
  // Long lists stay in help; the description only hints at them.
  return ps.length ? `{${ps.length > 5 ? `${ps.slice(0, 4).join(',')},…` : ps.join(',')}}` : ''
}

/** The MCP tool definition of an area. */
export function areaToolDef(area: AreaSpec): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const ops = Object.entries(area.ops).map(([name, op]) => `${name}${signature(op)}: ${op.summary}`).join('; ')
  return {
    name: area.tool,
    description: `${area.summary} ops: ${ops}. op "help" (about: an op) explains one op, or lists them all.`,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...Object.keys(area.ops), 'help'] },
        ...mergedParams(area),
        about: { type: 'string', description: 'help only: the op to explain.' },
      },
      required: ['op'],
    },
  }
}

const describeParam = (name: string, p: ParamSpec): string => {
  const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : ''
  const values = p.enum ? ` one of ${p.enum.join('|')}` : ''
  return `  ${name}${p.required ? '' : '?'} (${p.type}${range}${values}): ${p.description}`
}

/** `op:"help"`: one op in detail, or the whole area. */
export function areaHelp(area: AreaSpec, opName?: string): string {
  const one = (name: string, op: OpSpec): string => [
    `${area.tool} op "${name}": ${op.summary}.`,
    ...Object.entries(op.params).map(([n, p]) => describeParam(n, p)),
    ...(op.details ? [op.details] : []),
  ].join('\n')
  if (opName && opName in area.ops) return one(opName, area.ops[opName])
  return [
    ...(opName ? [`No op "${opName}".`] : []),
    `${area.summary}`,
    ...Object.entries(area.ops).map(([n, op]) => one(n, op)),
    ...(area.notYet.length ? [`Not available to agents yet (tell the user to do it in the app): ${area.notYet.join('; ')}.`] : []),
  ].join('\n\n')
}

/** The usual near-misses of a list parameter, forgiven before checking: a
 *  single `elementId` where `elementIds` is meant (wrapped in a list), and
 *  `elementIds: ["x"]` where one `elementId` is meant. Saves a failed call. */
export function normalizeArgs(area: AreaSpec, opName: string, args: Record<string, unknown>): Record<string, unknown> {
  const op = area.ops[opName]
  if (!op) return args
  const out = { ...args }
  for (const [name, v] of Object.entries(args)) {
    if (name === 'op' || name in op.params) continue
    const plural = op.params[`${name}s`]
    const singular = name.endsWith('s') ? op.params[name.slice(0, -1)] : undefined
    if (plural?.type === 'string[]' && typeof v === 'string' && out[`${name}s`] === undefined) {
      out[`${name}s`] = [v]
      delete out[name]
    } else if (singular?.type === 'string' && Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && out[name.slice(0, -1)] === undefined) {
      out[name.slice(0, -1)] = v[0]
      delete out[name]
    }
  }
  return out
}

/** Checks `args` against an op's params: unknown names, types, enums,
 *  ranges, required. Null when fine, else the message for the model. */
export function checkArgs(area: AreaSpec, opName: string, args: Record<string, unknown>): string | null {
  const op = area.ops[opName]
  if (!op) return `Unknown ${area.tool} op "${opName}". Ops: ${Object.keys(area.ops).join(', ')} (or help).`
  const problems: string[] = []
  for (const name of Object.keys(args)) {
    if (name !== 'op' && !(name in op.params)) problems.push(`"${name}" is not a parameter of ${opName}`)
  }
  for (const [name, p] of Object.entries(op.params)) {
    const v = args[name]
    if (v === undefined || v === null) { if (p.required) problems.push(`${name} is required`); continue }
    const okType = p.type === 'string' ? typeof v === 'string'
      : p.type === 'integer' ? Number.isInteger(v)
      : p.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : p.type === 'boolean' ? typeof v === 'boolean'
      : p.type === 'object[]' ? Array.isArray(v) && v.every((x) => !!x && typeof x === 'object' && !Array.isArray(x))
      : Array.isArray(v) && v.every((x) => typeof x === 'string')
    if (!okType) { problems.push(`${name} must be ${p.type}`); continue }
    if (p.enum && !p.enum.includes(v as string)) problems.push(`${name} must be one of ${p.enum.join('|')}`)
    if (typeof v === 'number' && ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))) problems.push(`${name} must be ${p.min ?? ''}..${p.max ?? ''}`)
    if (p.required && Array.isArray(v) && v.length === 0) problems.push(`${name} must not be empty`)
  }
  return problems.length ? `${area.tool} ${opName}: ${problems.join('; ')}. (op "help" with about "${opName}" explains it.)` : null
}
