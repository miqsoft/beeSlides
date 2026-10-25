// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Editor shell: topbar, slide sidebar, canvas, properties panel, keyboard
// shortcuts, save & present wiring.

import { hasDocExt } from '../../../kernel/src/docext.ts'
import type { Store } from '../store'
import {
  FORMAT_VERSION, MEDIA_EMBED_BUDGET, REUSABLE_OBJECT_CANVAS,
  builtinLayouts, commentEntries, createReusableObject, defaultImage, defaultText,
  createSlideTypeAsBasis, createSlideTypeAsParentChild, createSlideTypeBlank,
  detachSlideType, effectiveLayout, moveSlideTypeInTree, relinkPreview, relinkSlide, resyncLinkedSlides, slideTypeRows,
  instantiateTemplate, layoutElementIds, newDocId, parseDoc, parseTemplateForEditing, resolveStoreRefs, removeLayout, resolveAgentSlide, textDefaultsFor,
  stampAsTemplate, starterSlide, syncLinkedChart, templateFileDoc, uid,
  ancestorElementIds, paginates, inLinearFlow, extraParent, sectionsInOrder, sectionOf, sectionRange,
  type RelinkPreview, type SlidomingoDoc, type ChartElement, type CommentFilter, type Section, type ShapeElement, type Slide, type SlideElement, type TableElement, type TextElement, type TransitionKind, setSlideTransition } from '../model'
import { THEME_CHOICES, onThemeChange, resolvedTheme, setTheme, themeChoice } from '../../../kernel/src/theme.ts'
import { offlineEnabled, setOffline } from '../../../kernel/src/net.ts'
import { renderSlide, renderThumbnail, sanitizeHtml } from '../render'
import { stepCount } from '../builds'
import { isFullBleed, marginFor, overflowFindings, validateDoc, type Finding, type ValidateOpts } from '../validate'
import { layoutBrief } from '../layoutbrief'
import { checkLayout, deriveContainerChildren, guardLayout, reanchorEditedChildren, snapshotSlide, type GuardResult } from '../layoutguard'
import { htmlToMarkdown, insertLiteralText, keptLines, markdownToHtml } from './markdown'
import { outlineParts } from './outlinemodel'
import { paletteOf, paletteSignature, resolveThemeRefs } from '../palette'
import { SlideCanvas } from './canvas'
import { exportDeckAsPdfDesktop, exportFigureAsPdfDesktop, exportFigureAsSvg, fitCanvasToContent, slideSnapshotHtml } from './figureexport'
import { PropsPanel } from './panels'
import { ElementEdits } from './elementactions'
import { MiniToolbar, setLegacyQuickBarPlace } from './minitoolbar'
import { NotesPane } from './notes-pane'
import { FindBar, findChord } from './findbar'
import { ContextMenu, elementLabel } from './contextmenu'
import { TABLE_OPS } from './tablerange'
import { friendlyFinding, type CheckGroup, type FriendlyFinding } from './checkmessages'
import { FormatPainter } from './formatpainter'
import { ReapplyChangeTool } from './reapplychange'
import { applyReapplicablePatch, changedFieldKeys, clearActionLog, compactChange, computeReapplicablePatch } from '../actionlog'
import { startPresentation } from '../present'
// serializeFile (plain output) is deliberately NOT imported here: every path
// in this file writes a real file for a person, so all of them must inherit an
// active password. serializeAuto is the only encryption-aware serializer.
import { adoptFileHandle, canonicalJson, canWriteInPlace, currentFileHandle, currentFileName, fileBase, hasFileHandle, hostCan, isEncryptionActive, openedFileName, parseEnvelope, resolveDocText, saveFile, serializeAuto, serializeDocInto, serializeFile, setEncryptionPassword, suggestedFileName, writeUpdatedFile, writeUpdatedFileAs } from '../save'
import { noteSavedFromWeb } from './returngate'
import { addVersion, clearRecovery, clearVersions, docContentKey, getRecovery, listVersions, pruneOld, putRecovery, type Snapshot } from '../autosave'
import { armPlainPaste, insertElements, insertSlides, mergeClipResources, parseClip, parseClipPayload, plainTextHtml, remapCopiedRefs, serializeElements, serializeSlides, takePlainPaste } from './clipboard'
import { isMacOS, openSpeakerWindow, speakerIdleBody } from '../screens'
import { displayChord } from './customize/logic'
// Bridged into the terminal integration's MCP read verbs (respondAgentQuery)
// so a `claude` session in the desktop panel can check sizing/placement and
// read validation/comment state without a browser of its own — see
// docs/PLATFORM.md §7 and desktop/src/mcp/slides-mcp-server.mjs.
import { fitMathFrame, measureElement, measureText, type TextMeasureSpec } from '../measure'
import { REQUIRED_KEYS, checkElementProp, isWholePictureCrop, sanitizeAssets, sanitizeFonts, sanitizeSlide } from '../untrusted'
import { rerouteConnectors } from './lineedit'
import { afterSlideBlock, deleteSection, deleteSlidesByIds, duplicateSlidesInStore, insertSectionBefore, insertSlidesFromLayout, renameSection, slidesDeleteImpact, survivesDeletion } from './slideops'
import { applyTokens, dropSlots, extraDropAt, moveSectionTo, moveSlidesAsExtras, moveSlidesOutOfExtras, moveSlidesTo, movingSlideIds, stepSlides, tokensOf, type DropSlot, type Token } from './slideorder'
import { ICONS } from '../icons'
import { aiSettingsAvailable, renderAiCategory } from './aisettings'
import { WORDMARK_HTML, logoSvg } from '../brand'
import { t, setLocale, locale, localeChoices, applyDirection, isRtl } from '../i18n'
import { injectFonts } from '../fonts'
import { APP_VERSION, appConfig } from '../../../kernel/src/app.ts'
import { lsGet, lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { loadGridPref, saveGridPref, gridOnKey, gridStepPx } from './gridpref'
import { GRID_PREF_EVENT, openGridSnapPanel } from './gridsnap'
import { layoutTracks, normalizeGuides, normalizeLayoutGrid } from '../layoutgrid'
import { convertPptx } from '../../../kernel/src/convert/pptx.ts'
import { convertMarkdown } from '../../../kernel/src/convert/qmd.ts'
import type { FidelityReport } from '../../../kernel/src/convert/report.ts'
import { canFixWithClaude, fixWithClaude, leftoverLines, listLayouts, repairCount, restyleOntoLayout, restyleSummary, reuseLayout, reuseSummary, settleImport, settleSummary, type ImportContext } from './importfix'
import type { RepairItem } from '../importrepair'
import type { SettleResult } from '../importrepair'
import { openIconSearchPopover, searchIconLibrary, type IconResult } from './iconlibrary'
import { agentSvgPatchViolation, agentSvgViolation } from './agentsvg'
import { renderIconSources } from './iconsettings'
import { openLibraryPanel } from './librarypanel'
import { openSaveSelectionDialog } from './saveselection'
import { canCopyFormat, copySpecial, type CopyFormat } from './copyspecial'
import { openCopySpecialMenu, renderCopySettings } from './copyspecialmenu'
import { closeVariantPicker, MAX_VARIANTS, openVariantPicker, type PendingVariant, type PendingVariants } from './variantpicker'
import { colorForSession } from './sessioncolor'
import { flipMenuIfNeeded, positionFloating } from './floatingposition'
import { isDesktopShell, useRibbonChrome, buildRibbon, ribbonGroup, ribbonRow } from './ribbon'
import { buildMenuBar, type BarItem, type MenuBarHandle } from './menubar'
import { buildTitlebar } from './titlebar'
import {
  openLayoutManager, renderDocumentMetaForm, moveLayoutWithinParent, remintElements,
  type LayoutManagerNavState, type LayoutManagerSession, type OpenLayoutManagerDetail, type Tab as LayoutManagerTab,
} from './layoutmanager'
import { promoteToReusableObject } from './reusableobjects'
import {
  buildInsertGroup, insertChart, insertCode, insertEmbed, insertPresetShape, insertShape, insertTable, insertText,
  insertMath,
  pickImage, pickMedia, promptMediaUrl, SHAPE_MENU,
} from './insertgroup'
import { SHAPE_PRESETS } from './shapepresets'
import { CommandRegistry, commandLabel } from './commands'
import { ALIGN_KEYS, TRANSITION_KINDS, TRANSITION_LABELS, type MenuModel } from './menumodel'
import type { AlignEdge } from '../alignment'
import { openReusableObjectPicker } from './reusableobjects'
import { buildSaveIndicator, type SaveIndicator } from './saveindicator'
import { SAVE_AS_TEMPLATE_EVENT } from './templatemenu'
import { actionToast, promptTemplateOptions } from './templatewindow'
import { CommentsPill } from './commentspill'
import { commentAuthor, commentStats, sendCommentsToClaude } from './comments'
import { openPlanIcons } from './iconplan'
import { addOneIcon, applyIconsetStyle, commentOnIcons, drawIconsWithAi, exportIconSet, exportOneIcon, iconExportTip, lookPreviewUrl, planIconsWithAi, setIconCanvas } from './iconsetactions'
import { ICON_CANVASES, addIconNames, iconCanvasId, iconCanvasUnits, iconsetInfo, type IconCanvasId } from '../iconset'
import { exampleSvg, readIconExamples } from '../iconexamples'
import {
  clearDesktopProblem, desktopBackground, desktopBound, desktopError, desktopFileName, desktopFilePath, desktopKind, desktopLaunch, onDesktopStatus,
  desktopStatus, desktopStatusSource, desktopWritesDisabled, desktopWritesSettled, markDesktopProblem,
  reportDocState, saveDesktopAs, setFlushHandler, writeDesktop, type FlushAnswer,
} from './desktopdoc'
import { formatGate, refuseGatedWrite, refuseNewerDoc } from '../formatgate'
import { lightDoc } from '../../../kernel/src/assetstore.ts'
import { DOC_BLOCK_SELECTOR, isEncFormat } from '../../../kernel/src/legacynames.ts'
import { pickSlideZoom, pickSummaryZoom, zoomDropdown } from './zoompicker'
import { UiCustomizer, targetLabel } from './customize/apply'
import { UiProfileStore } from './customize/store'
import { CUSTOMIZE_TABS, customizeTabLabel, renderCustomizePane, type CustomizeTab } from './customize/settingspane'
import { renderKeymapPane } from './customize/keymappane'
import { buildKeymap, filterRows, keyText } from './customize/keymap'
import { chatBridge, renderChatPane } from './customize/chatpane'
import { validateProfile } from './customize/validate'
import { QUICKBAR_PLACES, emptyProfile, type QuickBarPlace, type UiProfile } from './customize/schema'
import type { RibbonHandle } from './ribbon'
import { agentFindText } from './findtext'
import { applyThemePatch, isAreaTool, runAreaOp, sectionRows, slideFromCompiled, themedDoc, themePatch, type HtmlLayout, type ThemePatch, type IconLibraryAccess, type SlideWrites, type VariantAccess, type VariantOutcome } from './agentops'
import { compileSlideHtml, type CompileResult } from '../htmlslide'
import { MAX_SLIDE_HTML } from '../agentops/spec'
import { slideToHtml } from '../htmlemit'


/** Per-BROWSER, not per-deck: whether the "this browser can't rewrite files"
 *  notice has been acknowledged. It is a property of the browser. */
const SAVE_NOTICE_KEY = 'slidomingo-save-notice'

/** Shared return shape for buildWebTopbar()/buildRibbonChrome() — see
 *  build()'s fork. commentB/pdfB/formatPainterB are nodes the shared tail of
 *  build() wires up regardless of branch; finishMount is phone-topbar-only
 *  (phone-chrome capture + fitTopbar/observers), absent with the ribbon. */
interface TopbarBuild {
  bar: HTMLElement
  commentB: HTMLElement
  pdfB: HTMLElement
  formatPainterB: HTMLElement
  reapplyChangeB: HTMLElement
  finishMount?: () => void
}

/** Categories in the Settings dialog — see Editor.openSettings(). */
/** A part of a slide, in slide px (agent screenshots). */
type CaptureRegion = { x: number; y: number; w: number; h: number }

type SettingsCategoryId = 'general' | 'shortcuts' | 'copy' | 'icons' | 'document' | 'ai' | 'customize'

/** What openLayoutPicker's click should do with the chosen layout. */
type LayoutPickAction =
  | { kind: 'insert'; at: number }
  /** "Change layout…" — `slideId` (default: the current slide) follows the pick */
  | { kind: 'change'; slideId?: string }

/** Quiet time after the last edit before a running show takes the new deck: a burst of writes lands as one update. */
const LIVE_EDIT_SETTLE_MS = 200

export class Editor {
  private canvas!: SlideCanvas
  private panel!: PropsPanel
  private commentsPill: CommentsPill | null = null
  private claudeOpen = false
  /** Every menu command (native menu bar on desktop) — see editor/commands.ts. */
  readonly commands = new CommandRegistry()
  /** The per-install UI profile (editor/customize/), re-applied after every
   *  build; the ribbon / web "My tools" slot it fills. */
  private customizer: UiCustomizer | null = null
  private ribbonHandle: RibbonHandle | null = null
  private myToolsSlot: HTMLElement | null = null
  /** Title bar + ribbon (desktop shell, desktop-width browser) rather than
   *  the flat phone topbar — decided by each build() (ribbon.ts
   *  useRibbonChrome); DECISIONS 2026-10-13 "Web chrome parity". */
  private ribbonChrome = false
  /** The browser's in-page menu bar (editor/menubar.ts) — null on desktop,
   *  whose menu is native, and with the phone topbar. */
  private menuBar: MenuBarHandle | null = null

  private sentToClaudeMsg(n: number): string {
    return this.claudeOpen ? t('Sent {n} comments to Claude', { n }) : t('Starting Claude Code with {n} comments…', { n })
  }
  /** The one shared element-edit layer (undo bursts, palette refs) — the
   *  properties panel and the mini toolbar both edit through it. */
  private edits!: ElementEdits
  private miniToolbar!: MiniToolbar
  /** the same bar, docked at the top of the slide area (Settings: where it shows) */
  private quickBar!: MiniToolbar
  private findBar!: FindBar
  private canvasWrap!: HTMLElement
  private contextMenu!: ContextMenu
  private formatPainter!: FormatPainter
  private reapplyChangeTool!: ReapplyChangeTool
  private sidebar!: HTMLElement
  /** The slide panel's own selection (PowerPoint's thumbnail pane): slide
   *  ids, always containing the current slide. Shift/⌘-click and the panel
   *  shortcuts (wireKeyboard's slidesFocused branch) build it; any slide
   *  change made from outside the panel collapses it to the current slide
   *  (onCurrentSlide). `slideAnchor` is the fixed end of a ⇧ range. */
  private slideSel = new Set<string>()
  private slideAnchor: string | null = null
  /** True while a panel action moves `current` itself — so onCurrentSlide
   *  keeps the selection that action just set instead of collapsing it. */
  private panelNav = false
  private props!: HTMLElement
  private notesPane!: NotesPane
  private notesToggleBtn?: HTMLElement
  /** Save button + dirty dot + "Saved"/"Backed up" flash tag for the main
   *  editor's own topbar/ribbon — rebuilt by every build(), which runs
   *  exactly one of buildWebTopbar() / buildRibbonChrome() (`ribbonChrome`).
   *  See `activeSaveIndicator`
   *  for the Layout Manager overlay's own separate instance. */
  private saveIndicator!: SaveIndicator
  private fileChip?: HTMLElement
  /** Name of a deck opened by DROP when no writable handle came with it. */
  private openedAs?: string
  private thumbTimer = 0
  private presenting = false
  /** Topbar badge for a pending propose_variants set — created lazily in
   *  buildRibbonChrome (desktop shell only, next to the terminal toggle),
   *  hidden while pendingVariants is null. */
  private variantBadge?: HTMLElement
  /** A propose_variants candidate set awaiting a human pick — NEVER written
   *  into store.doc and NEVER touches store.commit/the undo stack until
   *  applyVariant() commits the chosen one. Single pending slot, not a
   *  queue: a later propose_variants call replaces this wholesale (see
   *  applyAgentAction's 'propose_variants' case). */
  private pendingVariants: PendingVariants | null = null
  /** side panel widths (px) — user-resizable, persisted per browser */
  private panelW = { left: 188, right: 236 }
  /** notes pane height (px) — user-resizable, persisted per browser */
  private notesHeight = 180

  /** A template window (desktop Edit Template, editor/templatewindow.ts):
   *  the bound file IS a template. Every write is `templateFileDoc(doc)`,
   *  the Layout Manager is home (its head names the template), and a slim
   *  banner leads back to it from the sample slides. */
  readonly templateMode: boolean
  /** A template window's identity, fixed at boot: every write stamps it
   *  (templateFileDoc), whatever replaced the document since. */
  private readonly templateId: string | undefined

  constructor(
    private root: HTMLElement,
    private store: Store,
    opts: { templateMode?: boolean } = {},
  ) {
    this.templateMode = !!opts.templateMode
    this.templateId = this.templateMode ? store.doc.templateId : undefined
    if (this.templateMode) {
      this.lastTemplateSamples = store.doc.templateSamples !== false
      store.on('doc', () => this.keepTemplateIdentity())
    }
    this.registerCommands()
    this.build()
    this.wireKeyboard()
    this.wireMenuSync()
    this.wireCustomizer()
    store.on('slides', () => { this.pruneSlideSel(); this.rebuildSidebar() })
    store.on('current', () => this.onCurrentSlide())
    store.on('doc', () => this.scheduleThumbs())
    store.on('look', () => this.scheduleThumbs())
    // A desktop-bound window is protected by main's close/quit flush protocol
    // (desktop windows.ts) — an in-page beforeunload would only silently
    // block View ▸ Reload there.
    if (!desktopBound()) {
      window.addEventListener('beforeunload', (ev) => {
        if (store.dirty) ev.preventDefault()
      })
    }
    this.wireAutosave()
    if (desktopBound()) this.wireDesktopDoc()
    this.wirePaste()
    this.wireCopy()
    if (isDesktopShell()) {
      this.store.on('selection', () => this.scheduleSelectionContext())
      // property edits to the CURRENT selection (not just re-selecting) also
      // need to refresh the snapshot — e.g. dragging a selected element.
      this.store.on('doc', () => this.scheduleSelectionContext())
      window.slidomingoDesktop?.onApplyEdit((cmd) => this.applyExternalEdit(cmd))
      window.slidomingoDesktop?.onSlideRequest((req) => this.respondSlideRequest(req))
      window.slidomingoDesktop?.onSlideWrite((cmd) => this.applyExternalSlideWrite(cmd))
      window.slidomingoDesktop?.onAgentQuery?.((req) => this.respondAgentQuery(req))
      window.slidomingoDesktop?.onAgentAction?.((cmd) => this.applyAgentAction(cmd))
      // A terminal tab (parallel `claude` session) closing releases every
      // slide lock it held immediately, rather than waiting out the idle
      // timeout — see store.ts's lock registry.
      // A tab finishing its turn does the same (the slides are no longer
      // being worked on).
      window.slidomingoDesktop?.onAgentSessionClosed?.(({ sessionId }) => this.store.releaseSessionLocks(sessionId))
      // Main asks before an outside AI app connects (agentendpoint.ts) and
      // has no catalog of its own; {client} is the app's name.
      window.slidomingoDesktop?.setAgentConsentStrings?.({
        message: t('“{client}” wants to work on your open decks', { client: '{client}' }),
        detail: t('It can read and change the decks open in BeeSlides, the same way the Claude panel can. Allow it only if you started it yourself. You can take this back in Settings ▸ AI chat ▸ Advanced.'),
        allow: t('Allow'),
        deny: t('Don’t Allow'),
      })
      this.store.on('locks', () => { this.rebuildSidebar(); this.scheduleSelectionContext() })
      // The terminal panel is a fully separate renderer with no access to
      // this window's localStorage/theme state — it can't resolve the
      // app's own Auto/Light/Dark preference on its own, so it's pushed
      // here (current value now, then on every change) rather than left to
      // guess and clash with the surrounding chrome.
      window.slidomingoDesktop?.sendTerminalTheme(resolvedTheme())
      onThemeChange((t) => window.slidomingoDesktop?.sendTerminalTheme(t))
    }
    store.on('doc', () => this.syncLinkedCharts())
    store.on('doc', () => this.syncContainers())
    store.on('doc', () => this.syncConnectors())
    store.on('doc', () => this.syncThemeRefs())
    store.on('doc', () => this.syncLayoutInstances())
    // "Change layout…" — from the panel, the ribbon, and the Layout
    // Manager's slide leaves (typetree.ts, which names the slide).
    document.addEventListener('slidomingo:apply-layout', ((ev: CustomEvent) => {
      this.openLayoutPicker(ev.detail.anchor as HTMLElement, { kind: 'change', slideId: ev.detail.slideId as string | undefined })
    }) as EventListener)
    // The Layout Manager's "Save to template ▸ Save as new template…" (templatemenu.ts)
    document.addEventListener(SAVE_AS_TEMPLATE_EVENT, () => void this.saveAsTemplate())
    // Figure mode's panel (panels.ts buildFigurePanel) talks to the canvas through these
    document.addEventListener('slidomingo:grid-changed', () => this.applyGridPref())
    document.addEventListener('slidomingo:figure-fit', () => this.fitFigureToContent())
    // the icon-set panel's buttons (panels.ts buildIconsetPanel)
    document.addEventListener('slidomingo:iconset', ((ev: CustomEvent<{ action: string }>) => {
      const a = ev.detail?.action
      if (a === 'draw') this.drawIconsWithAi()
      else if (a === 'plan') void this.planIconsWithAi((ev.detail as { request?: string }).request)
      else if (a === 'style') this.applyIconStyle()
      else if (a === 'export') this.exportIconSet()
    }) as EventListener)
    document.addEventListener('slidomingo:open-layout-manager', ((ev: CustomEvent<OpenLayoutManagerDetail>) => {
      this.openLayoutManager(ev.detail?.tab, ev.detail ?? undefined)
    }) as EventListener)
    this.rebuildSidebar()
  }

  // --- DOM ----------------------------------------------------------------

  private build() {
    this.root.innerHTML = ''
    this.safeZoneBtns = []
    this.alignRefBtns = []
    this.buildBadgeBtns = []
    this.gridBtns = []
    this.root.className = 'ed-root'
    this.root.classList.toggle('ed-figure', this.isFigure)
    this.root.classList.toggle('ed-iconset', this.isIconset)
    wireTooltips()
    // which chrome this build gets; the previous build's handles describe DOM
    // that is gone (a language switch rebuilds on the same viewport, but the
    // answer is re-asked, so a reload on a resized window can change it)
    this.ribbonChrome = useRibbonChrome()
    document.documentElement.toggleAttribute('data-ribbon-chrome', this.ribbonChrome)
    this.myToolsSlot = null
    this.ribbonHandle = null
    this.ribbonToggle = null
    this.ribbonCollapsed = () => false
    this.menuBar?.close()
    this.menuBar = null
    this.phoneChrome = null
    this.topbar = null

    // Canvas must exist BEFORE buildWebTopbar()/buildRibbonChrome(): both
    // wire the insert toolbar via insertgroup.ts's buildInsertGroup(store,
    // canvas), which captures `canvas` BY VALUE into each button's click
    // closure — constructing it after left every insert button (Text,
    // Shape, Image, …) permanently bound to `undefined`, throwing on the
    // first click of a fresh session. canvasWrap itself is attached to the
    // live DOM later in this same synchronous call (this.root.append(bar,
    // main) below), before anything can actually run against it.
    const canvasWrap = div('ed-canvas-wrap')
    this.canvasWrap = canvasWrap
    this.canvas = new SlideCanvas(canvasWrap, this.store)
    this.canvas.setGridPref(loadGridPref(), this.gridStep()) // saved viewer preference — survives rebuilds

    const { bar, commentB, formatPainterB, reapplyChangeB, finishMount } =
      this.ribbonChrome ? this.buildRibbonChrome() : this.buildWebTopbar()
    // a saved View preference must show as "on" in the controls built just now
    this.syncSafeZoneButtons()
    this.syncBuildBadgeButtons()

    // main area
    const main = div('ed-main')
    this.sidebar = div('ed-sidebar')
    // A focus zone of its own: while it has focus, Delete/⌘D/⌘C/arrows… act
    // on the selected SLIDES (wireKeyboard's slidesFocused branch), not on
    // canvas elements. Focus is moved here explicitly on a thumb press
    // (pressThumb) — the thumb's mousedown stops propagation and canvas code
    // may preventDefault, so the browser's own click-to-focus can't be
    // relied on.
    this.sidebar.tabIndex = 0
    this.sidebar.setAttribute('role', 'listbox')
    this.sidebar.setAttribute('aria-multiselectable', 'true')
    this.sidebar.setAttribute('aria-label', this.isIconset ? t('Icons') : t('Slides'))
    this.wireSidebarDrop()
    // Pressing anywhere outside the panel leaves the zone, even where that
    // press can't take focus itself (the stage prevents default on it).
    document.addEventListener('pointerdown', (ev) => {
      if (document.activeElement === this.sidebar && !(ev.target instanceof Node && this.sidebar.contains(ev.target))) {
        this.sidebar.blur()
      }
    }, true)
    // Presenting lives in ONE split pill beside the zoom control with the phone
    // topbar — the main half starts the fullscreen show, its menu holds
    // tab-fill and speaker view. The ribbon chrome already has equivalent
    // entry points (the titlebar's Slideshow icon, the View ribbon's Show
    // group, the Play menu), so this floating canvas-corner control is
    // redundant clutter there — built only with the phone topbar.
    let pill: HTMLElement | null = null
    let showB: HTMLElement | null = null
    if (!this.ribbonChrome) {
      pill = div('ed-dropdown ed-present-pill ed-slides-only')
      showB = btn(ICONS.slideshow, t('Slideshow'), () => this.present(false, true),
        t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends'))
      showB.classList.add('ed-pill-main')
      // Nudge: newcomers don't always spot how to start a show — run the neon
      // runner around the Slideshow pill on EVERY editor load until they've
      // actually started a slideshow once (flag set in present(), not when the
      // hint merely plays — so it keeps nudging until it's used). Hover replays it
      // any time (CSS :hover). When the laps finish fading, just drop the class so
      // hover takes over cleanly (a lingering class would replay on mouse-out).
      if (!lsGet('slidomingo-slideshow-started')) pill.classList.add('ed-hint-pulse')
      pill.addEventListener('animationend', (e) => {
        if ((e as AnimationEvent).animationName !== 'ed-runner-fade') return
        pill!.classList.remove('ed-hint-pulse')
      })
      const caret = btn('<span class="ed-caret">▴</span>', '', () => pill!.classList.toggle('open'),
        t('More ways to present'))
      caret.classList.add('ed-pill-caret')
      const pmenu = div('ed-menu')
      const pItem = (icon: string, label: string, title: string, onClick: () => void) => {
        const b = btn(icon, label, () => { pill!.classList.remove('open'); onClick() }, title)
        pmenu.appendChild(b)
      }
      pItem(ICONS.window, t('Present in this tab'), t('Fills this tab instead of going fullscreen — handy for testing or sharing a window'), () => this.present(false, false))
      pItem(ICONS.presenter, t('Open speaker view'), t('Notes, controls and slide thumbnails in a separate window — drag it to a second screen. On macOS, open it before going fullscreen.'), () => this.openSpeakerView())
      pill.append(showB, caret, pmenu)
      document.addEventListener('pointerdown', (ev) => {
        if (!pill!.contains(ev.target as Node)) pill!.classList.remove('open')
      })
    }
    // shared bottom-right cluster: zoom pill (+ the Slideshow pill on
    // web/mobile) — the canvas appends its zoombar to canvasWrap; we adopt it
    // into the cluster below.
    const corner = div('ed-corner-br')
    const cmtPill = new CommentsPill(this.store, (id) => this.canvas.openCommentThread(id), (m) => this.toast(m), () => this.canvas.refreshComments())
    this.commentsPill = cmtPill
    cmtPill.setClaudeAvailable(this.claudeOpen)
    corner.appendChild(cmtPill.root)
    // ▶ Preview animation: always in reach while the slide has any animation
    // (the properties-panel button is inside a collapsed section)
    const fxPill = document.createElement('button')
    fxPill.className = 'ed-fxpill'
    fxPill.textContent = t('▶ Preview animation')
    fxPill.title = t('Play this slide\'s animations on the canvas (click or any key stops)')
    fxPill.addEventListener('click', () => this.canvas.previewAnimations())
    const syncFxPill = () => { fxPill.hidden = !this.store.slide?.elements.some((el) => el.fx) }
    syncFxPill()
    for (const ev of ['doc', 'current', 'slides'] as const) this.store.on(ev, syncFxPill)
    corner.appendChild(fxPill)
    if (pill) corner.appendChild(pill)
    canvasWrap.appendChild(corner)
    queueMicrotask(() => {
      const zb = canvasWrap.querySelector('.ed-zoombar')
      if (zb) corner.appendChild(zb)
    })
    this.props = div('ed-props')
    const canvasCol = div('ed-canvas-col')
    canvasCol.append(canvasWrap, this.makeNotesResizer())
    this.notesPane = new NotesPane(this.store, canvasCol)
    main.append(this.sidebar, this.makeResizer('left'), canvasCol, this.makeResizer('right'), this.props)

    this.root.append(bar, main)

    // phones/small windows: start with both panels collapsed so the CANVAS
    // is what you see — the topbar toggles (and [ / ]) bring them back
    if (window.innerWidth < 700) {
      this.sidebar.classList.add('ed-collapsed')
      this.props.classList.add('ed-collapsed')
    }

    // Phone topbar only: phone-chrome capture + fitTopbar/observers wiring.
    // buildRibbonChrome() returns no finishMount — the ribbon has no
    // narrow-window fold system (by design; see the ribbon/titlebar files).
    finishMount?.()

    this.restorePanelWidths()
    this.restoreNotesPane()
    this.canvas.onCommentModeChange = (on) => commentB.classList.toggle('ed-btn-armed', on)
    this.canvas.onSlideNav = (dir) => this.store.goToLinear(dir)
    this.canvas.onLockedElementClick = () => this.toast(
      t('This element comes from its slide type — open that slide type in the Layout Manager to edit it'))
    this.edits = new ElementEdits(this.store)
    this.panel = new PropsPanel(this.props, this.store, this.edits)
    this.panel.onAlignRefChange = () => { this.syncAlignRefButtons(); this.scheduleMenuSync() }
    this.panel.setSlidesHidden = (on) => this.setSlidesHidden(on)
    // the selected table cells drive the panel's Cells block and Edit ▸ Table
    this.panel.tableCells = this.canvas.tableRange
    this.canvas.tableRange.onChange(() => { this.panel.refreshTableCells(); this.scheduleMenuSync() })
    // Mounted in canvasWrap (not body) so it rides along when the Layout
    // Manager reparents the canvas.
    this.miniToolbar = new MiniToolbar(this.store, this.canvas, this.panel, this.edits, this.canvasWrap, {
      suppressed: () => this.presenting,
      revealPanelSection: (key) => this.revealPanelSection(key),
      custom: () => this.customizer,
    })
    this.quickBar = new MiniToolbar(this.store, this.canvas, this.panel, this.edits, this.canvasWrap, {
      suppressed: () => this.presenting,
      revealPanelSection: (key) => this.revealPanelSection(key),
      custom: () => this.customizer,
      docked: true,
      runCommand: (id) => { this.commands.run(id) },
      commandVisible: (id) => this.commands.state(id).visible !== false,
    })
    this.panel.sectionOrder = () => this.customizer?.panelOrder() ?? []
    // also in canvasWrap; closed while the Layout Manager borrows the canvas
    this.findBar = new FindBar(this.store, this.canvas, this.canvasWrap, {
      toast: (msg) => this.toast(msg),
      blocked: () => this.layoutManagerOpen || this.presenting,
      showNotes: () => {
        if (this.isFigure) return null
        if (this.notesPane.el.classList.contains('ed-collapsed')) this.toggleNotes()
        return this.notesPane.el.querySelector('textarea')
      },
    })
    this.contextMenu = new ContextMenu(this.store, this.panel, this.canvas, {
      copySelection: () => this.copySelection(),
      cutSelection: () => this.cutSelection(),
      pasteFromClipboardAsync: () => this.pasteFromClipboardAsync(),
      copySpecial: (x, y) => this.openCopySpecial({ x, y }),
    }, () => this.customizer)
    this.canvas.onContextMenu = (elId, x, y, stack) => this.contextMenu.open(elId, x, y, stack)
    this.formatPainter = new FormatPainter(this.store, this.canvas)
    this.formatPainter.onArmedChange = (on) => formatPainterB.classList.toggle('ed-btn-armed', on)
    this.reapplyChangeTool = new ReapplyChangeTool(this.store, this.canvas)
    this.reapplyChangeTool.onArmedChange = (on) => reapplyChangeB.classList.toggle('ed-btn-armed', on)
  }

  /**
   * Phones (ribbon.ts COMPACT_CHROME_QUERY): the flat responsive topbar
   * (wordmark, title, Insert group, actions group, phone-chrome fold menus).
   * A desktop-width browser tab gets buildRibbonChrome() instead, like the
   * desktop shell; the two never run in the same build().
   */
  private buildWebTopbar(): TopbarBuild {
    // topbar
    const bar = div('ed-topbar')
    const logo = div('ed-logo')
    logo.innerHTML = `${logoSvg(20, { className: 'ed-logo-mark' })} <b>${WORDMARK_HTML}</b>`
    logo.title = t('About BeeSlides — version, updates, licenses')
    logo.style.cursor = 'pointer'
    logo.addEventListener('click', () => this.openAboutPanel())
    const title = document.createElement('input')
    title.className = 'ed-title'
    title.title = t('Deck title — shown in the tab, on {{title}} fields, and as the suggested file name')
    title.value = this.store.doc.title
    title.spellcheck = false
    title.addEventListener('change', () => {
      this.store.commit(() => { this.store.doc.title = title.value || 'Untitled' })
      this.syncWindowTitle()
    })
    // remote/programmatic title changes reflect live (unless being typed in)
    this.store.on('doc', () => {
      if (document.activeElement !== title && title.value !== this.store.doc.title) {
        title.value = this.store.doc.title
        this.syncWindowTitle()
      }
    })

    // The FILE this deck is open as — deliberately separate from the deck
    // title above, because the two drift apart constantly (rename the deck and
    // the file on disk keeps its old name) and only one of them answers "what
    // does ⌘S overwrite?". Absent until the answer is knowable: a never-saved
    // deck has no file, and saying so would be noise.
    this.fileChip = div('ed-filechip')
    this.fileChip.hidden = true
    this.saveIndicator = buildSaveIndicator(this.store, () => this.save(false), desktopStatusSource())

    const formatPainterB = tagTool(btn(ICONS.paintbrush, t('Format Painter'), () => this.toggleFormatPainter(),
      t('Format Painter — click a styled element, then click others to copy its look (Esc to stop)')), 'format-painter')
    const reapplyChangeB = tagTool(btn(ICONS.reapply, t('Reapply Change'), () => this.toggleReapplyChange(),
      t('Reapply Change — click a recently-edited element, then click others of the same type to apply that same edit (Esc to stop)')), 'reapply-change')
    const insert = div('ed-group ed-insert')
    const insertGroup = buildInsertGroup(this.store, this.canvas)
    // Clusters, divided by thin rules, so ~17 icons scan as five groups:
    // things you put on a slide · data & special objects · reuse · format
    // tools · comment (appended below). Dividers vanish in phone menus.
    const tbSep = () => { const d = document.createElement('span'); d.className = 'ed-tb-sep'; d.setAttribute('aria-hidden', 'true'); return d }
    // an icon set exports shapes only: the rest would be left out of its SVGs
    for (const el of [insertGroup.text, insertGroup.image, insertGroup.icons, insertGroup.media, insertGroup.table,
      insertGroup.chart, insertGroup.math, insertGroup.code, insertGroup.embed]) notIconset(el)
    insert.append(
      insertGroup.text,
      insertGroup.shape,
      insertGroup.image,
      insertGroup.icons,
      insertGroup.media,
      notIconset(tbSep()),
      insertGroup.table,
      insertGroup.chart,
      insertGroup.math,
      insertGroup.code,
      insertGroup.embed,
      notIconset(tagTool(zoomDropdown(this.store, this.canvas), 'zoom')),
      tbSep(),
      insertGroup.objects,
      tagTool(this.saveSelectionButton(), 'save-selection'),
      tagTool(this.libraryPanelButton(), 'library'),
      tbSep(),
      formatPainterB,
      reapplyChangeB,
      tbSep(),
    )
    const commentB = tagTool(btn(ICONS.comment, t('Comment'), () => this.canvas.toggleCommentMode(),
      this.isIconset ? t('Comment (C) — click a shape or a spot on the icon') : t('Comment (C) — click an element or a spot on the slide')), 'comment')
    insert.appendChild(commentB)

    const actions = div('ed-group ed-group-right')
    const undoB = tagTool(btn(ICONS.undo, '', () => this.undo(), t('Undo (⌘Z)')), 'undo')
    const redoB = tagTool(btn(ICONS.redo, '', () => this.redo(), t('Redo (⇧⌘Z)')), 'redo')
    // pressing them must not first APPLY a crop in progress (crop mode
    // commits on any outside mousedown) — this.undo cancels it instead
    undoB.dataset.keepsCrop = ''
    redoB.dataset.keepsCrop = ''
    const pdfB = tagTool(this.isFigure ? this.figureExportMenu(false) : this.isIconset ? this.iconsetExportMenu(false)
      : btn(ICONS.pdf, '', () => this.exportPdf(), t('Export PDF (print)')), 'pdf')
    const notesB = tagTool(btn(ICONS.notes, t('Notes'), () => this.toggleNotes(),
      t('Notes — show or hide the speaker notes pane below the slide')), 'notes')
    this.notesToggleBtn = notesB
    notesB.classList.add('ed-slides-only')
    // Always-visible web entry point into the Layout Manager — mirrors the
    // desktop ribbon's own button (same two, already-existing strings, zero
    // new i18n). panels.ts's "🖼 Layout Manager…" button only renders while
    // NO element is selected (buildSlidePanel's zero-selection branch), so
    // it's completely absent from the DOM the rest of the time; this button
    // is a second, always-present entry point that doesn't depend on
    // selection state.
    const layoutMgrB = tagTool(btn(ICONS.template, t('Layout Manager…'), () => this.openLayoutManager(),
      t('Manage building blocks shared across every slide type, and the slide types themselves')), 'layout-manager')
    layoutMgrB.classList.add('ed-slides-only')
    const settingsB = btn(ICONS.settings, '', () => this.openSettings(), t('Settings (⌘,)'))
    const helpB = tagTool(btn('<b class="ed-help-q">?</b>', '', () => this.openHelp(), t('Shortcuts & tips (?)')), 'help')
    helpB.classList.add('ed-btn-help')
    // Intuitive grouping: LEFT = the document (identity · title · save-state ·
    // undo/redo history) · CENTRE = insert tools · RIGHT = output
    // (print · Save · more) with help pinned to the corner.
    const history = div('ed-group ed-group-history')
    history.append(undoB, redoB)
    const saveGroup = div('ed-split')
    saveGroup.append(this.saveIndicator.root, this.saveDropdown())
    const viewD = tagTool(this.viewDropdown(), 'view')
    actions.append(pdfB, notesB, layoutMgrB, viewD, saveGroup, settingsB, helpB)
    // a UI profile's own buttons (editor/customize/apply.ts fills it)
    this.myToolsSlot = div('ed-dropdown ed-mytools')
    this.myToolsSlot.hidden = true
    actions.insertBefore(this.myToolsSlot, settingsB)

    // Phone chrome: two menus that stay EMPTY on a wide screen. Nothing is
    // duplicated — applyPhoneChrome moves the real buttons in and out, so every
    // listener, tooltip and live reference (dirtyDot, the comment
    // button's armed state) keeps working wherever the button currently sits.
    const insertMenu = div('ed-menu')
    const insertD = div('ed-dropdown ed-phone-only ed-phone-insert')
    insertD.append(
      btn(ICONS.plus, t('Insert'), () => insertD.classList.toggle('open'), t('Insert — text, shapes, images, media, tables, charts')),
      insertMenu)
    const moreMenu = div('ed-menu')
    const moreD = div('ed-dropdown ed-phone-only')
    moreD.append(
      btn('<b>⋯</b>', t('More'), () => {
        // Fill BEFORE opening: the save-as list reflects live state (is this
        // file encrypted?) and must be current the moment it becomes visible.
        if (!moreD.classList.contains('open')) this.fillPhoneSaveAs(moreMenu, moreD)
        moreD.classList.toggle('open')
      }, t('More actions')),
      moreMenu)
    const slidesB = this.slideListButton()
    slidesB.classList.add('ed-phone-only')
    const formatB = btn(ICONS.panelRight, t('Format'), () => this.togglePanel('right'), t('Format — show or hide the properties panel'))
    formatB.classList.add('ed-phone-only')

    this.syncWindowTitle()

    this.phoneChrome = {
      insertD, insertMenu, moreD, moreMenu, slidesB, formatB, insert, actions, history,
      // order matters: this is the order they appear in the ⋯ menu
      demote: [redoB, commentB, pdfB, notesB, layoutMgrB, viewD, helpB],
      // filled in once the bar is fully assembled (formatB lands last)
      authored: new Map(), homeOf: new Map(),
    }

    bar.append(logo, title, this.saveIndicator.flashTag, this.fileChip, slidesB, insertD, history, insert, actions, moreD)

    const finishMount = () => {
      actions.insertBefore(formatB, saveGroup)

      // The authored desktop layout, captured once the bar is fully assembled.
      // Unfolding REPLAYS this instead of guessing where each button belongs.
      // Guessing is what the old restore did — everything except demote[0] went
      // back to `actions` immediately before formatB — and it could not be right:
      // Comment is authored into the INSERT group, so it changed groups entirely,
      // and pdf/share/lang/help landed in a row after Save instead of interleaved
      // with the avatars strip, leaving Save sitting after Help.
      for (const g of [history, insert, actions]) {
        this.phoneChrome!.authored.set(g, [...g.children] as HTMLElement[])
      }
      for (const [g, kids] of this.phoneChrome!.authored) {
        for (const k of kids) this.phoneChrome!.homeOf.set(k, g)
      }

      // drive it now and whenever the bar's size or content changes.
      // build() has just re-authored the bar, so whatever folding state a PREVIOUS
      // bar was in no longer describes this DOM. Without this reset a rebuild on a
      // phone (switching language, say) would early-return on `true === true` and
      // leave the freshly authored DESKTOP bar in place — overflowing, with Save
      // off-screen again.
      this.phoneChromeOn = null
      this.topbar = bar
      this.fitTopbar()
      // A ResizeObserver on the bar itself is the primary width signal. It fires
      // for every viewport change (matchMedia change events do not fire at all
      // under CDP-driven viewport changes, and a phone ROTATING is exactly this
      // path); the plain resize listener is belt and braces on top. fitTopbar
      // is idempotent, so the overlap costs a few reads.
      this.barRO?.disconnect()
      this.barRO = new ResizeObserver(() => this.fitTopbar())
      this.barRO.observe(bar)
      window.addEventListener('resize', () => this.fitTopbar())
      // The bar's CONTENT changes width too, at a constant viewport (avatars
      // join, the update chip appears, the file chip fills in, the "Saved" tag
      // flashes), and each of these used to clip the end of the bar. fitTopbar
      // drops the records its own mutations queue, so this cannot loop.
      this.barMO?.disconnect()
      this.barMO = new MutationObserver(() => this.fitTopbar())
      this.barMO.observe(bar, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['style', 'hidden'],
      })
    }

    return { bar, commentB, pdfB, formatPainterB, reapplyChangeB, finishMount }
  }

  /**
   * Title bar (editor/titlebar.ts) + PowerPoint-style ribbon
   * (editor/ribbon.ts): the desktop shell, and a desktop-width browser tab
   * (`ribbonChrome`, ribbon.ts useRibbonChrome). ONE builder for both — the
   * differences are per ITEM, gated on the desktop API each one needs
   * (terminal, agent variants, start page, ☰ native menu popup) — so the
   * browser gets the same groups and `data-ui-tool` ids as desktop. In a
   * browser the title bar also carries the in-page menu bar (menubar.ts,
   * drawn from the same command registry as the native menu). This branch builds its own instances of the
   * buttons/dropdowns the phone topbar also builds: the two never run in the
   * same build(), so there is no live node to share, unlike
   * applyPhoneChrome's reparent discipline. commentB/pdfB/formatPainterB are
   * returned because the shared tail of build() needs them either way.
   */
  private buildRibbonChrome(): TopbarBuild {
    const desktop = window.slidomingoDesktop
    const wrap = div('ed-desktop-chrome')

    // ---- pieces shared by the title bar and elsewhere in the class --------
    const title = document.createElement('input')
    title.className = 'ed-title'
    title.title = t('Deck title — shown in the tab, on {{title}} fields, and as the suggested file name')
    title.value = this.store.doc.title
    title.spellcheck = false
    title.addEventListener('change', () => {
      this.store.commit(() => { this.store.doc.title = title.value || 'Untitled' })
      this.syncWindowTitle()
    })
    this.store.on('doc', () => {
      if (document.activeElement !== title && title.value !== this.store.doc.title) {
        title.value = this.store.doc.title
        this.syncWindowTitle()
      }
    })

    this.fileChip = div('ed-filechip')
    this.fileChip.hidden = true
    this.saveIndicator = buildSaveIndicator(this.store, () => this.save(false), desktopStatusSource())

    // ---- title bar: Quick Access (Save/Undo/Redo) + title + right cluster -
    const undoB = tagTool(btn(ICONS.undo, '', () => this.undo(), t('Undo (⌘Z)')), 'undo')
    const redoB = tagTool(btn(ICONS.redo, '', () => this.redo(), t('Redo (⇧⌘Z)')), 'redo')
    // pressing them must not first APPLY a crop in progress (crop mode
    // commits on any outside mousedown) — this.undo cancels it instead
    undoB.dataset.keepsCrop = ''
    redoB.dataset.keepsCrop = ''
    const saveGroup = div('ed-split')
    saveGroup.append(this.saveIndicator.root, this.saveDropdown())

    // [▶|▾] split like Save: the caret offers the Play menu's other ways to
    // present. The tag sits on the group so Customize hides both halves.
    const presentB = tagTool(div('ed-split'), 'present')
    presentB.classList.add('ed-slides-only')
    presentB.append(btn(ICONS.slideshow, '', () => this.present(false, true),
      t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends')), this.presentDropdown())
    // Claude Code terminal + agent variant picker: desktop APIs, no browser
    // equivalent — not built at all off desktop (never a silent no-op)
    const terminalB = tagTool(btn(ICONS.terminal, '', () => void window.slidomingoDesktop?.toggleTerminal(),
      t('Toggle Claude Code terminal (⌘`)')), 'terminal')
    window.slidomingoDesktop?.onTerminalStateChange?.((state) => {
      terminalB.classList.toggle('ed-btn-armed', state.open)
      this.panel?.setClaudeAvailable(state.open)
      this.claudeOpen = state.open
      this.commentsPill?.setClaudeAvailable(state.open)
    })
    window.slidomingoDesktop?.onFullscreenChange?.((state) =>
      document.documentElement.toggleAttribute('data-desktop-fullscreen', state.fullscreen))
    // propose_variants badge — created hidden, shown/updated by
    // updateVariantBadge() the moment applyAgentAction stores a pending set.
    // Built as a local const (not read back off `this.variantBadge`) so the
    // closure and the rightCluster array below both see a definite
    // HTMLElement rather than fighting TS's this.field narrowing rules.
    const variantBadge = btn(ICONS.sparkle, '', () => this.openVariants(),
      t('Claude Code proposed slide variants — pick one'))
    variantBadge.classList.add('ed-variant-badge')
    variantBadge.style.display = 'none'
    this.variantBadge = variantBadge
    const settingsB = btn(ICONS.settings, '', () => this.openSettings(), t('Settings (⌘,)'))

    // Shrunk mark only — the wordmark text is dropped, but the click into
    // About survives (Help's '?' opens shortcuts, not About).
    const logo = div('ed-titlebar-logo')
    logo.innerHTML = logoSvg(20, { className: 'ed-logo-mark' })
    logo.title = t('About BeeSlides — version, updates, licenses')
    logo.style.cursor = 'pointer'
    logo.addEventListener('click', () => this.openAboutPanel())

    // Filled in once the ribbon exists below — the button has to be built
    // before buildTitlebar() so it can sit in the title bar's right cluster.
    let onCollapseToggle = () => {}
    const collapseB = btn('<span class="ed-ribbon-collapse-glyph">︿</span>', '', () => onCollapseToggle(),
      t('Collapse the ribbon'))

    // Home: back to the start page in this window (desktop-bound decks only).
    const homeB = desktopBound() && window.slidomingoDesktop?.goHome
      ? [btn(ICONS.home, '', () => void window.slidomingoDesktop!.goHome!(), t('Start page (⇧⌘H) — this deck is saved first'))]
      : []
    // Windows/Linux: the native menu bar is hidden (windows.ts) — this button
    // pops the SAME application menu up. macOS keeps the system menu bar.
    const menuB = !isMacOS() && window.slidomingoDesktop?.popupAppMenu
      ? [btn('<span class="ed-menu-glyph">☰</span>', '', () => void window.slidomingoDesktop!.popupAppMenu!(), t('Menu'))]
      : []
    // Browser: the in-page menu bar, drawn from the SAME registry model the
    // native menu is (commands.serialize()); main-owned slots map to web
    // equivalents or nothing (webMenuSlot).
    if (!desktop) {
      this.menuBar = buildMenuBar({
        model: () => this.commands.serialize(),
        run: (id) => { this.commands.run(id) },
        slot: (name, model) => this.webMenuSlot(name, model),
        mac: isMacOS(),
        label: t('Menu'),
      })
    }
    buildTitlebar(wrap, {
      quickAccess: [...(this.menuBar ? [this.menuBar.el] : []), ...menuB, ...homeB, saveGroup, undoB, redoB],
      titleInput: title,
      rightCluster: desktop
        ? [presentB, terminalB, variantBadge, settingsB, collapseB]
        // the language is in Settings ▸ General and View ▸ Language
        : [presentB, settingsB, collapseB],
      logo,
    })
    // title is now DOM-attached (buildTitlebar put it in .ed-titlebar-title) —
    // mirrors buildWebTopbar's placement of the flash tag and file chip as
    // title's siblings. The chip shows only when the file name differs from
    // the title (syncWindowTitle).
    title.after(this.saveIndicator.flashTag, this.fileChip)

    // ---- ribbon: Home / Insert / Design / Transitions / View --------------
    const formatPainterB = tagTool(btn(ICONS.paintbrush, t('Format Painter'), () => this.toggleFormatPainter(),
      t('Format Painter — click a styled element, then click others to copy its look (Esc to stop)')), 'format-painter')
    const reapplyChangeB = tagTool(btn(ICONS.reapply, t('Reapply Change'), () => this.toggleReapplyChange(),
      t('Reapply Change — click a recently-edited element, then click others of the same type to apply that same edit (Esc to stop)')), 'reapply-change')
    const commentB = tagTool(btn(ICONS.comment, t('Comment'), () => this.canvas.toggleCommentMode(),
      this.isIconset ? t('Comment (C) — click a shape or a spot on the icon') : t('Comment (C) — click an element or a spot on the slide')), 'comment')
    // Send open comments to Claude (starts the terminal if it isn't open)
    const sendB = tagTool(btn(ICONS.sparkle, t('Send to Claude'), () => this.sendOpenComments(), ''), 'send-to-claude')
    const refreshSendB = () => {
      const n = commentStats(this.store.doc).openCount
      ;(sendB as HTMLButtonElement).disabled = !n
      sendB.title = t('Send {n} open comments to Claude', { n })
    }
    this.store.on('doc', refreshSendB)
    refreshSendB()

    // Ribbon Arrange buttons are always visible (unlike the properties
    // panel's Arrange section, which only renders for a 2+ selection) — the
    // underlying methods already no-op safely on too-small selections
    // (panels.ts align/distribute/group/ungroup), this guard just avoids a
    // spurious empty commit when nothing is selected at all.
    const alignBtn = (glyph: string, title: string, edge: AlignEdge) =>
      btn(`<b>${glyph}</b>`, '', () => this.alignSelection(edge), title)
    // Align to slide: the PowerPoint mode, but lit up while it is on
    const toSlideB = btn(ICONS.centerSlide, this.isCanvasDoc ? t('To canvas') : t('To slide'), () => this.toggleAlignToSlide(),
      (this.isCanvasDoc ? t('Align and distribute against the canvas instead of the selection') : t('Align and distribute against the slide instead of the selection'))
        + ` (${displayChord('Alt+Shift+S', isMacOS())})`)
    this.alignRefBtns.push(toSlideB)
    const arrangeGroup = ribbonGroup(t('Arrange'), [
      alignBtn('⇤', t('Align left'), 'left'),
      alignBtn('⇹', t('Align horizontal centers'), 'centerX'),
      alignBtn('⇥', t('Align right'), 'right'),
      alignBtn('⤒', t('Align top'), 'top'),
      alignBtn('⇳', t('Align vertical middles'), 'middleY'),
      alignBtn('⤓', t('Align bottom'), 'bottom'),
      btn('<b>⊕</b>', '', () => this.centerSelectionOnSlide(), this.isCanvasDoc ? t('Center on canvas') : t('Center on slide')),
      toSlideB,
      btn('<b>⋯</b>', '', () => this.distributeSelection('x'), t('Equal horizontal gaps (3+)')),
      btn('<b>⋮</b>', '', () => this.distributeSelection('y'), t('Equal vertical gaps (3+)')),
      btn('', t('⛓ Group'), () => this.groupSelection(true), t('Elements select and move as one; Alt-click reaches a member (G)')),
      btn('', t('⛓ Ungroup'), () => this.groupSelection(false), t('Dissolve the group (⇧G)')),
    ])
    const homeRow = ribbonRow([
      this.isIconset ? this.iconsetRibbonGroup() : ribbonGroup(t('Slides'), [
        tagTool(btn(ICONS.plus, t('New slide'), (ev) => this.openLayoutPicker(ev.currentTarget as HTMLElement),
          t('Add a slide — pick a slide type')), 'new-slide'),
      ]),
      ...(this.isIconset ? [this.iconsetLookGroup()] : []),
      ribbonGroup(t('Format Painter'), [formatPainterB]),
      ribbonGroup(t('Reapply Change'), [reapplyChangeB]),
      arrangeGroup,
      ribbonGroup(t('Comment'), window.slidomingoDesktop?.sendAgentPrompt ? [commentB, sendB] : [commentB]),
    ])

    const ribbonInsertGroup = buildInsertGroup(this.store, this.canvas)
    const objectsGroup = ribbonGroup(t('Objects'), [ribbonInsertGroup.objects, tagTool(this.saveSelectionButton(), 'save-selection'), tagTool(this.libraryPanelButton(), 'library')])
    // An icon set exports shapes only (iconset.ts iconSlideSvg), so its Insert
    // tab is a drawing toolbar: no text, pictures, media, tables or charts that
    // the export would leave out.
    const insertRow = this.isIconset ? ribbonRow([
      ribbonGroup(t('Shapes'), [
        ...SHAPE_MENU.filter((item) => item.draw !== 'connector' && item.kind !== 'arrow').map((item) =>
          btn(item.icon, t(item.label), () => insertShape(this.store, this.canvas, item), t(item.tip))),
        ribbonInsertGroup.shape,
      ]),
      objectsGroup,
    ]) : ribbonRow([
      ribbonGroup(t('Basic'), [ribbonInsertGroup.text, ribbonInsertGroup.image]),
      ribbonGroup(t('Illustrations'), [ribbonInsertGroup.shape, ribbonInsertGroup.icons]),
      ribbonGroup(t('Media'), [ribbonInsertGroup.media]),
      ribbonGroup(t('Zoom'), [tagTool(zoomDropdown(this.store, this.canvas), 'zoom')]),
      objectsGroup,
      ribbonGroup(t('Tables & Charts'), [ribbonInsertGroup.table, ribbonInsertGroup.chart]),
      ribbonGroup(t('Text'), [ribbonInsertGroup.code, ribbonInsertGroup.embed]),
      ribbonGroup(t('Symbols'), [ribbonInsertGroup.math]),
    ])

    // Page Setup/Background/Theme controls stay OUT of this tab (no new model
    // fields, no duplicated panel UI) — "Slide settings…" just reveals the
    // existing Format panel section that already owns them.
    const designRow = ribbonRow([
      ribbonGroup(t('Slide Type'), [
        btn(ICONS.copy, t('Change slide type…'), (ev) =>
          document.dispatchEvent(new CustomEvent('slidomingo:apply-layout', { detail: { anchor: ev.currentTarget as HTMLElement } })),
          t('Pick the slide type this slide follows — its content moves into the new placeholders; nothing is deleted')),
        btn(ICONS.plus, t('Save as slide type…'), () => this.saveSlideAsType(), t("Add this slide to the document’s slide types (New slide button)")),
        btn(ICONS.template, t('Layout Manager…'), () => this.openLayoutManager(),
          t('Manage building blocks shared across every slide type, and the slide types themselves')),
      ]),
      ribbonGroup(t('Background & Theme'), [
        btn(ICONS.panelRight, t('Slide settings…'), () => this.openSlideSettings(), t('Background, size and other slide settings — in the Format panel')),
      ]),
    ])

    // Deliberately thin: the kinds only — the doc model has no duration/
    // sound/apply-to-all fields today; a push/wipe/cover/split's direction is
    // in the slide panel.
    const TRANSITIONS: Array<{ kind: TransitionKind; label: string }> =
      TRANSITION_KINDS.map((kind) => ({ kind, label: t(TRANSITION_LABELS[kind]) }))
    const transitionButtons = new Map<TransitionKind, HTMLElement>()
    const refreshTransitionActive = () => {
      const current = this.store.slide.transition
      for (const [kind, b] of transitionButtons) b.classList.toggle('ed-btn-armed', kind === current)
    }
    const transitionGroup = ribbonGroup(t('Transition to This Slide'), TRANSITIONS.map(({ kind, label }) => {
      const b = btn('', label, () => {
        this.setTransition(kind)
        refreshTransitionActive()
      }, t('Transition when arriving on this slide'))
      transitionButtons.set(kind, b)
      return b
    }))
    this.store.on('current', refreshTransitionActive)
    this.store.on('doc', refreshTransitionActive)
    refreshTransitionActive()
    const transitionsRow = ribbonRow([transitionGroup])

    const pdfB = tagTool(this.isFigure ? this.figureExportMenu(true) : this.isIconset ? this.iconsetExportMenu(true)
      : btn(ICONS.pdf, t('Export PDF'), () => this.exportPdf(), t('Export PDF (print)')), 'pdf')
    const notesB2 = btn(ICONS.notes, t('Notes'), () => this.toggleNotes(),
      t('Notes — show or hide the speaker notes pane below the slide'))
    this.notesToggleBtn = notesB2
    notesB2.classList.add('ed-slides-only')
    const sorterB = this.sorterButton(() => this.openSlideSorter())
    const viewRow = ribbonRow([
      iconsetToo(slidesOnly(this.isIconset ? ribbonGroup(t('Icons'), [sorterB]) : ribbonGroup(t('Presentation Views'), [sorterB]))),
      slidesOnly(ribbonGroup(t('Show'), [
        btn(ICONS.slideshow, window.slidomingoDesktop?.presentBegin ? t('Present') : t('Slideshow'), () => this.present(false, true),
          window.slidomingoDesktop?.presentBegin
            ? t('Start the slideshow fullscreen — with a second display, the notes open on this one. F toggles fullscreen, S opens speaker view, Esc ends')
            : t('Start the slideshow fullscreen — F toggles fullscreen, S opens speaker view, Esc ends')),
        btn(ICONS.window, t('Present in tab'), () => this.present(false, false),
          t('Fills this tab instead of going fullscreen — handy for testing or sharing a window')),
        ...(window.slidomingoDesktop?.presentBegin ? [] : [btn(ICONS.presenter, t('Speaker View'), () => this.openSpeakerView(),
          t('Notes, controls and slide thumbnails in a separate window — drag it to a second screen. On macOS, open it before going fullscreen.'))]),
      ])),
      ribbonGroup(t('Panels'), [
        iconsetToo(slidesOnly(this.slideListButton())),
        btn(ICONS.panelRight, t('Format'), () => this.togglePanel('right'), t('Format — show or hide the properties panel')),
        notesB2,
      ]),
      ribbonGroup(t('Guides & Checks'), [
        // margin guides are the Grid & Snap panel's "Margins" row (and View ▸ Margin guides)
        this.gridSplitButton(),
        slidesOnly(this.buildBadgeButton('ed-btn-armed')),
        notIconset(btn(ICONS.checkCircle, t('Check slides'), () => this.openDeckCheck(),
          t('Find problems before you present: text that is cut off or doesn’t fit its box, missing pictures or fonts, broken links, and animations that won’t play.'))),
      ]),
      ribbonGroup(t('Export'), [pdfB]),
    ])

    const ribbon = buildRibbon(wrap, {
      tabs: [
        { key: 'home', label: t('Home'), row: homeRow },
        { key: 'insert', label: t('Insert'), row: insertRow },
        ...(this.isCanvasDoc ? [] : [{ key: 'design', label: t('Design'), row: designRow }]),
        ...(this.isCanvasDoc ? [] : [{ key: 'transitions', label: t('Transitions'), row: transitionsRow }]),
        { key: 'view', label: t('View'), row: viewRow },
      ],
    })
    onCollapseToggle = () => {
      const next = !ribbon.isCollapsed()
      ribbon.setCollapsed(next)
      collapseB.title = next ? t('Expand the ribbon') : t('Collapse the ribbon')
      this.scheduleMenuSync()
    }
    this.ribbonToggle = () => onCollapseToggle()
    this.ribbonCollapsed = () => ribbon.isCollapsed()
    this.ribbonHandle = ribbon

    this.syncWindowTitle()

    return { bar: wrap, commentB, pdfB, formatPainterB, reapplyChangeB }
  }

  // --- resizable side panels ------------------------------------------------

  private static PANEL_BOUNDS = { left: [110, 400], right: [190, 520] } as const
  private static PANEL_DEFAULTS = { left: 188, right: 236 } as const
  private static NOTES_BOUNDS = [96, 440] as const
  private static NOTES_DEFAULT = 180

  private restorePanelWidths() {
    try {
      const saved = lsJson<Record<string, number>>('slidomingo-ed-panels', {})
      for (const side of ['left', 'right'] as const) {
        const [min, max] = Editor.PANEL_BOUNDS[side]
        if (typeof saved[side] === 'number') this.panelW[side] = Math.min(max, Math.max(min, saved[side]))
      }
    } catch { /* corrupt storage — keep defaults */ }
    this.applyPanelWidths()
  }

  private applyPanelWidths() {
    this.sidebar.style.setProperty('--panew', `${this.panelW.left}px`)
    this.props.style.setProperty('--panew', `${this.panelW.right}px`)
  }

  private panelToggles: { left?: HTMLElement; right?: HTMLElement } = {}

  private updatePanelChevrons() {
    const glyph = (side: 'left' | 'right') => {
      const collapsed = (side === 'left' ? this.sidebar : this.props).classList.contains('ed-collapsed')
      // chevron points where clicking will move the boundary. 'left'/'right'
      // name the DOM order, not the screen: under an RTL chrome the slide list
      // sits on the right, so the arrow that means "open me" turns around too.
      const g = side === 'left' ? (collapsed ? '›' : '‹') : (collapsed ? '‹' : '›')
      return isRtl() ? (g === '›' ? '‹' : '›') : g
    }
    for (const side of ['left', 'right'] as const) {
      const b = this.panelToggles[side]
      if (b) {
        b.textContent = glyph(side)
        const collapsed = (side === 'left' ? this.sidebar : this.props).classList.contains('ed-collapsed')
        const list = this.isIconset
          ? (collapsed ? t('Show icon list ([)') : t('Hide icon list ([)'))
          : (collapsed ? t('Show slide list ([)') : t('Hide slide list ([)'))
        b.title = side === 'left' ? list : collapsed ? t('Show properties (])') : t('Hide properties (])')
      }
    }
  }

  private makeResizer(side: 'left' | 'right'): HTMLElement {
    const handle = div('ed-resizer')
    handle.title = t('Drag to resize · double-click to reset')
    const toggle = document.createElement('button')
    toggle.className = 'ed-panel-toggle'
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.togglePanel(side)
    })
    this.panelToggles[side] = toggle
    handle.appendChild(toggle)
    queueMicrotask(() => this.updatePanelChevrons())
    const commit = () => {
      lsSet('slidomingo-ed-panels', JSON.stringify(this.panelW))
      // thumbnails render at a width derived from the sidebar — refit them
      if (side === 'left') this.rebuildSidebar()
    }
    handle.addEventListener('mousedown', (down) => {
      if (down.target === toggle) return // the chevron is a click, not a drag
      const panel = side === 'left' ? this.sidebar : this.props
      if (panel.classList.contains('ed-collapsed')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.panelW[side]
      const [min, max] = Editor.PANEL_BOUNDS[side]
      panel.classList.add('ed-noanim')
      document.body.classList.add('ed-col-resizing')
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        // clientX is physical; which way widens the panel depends on which
        // screen edge it is docked to, and RTL swaps the two panels over.
        const widens = (side === 'left') !== isRtl() ? dx : -dx
        this.panelW[side] = Math.min(max, Math.max(min, startW + widens))
        this.applyPanelWidths()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        panel.classList.remove('ed-noanim')
        document.body.classList.remove('ed-col-resizing')
        commit()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.panelW[side] = Editor.PANEL_DEFAULTS[side]
      this.applyPanelWidths()
      commit()
    })
    return handle
  }

  private makeNotesResizer(): HTMLElement {
    const handle = div('ed-notes-resizer')
    handle.title = t('Drag to resize · double-click to reset')
    handle.addEventListener('mousedown', (down) => {
      if (this.notesPane.el.classList.contains('ed-collapsed')) return
      down.preventDefault()
      const startY = down.clientY
      const startH = this.notesHeight
      const [min, max] = Editor.NOTES_BOUNDS
      this.notesPane.el.classList.add('ed-noanim')
      document.body.classList.add('ed-row-resizing')
      const move = (ev: MouseEvent) => {
        this.notesHeight = Math.min(max, Math.max(min, startH + (startY - ev.clientY)))
        this.notesPane.el.style.setProperty('--notesh', `${this.notesHeight}px`)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        this.notesPane.el.classList.remove('ed-noanim')
        document.body.classList.remove('ed-row-resizing')
        lsSet('slidomingo-ed-notes', JSON.stringify({ open: true, height: this.notesHeight }))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.notesHeight = Editor.NOTES_DEFAULT
      this.notesPane.el.style.setProperty('--notesh', `${this.notesHeight}px`)
      lsSet('slidomingo-ed-notes', JSON.stringify({ open: true, height: this.notesHeight }))
    })
    return handle
  }

  private restoreNotesPane() {
    const saved = lsJson<{ open: boolean; height: number }>('slidomingo-ed-notes', { open: true, height: Editor.NOTES_DEFAULT })
    const [min, max] = Editor.NOTES_BOUNDS
    this.notesHeight = Math.min(max, Math.max(min, saved.height ?? Editor.NOTES_DEFAULT))
    const startOpen = window.innerWidth < 700 ? false : saved.open
    if (!startOpen) this.notesPane.el.classList.add('ed-collapsed')
    this.notesPane.el.style.setProperty('--notesh', `${this.notesHeight}px`)
    this.notesToggleBtn?.classList.toggle('ed-btn-armed', startOpen)
  }

  /** Toggle the speaker-notes pane below the canvas. */
  /** Edit ▸ Find… / Find and replace…, ⌘F / ⌥⌘F. */
  openFind(withReplace: boolean, seed?: string) {
    if (this.layoutManagerOpen || this.presenting) return
    this.findBar.open(withReplace, seed)
  }

  /** Undo / redo from every entry point (keys, toolbar, the desktop's
   *  native Edit menu, which sends a menu command and no key event). While a
   *  picture is being cropped they only cancel the crop session: it is not a
   *  store step yet, so the store would undo the EARLIER edit instead. */
  undo() {
    if (this.canvas?.cancelCrop()) return
    if (this.canvas?.cancelMathEdit()) return // the popover is not a store step yet
    this.store.undo()
  }

  redo() {
    if (this.canvas?.cancelCrop()) return
    if (this.canvas?.cancelMathEdit()) return
    this.store.redo()
  }

  toggleNotes() {
    if (this.isCanvasDoc) return
    this.notesPane.el.classList.toggle('ed-collapsed')
    const open = !this.notesPane.el.classList.contains('ed-collapsed')
    this.notesToggleBtn?.classList.toggle('ed-btn-armed', open)
    lsSet('slidomingo-ed-notes', JSON.stringify({ open, height: this.notesHeight }))
    this.scheduleMenuSync()
  }

  /** Collapse/expand the slide list or the properties panel. */
  private phoneChrome: {
    insertD: HTMLElement; insertMenu: HTMLElement
    moreD: HTMLElement; moreMenu: HTMLElement
    slidesB: HTMLElement; formatB: HTMLElement
    insert: HTMLElement; actions: HTMLElement; history: HTMLElement
    demote: HTMLElement[]
    /** each group's children in authored desktop order — replayed on unfold */
    authored: Map<HTMLElement, HTMLElement[]>
    /** which group each button was authored into */
    homeOf: Map<HTMLElement, HTMLElement>
  } | null = null

  /**
   * Fold the topbar into menus, and unfold it again when there is room.
   * Driven by fitTopbar (every phone, plus any window where even the icon
   * tier overflows). REPARENTS the existing buttons rather than building
   * phone copies: a duplicate would need its own listeners and would desync
   * from live state (the dirty dot lives ON the save button; the comment
   * button carries an armed class). Moving a node keeps all of that by
   * construction.
   */
  private applyPhoneChrome(on: boolean) {
    const p = this.phoneChrome
    if (!p || this.phoneChromeOn === on) return
    // A FRESH bar is already in its authored desktop order, so there is nothing
    // to put back — and running the restore below anyway does not just waste
    // work, it REORDERS: every demoted button lands before formatB regardless
    // of where it started, so Comment and Export PDF jumped groups and Save
    // ended up after Help. Switching language then *fixed* it, because build()
    // re-authors the bar and this call early-returns second time around, which
    // is why the bug read as "the order changes when I switch language" when it
    // was the first load that was wrong.
    const fresh = this.phoneChromeOn === null
    this.phoneChromeOn = on
    if (on) {
      // the six insert tools + comment go under ＋
      while (p.insert.firstChild) p.insertMenu.appendChild(p.insert.firstChild)
      for (const b of p.demote) {
        if (!b.parentElement) continue
        // Undo/redo/PDF are icon-only BY DESIGN in the bar (no <span> at all),
        // so the menu's label rule has nothing to reveal and they would sit in
        // ⋯ as mystery glyphs. Borrow the tooltip, minus its shortcut: "Redo
        // (⇧⌘Z)" -> "Redo". No new strings, and desktop is untouched.
        // A demoted DROPDOWN is a wrapper, so label its TRIGGER and ask the
        // trigger alone whether it already has one. Asking the wrapper always
        // answers yes — it contains the menu it hides, and that menu is full of
        // spans. Language lost its label to exactly that: it sat in ⋯ as a bare
        // globe while everything around it was captioned.
        const face = b.classList.contains('ed-dropdown')
          ? (b.firstElementChild as HTMLElement | null)
          : b
        if (face && !face.querySelector('span') && face.title) {
          const lab = document.createElement('span')
          lab.dataset.phoneLabel = '1'
          // "Redo (⇧⌘Z)" -> "Redo"; "Not sharing yet — click…" -> "Not sharing yet"
          lab.textContent = face.title.split('(')[0].split('—')[0].trim()
          face.appendChild(lab)
        }
        p.moreMenu.appendChild(b)
      }
    } else if (!fresh) {
      while (p.insertMenu.firstChild) p.insert.appendChild(p.insertMenu.firstChild)
      for (const lab of p.moreMenu.querySelectorAll('[data-phone-label]')) lab.remove()
      // The save-as rows are a phone-only copy; on a wide screen the split
      // button's caret is back and owns that list again.
      for (const row of p.moreMenu.querySelectorAll('[data-phone-saveas]')) row.remove()
      // Back to their authored homes, in their authored order.
      //
      // Both halves matter. Sending each button to the group it was authored
      // into is what keeps Comment in the INSERT group instead of migrating it
      // to actions; replaying the captured order is what stops pdf/share/lang/
      // help from landing in a row and pushing Save past Help. Re-appending in
      // order is deliberately not "insert before the sibling I remember" —
      // that sibling may itself be demoted and not back yet.
      for (const b of p.demote) p.homeOf.get(b)?.appendChild(b)
      for (const [group, order] of p.authored) {
        for (const child of order) {
          if (child.parentElement === group) group.appendChild(child)
        }
      }
      p.moreD.classList.remove('open')
      p.insertD.classList.remove('open')
    }
  }

  private phoneChromeOn: boolean | null = null
  private topbar: HTMLElement | null = null
  private barRO: ResizeObserver | null = null
  private barMO: MutationObserver | null = null

  /**
   * Size the topbar by MEASURING it, not by width breakpoints. Breakpoints
   * in px were wrong here: browser zoom, OS text scaling, wider translations
   * and live content (avatars, the update chip) all change how much room the
   * same buttons need at the same viewport width, and each of those cases
   * used to clip the end of the bar. Instead, start from the widest layout
   * and step down a tier while the bar still overflows its own box. First
   * ed-bar-compact hides the button labels, then ed-bar-tight drops the
   * wordmark, then ed-bar-fold moves buttons into menus (applyPhoneChrome).
   */
  private fitTopbar() {
    const bar = this.topbar
    if (!bar || !bar.isConnected) return
    const tiers = ['ed-bar-compact', 'ed-bar-tight', 'ed-bar-fold']
    // Phones fold unconditionally. The 700px media query is also what turns
    // the panels into overlay drawers, and the folded bar belongs with it.
    if (window.innerWidth <= 700) {
      bar.classList.add(...tiers)
      this.applyPhoneChrome(true)
      this.barMO?.takeRecords()
      return
    }
    // Re-fitting starts by unfolding, which reparents buttons and would slam
    // shut a dropdown the user is reading. Skip while one is open; the next
    // resize or content change runs this again.
    if (bar.querySelector('.ed-dropdown.open')) return
    // scrollWidth counts content that sticks out of the padding box even with
    // overflow visible, so "scrollWidth > clientWidth" IS the clipped-buttons
    // condition (ed-root clips whatever leaks). The 1px slack absorbs
    // subpixel rounding at fractional zoom levels.
    const overflow = () => bar.scrollWidth - bar.clientWidth > 1
    // The title input is the bar's only shrinkable item, so flexbox crushes
    // it toward its 48px floor before anything overflows. Waiting for hard
    // overflow would mean full button labels beside an unusable title, so
    // step down while the title is squeezed badly, not only on true overflow.
    const title = bar.querySelector<HTMLElement>('.ed-title')
    const cramped = () => overflow() || (!!title && title.getBoundingClientRect().width < 120)
    bar.classList.remove(...tiers)
    this.applyPhoneChrome(false)
    if (cramped()) bar.classList.add('ed-bar-compact')
    if (cramped()) bar.classList.add('ed-bar-tight')
    if (overflow()) {
      bar.classList.add('ed-bar-fold')
      this.applyPhoneChrome(true)
    }
    // the class flips and reparenting above queued mutation records of their
    // own; drop them, or the observer re-runs this forever
    this.barMO?.takeRecords()
  }

  /** Expand the properties panel if it is collapsed, then open + scroll to
   *  one of its sections (English key) — the mini toolbar's ⋯ button. */
  /** Settings ▸ where the quick-format bar shows: a UI-profile write. */
  async setQuickBarPlace(place: QuickBarPlace) {
    const profiles = this.customizer?.profiles
    const p = profiles?.current().profile ?? emptyProfile()
    const next = { ...p, toolbar: { ...(p.toolbar ?? {}), quickbar: place } }
    const r = profiles ? await profiles.write(next, 'settings', t('Quick-format bar: {where}', { where: quickBarPlaceLabel(place) })) : null
    // no profile to write to (switched off by policy): the per-install preference
    if (!r?.ok) setLegacyQuickBarPlace(place)
  }

  revealPanelSection(key: string) {
    this.canvas.commitTextEdit()
    if (this.props.classList.contains('ed-collapsed')) this.togglePanel('right')
    this.panel.revealSection(key)
  }

  togglePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.sidebar : this.props
    el.classList.toggle('ed-collapsed')
    this.updatePanelChevrons()
    this.scheduleMenuSync()
    // the canvas wrap resizes; its ResizeObserver re-fits the stage
  }

  // --- Save dropdown: copy / new deck / template -----------------------------

  /** The titlebar Present caret: the Play menu's other present commands,
   *  run through the registry so they behave exactly like the menu. */
  private presentDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const menu = div('ed-menu ed-save-menu')
    const icons: Record<string, string> = { 'play.noSpeaker': ICONS.slideshow, 'play.inTab': ICONS.window, 'play.kiosk': ICONS.play }
    const trigger = btn('<span class="ed-caret">▾</span>', '', () => {
      wrap.classList.toggle('open')
      if (!wrap.classList.contains('open')) return
      menu.textContent = ''
      for (const id of Object.keys(icons)) {
        if (this.commands.state(id).visible === false) continue
        menu.appendChild(btn(icons[id], commandLabel(id), () => {
          wrap.classList.remove('open')
          this.commands.run(id)
        }))
      }
      flipMenuIfNeeded(wrap, menu)
    }, t('More ways to present'))
    trigger.classList.add('ed-split-caret')
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  private saveDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const menu = div('ed-menu ed-save-menu')
    const trigger = btn('<span class="ed-caret">▾</span>', '', () => {
      wrap.classList.toggle('open')
      if (wrap.classList.contains('open')) { rebuild(); flipMenuIfNeeded(wrap, menu) }
    }, t('Save as… — copy, new deck, password'))
    trigger.classList.add('ed-split-caret')
    const rebuild = () => {
      menu.textContent = ''
      this.buildSaveAsItems(menu, () => wrap.classList.remove('open'))
    }
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  /**
   * The Save-as list, built into `into`.
   *
   * Rebuilt on every open because it reflects live state: an encrypted file
   * offers Change/Remove password where a plain one offers Encrypt.
   *
   * It takes a container so ONE list can serve two homes — the desktop split
   * button's dropdown, and the ⋯ menu on a phone, where the caret that opens
   * this list does not fit beside a 44px Save button. `mark` tags what it
   * creates so the phone copy can be torn down again without disturbing the
   * real toolbar buttons parked in that same menu.
   */
  private buildSaveAsItems(into: HTMLElement, close: () => void, mark = false) {
    const tag = <T extends HTMLElement>(el: T): T => {
      if (mark) el.dataset.phoneSaveas = '1'
      return el
    }
    const item = (icon: string, label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      if (icon) b.innerHTML = icon
      b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
      b.title = title
      b.addEventListener('click', () => {
        close()
        onClick()
      })
      into.appendChild(tag(b))
    }
    {
      item(ICONS.copy, commandLabel('file.saveCopy'),
        t('A backup of this deck for yourself — same deck, same content.'),
        () => void this.save(true))
      if (this.templateMode) {
        item(ICONS.plus, commandLabel('file.newFromLayout'),
          t('Start a new deck from this layout, in a new window — this layout stays open.'),
          () => void this.newDeckFromTemplate())
      } else {
        item(ICONS.plus, commandLabel('file.duplicate'),
          t('A separate deck for you — same content, new identity.'),
          () => this.saveAsNewDeck())
      }
      // A template is the copy people hand around: never encrypted, never a
      // sealed player file (templateFileDoc is the only way it is written).
      if (this.templateMode) {
        // (no password, no present-only file)
      } else if (isEncryptionActive()) {
        item(ICONS.lock, commandLabel('file.pwChange'),
          t('Pick a new password for this file — takes effect on the next save.'),
          () => void this.setFilePassword())
        item(ICONS.lock, commandLabel('file.pwRemove'),
          t('Stop encrypting this file — the next save writes it as plain, readable JSON again.'),
          () => this.removeFilePassword())
      } else {
        item(ICONS.lock, commandLabel('file.pwSet'),
          t('Protect this file with a password: the document is encrypted at rest with AES-256. The password cannot be recovered.'),
          () => void this.setFilePassword())
      }
      if (!this.templateMode) {
        item(ICONS.exportPresent, commandLabel('file.presentOnly'),
          t('A sealed hand-out: it opens on a start card to present — no editor.'),
          () => void this.savePresentationPackage())
      }
      item(ICONS.template, this.templateMode ? commandLabel('file.copyLayout') : commandLabel('file.saveLayout'),
        this.templateMode
          ? t('A new, separate layout starting from this one — this one stays as it is.')
          : t('A reusable starter: everyone who opens it gets their own fresh, independent deck.'),
        () => void this.saveAsTemplate())
      // the document AS DATA — history and the AI/JSON round-trip live with
      // the other file operations now (they were buried in the About dialog).
      // With the ribbon chrome they are in the File menu only (native on
      // desktop, in-page in a browser) and this list keeps the save
      // variants; the phone ⋯ keeps them here.
      if (this.ribbonChrome) return
      into.appendChild(tag(div('ed-menu-sep')))
      item(ICONS.history, t('Version history…'),
        t('Restore an earlier auto-saved version of this deck (kept locally in this browser).'),
        () => void this.openVersionHistory())
      item(ICONS.code, t('Copy document JSON'),
        t('Copies this deck as plain JSON. Edit it in another tool, then bring it back with Replace from JSON.'),
        () => void this.copyDocJson())
      item(ICONS.code, t('Copy document JSON without pictures'),
        t('Copies only the deck’s structure: pictures, fonts and media become short references. Replace from JSON in this deck puts them back.'),
        () => void this.copyDocJson(true))
      item(ICONS.code, t('Replace from JSON…'),
        t('Paste edited document JSON to replace this deck’s content — ⌘Z undoes.'),
        () => this.openReplaceJson())
      item(ICONS.upload, t('Import PowerPoint…'),
        t('Import a .pptx file — slides keep their resolved content, and its masters and layouts come in as slide types for the Layout Manager.'),
        () => this.importPowerPoint())
      item(ICONS.upload, t('Import Quarto / Markdown…'),
        t('Import a .qmd or .md deck — headings become slides, code and math come in as real elements, and every slide is linked to an editable slide type.'),
        () => this.importMarkdown())
      item(ICONS.template, t('Start from scratch…'),
        t('Replace every slide with one blank slide. Keeps the deck’s theme and name — ⌘Z undoes.'),
        () => this.startFromScratch())
    }
  }

  /**
   * Put the save-as list at the bottom of ⋯ on a phone.
   *
   * The split button's caret is hidden there — it does not fit beside a 44px
   * Save target — which left Save a copy, Duplicate as new deck, every password
   * action, Version history and the whole JSON round-trip with NO route on a
   * phone at all. They are file operations, so ⋯ ("everything occasional") is
   * where they belong rather than a second nested dropdown, which on glass is
   * a worse answer than a long list.
   *
   * Rebuilt on each open (the list is state-dependent) and torn down BY TAG:
   * the buttons sharing this menu are the real toolbar nodes on loan from the
   * bar, and clearing the container would destroy them.
   */
  private fillPhoneSaveAs(menu: HTMLElement, wrap: HTMLElement) {
    for (const stale of Array.from(menu.querySelectorAll('[data-phone-saveas]'))) stale.remove()
    if (!this.phoneChromeOn) return
    // `el.dataset.x = …`, never Object.assign(el, {dataset}) — dataset is a
    // getter-only accessor, so assigning it wholesale THROWS. It type-checks
    // either way, and the throw here landed before the menu's own toggle, so
    // the symptom was ⋯ refusing to open at all rather than anything about
    // save-as.
    const sep = div('ed-menu-sep')
    sep.dataset.phoneSaveas = '1'
    menu.appendChild(sep)
    this.buildSaveAsItems(menu, () => wrap.classList.remove('open'), true)
  }

  private pptxInput: HTMLInputElement | null = null

  /**
   * File → Import PowerPoint…. kernel/src/convert/pptx.ts resolves the full
   * slide → layout → master → theme chain to bake correct per-shape values
   * into every slide, AND extracts the masters and layouts actually used into
   * doc.layouts as a tree (each master a root slide type, its layouts
   * children via parentId). Only slides that do not deviate from their layout
   * are linked to it (layoutId set), because the Slide-Master resync would
   * silently revert a deviating slide the first time someone edits the
   * master. Those stay flattened, and the import report lists them
   * ('slide-unlinked'). A plain <input type=file> works fine inside
   * Electron's renderer too, so no native-dialog IPC is needed.
   */
  importPowerPoint() {
    if (!this.pptxInput) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.pptx,.potx'
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        input.value = '' // so picking the same file twice still fires 'change'
        if (file) void this.applyPptxImport(file)
      })
      document.body.appendChild(input)
      this.pptxInput = input
    }
    this.pptxInput.click()
  }

  private async applyPptxImport(file: File) {
    this.toast(t('Importing {name}…', { name: file.name }))
    let result: Awaited<ReturnType<typeof convertPptx>>
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      result = await convertPptx(bytes)
    } catch (err) {
      this.toast(t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
      return
    }
    if (result.doc.slides.length === 0) {
      this.toast(t('{name} has no slides to import', { name: file.name }))
      return
    }
    const next = {
      ...result.doc,
      version: FORMAT_VERSION, // the converter's OutDoc carries '1.0.0' (a string) — normalize to the format's numeric version
      docId: newDocId(),
    } as unknown as import('../model').SlidomingoDoc
    const ctx: ImportContext = { name: file.name, report: result.report, kind: 'pptx', sourcePath: pickedPath(file) }
    if (await this.openImportedAsDraft(next, ctx)) return
    if (refuseGatedWrite((m) => this.toast(m))) return
    this.canvas.commitTextEdit()
    this.store.replaceDoc(next)
    this.toast(t('Imported {name} — ⌘Z undoes', { name: file.name }))
    void this.afterPptxImport(ctx)
  }

  /**
   * Static first, then AI (editor/importfix.ts): fit the imported text the
   * way PowerPoint would, then show the report — with "Fix with Claude" for
   * what is left that needs judgement, when this window has Claude.
   */
  private async afterPptxImport(ctx: ImportContext, opts: { reuse?: boolean; design?: ImportDesign } = {}) {
    // 1. the user's own layout, when it is the same design (DECISIONS
    //    2026-10-13): one undo step, undone by "Keep the file's own design"
    let design = opts.design ?? null
    if (!design && opts.reuse !== false && !this.store.readOnly) {
      try {
        const reuse = await reuseLayout(this.store)
        if (reuse) design = { line: reuseSummary(reuse, this.store.doc.slides.length), fileDesign: reuse.fileDesign, floating: [] }
      } catch (err) { console.warn('[import] layout match failed', err) }
    }
    // 2. text fit
    let settle: SettleResult = { grown: 0, shrunk: 0, leftovers: [] }
    try {
      if (!this.store.readOnly) settle = await settleImport(this.store)
    } catch (err) {
      console.warn('[import] text re-measure failed', err)
    }
    // 3. the report: undo the design choice, or pick another layout; Claude
    //    for what needs judgement
    const floating = design?.floating ?? []
    const extras: Array<{ label: string; run: () => void; primary?: boolean }> = []
    if (design) {
      const fileDesign = design.fileDesign
      extras.push({
        label: t('Keep the file’s own design'),
        run: () => {
          document.querySelector('.ed-about-overlay')?.remove()
          this.canvas.commitTextEdit()
          this.store.replaceDoc(structuredClone(fileDesign))
          void this.afterPptxImport(ctx, { reuse: false })
        },
      })
    } else if (!this.store.readOnly) {
      const layouts = await listLayouts()
      if (layouts.length) {
        extras.push({
          label: t('Use a different layout…'),
          run: () => this.pickImportLayout(ctx, layouts),
        })
      }
    }
    const items = canFixWithClaude() ? repairCount(this.store, ctx, settle.leftovers, floating) : 0
    if (items) {
      extras.push({
        label: t('✦ Fix {n} with Claude', { n: String(items) }),
        primary: true,
        run: () => {
          document.querySelector('.ed-about-overlay')?.remove()
          void fixWithClaude(this.store, ctx, settle.leftovers, (m) => this.toast(m), floating)
        },
      })
    }
    this.showImportReport(ctx.name, ctx.report, extras, settle, design?.line)
  }

  /** "Use a different layout…" on the import report: the user's layouts as
   *  a list; a pick restyles the deck onto it (one undo step) and shows the
   *  report again, with the way back. */
  private pickImportLayout(ctx: ImportContext, layouts: Array<{ path: string; name: string }>) {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')
    const h = div('ed-about-h')
    h.textContent = t('Use a different layout')
    const hint = div('ed-about-status')
    hint.textContent = t('Each slide keeps its content and moves onto the best-fitting slide type of the layout. ⌘Z undoes it.')
    const list = div('ed-about-row ed-import-layouts')
    for (const meta of layouts) {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      b.textContent = meta.name
      b.addEventListener('click', () => {
        overlay.remove()
        void (async () => {
          this.canvas.commitTextEdit()
          const r = await restyleOntoLayout(this.store, meta, ctx.report)
          if ('error' in r) { this.toast(r.error); return }
          void this.afterPptxImport(ctx, { design: { line: restyleSummary(r), fileDesign: r.fileDesign, floating: r.floating } })
        })()
      })
      list.appendChild(b)
    }
    const row = div('ed-about-row')
    const cancel = document.createElement('button')
    cancel.className = 'ed-btn'
    cancel.textContent = t('Cancel')
    cancel.addEventListener('click', () => overlay.remove())
    row.appendChild(cancel)
    box.append(h, hint, list, row)
    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  }

  private mdInput: HTMLInputElement | null = null

  /**
   * File → Import Quarto / Markdown….
   *
   * kernel/src/convert/qmd.ts turns a `.qmd`/`.md` into an ORDINARY deck:
   * headings become slides, fences become `code` elements, `$…$` is left
   * verbatim (render.ts already renders it), pipe tables become real tables,
   * and every slide is LINKED to a materialized slide type (the .pptx path
   * links only the slides that don't deviate from theirs), so
   * re-apply/re-theme/re-layout all work afterwards.
   *
   * MULTI-SELECT IS THE POINT. Quarto's engine runs before Pandoc for every
   * output format, so `quarto render --to markdown` writes executed markdown
   * plus a sibling `_files/` folder of figures. Pick the source AND its
   * figures together (the converter resolves a `figs/plot.png` reference
   * against a picked `plot.png` by basename, so they need not have kept their
   * folder), and computation arrives for free with nothing to run in the
   * document. Figures still missing get an "Add figure folder…" button on the
   * report, since a macOS file dialog cannot reach into a subfolder in one go.
   */
  importMarkdown() {
    if (!this.mdInput) {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.qmd,.md,.markdown,.rmd,image/*'
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
        input.value = '' // so picking the same file twice still fires 'change'
        if (files.length) void this.applyMarkdownImport(files)
      })
      document.body.appendChild(input)
      this.mdInput = input
    }
    this.mdInput.click()
  }

  private async applyMarkdownImport(files: File[]) {
    const SOURCE = /\.(qmd|md|markdown|rmd)$/i
    // The source is the markdown file; everything else picked alongside it is
    // an asset. A pick with no markdown at all is the "wrong files" case.
    const src = files.find((f) => SOURCE.test(f.name)) ?? (files.length === 1 ? files[0] : undefined)
    if (!src) {
      this.toast(t('Pick a .qmd or .md file (its figures can come along too)'))
      return
    }
    this.toast(t('Importing {name}…', { name: src.name }))
    let text: string
    const assets: Record<string, Uint8Array> = {}
    try {
      text = await src.text()
      for (const f of files) {
        if (f === src) continue
        // webkitRelativePath is set by a directory pick and empty for a plain
        // multi-select — either key resolves, since the converter falls back
        // to matching on basename.
        const key = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        assets[key] = new Uint8Array(await f.arrayBuffer())
      }
    } catch (err) {
      this.toast(t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
      return
    }
    void this.finishMarkdownImport(src.name, text, assets)
  }

  /** Convert + install, factored out so "Add figure folder…" can re-run it
   *  against the same source with more assets in hand. */
  private async finishMarkdownImport(name: string, text: string, assets: Record<string, Uint8Array>, refine = false) {
    let result: ReturnType<typeof convertMarkdown>
    try {
      result = convertMarkdown(text, { assets, name })
    } catch (err) {
      this.toast(t('Import failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
      return
    }
    const next = {
      ...result.doc,
      version: FORMAT_VERSION, // the converter's OutDoc carries '1.0.0' (a string) — normalize to the format's numeric version
      docId: newDocId(),
    } as unknown as import('../model').SlidomingoDoc
    // a re-run with more figures refines the import already in this window
    if (!refine && await this.openImportedAsDraft(next, { name, report: result.report })) return
    if (refuseGatedWrite((m) => this.toast(m))) return
    this.canvas.commitTextEdit()
    this.store.replaceDoc(next)
    this.toast(t('Imported {name} — ⌘Z undoes', { name }))
    const missing = result.report.entries.some((e) => e.code === 'image-unresolved')
    this.showImportReport(name, result.report, missing && pickFolderSupported()
      ? {
          label: t('Add figure folder…'),
          run: () => void this.addFigureFolder(name, text, assets),
        }
      : undefined)
  }

  /** Second pass: merge a folder of figures in and re-import the same source. */
  private async addFigureFolder(name: string, text: string, assets: Record<string, Uint8Array>) {
    const merged = { ...assets }
    try {
      const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
      if (typeof picker === 'function') {
        await collectDir(await picker(), '', merged)
      } else {
        const picked = await pickDirectoryViaInput()
        for (const f of picked) {
          const key = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
          merged[key] = new Uint8Array(await f.arrayBuffer())
        }
      }
    } catch {
      return // cancelled
    }
    document.querySelector('.ed-about-overlay')?.remove()
    void this.finishMarkdownImport(name, text, merged, true)
  }

  /** Fidelity report dialog: what converted cleanly, what didn't — the
   *  converter's own honesty mechanism (kernel/src/convert/report.ts), never
   *  silently dropped. `extra` is one optional repair action (the markdown
   *  importer's "Add figure folder…"), beside Close. */
  private showImportReport(name: string, report: FidelityReport, extra?: { label: string; run: () => void; primary?: boolean } | Array<{ label: string; run: () => void; primary?: boolean }>, settle?: SettleResult, designLine?: string) {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')
    const h = document.createElement('div')
    h.className = 'ed-about-h'
    h.textContent = t('Import report — {name}', { name })
    const summary = document.createElement('div')
    summary.className = 'ed-about-status'
    summary.textContent = t('{carried} carried, {approx} approximated, {dropped} dropped', {
      carried: String(report.counts.carried),
      approx: String(report.counts.approximated),
      dropped: String(report.counts.dropped),
    })
    const lines = [...report.entries.map((e) => {
      const mark = e.verdict === 'dropped' ? '✗' : e.verdict === 'approximated' ? '≈' : '✓'
      const count = e.count > 1 ? ` (×${e.count})` : ''
      return `• ${mark} ${e.where}: ${e.detail}${count}`
    }), ...(settle ? leftoverLines(settle.leftovers) : [])].join('\n')
    const notes = reportList(lines || t('Every element converted cleanly.'))
    const fitted = settle ? settleSummary(settle) : ''
    if (fitted) summary.textContent += ` · ${fitted}`
    const design = designLine ? div('ed-about-status') : null
    if (design) design.textContent = designLine!
    const closeB = document.createElement('button')
    closeB.className = 'ed-btn ed-btn-primary'
    closeB.textContent = t('Close')
    closeB.addEventListener('click', () => overlay.remove())
    const row = div('ed-about-row')
    for (const x of Array.isArray(extra) ? extra : extra ? [extra] : []) {
      const b = document.createElement('button')
      b.className = x.primary ? 'ed-btn ed-btn-primary' : 'ed-btn'
      if (x.primary) closeB.className = 'ed-btn'
      b.textContent = x.label
      b.addEventListener('click', () => x.run())
      row.appendChild(b)
    }
    row.appendChild(closeB)
    box.append(h, summary, ...(design ? [design] : []), notes, row)
    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  }

  /**
   * Clear the deck back to a single blank slide (issue #31). Starting a fresh
   * presentation meant deleting every slide by hand, then stripping the one
   * the deck refuses to delete.
   *
   * CONTENT ONLY: docId, theme, size, layouts and the live session all stay.
   * "Duplicate as new deck…" (above) is the action that changes IDENTITY, and
   * conflating the two here would be the surprising choice — under collab this
   * lands as an ordinary edit everyone sees, which is what "let's start over
   * on this deck" means. One commit, so ⌘Z brings the whole deck back.
   */
  startFromScratch() {
    const n = this.store.doc.slides.length
    if (!window.confirm(t('Replace all {n} slides with one blank slide? ⌘Z undoes this.', { n: String(n) }))) return
    this.canvas.commitTextEdit() // a live text edit would commit ONTO the new slide
    this.store.commit(() => {
      this.store.doc.slides = [starterSlide(this.store.doc)]
    }, 'slides')
  }

  /** A sealed hand-out (File ▸ Export): present-only player file, no editor.
   *  On desktop it is spliced into the small viewer-only shell (dist-viewer);
   *  elsewhere into this page's own shell with `readonly` set, which boots
   *  into the same start card (player.ts). */
  async savePresentationPackage() {
    if (refuseGatedWrite((m) => this.toast(m))) return
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').SlidomingoDoc
    clone.readonly = true
    const saved = t('Presentation file saved — it opens on a start card to present')
    try {
      const viewerHtml = await window.slidomingoDesktop?.getViewerShell?.()
      const viewerShell = viewerHtml ? new DOMParser().parseFromString(viewerHtml, 'text/html') : null
      const html = viewerShell?.querySelector(DOC_BLOCK_SELECTOR)
        ? await serializeDocInto(viewerShell, clone)
        : await serializeAuto(clone)
      if (window.slidomingoDesktop?.saveDocumentAs) {
        // Desktop writes through main's native dialog (like Save a copy…); the
        // browser file picker the web path uses does not exist in Electron.
        this.canvas.commitTextEdit()
        const res = await saveDesktopAs(html, suggestedFileName(clone, 'presentonly'), 'copy')
        if ('cancelled' in res) return
        if ('error' in res) { this.toast(this.saveErrorText(res.error)); return }
        this.toast(saved)
        return
      }
      const ok = await writeUpdatedFileAs(html, clone, { suffix: 'presentonly' })
      if (ok) this.toast(saved)
    } catch (err) {
      this.toast(t('Couldn’t save: {reason}', { reason: err instanceof Error ? err.message : String(err) }))
    }
  }

  /**
   * The document as loose data (the AI/tooling round-trip). It leaves as
   * plain content: this text is pasted into chats, tickets and scratch files.
   */
  async copyDocJson(light = false) {
    // readable (canonicalJson, like the file's own block). LIGHT = every
    // embedded picture/font/clip as a short content-hash ref: the structure
    // alone, small enough for any chat; Replace from JSON in a deck holding
    // the same bytes puts them back (model.resolveStoreRefs).
    const doc = this.store.doc
    try {
      await navigator.clipboard.writeText(canonicalJson(light ? lightDoc(doc) : doc))
      this.toast(light ? t('Document JSON copied (without pictures)') : t('Document JSON copied'))
    } catch {
      this.toast(t('Couldn’t access the clipboard'))
    }
  }

  /** Paste-and-apply document JSON (the counterpart of Copy document JSON). */
  openReplaceJson() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')
    const h = document.createElement('div')
    h.className = 'ed-about-h'
    h.textContent = t('Replace from JSON')
    const ta = document.createElement('textarea')
    ta.className = 'ed-about-json'
    ta.rows = 8
    ta.placeholder = t('Paste document JSON here…')
    const row = div('ed-about-row')
    const applyB = document.createElement('button')
    applyB.className = 'ed-btn ed-btn-primary'
    applyB.textContent = t('Apply')
    applyB.addEventListener('click', () => {
      const parsed = parseDoc(ta.value)
      if (parsed && refuseNewerDoc(parsed, null, (m) => this.toast(m))) return
      if (parsed) {
        // refs from a light copy: the bytes come back from this deck
        const { doc: next, missing } = resolveStoreRefs(parsed, this.store.doc)
        this.checkpointBeforeReplace()
        this.store.replaceDoc(next)
        this.toast(missing.length
          ? t('Document replaced — {n} picture(s) or file(s) aren’t in this deck and were kept as references', { n: String(missing.length) })
          : t('Document replaced — ⌘Z undoes'))
        overlay.remove()
      } else {
        ta.style.borderColor = '#C0392B'
        applyB.textContent = t('Invalid document JSON')
        setTimeout(() => { applyB.textContent = t('Apply') }, 1800)
      }
    })
    const cancelB = document.createElement('button')
    cancelB.className = 'ed-btn'
    cancelB.textContent = t('Cancel')
    cancelB.addEventListener('click', () => overlay.remove())
    row.append(applyB, cancelB)
    box.append(h, ta, row)
    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
    ta.focus()
  }

  /** Set or change the encryption password (double-entry dialog). */
  private async setFilePassword() {
    if (this.templateMode) { this.toast(t('A layout can’t have a password — every deck made from it would need it.')); return }
    const pass = await this.promptPassword()
    if (pass === null) return
    setEncryptionPassword(pass)
    this.scheduleMenuSync()
    // Purge any plaintext snapshots already written to IndexedDB before encryption
    // was enabled — otherwise up to MAX_VERSIONS version snapshots + a recovery copy
    // (full plaintext JSON, incl. collab keys) would linger ~30 days, defeating the
    // encryption the user just turned on.
    const docId = this.store.doc.docId
    await clearRecovery(docId)
    await clearVersions(docId)
    await clearActionLog(docId)
    this.toast(t('Encrypted — remember this password; it cannot be recovered'))
    void this.save(true)
  }

  private promptPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog')
      dlg.className = 'ed-dialog ed-pwdialog'
      dlg.innerHTML =
        `<h2>${t('Encrypt with password…').replace(/…$/, '')}</h2>` +
        `<p>${t('The password cannot be recovered — if it is lost, the file is lost.')}</p>` +
        `<label>${t('Password')}<input type="password" class="pw1" autocomplete="new-password"></label>` +
        `<label>${t('Confirm password')}<input type="password" class="pw2" autocomplete="new-password"></label>` +
        `<div class="ed-pwerr"></div>` +
        `<div class="ed-dialog-actions"><button class="cancel">${t('Cancel')}</button>` +
        `<button class="ok ed-primary">${t('Set password')}</button></div>`
      document.body.appendChild(dlg)
      const pw1 = dlg.querySelector<HTMLInputElement>('.pw1')!
      const pw2 = dlg.querySelector<HTMLInputElement>('.pw2')!
      const err = dlg.querySelector<HTMLElement>('.ed-pwerr')!
      const done = (v: string | null) => {
        dlg.close()
        dlg.remove()
        resolve(v)
      }
      dlg.querySelector('.cancel')!.addEventListener('click', () => done(null))
      dlg.querySelector('.ok')!.addEventListener('click', () => {
        if (!pw1.value) {
          err.textContent = t('Password')
          return
        }
        if (pw1.value !== pw2.value) {
          err.textContent = t('Passwords do not match')
          return
        }
        done(pw1.value)
      })
      dlg.addEventListener('cancel', () => done(null))
      dlg.showModal()
      pw1.focus()
    })
  }

  async saveAsNewDeck() {
    if (refuseGatedWrite((m) => this.toast(m))) return
    if (this.templateMode) { await this.newDeckFromTemplate(); return }
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').SlidomingoDoc
    clone.docId = newDocId()
    if (desktopBound()) {
      // Never swap identities under a bound file (autosave would write the
      // new deck into THIS file): write the clone elsewhere, then open it in
      // this window's place (main flushes this deck first; the new one says
      // "Opened …").
      this.canvas.commitTextEdit()
      const res = await saveDesktopAs(await serializeAuto(clone), suggestedFileName(clone), 'copy')
      if ('cancelled' in res) return
      if ('error' in res) { this.toast(this.saveErrorText(res.error)); return }
      void window.slidomingoDesktop?.openDocument?.(res.path)
      return
    }
    this.store.replaceDoc(clone)
    this.toast(t('This is now a new deck — save it under a new name'))
    void this.save(true)
  }

  /**
   * Save as template — a template is the deck's DESIGN (slide types, theme,
   * fonts, reusable objects and the assets they use), optionally with the
   * current slides as samples (docs/DECISIONS.md 2026-09-24). Asks for a
   * name and which of the two. Refused for a password-protected deck: a
   * template is the copy people hand around, and writing it encrypted would
   * make it unlistable while writing it plain would leak the deck.
   */
  async saveAsTemplate() {
    if (refuseGatedWrite((m) => this.toast(m))) return
    if (isEncryptionActive()) {
      this.toast(t('A password-protected deck can’t be saved as a layout — remove the password first (Save ▸ Remove password)'))
      return
    }
    this.canvas.commitTextEdit()
    const n = this.store.doc.slides.length
    const choice = await promptTemplateOptions({
      heading: this.templateMode ? t('Copy as new layout') : t('Save as layout'),
      intro: t('A layout holds this deck’s slide types, theme and the pictures and fonts they use. Every deck started from it is independent.'),
      name: this.templateMode ? '' : this.templateNameSuggestion(),
      okLabel: t('Save layout'),
      slideCount: n,
    })
    if (!choice) return
    // A template window's doc carries ITS template's id: a copy is a new,
    // separate template, never a second file with the same identity.
    const clone = stampAsTemplate(this.store.doc, { samples: choice.samples })
    if (this.templateMode) clone.templateId = newDocId()
    clone.title = choice.name
    if (isDesktopShell() && window.slidomingoDesktop?.saveTemplate) {
      // Desktop has a real templates folder (see templates.ts) — land there
      // directly, no OS save dialog, so the file shows up on the start page
      // immediately.
      try {
        const path = await window.slidomingoDesktop.saveTemplate(serializeFile(clone), choice.name)
        if (!path) { this.toast(t('Save failed — see console')); return }
        const name = fileBase(path.split(/[\\/]/).pop() ?? path)
        // this deck now "comes from" the new template: the Layout Manager's
        // "Update …" targets it from here on (a template has no basedOn)
        if (!this.templateMode) {
          this.store.doc.basedOn = { templateId: clone.templateId, name }
          this.store.touch()
        }
        const message = t('Saved as layout “{name}” — every open of it starts a fresh deck', { name })
        if (window.slidomingoDesktop.editTemplate) {
          actionToast(message, t('Edit it'), () => void window.slidomingoDesktop?.editTemplate?.(path))
        } else {
          this.toast(message)
        }
      } catch (err) {
        console.error(err)
        this.toast(t('Save failed — see console'))
      }
      return
    }
    try {
      const ok = await writeUpdatedFileAs(serializeFile(clone), clone, { suffix: 'template' })
      if (ok) this.toast(t('Layout saved — every open of it starts a fresh deck'))
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  /** Save as template's suggested name: the template this deck came from,
   *  else its title (unless that is still "Untitled"). */
  private templateNameSuggestion(): string {
    const title = this.store.doc.title
    return this.store.doc.basedOn?.name ?? (title && title !== 'Untitled' ? title : '')
  }

  /** A template window's name: its file's name (the start page shows the
   *  same), else the doc title. */
  templateName(): string {
    const file = desktopFileName()
    return file ? fileBase(file) : this.store.doc.title
  }

  /** Template window ▸ "New deck from this template": a fresh deck (no
   *  samples, the default slide type — the start page's one-click default)
   *  as a new draft in a NEW window; this template stays open. */
  async newDeckFromTemplate() {
    this.canvas.commitTextEdit()
    const deck = instantiateTemplate(JSON.stringify(templateFileDoc(this.store.doc, this.templateId)), { includeSamples: false, name: this.templateName() })
    if (!deck || !window.slidomingoDesktop?.openAsDraft) { this.toast(t('Couldn’t start a deck from this layout')); return }
    await window.slidomingoDesktop.openAsDraft(JSON.stringify(deck), { newWindow: true })
  }

  /** Template window ▸ Rename…: renames the template FILE (main re-points
   *  this window's binding, desktop templates.ts renameTemplate), after any
   *  pending write has landed under the old name. */
  async renameTemplateFile() {
    const api = window.slidomingoDesktop
    const path = desktopFilePath()
    if (!api?.renameTemplate || !path) return
    const current = this.templateName()
    const next = prompt(t('New name for the layout'), current)?.trim()
    if (!next || next === current) return
    clearTimeout(this.autosaveTimer)
    await this.desktopWriteNow()
    await desktopWritesSettled()
    const moved = await api.renameTemplate(path, next).catch(() => null)
    if (!moved) { this.toast(t('Couldn’t rename — a layout with that name may already exist.')); return }
    this.toast(t('Renamed to “{name}”', { name: fileBase(moved.split(/[\\/]/).pop() ?? moved) }))
  }

  /**
   * View menu — Slide Sorter (`openSlideSorter()`). Outline View
   * (`openOutlineView()`) is still implemented but has no entry point: its
   * ribbon button, View-menu item, command and ⌘2 are removed for now.
   *
   * Also carries the "Margin guides" checkbox-style toggle for the
   * persistent canvas margin overlay, and "Check slides" — validateDoc()'s
   * findings surfaced in the UI (see openDeckCheck).
   */
  private viewDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    // viewDropdown() is built during buildWebTopbar()/buildDesktopChrome(),
    // BEFORE `this.canvas` is constructed (build() wires the canvas after the
    // chrome) — so the safe-zone checkmark can only be synced once the
    // trigger is actually clicked, never at build time.
    const menu = div('ed-menu')
    const trigger = btn(ICONS.grid, '', () => {
      safeZoneB.classList.toggle('ed-menu-on', this.canvas.showSafeZone)
      this.syncBuildBadgeButtons()
      this.syncGridControls()
      wrap.classList.toggle('open')
      if (wrap.classList.contains('open')) flipMenuIfNeeded(wrap, menu)
    }, t('View'))
    const safeZoneB = this.safeZoneButton(btn(ICONS.ruler, t('Margin guides'), () => this.toggleSafeZone(), t('Show the deck’s side margins. Keep text between the dashed lines so it lines up with your other slides. “Check slides” points out text that crosses them.')), 'ed-menu-on')
    const sorterB = this.sorterButton(() => { wrap.classList.remove('open'); this.openSlideSorter() })
    menu.append(
      sorterB,
      div('ed-menu-sep'),
      safeZoneB,
      this.buildBadgeButton('ed-menu-on'),
      this.gridButton('ed-menu-on'),
      btn(ICONS.magnet, t('Grid & Snap…'), () => { wrap.classList.remove('open'); this.openGridSnap(trigger) },
        t('Grid spacing, column grid, guides — and what things snap to')),
      notIconset(btn(ICONS.checkCircle, t('Check slides'), () => { wrap.classList.remove('open'); this.openDeckCheck() },
        t('Find problems before you present: text that is cut off or doesn’t fit its box, missing pictures or fonts, broken links, and animations that won’t play.'))),
    )
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  /**
   * "Check slides" — runs validateDoc() (src/validate.ts) against the open
   * document and shows what a person can act on, in plain words, grouped by
   * slide. Deliberately modest (a manual, on-demand scan rather than a
   * persistent linter panel — see docs/PARALLEL-WORK.md task scope).
   *
   * validate.ts is the AGENT API and keeps its developer wording; the user
   * layer lives in checkmessages.ts. Findings a person cannot fix from the
   * canvas (stray JSON keys, duplicate ids, …) sit behind a collapsed
   * "technical details" disclosure instead of the main list.
   */
  private openDeckCheck() {
    this.canvas.commitTextEdit()
    const result = validateDoc(this.store.doc)
    const items = result.findings.map((f) => ({ f, fr: friendlyFinding(f) }))
    const main = items.filter((i) => i.fr.group !== 'technical')
    const tech = items.filter((i) => i.fr.group === 'technical')
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-check-box')
    const h = document.createElement('h2')
    h.textContent = t('Check slides')
    box.appendChild(h)

    const summary = div('ed-check-summary')
    if (!main.length) {
      summary.textContent = t('Everything looks good.')
    } else {
      const count = (g: CheckGroup) => main.filter((i) => i.fr.group === g).length
      const parts: string[] = []
      if (count('problem')) parts.push(t('Problems: {n}', { n: String(count('problem')) }))
      if (count('warning')) parts.push(t('Warnings: {n}', { n: String(count('warning')) }))
      if (count('tip')) parts.push(t('Tips: {n}', { n: String(count('tip')) }))
      summary.textContent = parts.join(' · ')
    }
    box.appendChild(summary)
    if (!result.measured) {
      const note = div('ed-check-note')
      note.textContent = t('Text-overflow checks were skipped (no live canvas available to measure against).')
      box.appendChild(note)
    }

    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)

    if (main.length) {
      // Deck order, one heading per slide; deck-level findings come first.
      const slideIdx = (f: Finding) => (f.slide ? this.store.doc.slides.findIndex((s) => s.id === f.slide) : -1)
      const rank: Record<CheckGroup, number> = { problem: 0, warning: 1, tip: 2, technical: 3 }
      const bySlide = new Map<number, typeof main>()
      for (const i of main) {
        const k = slideIdx(i.f)
        if (!bySlide.has(k)) bySlide.set(k, [])
        bySlide.get(k)!.push(i)
      }
      const list = div('ed-check-list')
      for (const k of [...bySlide.keys()].sort((a, b) => a - b)) {
        const head = div('ed-check-slide')
        head.textContent = k >= 0 ? t('Slide {n}', { n: String(this.linearNumber(k)) }) : t('Whole presentation')
        list.appendChild(head)
        for (const i of bySlide.get(k)!.sort((a, b) => rank[a.fr.group] - rank[b.fr.group])) {
          list.appendChild(this.renderCheckRow(i.f, i.fr, close))
        }
      }
      box.appendChild(list)
    }

    if (tech.length) {
      const det = document.createElement('details')
      det.className = 'ed-check-tech'
      const sum = document.createElement('summary')
      sum.textContent = t('Show technical details ({n})', { n: String(tech.length) })
      det.appendChild(sum)
      const intro = div('ed-check-note')
      intro.textContent = t('These matter mostly if you edit the document’s JSON or work with an AI agent.')
      det.appendChild(intro)
      const list = div('ed-check-list')
      for (const i of tech) list.appendChild(this.renderCheckRow(i.f, i.fr, close))
      det.appendChild(list)
      box.appendChild(det)
    }

    document.body.appendChild(overlay)
  }

  /** One finding row for openDeckCheck(); clicking a slide-scoped finding
   *  jumps there (and selects the element, when it has one) and closes the
   *  dialog. Technical rows keep the validator's own message and the raw id. */
  private renderCheckRow(f: Finding, fr: FriendlyFinding, close: () => void): HTMLElement {
    const technical = fr.group === 'technical'
    const row = div(`ed-check-row ed-check-${f.severity}`)
    const badge = div('ed-check-badge')
    badge.textContent = technical ? f.severity
      : fr.group === 'problem' ? t('Problem') : fr.group === 'warning' ? t('Warning') : t('Tip')
    const msg = div('ed-check-msg')
    msg.textContent = fr.text ?? f.message
    row.append(badge, msg)
    const idx = f.slide ? this.store.doc.slides.findIndex((s) => s.id === f.slide) : -1
    // a finding about a slide type's own chrome is fixed in the slide type
    const layout = !technical && f.layout ? this.store.doc.layouts?.find((l) => l.id === f.layout) : undefined
    if (f.element) {
      const el = idx >= 0 ? this.store.doc.slides[idx].elements.find((e) => e.id === f.element) : undefined
      const loc = div('ed-check-loc')
      loc.textContent = technical || !el ? f.element : elementLabel(el)
      row.appendChild(loc)
    }
    if (layout) {
      row.classList.add('ed-check-clickable')
      row.title = t('Open this slide type in the Layout Manager')
      row.addEventListener('click', () => {
        close()
        this.openSlideTypeAt(layout.id, f.element)
      })
    } else if (idx >= 0) {
      row.classList.add('ed-check-clickable')
      row.title = t('Jump to this slide')
      row.addEventListener('click', () => {
        this.store.goTo(idx)
        if (f.element) this.store.select([f.element])
        close()
      })
    }
    return row
  }

  /**
   * Slide Sorter — full-screen grid of renderThumbnail() at a larger size
   * than the sidebar. Plain click jumps to that slide and closes; shift/cmd
   * click (range/toggle) multi-selects without closing, for batch
   * duplicate/delete. Reorder is the same drop controller as the sidebar
   * (wireSlideDrop, grid axis); dragging a selected tile drags the whole
   * selection.
   */
  private openSlideSorter() {
    if (this.layoutManagerOpen) { this.toast(t('Close the Layout Manager to open Slide Sorter')); return }
    this.slideSorterOpen = true
    document.querySelector('.ed-sorter-overlay')?.remove()
    // an icon set's sorter is its overview: every icon by name, in any of its styles
    const icons = this.isIconset
    const overlay = div('ed-sorter-overlay' + (icons ? ' ed-sorter-icons' : ''))
    const bar = div('ed-sorter-bar')
    const h = document.createElement('h2')
    h.textContent = icons ? t('All icons') : t('Slide Sorter')
    const count = div('ed-sorter-count')
    const dupBtn = btn(ICONS.copy, t('Duplicate'), () => batchDuplicate(), icons ? t('Duplicate selected icons') : t('Duplicate selected slides'))
    const delBtn = btn(ICONS.trash, t('Delete'), () => batchDelete(), icons ? t('Delete selected icons') : t('Delete selected slides'))
    const closeBtn = btn('✕', '', () => close(), t('Close (Esc)'))
    closeBtn.classList.add('ed-sorter-close')
    const looks = div('ed-setbar ed-sorter-looks')
    bar.append(h, looks, count, dupBtn, delBtn, closeBtn)
    /** the style chips: the same choice as the canvas's (store.iconLook) */
    const renderLooks = () => {
      looks.replaceChildren()
      const variants = icons ? this.store.doc.iconset?.variants ?? [] : []
      looks.hidden = !variants.length
      const shown = this.store.shownLook?.id ?? null
      for (const [name, id] of [[t('As drawn'), null], ...variants.map((l) => [l.name, l.id])] as Array<[string, string | null]>) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-setchip' + (id === shown ? ' active' : '')
        b.setAttribute('aria-pressed', String(id === shown))
        b.textContent = name
        b.addEventListener('click', () => this.store.showLook(id))
        looks.appendChild(b)
      }
    }
    const scroll = div('ed-sorter-scroll')
    const grid = div('ed-sorter-grid')
    scroll.appendChild(grid)
    overlay.append(bar, scroll)

    // Seed from the persisted "selected for Claude" set (see
    // slideSelectionForClaude) so reopening the sorter visually shows what's
    // still selected — ids that no longer exist are simply dropped.
    const selected = new Set<number>()
    for (const id of this.slideSelectionForClaude) {
      const idx = this.store.doc.slides.findIndex((s) => s.id === id)
      if (idx >= 0) selected.add(idx)
    }
    let lastClicked: number | null = null
    // the selection is held as indices — a drop re-finds it by id
    let selectedAtDrag: string[] = []
    wireSlideDrop(this.store, grid, {
      axis: 'grid',
      scroller: scroll,
      onDropped: () => {
        const slides = this.store.doc.slides
        selected.clear()
        for (const id of selectedAtDrag) {
          const k = slides.findIndex((s) => s.id === id)
          if (k >= 0) selected.add(k)
        }
        lastClicked = null
        updateBar()
      },
    })

    const updateBar = () => {
      count.textContent = selected.size ? t('{n} selected', { n: String(selected.size) }) : ''
      dupBtn.toggleAttribute('disabled', selected.size === 0)
      delBtn.toggleAttribute('disabled', selected.size === 0)
      grid.querySelectorAll<HTMLElement>('.ed-sorter-item').forEach((item) => {
        item.classList.toggle('selected', selected.has(Number(item.dataset.index)))
      })
      // The Slide Sorter's multi-select IS "the slides selected for Claude"
      // — persist it (ids, not indices, so it survives future reorders) and
      // push a fresh selection.json so a docked terminal session sees it.
      this.slideSelectionForClaude = [...selected].sort((a, b) => a - b)
        .map((i) => this.store.doc.slides[i]?.id).filter((id): id is string => !!id)
      this.scheduleSelectionContext()
    }

    const renderGrid = () => {
      grid.innerHTML = ''
      const doc = this.store.doc
      const slides = doc.slides
      const ranges = sectionsInOrder(doc).map((section) => ({ section, ...sectionRange(doc, section) }))
      const headerAt = new Map(ranges.map((r) => [r.start, r]))
      const hiddenIdx = collapsedSlideIndices(doc, ranges)
      slides.forEach((slide, i) => {
        const r = headerAt.get(i)
        if (r) {
          grid.appendChild(buildSectionHeader({
            store: this.store,
            section: r.section,
            open: !hiddenIdx.has(i),
            onToggle: (open) => { setSectionOpen(doc, r.section.id, open); renderGrid() },
            // clicking the header body (not the chevron/name/tools) seeds the
            // multi-select with this section's whole range — the batch ops
            // (batchDuplicate/batchDelete) already work on whatever's selected
            onSelectRange: () => {
              const { start, end } = sectionRange(doc, r.section)
              for (let k = start; k < end; k++) selected.add(k)
              lastClicked = end - 1
              updateBar()
            },
          }))
        }
        if (hiddenIdx.has(i)) return // collapsed — mirrors the sidebar
        const item = div('ed-sorter-item')
        item.dataset.index = String(i)
        item.dataset.slideId = slide.id
        item.draggable = true
        if (slide.stateOf) item.classList.add('state')
        if (slide.hidden) item.classList.add('hidden')
        const num = div('ed-sorter-num')
        if (icons) {
          num.textContent = slide.name || t('Untitled icon')
          if (slide.icon?.prompt) item.title = slide.icon.prompt
          item.append(this.thumbSurface(slide, 112), num)
        } else {
          num.textContent = slide.stateOf
            ? (slide.name ?? '⤷')
            : (paginates(slide, this.store.doc) ? String(this.linearNumber(i)) : '—')
          item.appendChild(num)
          item.appendChild(renderThumbnail(slide, this.store.doc, 220))
        }
        this.appendLockBadge(item, slide.id)
        item.addEventListener('click', (ev) => {
          if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
            ev.preventDefault()
            if (ev.shiftKey && lastClicked !== null) {
              const [a, b] = [lastClicked, i].sort((x, y) => x - y)
              for (let k = a; k <= b; k++) selected.add(k)
            } else if (selected.has(i)) {
              selected.delete(i)
            } else {
              selected.add(i)
            }
            lastClicked = i
            updateBar()
            return
          }
          this.store.goTo(i)
          close()
        })
        item.addEventListener('dragstart', (ev) => {
          const picked = selected.has(i) ? [...selected].sort((a, b) => a - b) : [i]
          const ids = picked.map((k) => slides[k]?.id).filter((id): id is string => !!id)
          selectedAtDrag = [...selected].map((k) => slides[k]?.id).filter((id): id is string => !!id)
          startSlideDrag(ev, ids, item, grid)
        })
        item.addEventListener('dragend', endSlideDrag)
        grid.appendChild(item)
      })
      updateBar()
    }

    // one commit each — one undo step, one confirm — however many are selected
    const batchDuplicate = () => {
      const ids = [...selected].sort((a, b) => a - b).map((i) => this.store.doc.slides[i]?.id).filter(Boolean) as string[]
      this.duplicateSlides(ids)
      selected.clear()
      renderGrid()
    }

    const batchDelete = () => {
      const ids = [...selected].map((i) => this.store.doc.slides[i]?.id).filter(Boolean) as string[]
      this.deleteSlides(ids)
      selected.clear()
      renderGrid()
    }

    const unsub = this.store.on('slides', () => renderGrid())
    const unsubLocks = this.store.on('locks', () => renderGrid())
    const unsubLook = this.store.on('look', () => { renderLooks(); renderGrid() })
    renderLooks()
    const close = () => {
      unsub()
      unsubLocks()
      unsubLook()
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      this.slideSorterOpen = false
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    renderGrid()
  }

  /**
   * Outline View — a text-only pane over the whole deck. Every text element
   * on a slide is an editable field in reading order (`outlinemodel.ts`: the
   * `role:'title'` text, else the topmost, is the heading); a picture, table,
   * chart… is only named under the row. Bullet lines reuse markdown.ts's "- "
   * convention both ways.
   *
   * DORMANT: nothing opens it (ribbon, View menu, command and ⌘2 removed).
   * Public only so the unused-member check stays quiet; restore the entry
   * points from git history if it comes back.
   */
  openOutlineView() {
    if (this.layoutManagerOpen) { this.toast(t('Close the Layout Manager to open Outline View')); return }
    this.outlineViewOpen = true
    document.querySelector('.ed-outline-overlay')?.remove()
    const overlay = div('ed-outline-overlay')
    const bar = div('ed-outline-bar')
    const h = document.createElement('h2')
    h.textContent = t('Outline View')
    const closeBtn = btn('✕', '', () => close(), t('Close (Esc)'))
    closeBtn.classList.add('ed-outline-close')
    bar.append(h, closeBtn)
    const scroll = div('ed-outline-scroll')
    const list = div('ed-outline-list')
    scroll.appendChild(list)
    // rows aren't drag sources here, so only a header drag ever drops
    wireSlideDrop(this.store, list, { axis: 'y', scroller: scroll, onDropped: () => {} })
    overlay.append(bar, scroll)

    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      unsub()
      this.outlineViewOpen = false
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    // keeps the outline live against undo/redo and remote collab edits.
    // 'doc' also fires on a commit this view makes itself (a field's own
    // blur) — that field's DOM already shows what was just typed, so a full
    // teardown-and-rebuild is redundant AND unsafe: it can land mid-gesture
    // (e.g. the click that blurs field A to focus field B) and wipe field
    // B's not-yet-committed keystrokes. outlineSyncing skips the rerender
    // for exactly those self-caused commits.
    const unsub = this.store.on('doc', () => { if (!this.outlineSyncing) this.renderOutline(list) })
    document.body.appendChild(overlay)
    this.renderOutline(list)
  }

  /** True while a commit originates from the outline's own fields — see the
   *  'doc' listener in openOutlineView() above. */
  private outlineSyncing = false

  /** Stored rich text → the markdown an outline field shows and edits
   *  (markdown.ts htmlToMarkdown: emphasis, links and nested lists survive
   *  the round trip through commitOutline*). Bullets typed as a "• " glyph
   *  by older builds come back in markdown's "- " form. */
  private outlineHtmlToText(html: string): string {
    return htmlToMarkdown(sanitizeHtml(html)).replace(/^(\s*)• ?/gm, '$1- ')
  }

  /** The lines of a field's stored html, for its commit to reuse wherever
   *  the edit left a line's markdown as it was: a coloured or sized run, an
   *  underline — what markdown cannot spell — then survives an edit to some
   *  other line (DECISIONS 2026-10-08, rich text phase 2). Built from the same
   *  sanitized html outlineHtmlToText showed; the result is sanitized again. */
  private outlineKept(html: string) {
    return keptLines(sanitizeHtml(html))
  }

  private renderOutline(list: HTMLElement) {
    const focused = document.activeElement
    const focusedIndex = focused?.closest<HTMLElement>('.ed-outline-row')?.dataset.index
    const focusedClass = focused instanceof HTMLElement ? [...focused.classList].find((c) => c.startsWith('ed-outline-')) : undefined
    list.innerHTML = ''
    const doc = this.store.doc
    const ranges = sectionsInOrder(doc).map((section) => ({ section, ...sectionRange(doc, section) }))
    const headerAt = new Map(ranges.map((r) => [r.start, r]))
    const hiddenIdx = collapsedSlideIndices(doc, ranges)
    doc.slides.forEach((slide, i) => {
      const r = headerAt.get(i)
      if (r) {
        list.appendChild(buildSectionHeader({
          store: this.store,
          section: r.section,
          open: !hiddenIdx.has(i),
          onToggle: (open) => { setSectionOpen(doc, r.section.id, open); this.renderOutline(list) },
        }))
      }
      if (hiddenIdx.has(i)) return // collapsed — mirrors the sidebar: nothing rendered for it
      const row = div('ed-outline-row')
      row.dataset.index = String(i)
      row.dataset.slideId = slide.id
      if (slide.stateOf) row.classList.add('state')
      if (slide.hidden) row.classList.add('hidden')
      if (slide.id === this.store.slide?.id && !this.store.editingSurface) row.classList.add('current')

      const num = div('ed-outline-num')
      num.textContent = slide.stateOf ? '⤷' : (paginates(slide, doc) ? String(this.linearNumber(i)) : '—')
      num.addEventListener('click', () => this.store.goTo(i))
      row.appendChild(num)

      const body = div('ed-outline-body')
      const layout = slide.layoutId ? doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
      const parts = outlineParts(slide, layout ? ancestorElementIds(doc, layout) : undefined)
      const titleEl = parts.title

      const titleField = document.createElement('div')
      titleField.className = 'ed-outline-title'
      // Plain-text, one line: a title that wraps still has no hard breaks.
      titleField.contentEditable = titleEl ? 'plaintext-only' : 'false'
      titleField.textContent = titleEl ? this.outlineHtmlToText(titleEl.html) : ''
      if (!titleEl) {
        titleField.classList.add('empty', 'disabled')
        titleField.dataset.placeholder = t('No title element on this slide')
      } else {
        titleField.dataset.placeholder = t('Slide title')
        if (!titleField.textContent) titleField.classList.add('empty')
        titleField.addEventListener('input', () => titleField.classList.toggle('empty', !titleField.textContent))
        titleField.addEventListener('focus', () => this.store.goTo(i))
        titleField.addEventListener('blur', () => this.commitOutlineText(slide.id, titleEl.id, titleField.textContent ?? '', true))
        titleField.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault()
            this.commitOutlineText(slide.id, titleEl.id, titleField.textContent ?? '', true)
            this.insertOutlineSlideAfter(i, list)
          }
        })
      }
      body.appendChild(titleField)

      // every other text box on the slide, in reading order — a subtitle, a
      // second column, an untagged note: each is its own field, so no slide
      // is a read-only dead end
      for (const el of parts.rest) {
        const field = document.createElement('textarea')
        field.className = 'ed-outline-text'
        field.dataset.elId = el.id
        field.value = this.outlineHtmlToText(el.html)
        field.placeholder = el.placeholder ?? ''
        const fit = () => { field.rows = Math.max(1, field.value.split('\n').length) }
        fit()
        field.addEventListener('focus', () => this.store.goTo(i))
        field.addEventListener('input', fit)
        field.addEventListener('blur', () => this.commitOutlineText(slide.id, el.id, field.value, false))
        body.appendChild(field)
      }

      // what the outline cannot show is named, so a row never looks empty
      // when the slide is not
      const named = (['image', 'media', 'table', 'chart', 'code', 'math'] as const)
        .filter((k) => parts.other[k])
        .map((k) => {
          const n = parts.other[k]!
          const label = t({ image: 'Image', media: 'Media', table: 'Table', chart: 'Chart', code: 'Code', math: 'Equation' }[k])
          return n > 1 ? `${label} ×${n}` : label
        })
      if (named.length) {
        const also = div('ed-outline-also')
        also.textContent = named.join(' · ')
        also.title = t('This slide has content the outline can’t show — open it on the canvas')
        also.addEventListener('click', () => this.store.goTo(i))
        body.appendChild(also)
      }
      row.appendChild(body)
      list.appendChild(row)
    })
    // re-render (e.g. after a remote edit) drops focus — restore it on the
    // same row/field so a mid-type collab update doesn't yank the caret away
    if (focusedIndex != null && focusedClass) {
      const again = list.querySelector<HTMLElement>(`.ed-outline-row[data-index="${focusedIndex}"] .${focusedClass}`)
      again?.focus()
    }
  }

  /** Writes an outline field back into its element. `oneLine` = a title: line
   *  breaks collapse to spaces. */
  private commitOutlineText(slideId: string, elId: string, text: string, oneLine: boolean) {
    const slide = this.store.doc.slides.find((s) => s.id === slideId)
    const el = slide?.elements.find((e): e is TextElement => e.type === 'text' && e.id === elId)
    if (!el) return
    // unchanged text is not an edit: what markdown cannot spell (a coloured
    // or sized run, underline) must not be flattened by focusing the field
    if (text === this.outlineHtmlToText(el.html)) return
    const html = sanitizeHtml(markdownToHtml(oneLine ? text.replace(/\n+/g, ' ') : text, this.outlineKept(el.html)))
    if (el.html === html) return
    this.outlineSyncing = true
    this.store.commit(() => { el.html = html })
    this.outlineSyncing = false
  }

  /** Enter in a title field: new slide from the "Title + content" builtin,
   *  inserted right after this one, outline re-rendered with focus on it.
   *  (Suppresses the listener's own rerender — this method already does one,
   *  and doing both would rebuild the list twice for nothing.) */
  private insertOutlineSlideAfter(i: number, list: HTMLElement) {
    const layout = builtinLayouts(this.store.doc.size).find((l) => l.id === 'layout-title-content')
    if (!layout) return
    this.outlineSyncing = true
    this.insertSlideFromLayout(layout, i + 1)
    this.outlineSyncing = false
    this.renderOutline(list)
    requestAnimationFrame(() => {
      list.querySelector<HTMLElement>(`.ed-outline-row[data-index="${i + 1}"] .ed-outline-title`)?.focus()
    })
  }

  /** "Save selection…" — saves the selection to this deck's objects or to
   *  the library, asked in its dialog (saveselection.ts). Enabled only with
   *  a non-empty selection (unlike the Arrange-row buttons, which stay
   *  enabled and no-op instead — this one needs a disabled state because
   *  "nothing selected" is the common, expected way to notice the feature
   *  exists, not a stray click to swallow silently). */
  private saveSelectionButton(): HTMLElement {
    const b = btn(ICONS.download, t('Save selection…'), () => void openSaveSelectionDialog(this.store, this.store.selectedElements),
      t('Save the selected elements to the library or to this deck’s objects')) as HTMLButtonElement
    const sync = () => { b.disabled = !this.store.selectedElements.length }
    sync()
    this.store.on('selection', sync)
    return b
  }

  /** "Library" — the global element library's panel (librarypanel.ts). It
   *  lives here, in the slide editor, and not in the Layout Manager: the
   *  library belongs to the user, not to this file (docs/DECISIONS.md
   *  2026-09-28, "Scope split"). */
  private libraryPanelButton(): HTMLElement {
    return btn(ICONS.library, t('Library'), (ev) => openLibraryPanel(this.store, ev.currentTarget as HTMLElement),
      t('Your library — elements and groups you reuse across decks, kept in one shared file'))
  }

  private toggleFormatPainter() {
    this.formatPainter.toggle()
  }

  private toggleReapplyChange() {
    this.reapplyChangeTool.toggle()
  }

  // --- sidebar -----------------------------------------------------------------

  /** Appends a small colored lock badge to a thumbnail if `slideId` is
   *  currently locked by a parallel `claude` session (see store.ts's lock
   *  registry) — shared by the sidebar's makeThumb and the Slide Sorter's
   *  grid item, both of which show live document state via renderThumbnail.
   *  The badge's color matches the owning session's terminal tab (see
   *  sessioncolor.ts's colorForSession — same hash, independently derived,
   *  no cross-process color handshake needed). No-op (nothing appended) on
   *  an unlocked slide, so this costs nothing when no session is active. */
  private appendLockBadge(item: HTMLElement, slideId: string) {
    const owner = this.store.lockOwner(slideId)
    if (!owner) return
    const badge = div('ed-thumb-lock')
    badge.style.setProperty('--ed-lock-color', colorForSession(owner))
    badge.title = t('Another chat is working on this slide right now.')
    item.appendChild(badge)
  }

  /** The ✨ pill on the thumbnail of the slide Claude proposed designs for:
   *  it says how many and opens the compare view. */
  private appendVariantBadge(item: HTMLElement, slideId: string) {
    const pending = this.pendingVariants
    if (!pending || pending.slideId !== slideId) return
    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = 'ed-thumb-variants'
    badge.innerHTML = `${ICONS.sparkle}<span>${pending.variants.length}</span>`
    badge.title = pending.variants.length === 1
      ? t('Claude proposed a design for this slide — compare it with the slide')
      : t('Claude proposed {n} designs for this slide — compare them', { n: pending.variants.length })
    badge.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    badge.addEventListener('click', (ev) => { ev.stopPropagation(); this.openVariants() })
    item.appendChild(badge)
  }

  private makeThumb(slide: import('../model').Slide, i: number, isState: boolean): HTMLElement {
    const item = div('ed-thumb')
    item.dataset.index = String(i)
    item.draggable = true
    const num = div('ed-thumb-num')
    if (isState) {
      const parentIdx = this.store.doc.slides.findIndex((s) => s.id === slide.stateOf)
      num.textContent = slide.name ?? `⤷ ${parentIdx + 1}`
      num.title = `Interactive state of slide ${parentIdx + 1} — reached via links while presenting`
    } else if (slide.hidden) {
      // The sidebar shows what the AUDIENCE would count. With the default
      // numbering a hidden slide has no number at all, so show the marker
      // alone; with office-suite numbering it keeps one, struck through — the
      // same affordance PowerPoint uses. Either way it must be obvious at a
      // glance, because a slide you forgot you hid is found mid-presentation.
      num.textContent = paginates(slide, this.store.doc) ? String(this.linearNumber(i)) : '—'
      const parent = extraParent(this.store.doc, i)
      num.title = parent >= 0
        ? t('Extra slide of slide {n} — press X on slide {n} while presenting', { n: this.linearNumber(parent) })
        : t('Hidden — skipped while presenting and left out of PDF export')
    } else if (this.isIconset) {
      // an icon set's list is its plan: the name under each tile, the empty icons too
      num.textContent = slide.name || t('Untitled icon')
      if (slide.icon?.prompt) num.title = slide.icon.prompt
    } else {
      num.textContent = String(this.linearNumber(i))
    }
    // thumb width tracks the (resizable) sidebar; states and extras render smaller
    const base = this.thumbBase()
    const nested = isState || extraParent(this.store.doc, i) >= 0
    const surface = this.thumbSurface(slide, nested ? Math.round(base * 0.84) : base)
    const cmtState = thumbCommentState(slide)
    if (cmtState) {
      const badge = div('ed-thumb-cmt' + (cmtState === 'check' ? ' check' : ''))
      badge.title = cmtState === 'check'
        ? t('{n} to check', { n: slide.comments!.filter((c) => c.agentDone).length })
        : `${slide.comments!.filter((c) => !c.resolved).length} open comment(s)`
      item.appendChild(badge)
    }
    // A dangling layoutId counts as not linked — same as the Layout
    // Manager's "Not linked" list (model.ts `unlinkedSlides`).
    const master = slide.layoutId ? this.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
    if (master) {
      const link = div('ed-thumb-link')
      link.title = t('Linked to slide type “{name}” — its fonts and frame apply here; edit the slide type to change them permanently.', { name: master.name ?? t('Untitled') })
      item.appendChild(link)
    }
    this.appendLockBadge(item, slide.id)
    this.appendVariantBadge(item, slide.id)
    const clicks = stepCount(slide)
    if (clicks) item.appendChild(this.buildsBadge(clicks))
    const tools = div('ed-thumb-tools')
    tools.append(
      confirmBtn(ICONS.copy, t('Duplicate?'), () => { this.duplicateSlide(i); this.focusSlidePanel() }, this.isIconset ? t('Duplicate icon (click twice)') : t('Duplicate slide (click twice)')),
      confirmBtn(ICONS.trash, t('Delete?'), () => { this.deleteSlide(i); this.focusSlidePanel() }, this.isIconset ? t('Delete icon (click twice)') : t('Delete slide (click twice)'), 'danger'),
    )
    item.append(num, surface, tools)
    item.dataset.slideId = slide.id
    item.setAttribute('role', 'option')
    this.wireThumbDrag(item, i)
    return item
  }

  /** Show/hide the slide list — in an icon set, the icon list. */
  private slideListButton(): HTMLElement {
    return this.isIconset
      ? btn(ICONS.panelLeft, t('Icons'), () => this.togglePanel('left'), t('Icons — show or hide the icon list'))
      : btn(ICONS.panelLeft, t('Slides'), () => this.togglePanel('left'), t('Slides — show or hide the slide list'))
  }

  /** The Slide Sorter — in an icon set, the overview of all icons. */
  private sorterButton(run: () => void): HTMLElement {
    return this.isIconset
      ? btn(ICONS.grid, t('All icons'), run, t('Every icon of the set in one grid, in any of its styles'))
      : btn(ICONS.grid, t('Slide Sorter'), run, t('Switch to a grid view of all slides'))
  }

  /** Slide-list thumbnail width: the sidebar's, or one tile of an icon set's grid. */
  private thumbBase(): number {
    return this.isIconset ? this.iconTiles().size : Math.max(96, this.panelW.left - 52)
  }

  /** An icon set lays its list out as a grid of tiles (styles.css .ed-iconset
   *  .ed-sidebar): as many columns of at least 64 px as the sidebar holds. */
  private iconTiles(): { cols: number; size: number } {
    // the sidebar's padding (2 × 12) and scrollbar gutter; each tile adds a 2 px border
    const inner = this.panelW.left - 34
    const gap = 8
    const cols = Math.max(2, Math.floor((inner + gap) / (64 + 4 + gap)))
    return { cols, size: Math.floor((inner - (cols - 1) * gap) / cols) - 4 }
  }

  /** A slide-list thumbnail; in an icon set with a style shown, the icon in
   *  that style, and an icon not drawn yet is a placeholder showing what it
   *  is meant to show. */
  private thumbSurface(slide: Slide, width: number): HTMLElement {
    if (this.isIconset && !slide.elements.length) {
      // an empty icon canvas: its keyline circle, and what it is meant to show if that is known
      const box = div('beeslides-thumb-surface ed-icon-empty')
      box.style.width = `${width}px`
      box.style.height = `${Math.round(width * this.store.doc.size.height / this.store.doc.size.width)}px`
      box.title = t('Not drawn yet')
      if (slide.icon?.prompt) {
        const text = document.createElement('span')
        text.textContent = slide.icon.prompt
        box.appendChild(text)
      }
      return box
    }
    const look = this.store.shownLook
    if (!look) return renderThumbnail(slide, this.store.doc, width)
    const box = document.createElement('div')
    box.className = 'beeslides-thumb-surface'
    const height = Math.round(width * this.store.doc.size.height / this.store.doc.size.width)
    box.style.width = `${width}px`
    box.style.height = `${height}px`
    box.style.background = slide.background
    const img = document.createElement('img')
    img.src = lookPreviewUrl(this.store, slide.id, look)
    img.alt = ''
    img.width = width
    img.height = height
    img.style.display = 'block'
    box.appendChild(img)
    return box
  }

  /** 1-based position among non-state slides (what the audience counts). */
  private linearNumber(i: number): number {
    return this.store.doc.slides.slice(0, i + 1).filter((s) => paginates(s, this.store.doc)).length
  }

  private rebuildSidebar() {
    // States sit in doc order right after their parent and render nested —
    // smaller, indented, dimmed — so the structure reads at a glance.
    const scroll = this.sidebar.scrollTop
    this.sidebar.innerHTML = ''
    const doc = this.store.doc
    const slides = doc.slides
    // Section headers interleave with the thumbnails by walking doc.slides
    // and sectionsInOrder() in lockstep — headerAt maps a section's start
    // INDEX to the section itself, and hiddenIdx is every index that falls
    // inside a COLLAPSED section (not rendered at all — no thumb, no gap).
    const ranges = sectionsInOrder(doc).map((section) => ({ section, ...sectionRange(doc, section) }))
    const headerAt = new Map(ranges.map((r) => [r.start, r]))
    const hiddenIdx = collapsedSlideIndices(doc, ranges)
    // an icon set's grid adds icons with "Add icons" and Enter, not by hover gaps
    const gaps = !this.isIconset
    if (this.isIconset) {
      const { cols, size } = this.iconTiles()
      this.sidebar.style.setProperty('--icon-cols', String(cols))
      this.sidebar.style.setProperty('--icon-tile', `${size}px`)
      this.sidebar.style.setProperty('--icon-tile-h', `${Math.round(size * doc.size.height / doc.size.width)}px`)
    }
    slides.forEach((slide, i) => {
      // hover gap = insert here; never between a parent and its states, and
      // never inside a collapsed section — there's nothing to insert between
      if (gaps && !slide.stateOf && !hiddenIdx.has(i)) this.sidebar.appendChild(this.insertGap(i))
      const r = headerAt.get(i)
      if (r) {
        this.sidebar.appendChild(buildSectionHeader({
          store: this.store,
          section: r.section,
          open: !hiddenIdx.has(i),
          onToggle: (open) => { setSectionOpen(doc, r.section.id, open); this.rebuildSidebar() },
        }))
      }
      if (hiddenIdx.has(i)) return // collapsed — this slide's thumb is skipped entirely
      const item = this.makeThumb(slide, i, !!slide.stateOf)
      if (slide.stateOf) item.classList.add('ed-thumb-state')
      if (slide.hidden) item.classList.add('ed-thumb-hidden')
      if (extraParent(doc, i) >= 0) item.classList.add('ed-thumb-extra')
      this.sidebar.appendChild(item)
    })
    if (gaps) this.sidebar.appendChild(this.insertGap(slides.length))
    if (this.isIconset) this.sidebar.appendChild(this.iconAddTile())
    else {
      const add = btn(ICONS.plus, t('New slide'), () => this.openLayoutPicker(add))
      add.classList.add('ed-add-slide')
      add.title = t('New slide from a slide type')
      this.sidebar.appendChild(add)
    }
    this.sidebar.scrollTop = scroll
    this.highlightSidebar()
    if (this.iconAdding) this.focusIconAdding()
  }

  // ---- adding icons in the grid (DECISIONS 2026-10-16 "Add icons in place") ----

  /** The + tile is a name field: Enter adds the icon and starts the next. */
  private iconAdding = false
  /** a name the last Enter found already in the set (shown on the tile until the next key) */
  private iconAddDup = ''

  /** The icon grid's last tile: "+ Add icons", or, while adding, a new tile
   *  with its name field under it, the way a new icon will look. */
  private iconAddTile(): HTMLElement {
    const how = t('Name new icons one after another — each Enter adds one')
    if (!this.iconAdding) {
      const add = btn(ICONS.plus, t('Add icons'), () => this.startIconAdding(), how)
      add.classList.add('ed-add-slide')
      return add
    }
    const tile = div('ed-add-slide ed-icon-adding' + (this.iconAddDup ? ' is-dup' : ''))
    const face = div('ed-icon-adding-face')
    face.textContent = this.iconAddDup ? t('Already in the set') : ''
    const name = document.createElement('input')
    name.type = 'text'
    name.className = 'ed-icon-adding-name'
    name.placeholder = t('Name')
    name.maxLength = 120
    name.title = how
    name.setAttribute('aria-label', how)
    name.value = this.iconAddDup
    tile.append(face, name)
    let busy = false
    const add = (names: string[]) => {
      const list = names.map((n) => n.trim()).filter(Boolean)
      if (!list.length) return
      busy = true
      let res: { slideIds: string[]; added: number } = { slideIds: [], added: 0 }
      this.store.commit(() => { res = addIconNames(this.store.doc, list, this.store.doc.slides.length) })
      // a single name already there: say so on the tile and show that icon
      this.iconAddDup = res.added === 0 && list.length === 1 ? list[0] : ''
      const last = res.slideIds[res.slideIds.length - 1]
      const i = this.store.doc.slides.findIndex((s) => s.id === last)
      if (i >= 0) this.setSlideSel([last], i, last)
      this.rebuildSidebar()
      busy = false
    }
    name.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.isComposing) return
      if (ev.key === 'Escape') { ev.preventDefault(); this.stopIconAdding(); return }
      if (ev.key !== 'Enter') return
      ev.preventDefault()
      if (!name.value.trim()) this.stopIconAdding() // an empty Enter = done
      else add([name.value])
    })
    name.addEventListener('input', () => {
      if (!this.iconAddDup) return
      this.iconAddDup = ''
      tile.classList.remove('is-dup')
      face.textContent = ''
    })
    // a pasted list: every line (or comma-separated name) becomes an icon
    name.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text/plain') ?? ''
      if (!/[\n,]/.test(text)) return
      ev.preventDefault()
      add(text.split(/\r?\n|,/).slice(0, 200))
    })
    // clicking away keeps a typed name (like naming a new folder) and stops
    name.addEventListener('blur', () => setTimeout(() => {
      if (busy || !this.iconAdding) return
      const live = this.sidebar.querySelector('.ed-icon-adding-name')
      if (live && document.activeElement === live) return
      if (name.isConnected && name.value.trim() && name.value !== this.iconAddDup) add([name.value])
      this.stopIconAdding()
    }))
    return tile
  }

  /** Turn the + tile into a name field (the list opens if it was hidden). */
  startIconAdding() {
    if (!this.isIconset) return
    this.canvas.commitTextEdit()
    if (this.sidebar.classList.contains('ed-collapsed')) this.togglePanel('left')
    this.iconAdding = true
    this.iconAddDup = ''
    this.rebuildSidebar()
  }

  private stopIconAdding() {
    if (!this.iconAdding) return
    this.iconAdding = false
    this.iconAddDup = ''
    this.rebuildSidebar()
  }

  private focusIconAdding() {
    const name = this.sidebar.querySelector<HTMLInputElement>('.ed-icon-adding-name')
    if (!name) return
    name.focus()
    if (this.iconAddDup) name.select()
    name.closest('.ed-add-slide')?.scrollIntoView({ block: 'nearest' })
  }

  // --- layouts ---------------------------------------------------------------

  /** Layout popover. Serves three flows: the New-slide button and the
   *  insert-gaps (both insert at a position), and "Change layout…" of one
   *  slide — where every entry carries a fit badge (`relinkPreview`) and the
   *  document's slide types are grouped by family (root type). */
  private openLayoutPicker(
    anchor: HTMLElement,
    // after the current slide's states and extras, never between it and them
    action: LayoutPickAction = { kind: 'insert', at: this.afterSlideBlock(this.store.currentIndex) },
  ) {
    document.querySelector('.ed-layoutpick')?.remove()
    // an icon set has no slide types: "New slide" (+, the ribbon) adds icons by name
    if (this.isIconset) {
      if (action.kind !== 'change') this.startIconAdding()
      return
    }
    const doc = this.store.doc
    const target = action.kind === 'change'
      ? doc.slides.find((s) => s.id === (action.slideId ?? doc.slides[this.store.currentIndex]?.id))
      : undefined
    if (action.kind === 'change' && !target) return
    const pick = div('ed-layoutpick')
    if (target) {
      pick.classList.add('ed-layoutpick-apply')
      const titleEl = div('ed-layoutpick-title')
      titleEl.textContent = t('Change slide type')
      pick.appendChild(titleEl)
      const hint = div('ed-hint')
      hint.textContent = doc.layouts?.length
        ? t('The slide follows the slide type you pick — later edits to that type update it. Nothing on it is deleted.')
        : t('Re-arranges the slide once — built-in slide types don’t stay linked.')
      pick.appendChild(hint)
    }
    // Once the doc has its own slide types, Built-in is dropped entirely —
    // otherwise it sits beside "This document" as an unlabeled duplicate
    // (e.g. a template's own "Title + content" next to the generic one) and
    // picking it silently produces a slide with no layoutId link back.
    // Built-in only serves as the seed set before any slide types exist.
    // A deck whose types form families (an imported .pptx's masters) shows
    // them grouped under their master, as PowerPoint's New Slide gallery
    // does; a flat set of types stays one list, the default first.
    const sections: Array<[string, Slide[], boolean]> = []
    const families = slideTypeFamilies(doc)
    if (families.length > 1 || (families.length === 1 && families[0][0] !== undefined) || (target && families.length)) {
      sections.push(...families.map(([label, layouts]): [string, Slide[], boolean] => [label ?? t('This document'), layouts, true]))
    } else if (families.length) {
      const defaultId = doc.defaultLayoutId
      const ordered = defaultId
        ? [...families[0][1]].sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0))
        : families[0][1]
      sections.push([t('This document'), ordered, true])
    } else {
      sections.push([t('Built-in'), builtinLayouts(doc.size), false])
    }
    const known = target ? layoutElementIds(doc) : undefined
    sections.forEach(([label, layouts, custom], si) => {
      const h = div('ed-layoutpick-h')
      h.textContent = label
      pick.appendChild(h)
      // Only a pick from THIS section sets slide.layoutId (a built-in has no
      // persistent identity for a future master edit to point back to) — so
      // this hint is scoped here, not a blanket claim for the whole popover.
      if (action.kind === 'insert' && custom && si === 0) {
        const hint = div('ed-hint')
        hint.textContent = t('Slide types from this document stay linked — future edits in the Layout Manager update slides made from them live.')
        pick.appendChild(hint)
      }
      const grid = div('ed-layoutpick-grid')
      for (const ly of layouts) {
        const item = div('ed-layoutpick-item')
        item.appendChild(renderThumbnail(effectiveLayout(doc, ly), doc, 104))
        const name = div('ed-layoutpick-name')
        name.textContent = ly.name ?? t('Untitled')
        if (custom && doc.defaultLayoutId === ly.id) {
          const star = document.createElement('span')
          star.className = 'ed-layoutpick-default'
          star.textContent = '★'
          star.title = t('Default slide type')
          item.appendChild(star)
        }
        item.appendChild(name)
        const current = !!target && custom && target.layoutId === ly.id
        if (current) item.classList.add('is-current')
        if (target) item.appendChild(fitBadge(relinkPreview(doc, target, ly, known), current))
        item.addEventListener('click', () => {
          pick.remove()
          if (action.kind === 'insert') this.insertSlideFromLayout(ly, action.at, custom)
          else this.changeSlideLayout(target!.id, ly, custom)
        })
        // Deleting a slide type is a Layout Manager job, not something to
        // sit one mis-click away in a "which type should this slide use?"
        // list — the ✕ is offered only when adding a slide.
        if (custom && action.kind === 'insert') {
          const del = document.createElement('button')
          del.className = 'ed-layoutpick-del'
          del.textContent = '✕'
          del.title = t('Delete this slide type')
          del.addEventListener('click', (ev) => {
            ev.stopPropagation()
            // removeLayout also clears layoutId on every slide that tracked
            // this layout — without it those slides show "linked to
            // Untitled" forever (Layouts mode's own trash icon does this too).
            this.store.commit(() => removeLayout(doc, ly.id))
            pick.remove()
          })
          item.appendChild(del)
        }
        grid.appendChild(item)
      }
      pick.appendChild(grid)
    })
    // Append BEFORE positioning — positionFloating measures the panel's real
    // rendered box (getBoundingClientRect), never a guessed constant.
    document.body.appendChild(pick)
    // bottom-of-sidebar button: anchor above it (it sits at the screen's
    // bottom edge); anything else (insert-gap, a panel button): below it.
    // Either way positionFloating flips + clamps on both ends of both axes.
    positionFloating(anchor, pick, { placement: anchor.classList.contains('ed-add-slide') ? 'top-start' : 'bottom-start' })
    const close = (ev: PointerEvent) => {
      if (!pick.contains(ev.target as Node)) {
        pick.remove()
        document.removeEventListener('pointerdown', close, true)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', close, true))
  }

  private insertSlideFromLayout(layout: Slide, at: number, fromDocLayout = false) {
    insertSlidesFromLayout(this.store, layout, at, 1, fromDocLayout)
    this.store.goTo(at)
  }

  /** "Change layout…": onto a document slide type the slide FOLLOWS it from
   *  now on (`relinkSlide` — so the old type's next edit can no longer snap
   *  it back); onto a built-in it is re-arranged once and unlinked (a
   *  built-in has no identity to follow — the same state inserting from one
   *  produces). Either way content is matched by id, then role, and nothing
   *  is deleted: what finds no placeholder stays on top, and the toast says
   *  so. "Take the look but stay free" = this, then Unlink. */
  private changeSlideLayout(slideId: string, layout: Slide, fromDocLayout: boolean) {
    let preview = null as RelinkPreview | null
    this.store.commit(() => {
      const doc = this.store.doc
      if (fromDocLayout) { preview = relinkSlide(doc, slideId, layout.id); return }
      const s = doc.slides.find((x) => x.id === slideId)
      if (!s) return
      preview = relinkPreview(doc, s, layout)
      s.elements = preview.elements
      s.background = layout.background
      delete s.layoutId
    })
    // The slide's element ids just changed — drop a selection on it. Not
    // when picked from a Layout Manager leaf: the canvas shows a slide
    // type there, and its selection has nothing to do with this slide.
    if (!this.store.editingSurface && this.store.doc.slides[this.store.currentIndex]?.id === slideId) this.store.select([])
    const n = preview?.floating.length ?? 0
    if (n) {
      this.toast(n === 1
        ? t('1 item has no place in “{name}” — kept on top of the slide', { name: layout.name ?? t('Untitled') })
        : t('{n} items have no place in “{name}” — kept on top of the slide', { n, name: layout.name ?? t('Untitled') }))
    }
  }

  /** Topbar entry point into the Layout Manager (building blocks, slide
   *  types, document properties) — see editor/layoutmanager.ts. The
   *  underlying Editor/Store stay mounted underneath: autosave, undo and
   *  dirty-tracking `store.on('doc', ...)` listeners keep firing untouched
   *  while the overlay is open. `initialTab` only seeds the FIRST-EVER open
   *  this session — once `layoutManagerNav` exists it's reused verbatim on
   *  every reopen, so the overlay resumes the last tab/sub-editor instead of
   *  amnesia-resetting to the Building Blocks grid every time.
   *
   *  `opts.force` is the escape hatch for an entry point that is itself an
   *  explicit "go there now" user action (e.g. reusableobjects.ts's
   *  empty-state jump link) rather than the ambient "🖼 Layout Manager…"
   *  button — it overrides the resume-verbatim default above for THAT tab's
   *  own drill-down state (only; other tabs' positions are left alone), so
   *  a stale sub-editor from an earlier visit can never swallow the jump.
   *  `opts.newObject` additionally seeds `layoutManagerNav.newObjectPending`
   *  (Objects-tab-only), which the overlay's own `render()` consumes once to
   *  land directly in a fresh blank object sub-editor — see that flag's doc
   *  comment in layoutmanager.ts.
   *
   *  Re-entrant call while already open (this DOES happen: the jump link
   *  above can fire from INSIDE an already-open sub-editor's insert picker,
   *  since the shared insert toolbar is also mounted there) mutates
   *  `layoutManagerNav` exactly the same way, then refreshes the EXISTING
   *  session in place instead of invoking the module-level
   *  `openLayoutManager()` again — that would reparent canvasWrap/propsHost
   *  into a brand-new overlay stacked on top of the live one and strand the
   *  first session's `exit()` bookkeeping (its captured "home" would then
   *  be the first overlay's own canvasArea, not the real editor). */
  openLayoutManager(initialTab?: LayoutManagerTab, opts?: Pick<OpenLayoutManagerDetail, 'force' | 'newObject' | 'layoutId'>) {
    if (this.slideSorterOpen) { this.toast(t('Close Slide Sorter to open the Layout Manager')); return }
    if (this.outlineViewOpen) { this.toast(t('Close Outline View to open the Layout Manager')); return }
    this.canvas.commitTextEdit()
    const nav = (this.layoutManagerNav ??= { tab: initialTab ?? 'types', editingLayoutId: null, editingObjectId: null })
    if (opts?.force && initialTab) {
      nav.tab = initialTab
      // Only reset the TARGET tab's own drill-down state — an explicit jump
      // must never resume a stale sub-editor for this tab, but other tabs'
      // positions are unrelated and stay untouched.
      if (initialTab === 'types') nav.editingLayoutId = null
      else if (initialTab === 'objects') nav.editingObjectId = null
    }
    if (opts?.newObject) nav.newObjectPending = true
    // "Edit this slide type" (the slide panel's ⋯): straight into that type
    if (opts?.layoutId && this.store.doc.layouts?.some((l) => l.id === opts.layoutId)) {
      nav.tab = 'types'
      nav.editingLayoutId = opts.layoutId
    }
    if (this.layoutManagerOpen) {
      this.layoutManagerSession?.refresh()
      return
    }
    this.layoutManagerOpen = true
    this.findBar.close()
    this.scheduleMenuSync()
    this.syncTemplateBanner()
    this.layoutManagerSession = openLayoutManager(this.store, this.canvas, this.canvasWrap, this.props, () => {
      this.layoutManagerOpen = false
      this.scheduleMenuSync()
      this.layoutManagerSession = null
      this.canvas.render()
      this.rebuildSidebar()
      this.scheduleThumbs()
      this.syncTemplateBanner()
      if (isDesktopShell()) this.scheduleSelectionContext()
    }, () => this.save(false), nav, () => { if (isDesktopShell()) this.scheduleSelectionContext() },
    this.templateMode ? { name: () => this.templateName(), rename: () => void this.renameTemplateFile() } : undefined)
    // Opening on a tab with no sub-editor (e.g. Document properties) emits
    // no 'selection' event, so selection.json would keep saying "deck".
    if (isDesktopShell()) this.scheduleSelectionContext()
  }

  /** The Layout Manager's Slide types tab, on slide type `layoutId`'s own
   *  editor, with `elementId` selected there when it is one of its elements
   *  — where Check slides sends a finding about slide-type chrome. */
  private openSlideTypeAt(layoutId: string, elementId?: string) {
    const nav = (this.layoutManagerNav ??= { tab: 'types', editingLayoutId: null, editingObjectId: null })
    nav.tab = 'types'
    nav.editingLayoutId = layoutId
    this.openLayoutManager()
    if (!this.layoutManagerOpen || !elementId) return
    const layout = this.store.doc.layouts?.find((l) => l.id === layoutId)
    if (layout?.elements.some((e) => e.id === elementId)) this.store.select([elementId])
  }

  // --- template window: the way back to the Layout Manager -------------------

  /** The last `templateSamples` seen on an intact template doc. */
  private lastTemplateSamples = true

  /** Whole-document replaces (Replace from JSON, a restored version,
   *  `window.beeslides.loadDoc`) go through `parseDoc`, which strips a
   *  template's identity — put it back, so the live doc stays this window's
   *  template (its id, and whether its slides are samples). */
  private keepTemplateIdentity() {
    const d = this.store.doc
    if (d.template && d.templateId === this.templateId && typeof d.templateSamples === 'boolean') {
      this.lastTemplateSamples = d.templateSamples
      return
    }
    d.template = true
    d.templateId = this.templateId
    delete d.basedOn
    if (typeof d.templateSamples !== 'boolean') d.templateSamples = this.lastTemplateSamples
  }

  private templateBanner: HTMLElement | null = null
  private templateSamplesBox: HTMLInputElement | null = null

  /** A template window outside the Layout Manager (its sample slides) shows
   *  a slim banner: which template this is, whether these slides are saved
   *  with it as samples, and the way back. Hidden while the LM is open. */
  private syncTemplateBanner() {
    if (!this.templateMode || !this.canvasWrap) return
    if (this.layoutManagerOpen) { this.templateBanner?.remove(); return }
    if (!this.templateBanner) {
      const bar = div('ed-tmplbanner')
      bar.setAttribute('role', 'status')
      const label = document.createElement('span')
      label.className = 'ed-tmplbanner-name'
      const samples = document.createElement('label')
      samples.className = 'ed-tmplbanner-samples'
      samples.title = t('Off: the layout keeps only its slide types and theme, and a deck made from it starts with one slide')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.addEventListener('change', () => {
        this.store.commit(() => { this.store.doc.templateSamples = box.checked })
      })
      samples.append(box, document.createTextNode(' ' + t('Save these slides as samples')))
      const back = document.createElement('button')
      back.className = 'ed-btn ed-btn-primary'
      back.textContent = t('Back to Layout Manager')
      back.addEventListener('click', () => this.openLayoutManager('types'))
      bar.append(label, samples, back)
      this.templateBanner = bar
      this.templateSamplesBox = box
      this.store.on('doc', () => { if (this.templateSamplesBox) this.templateSamplesBox.checked = this.store.doc.templateSamples !== false })
    }
    const bar = this.templateBanner
    if (bar.parentElement !== this.canvasWrap) this.canvasWrap.appendChild(bar)
    bar.querySelector('.ed-tmplbanner-name')!.textContent = t('Editing layout “{name}”', { name: this.templateName() })
    this.templateSamplesBox!.checked = this.store.doc.templateSamples !== false
  }

  /** Slim hover strip between thumbnails — click inserts a blank slide there;
   *  a second, smaller icon starts a new section there instead. */
  private insertGap(at: number): HTMLElement {
    const gap = div('ed-insertgap')
    const plus = document.createElement('button')
    plus.className = 'ed-insertgap-btn'
    plus.textContent = '＋'
    plus.tabIndex = -1
    plus.title = t('Insert slide here')
    plus.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.openLayoutPicker(gap, { kind: 'insert', at })
    })
    gap.appendChild(plus)
    // A section needs a real slide to start from — the trailing gap after
    // the last slide (at === slides.length) has none.
    if (at < this.store.doc.slides.length) {
      const newSection = document.createElement('button')
      newSection.className = 'ed-insertgap-btn ed-insertgap-section'
      newSection.textContent = '§'
      newSection.tabIndex = -1
      newSection.title = t('New section here')
      newSection.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.createSectionAt(at)
      })
      gap.appendChild(newSection)
    }
    return gap
  }

  /** "＋ new section" from an insert-gap: groups from the slide right after
   *  the gap onward, auto-focused so the author can name it immediately. */
  private createSectionAt(at: number) {
    const doc = this.store.doc
    const slide = doc.slides[at]
    if (!slide) return
    if (doc.sections?.some((s) => s.startSlideId === slide.id)) {
      this.toast(t('This slide already starts a section'))
      return
    }
    const section = insertSectionBefore(this.store, slide.id, t('New section'))
    requestAnimationFrame(() => {
      const name = this.sidebar.querySelector<HTMLElement>(
        `.ed-section-head[data-section-id="${section.id}"] .ed-section-name`,
      )
      name?.dispatchEvent(new Event(SECTION_RENAME_EVENT))
    })
  }

  /** A sidebar thumb's press + drag source. Select on press, before the
   *  browser starts native dragging — waiting for click/dragstart leaves
   *  Moveable's previous canvas target live while the pointer crosses the
   *  workspace. Drops are the sidebar's wireSlideDrop, not the thumb's.
   *  A state thumb drags its parent's whole block (slideorder.ts). */
  private wireThumbDrag(item: HTMLElement, index: number) {
    item.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || (ev.target instanceof Element && ev.target.closest('.ed-thumb-tools'))) return
      ev.stopPropagation() // keep the canvas Moveable gesture controller out
      this.pressThumb(index, ev)
    })
    // a plain press inside a multi-selection only collapses it on release
    // without a drag (pressThumb) — as Finder and PowerPoint do
    item.addEventListener('click', () => {
      const id = item.dataset.slideId
      if (id && this.pendingCollapse === id) {
        this.pendingCollapse = null
        this.setSlideSel([id], index, id)
      }
    })
    item.addEventListener('dragstart', (ev) => {
      this.pendingCollapse = null
      const id = item.dataset.slideId ?? ''
      const ids = this.slideSel.has(id) ? this.selectedSlideIds() : [id]
      startSlideDrag(ev, ids, item, this.sidebar)
    })
    item.addEventListener('dragend', endSlideDrag)
  }

  /** The sidebar's drop controller (once — the sidebar element outlives
   *  every rebuild). A drop selects what moved and opens any collapsed
   *  section it landed in. */
  private wireSidebarDrop() {
    // read on every dragover: an icon set's list is a grid, and icons have no extras
    const iconset = () => this.isIconset
    wireSlideDrop(this.store, this.sidebar, {
      get axis() { return iconset() ? 'grid' as const : 'y' as const },
      get nestable() { return !iconset() },
      scroller: this.sidebar,
      onDropped: (kind, ids) => {
        if (kind !== 'slides') return
        const slides = this.store.doc.slides
        const cur = slides[this.store.currentIndex]?.id
        const to = cur && ids.includes(cur) ? this.store.currentIndex : slides.findIndex((s) => s.id === ids[0])
        if (to >= 0) this.setSlideSel(ids, to, slides[to].id)
        this.revealSlides(ids)
      },
    })
  }

  /** A moved slide that lands inside a collapsed section would vanish from
   *  the panel — open that section (a view setting, not undoable). */
  private revealSlides(ids: string[]) {
    const doc = this.store.doc
    let opened = false
    for (const id of ids) {
      const sec = sectionOf(doc, id)
      if (sec && !isSectionOpen(doc, sec.id)) { setSectionOpen(doc, sec.id, true); opened = true }
    }
    if (opened) this.rebuildSidebar()
  }

  private highlightSidebar() {
    let active: HTMLElement | undefined
    this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb').forEach((n) => {
      const isActive = Number(n.dataset.index) === this.store.currentIndex
      const selected = this.slideSel.has(n.dataset.slideId ?? '')
      n.classList.toggle('active', isActive)
      n.classList.toggle('selected', selected)
      n.setAttribute('aria-selected', String(selected))
      if (isActive) active = n
    })
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // --- slide panel: focus zone + multi-selection ---------------------------------

  private focusSlidePanel() {
    if (document.activeElement !== this.sidebar) this.sidebar.focus({ preventScroll: true })
  }

  /** The slide panel owns the keyboard: it has focus (not a field inside
   *  it, nor a button), and the Layout Manager isn't covering it. */
  private slidesFocused(): boolean {
    return document.activeElement === this.sidebar && !this.layoutManagerOpen && !this.presenting
  }

  /** Doc indices in sidebar order: every slide (states included) except
   *  those inside a collapsed section — what the panel actually shows. */
  private panelOrder(): number[] {
    const doc = this.store.doc
    const hidden = collapsedSlideIndices(doc)
    return doc.slides.map((_, i) => i).filter((i) => !hidden.has(i))
  }

  /** The selected slides' indices in doc order — never empty: falls back to
   *  the current slide. */
  private selectedSlideIndices(): number[] {
    const slides = this.store.doc.slides
    const out = slides.map((s, i) => (this.slideSel.has(s.id) ? i : -1)).filter((i) => i >= 0)
    return out.length ? out : [this.store.currentIndex]
  }

  private selectedSlideIds(): string[] {
    const slides = this.store.doc.slides
    return this.selectedSlideIndices().map((i) => slides[i]?.id).filter((id): id is string => !!id)
  }

  /** Set the panel selection and move `current` to `currentIdx` as ONE panel
   *  action (onCurrentSlide won't collapse it). The selection is also what
   *  a docked Claude session sees as "the selected slides". */
  private setSlideSel(ids: Iterable<string>, currentIdx = this.store.currentIndex, anchor?: string) {
    const slides = this.store.doc.slides
    const live = new Set(slides.map((s) => s.id))
    this.slideSel = new Set([...ids].filter((id) => live.has(id)))
    const cur = slides[Math.max(0, Math.min(currentIdx, slides.length - 1))]
    if (cur) this.slideSel.add(cur.id)
    if (anchor !== undefined) this.slideAnchor = anchor
    else if (!this.slideAnchor || !this.slideSel.has(this.slideAnchor)) this.slideAnchor = cur?.id ?? null
    this.panelNav = true
    try { this.store.goTo(currentIdx) } finally { this.panelNav = false }
    this.highlightSidebar()
    // A multi-selection is "the slides selected for Claude" (the Slide
    // Sorter's seeds from it too); a single click is just navigation, which
    // selection.json's slideId already carries.
    this.slideSelectionForClaude = this.slideSel.size > 1 ? this.selectedSlideIds() : []
    this.scheduleSelectionContext()
  }

  /** `current` moved from outside the panel (canvas arrows, a link, undo, a
   *  delete's neighbour…): the selection collapses to it, as PowerPoint's. */
  private onCurrentSlide() {
    if (!this.panelNav) {
      const id = this.store.doc.slides[this.store.currentIndex]?.id
      this.slideSel = new Set(id ? [id] : [])
      this.slideAnchor = id ?? null
    }
    this.highlightSidebar()
  }

  /** Drop ids the doc no longer has; an emptied selection is the current slide. */
  private pruneSlideSel() {
    const live = new Set(this.store.doc.slides.map((s) => s.id))
    for (const id of this.slideSel) if (!live.has(id)) this.slideSel.delete(id)
    const cur = this.store.doc.slides[this.store.currentIndex]?.id
    if (!this.slideSel.size && cur) this.slideSel.add(cur)
    if (this.slideAnchor && !live.has(this.slideAnchor)) this.slideAnchor = cur ?? null
  }

  /** A press on a sidebar thumb: plain = select just it, ⇧ = range from the
   *  anchor (sidebar order, so collapsed sections are skipped), ⌘/Ctrl =
   *  toggle it. Always takes focus into the panel and drops any canvas
   *  element selection — so the next Delete means the SLIDE, even when the
   *  pressed thumb is already the current slide. */
  private pressThumb(i: number, ev: MouseEvent) {
    this.pendingCollapse = null
    this.focusSlidePanel()
    if (this.store.selection.length) this.store.select([])
    const slides = this.store.doc.slides
    const id = slides[i]?.id
    if (!id) return
    if (ev.shiftKey) {
      this.selectSlideRange(i)
    } else if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(this.slideSel)
      if (!next.has(id)) {
        next.add(id)
        this.setSlideSel(next, i, id)
      } else if (next.size > 1) {
        // toggled off: `current` follows to the nearest still-selected slide
        next.delete(id)
        const cur = slides[this.store.currentIndex]?.id
        let to = this.store.currentIndex
        if (cur === id || !cur || !next.has(cur)) {
          const order = slides.map((s, k) => (next.has(s.id) ? k : -1)).filter((k) => k >= 0)
          to = order.find((k) => k > i) ?? order[order.length - 1]
        }
        this.setSlideSel(next, to, slides[to]?.id)
      }
    } else if (this.slideSel.size > 1 && this.slideSel.has(id)) {
      // may be the start of a multi-drag: collapse on click, not on press
      this.pendingCollapse = id
    } else {
      this.setSlideSel([id], i, id)
    }
  }

  /** Slide id a plain press landed on inside a multi-selection — collapsed
   *  to on its click, dropped by a dragstart (see wireThumbDrag). */
  private pendingCollapse: string | null = null

  /** Select anchor…`i` in sidebar order and make `i` current. */
  private selectSlideRange(i: number) {
    const slides = this.store.doc.slides
    const anchorId = this.slideAnchor ?? slides[this.store.currentIndex]?.id
    const anchorIdx = Math.max(0, slides.findIndex((s) => s.id === anchorId))
    const [a, b] = [anchorIdx, i].sort((x, y) => x - y)
    const ids = this.panelOrder().filter((k) => k >= a && k <= b).map((k) => slides[k].id)
    this.setSlideSel(ids, i, slides[anchorIdx]?.id)
  }

  /** ↑/↓ (and Home/End) in the panel: step through the thumbnails in
   *  sidebar order, states included; with ⇧ the selection extends. */
  private stepSlidePanel(to: 'prev' | 'next' | 'first' | 'last', extend: boolean) {
    const order = this.panelOrder()
    if (!order.length) return
    const cur = this.store.currentIndex
    let target: number | undefined
    if (to === 'first') target = order[0]
    else if (to === 'last') target = order[order.length - 1]
    else if (to === 'next') target = order.find((k) => k > cur) ?? order[order.length - 1]
    else target = [...order].reverse().find((k) => k < cur) ?? order[0]
    if (extend) this.selectSlideRange(target)
    else {
      const id = this.store.doc.slides[target]?.id
      if (id) this.setSlideSel([id], target, id)
    }
  }

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer)
    this.thumbTimer = window.setTimeout(() => {
        const thumbs = this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb')
      const doc = this.store.doc
      const expected = doc.slides.length - collapsedSlideIndices(doc).size
      if (thumbs.length !== expected) return this.rebuildSidebar()
      const base = this.thumbBase()
      thumbs.forEach((item) => {
        const slide = this.store.doc.slides[Number(item.dataset.index)]
        if (!slide) return
        const idx = Number(item.dataset.index)
        const w = slide.stateOf || extraParent(this.store.doc, idx) >= 0 ? Math.round(base * 0.84) : base
        item.querySelector('.beeslides-thumb-surface')?.replaceWith(this.thumbSurface(slide, w))
        // comment badge tracks doc-level changes too (comments emit 'doc')
        const cmtState = thumbCommentState(slide)
        const badge = item.querySelector('.ed-thumb-cmt')
        if (cmtState && (!badge || badge.classList.contains('check') !== (cmtState === 'check'))) {
          badge?.remove()
          const b = div('ed-thumb-cmt' + (cmtState === 'check' ? ' check' : ''))
          b.title = cmtState === 'check' ? t('{n} to check', { n: slide.comments!.filter((c) => c.agentDone).length }) : t('Open comment(s)')
          item.appendChild(b)
        } else if (!cmtState && badge) {
          badge.remove()
        }
        // click-count badge tracks builds edits (they only emit 'doc')
        const clicks = stepCount(slide)
        const bb = item.querySelector<HTMLElement>('.ed-thumb-builds')
        if (clicks && bb) bb.textContent = this.buildsBadge(clicks).textContent
        else if (clicks) item.appendChild(this.buildsBadge(clicks))
        else bb?.remove()
        // master-link badge — layoutId changes (delete a master, Unlink from
        // master) also only emit 'doc', never 'slides', so this incremental
        // path needs the same add/remove/refresh makeThumb does.
        const link = item.querySelector<HTMLElement>('.ed-thumb-link')
        const master = slide.layoutId ? this.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
        if (master) {
          const title = t('Linked to slide type “{name}” — its fonts and frame apply here; edit the slide type to change them permanently.', { name: master.name ?? t('Untitled') })
          if (link) link.title = title
          else {
            const b = div('ed-thumb-link')
            b.title = title
            item.appendChild(b)
          }
        } else if (link) {
          link.remove()
        }
      })
    }, 150)
  }

  // --- slide ops ------------------------------------------------------------------

  /** "3 clicks" chip for a slide thumbnail — the slide has click builds. */
  private buildsBadge(clicks: number): HTMLElement {
    const b = div('ed-thumb-builds')
    b.textContent = clicks === 1 ? t('1 click') : t('{n} clicks', { n: clicks })
    b.title = t('Click builds: the slide plays out over {n} click(s) while presenting', { n: clicks })
    return b
  }

  private duplicateSlide(i: number) {
    const id = this.store.doc.slides[i]?.id
    if (id) this.duplicateSlides([id])
  }

  /** Duplicate a set of slides in ONE commit (one undo step). A selected
   *  slide brings its interactive states along (re-pointed at the copy, as
   *  are links between them); the copies land together after the last
   *  selected slide's block (past its extras run when a copy is a normal
   *  slide; extras are not copied along) and become the selection. A state selected
   *  without its parent is copied as another state of that same parent. */
  private duplicateSlides(ids: string[]) {
    const newIds = duplicateSlidesInStore(this.store, ids)
    const first = this.store.doc.slides.findIndex((s) => s.id === newIds[0])
    if (first >= 0) this.setSlideSel(newIds, first, newIds[0])
  }

  private deleteSlide(i: number) {
    const id = this.store.doc.slides[i]?.id
    if (id) this.deleteSlides([id])
  }

  /** Delete a set of slides in ONE commit (one undo step): computes the
   *  confirm-dialog text, then routes the actual mutation through
   *  deleteSlidesByIds — the same shared path a section's "delete N slides
   *  too" uses (see that function's doc comment for why this matters). The
   *  surviving neighbour becomes current (store.reconcileView). */
  private deleteSlides(ids: string[]) {
    const doc = this.store.doc
    const live = ids.filter((id) => doc.slides.some((s) => s.id === id))
    if (!live.length) return
    const { doomedIds, states, linkCount, zoomCount } = slidesDeleteImpact(doc, live)
    if (!survivesDeletion(doc, doomedIds)) return this.toast(t('A deck needs at least one slide'))
    const extraStates = states.filter((s) => !live.includes(s.id)).length
    if (extraStates || linkCount || zoomCount) {
      const parts = [
        extraStates ? `${extraStates} interactive state${extraStates > 1 ? 's' : ''} will be deleted with ${live.length > 1 ? 'them' : 'it'}` : '',
        linkCount ? `${linkCount} element link${linkCount > 1 ? 's' : ''} will be cleared` : '',
        zoomCount ? (zoomCount > 1 ? t('{n} zoom tiles will be removed', { n: zoomCount }) : t('1 zoom tile will be removed')) : '',
      ].filter(Boolean).join('; ')
      const q = live.length > 1
        ? t('Delete these {n} slides? {parts}.', { n: String(live.length), parts })
        : t('Delete this slide? {parts}.', { parts })
      if (!window.confirm(q)) return
    }
    deleteSlidesByIds(this.store, live)
  }

  /** ⌘↑/⌘↓ (one place) and ⌘⇧↑/⌘⇧↓ (to the start/end): move the selected
   *  slides in ONE commit, keeping the selection. A slide moves together
   *  with its interactive states, and a state never moves alone — selecting
   *  one moves its parent. A step crosses a section header like any other
   *  token (slideorder.ts stepSlides); a section it empties is removed. */
  private moveSelectedSlides(dir: -1 | 1 | 'start' | 'end') {
    const doc = this.store.doc
    const ids = this.selectedSlideIds()
    const next = stepSlides(doc, ids, dir)
    if (!next) return
    this.store.commit(() => { applyTokens(doc, next) }, 'slides')
    this.revealSlides(ids)
  }

  /** Index just past slide `i`'s block (it and the states that follow it) —
   *  where something inserted "after" it must go, so it never lands between
   *  a parent and its states. When the insert carries a normal slide
   *  (`normal`), also past the rest of the extras run there: hidden slides
   *  after a normal one are ITS extras, so a new slide in front of them
   *  would silently take them over. */
  private afterSlideBlock(i: number, normal = true): number {
    return afterSlideBlock(this.store.doc.slides, i, normal)
  }

  /** Enter / Ctrl+M in the slide panel: a new slide after the current one,
   *  from its own slide type when it follows one, else "Title + content". */
  private newSlideAfterCurrent() {
    if (this.isIconset) {
      const at = this.afterSlideBlock(this.store.currentIndex)
      addOneIcon(this.store, at)
      const id = this.store.doc.slides[at]?.id
      if (id) this.setSlideSel([id], at, id)
      return
    }
    const doc = this.store.doc
    const cur = doc.slides[this.store.currentIndex]
    const parent = cur?.stateOf ? doc.slides.find((s) => s.id === cur.stateOf) : cur
    const linked = parent?.layoutId ? doc.layouts?.find((l) => l.id === parent.layoutId) : undefined
    const layout = linked ?? builtinLayouts(doc.size).find((l) => l.id === 'layout-title-content')
    if (!layout) return
    const at = this.afterSlideBlock(this.store.currentIndex)
    this.insertSlideFromLayout(layout, at, !!linked)
    const id = this.store.doc.slides[at]?.id
    if (id) this.setSlideSel([id], at, id)
  }

  /**
   * Export the deck to PDF via the browser's print pipeline: every linear
   * slide becomes one exact 1600×900 page. Anything outside the linear flow
   * stays off the paper: a state is reachable only through interaction, and a
   * hidden slide is material the audience was not meant to be handed.
   */
  get isFigure(): boolean { return this.store.doc.kind === 'figure' }
  /** An icon set (one icon per slide; DECISIONS "Icon sets"). */
  get isIconset(): boolean { return this.store.doc.kind === 'iconset' }
  /** A figure or an icon set: a drawing, not a deck — no present mode, notes,
   *  transitions or slide types. */
  get isCanvasDoc(): boolean { return this.isFigure || this.isIconset }

  /** The drawing grid in model px (0 = off): an icon set snaps to whole grid units. */
  private gridStep(): number {
    const info = iconsetInfo(this.store.doc)
    if (info) return loadGridPref().iconOn ? info.scale : 0
    return gridStepPx(this.isFigure)
  }

  // --- icon sets (iconsetactions.ts) ---------------------------------------------------

  /** Several icons selected in the slide list → those; one → every icon. */
  private iconTargets(): string[] {
    const sel = this.selectedSlideIds()
    return sel.length > 1 ? sel : this.store.doc.slides.map((s) => s.id)
  }

  /** "Plan with AI": a free-text request → Claude plans the icons. Without
   *  one, a small card asks for it (iconplan.ts) under `anchor`. */
  async planIconsWithAi(request?: string, anchor?: HTMLElement) {
    if (!window.slidomingoDesktop?.sendAgentPrompt) {
      this.toast(t('Drawing with AI needs the BeeSlides desktop app with Claude set up'))
      return
    }
    if (!request?.trim()) {
      this.canvas.commitTextEdit()
      openPlanIcons(anchor ?? this.menuAnchor(), (r) => void this.planIconsWithAi(r))
      return
    }
    this.canvas.commitTextEdit()
    if (planIconsWithAi(this.store, request)) this.toast(t('Claude is planning the icons — check the list, then press Draw with AI'))
  }

  drawIconsWithAi() {
    if (!window.slidomingoDesktop?.sendAgentPrompt) {
      this.toast(t('Drawing with AI needs the BeeSlides desktop app with Claude set up'))
      return
    }
    this.canvas.commitTextEdit()
    const n = drawIconsWithAi(this.store, this.selectedSlideIds())
    this.toast(n ? t('Sent {n} icons to Claude', { n }) : t('Every icon has a drawing — select the icons to redraw'))
  }

  applyIconStyle() {
    this.canvas.commitTextEdit()
    const n = applyIconsetStyle(this.store, this.iconTargets())
    this.toast(n ? t('Restyled {n} shapes', { n }) : t('Every shape already follows the set style'))
  }

  commentOnIcons() {
    const send = !!window.slidomingoDesktop?.sendAgentPrompt
    void commentOnIcons(this.store, this.selectedSlideIds(), send).then((n) => {
      if (n && send) this.toast(this.sentToClaudeMsg(n))
    })
  }

  exportIconSet() {
    this.canvas.commitTextEdit()
    void exportIconSet(this.store, (m) => this.toast(m)).catch((err) =>
      this.toast(t('Export failed: {m}', { m: err instanceof Error ? err.message : String(err) })))
  }

  exportIconSvg() {
    this.canvas.commitTextEdit()
    void exportOneIcon(this.store, (m) => this.toast(m))
  }

  /** The Home ribbon's Icons group (in place of Slides). */
  private iconsetRibbonGroup(): HTMLElement {
    const ai = !!window.slidomingoDesktop?.sendAgentPrompt
    const items = [
      ...(ai ? [tagTool(btn(ICONS.sparkle, t('Plan with AI'), (ev) => void this.planIconsWithAi(undefined, ev.currentTarget as HTMLElement),
        t('Say which icons you need in your own words — Claude plans them as empty icons for you to check')), 'icon-plan')] : []),
      tagTool(btn(ICONS.plus, t('Add icons'), () => this.startIconAdding(), t('Name new icons one after another — each Enter adds one')), 'icon-add'),
      ...(ai
        ? [tagTool(btn(ICONS.paintbrush, t('Draw with AI'), () => this.drawIconsWithAi(),
          t('Claude drafts every empty icon (or the icons selected in the icon list) from native shapes, in the set style')), 'icon-draw')]
        : []),
      tagTool(btn(ICONS.checkCircle, t('Apply set style'), () => this.applyIconStyle(),
        t('Stroke width, caps, joins and ink from the set, on every icon (or the selected ones)')), 'icon-style'),
      tagTool(btn(ICONS.comment, t('Comment on icons'), () => this.commentOnIcons(),
        t('One comment on each icon selected in the icon list — sent to Claude to redraw them')), 'icon-comment'),
    ]
    return ribbonGroup(t('Icons'), items)
  }

  /** The Home ribbon's Icon set group: the style the icons are shown in and
   *  the canvas's aspect ratio, beside Plan with AI and Add icons. */
  private iconsetLookGroup(): HTMLElement {
    return ribbonGroup(t('Style & canvas'), [tagTool(this.iconLookMenu(), 'icon-look'), tagTool(this.iconCanvasMenu(), 'icon-canvas')])
  }

  /** A ribbon dropdown whose label follows the doc: `fill` rebuilds the menu
   *  each time it opens, `label` runs on every look/doc change while the
   *  dropdown is in the page. */
  private liveDropdown(icon: string, tip: string, label: () => string, fill: (menu: HTMLElement, close: () => void) => void): HTMLElement {
    const wrap = div('ed-dropdown')
    const menu = div('ed-menu')
    const close = () => wrap.classList.remove('open')
    const trigger = btn(icon, ' ', () => {
      if (!wrap.classList.toggle('open')) return
      menu.replaceChildren()
      fill(menu, close)
    }, tip)
    trigger.insertAdjacentHTML('beforeend', `<span class="ed-caret ed-caret-chevron">${ICONS.chevronDown}</span>`)
    // the label IS the choice: it stays when the ribbon drops labels to fit
    trigger.dataset.keepLabel = ''
    // a style's name is the user's: set as text, never markup
    const text = trigger.querySelector('span')!
    let seen = false
    const relabel = () => {
      if (!wrap.isConnected && seen) { off.forEach((f) => f()); return }
      seen ||= wrap.isConnected
      text.textContent = label()
    }
    text.textContent = label()
    const off = [this.store.on('look', relabel), this.store.on('doc', relabel)]
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => { if (!wrap.contains(ev.target as Node)) close() })
    return wrap
  }

  /** Style ▾: show the icons as drawn or in one of the set's styles (store.iconLook). */
  private iconLookMenu(): HTMLElement {
    return this.liveDropdown(ICONS.eye, t('Show the icons in one of the set’s styles — a style only repaints, nothing is redrawn'),
      () => this.store.shownLook?.name ?? t('As drawn'),
      (menu, close) => {
        const shown = this.store.shownLook?.id ?? null
        const sid = this.store.slide.id
        const pick = (name: string, id: string | null, title: string, tweaked = false) => {
          const b = btn('', '', () => { close(); this.store.showLook(id) }, title)
          b.textContent = name + (tweaked ? ' •' : '') // a style's name is the user's: never markup
          if (id === shown) b.classList.add('ed-menu-on')
          menu.appendChild(b)
        }
        pick(t('As drawn'), null, t('The icon as drawn, in the set style'))
        // a dot: this icon is painted its own way in that style (IconLook.tweaks)
        for (const l of this.store.doc.iconset?.variants ?? []) {
          const tweaked = !!l.tweaks?.[sid]
          pick(l.name, l.id, tweaked
            ? t('Show the icons in “{name}” — this icon has its own changes in it', { name: l.name })
            : t('Show the icons in “{name}” — select a shape to paint it its own way in this style', { name: l.name }), tweaked)
        }
        menu.appendChild(div('ed-menu-sep'))
        menu.appendChild(btn('', t('Add or edit styles…'), () => { close(); this.revealPanelSection('Styles') }))
      })
  }

  /** Canvas ▾: the set's aspect ratio (iconset.ts ICON_CANVASES). */
  private iconCanvasMenu(): HTMLElement {
    const nameOf = (id: IconCanvasId) => id === '1:1' ? t('Square', undefined, 'canvas') : id === '3:4' ? `3:4 ${t('Portrait')}` : id
    return this.liveDropdown(ICONS.rect, t('The icon canvas: square or another aspect ratio — every icon in the set shares it'),
      () => {
        const info = iconsetInfo(this.store.doc)
        const id = info && iconCanvasId(info)
        return id ? nameOf(id) : info ? `${info.grid} × ${info.gridH}` : ''
      },
      (menu, close) => {
        const info = iconsetInfo(this.store.doc)
        if (!info) return
        const on = iconCanvasId(info)
        for (const c of ICON_CANVASES) {
          const u = iconCanvasUnits(info, c.id)
          const b = btn('', `${nameOf(c.id)} — ${u.w} × ${u.h}`, () => { close(); this.setIconCanvas(c.id) })
          if (c.id === on) b.classList.add('ed-menu-on')
          menu.appendChild(b)
        }
      })
  }

  setIconCanvas(id: IconCanvasId) {
    this.canvas.commitTextEdit()
    if (!setIconCanvas(this.store, id)) return
    const info = iconsetInfo(this.store.doc)
    if (info) this.toast(t('Canvas: {w} × {h} units — the drawings stay centred', { w: info.grid, h: info.gridH }))
  }

  /** The ribbon's Export dropdown in an icon set. */
  private iconsetExportMenu(labelled: boolean): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.download, labelled ? t('Export set') : '', () => wrap.classList.toggle('open'),
      iconExportTip(this.store.doc))
    const menu = div('ed-menu')
    menu.appendChild(btn(ICONS.download, t('Export icon set…'), () => { wrap.classList.remove('open'); this.exportIconSet() }))
    menu.appendChild(btn(ICONS.download, t('Export this icon as SVG…'), () => { wrap.classList.remove('open'); this.exportIconSvg() }))
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => { if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open') })
    return wrap
  }

  /** Figure mode's export: vector PDF at the figure's exact size, or SVG (text kept as text, or outlined). */
  async exportFigure(kind: 'pdf' | 'svg' | 'svg-outlined') {
    this.canvas.commitTextEdit()
    const doc = this.store.doc
    try {
      if (kind === 'pdf') {
        if (!(await exportFigureAsPdfDesktop(doc, (m) => this.toast(m)))) this.exportPdf()
      } else {
        await exportFigureAsSvg(doc, { outlineText: kind === 'svg-outlined' }, (m) => this.toast(m))
      }
    } catch (err) {
      this.toast(t('Export failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** The ribbon's "Export Figure" dropdown. */
  private figureExportMenu(labelled: boolean): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.pdf, labelled ? t('Export Figure') : '', () => wrap.classList.toggle('open'),
      t('Export the figure as vector PDF or SVG at its exact size'))
    const menu = div('ed-menu')
    const entry = (icon: string, label: string, kind: 'pdf' | 'svg' | 'svg-outlined') =>
      menu.appendChild(btn(icon, label, () => { wrap.classList.remove('open'); void this.exportFigure(kind) }))
    entry(ICONS.pdf, t('PDF (vector)'), 'pdf')
    entry(ICONS.download, t('SVG'), 'svg')
    entry(ICONS.download, t('SVG, text as outlines'), 'svg-outlined')
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => { if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open') })
    return wrap
  }

  /** Crop the figure canvas to its content plus a 2 mm margin. */
  fitFigureToContent() {
    fitCanvasToContent(this.store, (2 * 96) / 25.4, (m) => this.toast(m))
  }

  async exportPdf() {
    if (this.layoutManagerOpen) { this.toast(t('Close the Layout Manager to export PDF')); return }
    this.canvas.commitTextEdit()
    if (!this.isFigure && (await exportDeckAsPdfDesktop(this.store.doc, (m) => this.toast(m)))) return
    document.getElementById('beeslides-print')?.remove()
    const box = div('')
    box.id = 'beeslides-print'
    // page geometry follows the deck's aspect (width normalised to 1600)
    // A figure prints 1:1 at its own size (no 1600px normalisation): the page IS the figure.
    const fig = this.isFigure
    const pageW = fig ? this.store.doc.size.width : 1600
    const pageH = fig ? this.store.doc.size.height : Math.round((1600 * this.store.doc.size.height) / this.store.doc.size.width)
    const pageCss = document.createElement('style')
    pageCss.textContent = `@page { size: ${pageW}px ${pageH}px; margin: 0; } #beeslides-print .bp-page { width: ${pageW}px; height: ${pageH}px; }` +
      (fig ? ' #beeslides-print .bp-page { page-break-after: auto; break-after: auto; }' : '')
    box.appendChild(pageCss)
    for (const slide of this.store.doc.slides) {
      if (!inLinearFlow(slide)) continue
      const page = div('bp-page')
      const surface = renderSlide(slide, this.store.doc, { svgAsImage: true, hidePlaceholders: true, inlineData: true, stillTrails: true })
      // normalise to the print page size regardless of doc size
      const s = pageW / this.store.doc.size.width
      surface.style.transformOrigin = '0 0'
      if (s !== 1) surface.style.transform = `scale(${s})`
      page.appendChild(surface)
      box.appendChild(page)
    }
    document.body.appendChild(box)
    const cleanup = () => {
      box.remove()
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // give the freshly-inserted images a beat to decode before printing
    setTimeout(() => window.print(), 250)
  }

  // --- present & save ------------------------------------------------------------------

  /** Open the speaker view now (a launcher twin of the Slide-panel button) so it
   *  can be placed on a second screen before presenting — present mode adopts it. */
  private openSpeakerWindowForShow(): boolean {
    return !!openSpeakerWindow(
      `${this.store.doc.title} — ${t('Speaker view')}`,
      speakerIdleBody(this.store.doc.title, t('Starting…')),
    )
  }

  openSpeakerView() {
    const w = openSpeakerWindow(
      `${this.store.doc.title} — ${t('Speaker view')}`,
      speakerIdleBody(this.store.doc.title, t('Notes, controls and slide thumbnails appear here when you start presenting. Drag this window to your second display.')),
    )
    if (!w) this.toast(t('Couldn’t open the speaker view — allow pop-ups for this site.'))
  }

  /** `withSpeaker` = false: desktop one-screen rehearsal — fullscreen where the window is, no speaker view.
   *  `kiosk`: the show runs by itself from the start (K toggles it in the show either way). */
  async present(fromStart = false, fullscreen = true, withSpeaker = true, kiosk?: { seconds: number; loop: boolean }) {
    if (this.presenting) return
    if (this.isFigure) { this.toast(t('A figure has nothing to present — export it as PDF or SVG')); return }
    if (this.isIconset) { this.toast(t('An icon set has nothing to present — export it as SVG')); return }
    if (this.layoutManagerOpen) { this.toast(t('Close the Layout Manager to present')); return }
    // They've started a slideshow — retire the first-run nudge for good.
    lsSet('slidomingo-slideshow-started', '1')
    document.querySelector('.ed-hint-pulse')?.classList.remove('ed-hint-pulse')
    this.canvas.commitTextEdit()
    this.presenting = true
    // Desktop: main puts the slides on the audience display and tells us to
    // open the speaker view (2+ displays). Both happen before the show starts;
    // present mode adopts the open speaker window.
    const desk = window.slidomingoDesktop
    const placed = !!(fullscreen && desk?.presentBegin && withSpeaker)
    if (placed) {
      let speaker = false
      try { speaker = (await desk!.presentBegin!()).speaker } catch { /* present on this display */ }
      if (speaker && !this.openSpeakerWindowForShow()) this.toast(t('Couldn’t open the speaker view'))
    }
    this.flushMenuSync()
    this.miniToolbar.update()
    this.quickBar.update()
    // Edits made while the show runs (Claude, a reload from disk, undo) reach
    // it live: the show presents its own copy and takes each new state, a
    // beat after the last change so a burst of writes lands as one.
    let liveTimer = 0
    let stopLive = () => {}
    const session = startPresentation(this.store.doc, fromStart ? 0 : this.store.currentIndex, (last) => {
      stopLive()
      this.presenting = false
      if (placed) void desk!.presentEnd?.()
      this.flushMenuSync()
      this.store.goTo(last)
      this.canvas.render()
      this.miniToolbar.update()
      this.quickBar.update()
    }, { fullscreen, kiosk })
    const offDoc = this.store.on('doc', () => {
      clearTimeout(liveTimer)
      liveTimer = window.setTimeout(() => session.update(this.store.doc), LIVE_EDIT_SETTLE_MS)
    })
    stopLive = () => { offDoc(); clearTimeout(liveTimer) }
  }

  // --- menu commands (native menu bar on desktop) ---------------------------------
  //
  // editor/menumodel.ts is the catalog; every command below is a one-line call
  // into a method that already existed (or was extracted from an inline
  // closure the ribbon/Save ▾ used) — see docs/DECISIONS.md 2026-10-06.

  private ribbonToggle: (() => void) | null = null
  private ribbonCollapsed: () => boolean = () => false
  /** Buttons mirroring the safe-zone state (ribbon, View dropdown), with the class that shows "on". */
  private safeZoneBtns: Array<{ el: HTMLElement; cls: string }> = []
  private menuAnchorEl: HTMLElement | null = null
  private menuSyncTimer = 0
  private menuSyncLast = ''

  /** A 1px element at the top-centre of the canvas, for popovers that anchor
   *  to a button (icons, objects, library, layout picker) when a menu item —
   *  not a button — started them. */
  private menuAnchor(): HTMLElement {
    const a = this.menuAnchorEl ?? (this.menuAnchorEl = div('ed-menu-anchor'))
    const r = this.canvasWrap.getBoundingClientRect()
    a.style.cssText = `position:fixed;width:1px;height:1px;pointer-events:none;left:${Math.round(r.left + r.width / 2)}px;top:${Math.round(r.top + 8)}px`
    if (!a.isConnected) document.body.appendChild(a)
    return a
  }

  alignSelection(edge: AlignEdge) {
    const els = this.store.selectedElements
    if (els.length) this.panel.align(els, edge)
  }

  centerSelectionOnSlide() {
    const els = this.store.selectedElements
    if (els.length) this.panel.centerOnSlide(els)
  }

  /** Arrange ▸ Align ▸ Relative to slide (the panel's "Align to" switch). */
  toggleAlignToSlide() {
    this.panel.alignRef = this.panel.alignRef === 'slide' ? 'selection' : 'slide'
    this.toast(this.panel.alignRef === 'slide' ? t('Align and distribute: relative to the slide') : t('Align and distribute: relative to the selection'))
  }

  private alignRefBtns: HTMLElement[] = []
  private syncAlignRefButtons() {
    const on = this.panel.alignRef === 'slide'
    for (const el of this.alignRefBtns) {
      el.classList.toggle('ed-btn-armed', on)
      el.setAttribute('aria-pressed', String(on))
    }
  }

  distributeSelection(axis: 'x' | 'y') {
    const els = this.store.selectedElements
    if (els.length) this.panel.distribute(els, axis)
  }

  groupSelection(group: boolean) {
    const els = this.store.selectedElements
    if (!els.length) return
    if (group) this.panel.group(els)
    else this.panel.ungroup(els)
  }

  private saveSlideAsType() {
    void this.panel.promptSaveSlideAsLayout()
  }

  /** "Slide settings…" — reveals the Format panel, which owns them. */
  private openSlideSettings() {
    if (this.props.classList.contains('ed-collapsed')) this.togglePanel('right')
  }

  /** Hide / show every selected slide (states skipped) in ONE commit — one
   *  undo step. A hidden slide directly after a normal one becomes one of its
   *  "extras" (X while presenting), so this is how a set of slides is marked
   *  as backup material. Emits 'slides': the sidebar nesting depends on the
   *  neighbours, not just the slide itself. */
  setSlidesHidden(on: boolean) {
    const want = new Set(this.selectedSlideIds())
    const targets = this.store.doc.slides.filter((s) => want.has(s.id) && !s.stateOf)
    if (!targets.length) return
    this.store.commit(() => {
      for (const s of targets) {
        if (on) s.hidden = true
        else delete s.hidden
      }
    }, 'slides')
  }

  private setTransition(kind: TransitionKind) {
    this.store.commit(() => { setSlideTransition(this.store.slide, kind) })
  }

  private sendOpenComments() {
    const n = sendCommentsToClaude(this.store)
    if (n) this.toast(this.sentToClaudeMsg(n))
  }

  private removeFilePassword() {
    setEncryptionPassword(null)
    this.toast(t('Password removed — the next save writes an unencrypted file'))
    void this.save(false)
    this.scheduleMenuSync()
  }

  private changeLocale(code: string) {
    setLocale(code)
    // switching to (or away from) Arabic/Hebrew/… turns the chrome around
    applyDirection()
    this.build()
    this.customizer?.refresh()
    this.rebuildSidebar()
    this.flushMenuSync(true)
  }

  toggleSafeZone() {
    this.canvas.toggleSafeZone()
    this.syncSafeZoneButtons()
    this.scheduleMenuSync()
  }

  /** Buttons mirroring the click-step badge toggle (View dropdown, ribbon), with the class that shows "on". */
  private buildBadgeBtns: Array<{ el: HTMLElement; cls: string }> = []

  private buildBadgeButton(onClass: string): HTMLElement {
    const el = btn(ICONS.slideshow, t('Click step badges'), () => this.toggleBuildBadges(),
      t('Show a numbered chip on every element that arrives or leaves on a click (also shown while the Presenting or Builds panel is open)'))
    this.buildBadgeBtns.push({ el, cls: onClass })
    return el
  }

  toggleBuildBadges() {
    this.canvas.toggleBuildBadges()
    this.syncBuildBadgeButtons()
    this.scheduleMenuSync()
  }

  private syncBuildBadgeButtons() {
    for (const { el, cls } of this.buildBadgeBtns) el.classList.toggle(cls, this.canvas.showBuildBadges)
  }

  private syncSafeZoneButtons() {
    for (const { el, cls } of this.safeZoneBtns) el.classList.toggle(cls, this.canvas.showSafeZone)
  }

  private gridBtns: Array<{ el: HTMLElement; cls: string }> = []

  /** Re-apply the saved Grid & Snap preference to the canvas and every control showing it. */
  private applyGridPref() {
    this.canvas.setGridPref(loadGridPref(), this.gridStep())
    this.syncGridControls()
    document.dispatchEvent(new CustomEvent(GRID_PREF_EVENT)) // an open Grid & Snap panel follows ⌘G etc.
    // the Figure panel's own Grid select reads the same preference
    if (this.isFigure) this.panel.refresh()
    this.scheduleMenuSync()
  }

  toggleGrid() {
    const p = loadGridPref()
    const key = gridOnKey(this.isIconset)
    saveGridPref({ ...p, [key]: !p[key] })
    this.applyGridPref()
  }

  private togglePrefFlag(key: 'showGuides' | 'showLayout') {
    const p = loadGridPref()
    saveGridPref({ ...p, [key]: !p[key] })
    this.applyGridPref()
  }

  private syncGridControls() {
    const on = this.canvas.gridOn
    for (const { el, cls } of this.gridBtns) el.classList.toggle(cls, on)
  }

  private gridButton(onClass: string): HTMLElement {
    const el = btn(ICONS.grid, t('Grid'), () => this.toggleGrid(),
      t('Show a drawing grid and snap moves, drawing and line endpoints to it (G groups; ⌘G toggles the grid)'))
    this.gridBtns.push({ el, cls: onClass })
    return el
  }

  /** The ribbon's [ Grid |▾]: the left half toggles the grid (⌘G), the caret opens Grid & Snap. */
  private gridSplitButton(): HTMLElement {
    const wrap = div('ed-ribbon-split')
    const caret: HTMLElement = btn(ICONS.chevronDown, '', () => this.openGridSnap(wrap),
      t('Grid spacing, column grid, guides — and what things snap to'))
    caret.classList.add('ed-ribbon-split-caret')
    wrap.append(this.gridButton('ed-btn-armed'), caret)
    return wrap
  }

  /** The Grid & Snap panel under `anchor` (a control, or the canvas corner for menu commands). */
  openGridSnap(anchor?: HTMLElement) {
    this.canvas.commitTextEdit()
    const r = this.canvas.viewportRect()
    openGridSnapPanel(anchor ?? new DOMRect(r.left + 12, r.top + 8, 0, 0), {
      store: this.store,
      isFigure: this.isFigure,
      safeZoneShown: () => this.canvas.showSafeZone,
      toggleSafeZone: () => this.toggleSafeZone(),
      applyPref: () => this.applyGridPref(),
      selectionBox: () => {
        const els = this.store.selectedElements
        if (!els.length) return null
        const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
        const r2 = Math.max(...els.map((e) => e.x + e.w)), b = Math.max(...els.map((e) => e.y + e.h))
        return { x, y, w: r2 - x, h: b - y }
      },
      addGuides: (xs, ys) => {
        if (!loadGridPref().showGuides) this.togglePrefFlag('showGuides')
        this.canvas.addGuides(xs, ys)
      },
    })
  }

  private safeZoneButton(el: HTMLElement, onClass: string): HTMLElement {
    this.safeZoneBtns.push({ el, cls: onClass })
    return el
  }

  private registerCommands() {
    const reg = (id: string, run: () => void, o: { enabled?: () => boolean; checked?: () => boolean; visible?: () => boolean; menuLabel?: () => string | undefined } = {}) =>
      this.commands.register(id, { run, ...o })
    const slidesOnly = () => !this.isCanvasDoc
    // decks and icon sets: a slide list, the sorter, comments to Claude
    const withList = () => !this.isFigure
    const iconset = () => this.isIconset
    const noLM = () => !this.layoutManagerOpen
    const deckOnly = () => !this.templateMode
    const hasSel = () => this.store.selectedElements.length > 0
    this.commands.blocked = () => this.presenting

    reg('app.settings', () => { this.canvas.commitTextEdit(); this.openSettings() })

    reg('file.save', () => void this.save(false))
    reg('file.saveCopy', () => void this.save(true))
    reg('file.duplicate', () => void this.saveAsNewDeck(), { visible: deckOnly })
    reg('file.newFromLayout', () => void this.newDeckFromTemplate(), { visible: () => this.templateMode })
    reg('file.saveLayout', () => void this.saveAsTemplate(), { visible: deckOnly })
    reg('file.copyLayout', () => void this.saveAsTemplate(), { visible: () => this.templateMode })
    reg('file.presentOnly', () => void this.savePresentationPackage(), { visible: deckOnly })
    reg('file.pwSet', () => void this.setFilePassword(), { visible: () => deckOnly() && !isEncryptionActive() })
    reg('file.pwChange', () => void this.setFilePassword(), { visible: () => deckOnly() && isEncryptionActive() })
    reg('file.pwRemove', () => this.removeFilePassword(), { visible: () => deckOnly() && isEncryptionActive() })
    reg('file.history', () => void this.openVersionHistory())
    reg('file.importPptx', () => this.importPowerPoint())
    reg('file.importMarkdown', () => this.importMarkdown())
    reg('file.replaceJson', () => this.openReplaceJson())
    reg('file.exportPdf', () => this.exportPdf(), { visible: () => slidesOnly() && deckOnly(), enabled: noLM })
    reg('file.exportFigurePdf', () => void this.exportFigure('pdf'), { visible: () => this.isFigure })
    reg('file.exportFigureSvg', () => void this.exportFigure('svg'), { visible: () => this.isFigure })
    reg('file.exportFigureSvgOutlined', () => void this.exportFigure('svg-outlined'), { visible: () => this.isFigure })
    reg('file.exportIconSet', () => this.exportIconSet(), { visible: iconset })
    reg('file.exportIconSvg', () => this.exportIconSvg(), { visible: iconset })
    reg('file.copyJson', () => void this.copyDocJson())
    reg('file.copyJsonLight', () => void this.copyDocJson(true))
    reg('file.scratch', () => this.startFromScratch(), { visible: slidesOnly })

    reg('edit.undo', () => this.undo())
    reg('edit.redo', () => this.redo())
    reg('edit.formatPainter', () => this.toggleFormatPainter())
    reg('edit.reapply', () => this.toggleReapplyChange())
    reg('edit.copySpecial', () => this.openCopySpecial())
    reg('edit.copyAsPowerPoint', () => this.copyAs('powerpoint'), { enabled: () => canCopyFormat('powerpoint') })
    reg('edit.copyAsPicture', () => this.copyAs('picture'))
    reg('edit.copyAsPng', () => this.copyAs('png'))
    reg('edit.copyAsSvg', () => this.copyAs('svg'))
    reg('edit.copyAsSvgCode', () => this.copyAs('svgCode'))
    reg('edit.copyAsHtml', () => this.copyAs('html'))
    reg('edit.copySettings', () => this.openSettings('copy'))
    reg('edit.find', () => this.openFind(false), { enabled: noLM })
    reg('edit.replace', () => this.openFind(true), { enabled: noLM })
    const oneTable = () => this.store.selectedElements.length === 1 && this.store.selectedElements[0].type === 'table'
    for (const [op] of TABLE_OPS) {
      reg(`table.${op}`, () => { this.canvas.tableRange.run(op) }, { visible: oneTable, enabled: () => this.canvas.tableRange.can(op) })
    }

    // an icon set exports shapes only (iconset.ts iconSlideSvg)
    const notIcons = () => !iconset()
    reg('insert.text', () => insertText(this.store, this.canvas), { visible: notIcons })
    reg('insert.image', () => pickImage(this.store, this.canvas), { visible: notIcons })
    reg('insert.icons', () => openIconSearchPopover(this.store, this.menuAnchor(), (el) => this.canvas.insert(el)), { visible: notIcons })
    reg('insert.mediaFile', () => pickMedia(this.store, this.canvas), { visible: notIcons })
    reg('insert.videoLink', () => promptMediaUrl(this.store, this.canvas, 'video'), { visible: notIcons })
    reg('insert.audioLink', () => promptMediaUrl(this.store, this.canvas, 'audio'), { visible: notIcons })
    reg('insert.table', () => insertTable(this.store, this.canvas), { visible: notIcons })
    reg('insert.chart', () => insertChart(this.store, this.canvas), { visible: notIcons })
    reg('insert.code', () => insertCode(this.store, this.canvas), { visible: notIcons })
    reg('insert.embed', () => insertEmbed(this.canvas), { visible: notIcons })
    reg('insert.math', () => insertMath(), { visible: notIcons })
    reg('insert.objects', () => openReusableObjectPicker(this.store, this.menuAnchor()))
    reg('insert.saveSelection', () => void openSaveSelectionDialog(this.store, this.store.selectedElements), { enabled: hasSel })
    reg('insert.library', () => openLibraryPanel(this.store, this.menuAnchor()))
    reg('insert.comment', () => this.canvas.toggleCommentMode(), { enabled: noLM })
    reg('insert.zoom', () => pickSlideZoom(this.store, this.canvas), { visible: slidesOnly, enabled: noLM })
    reg('insert.summaryZoom', () => pickSummaryZoom(this.store), { visible: slidesOnly, enabled: noLM })
    SHAPE_MENU.forEach((item, i) => reg(`insert.shape.${i}`, () => insertShape(this.store, this.canvas, item)))
    for (const preset of SHAPE_PRESETS) reg(`insert.preset.${preset.id}`, () => insertPresetShape(this.store, this.canvas, preset))

    reg('slide.new', () => this.openLayoutPicker(this.menuAnchor()), { visible: slidesOnly, enabled: noLM })
    reg('slide.changeType', () =>
      document.dispatchEvent(new CustomEvent('slidomingo:apply-layout', { detail: { anchor: this.menuAnchor() } })),
      { visible: slidesOnly, enabled: noLM })
    reg('slide.saveType', () => this.saveSlideAsType(), { visible: slidesOnly, enabled: noLM })
    reg('slide.layoutManager', () => this.openLayoutManager(), { visible: slidesOnly })
    reg('slide.settings', () => this.openSlideSettings(), { visible: slidesOnly })
    reg('slide.hide', () => this.setSlidesHidden(!this.store.slide.hidden), {
      visible: slidesOnly,
      enabled: noLM,
      checked: () => !!this.store.slide?.hidden,
    })
    reg('icon.plan', () => void this.planIconsWithAi(), { visible: () => iconset() && !!window.slidomingoDesktop?.sendAgentPrompt })
    reg('icon.add', () => this.startIconAdding(), { visible: iconset })
    reg('icon.draw', () => this.drawIconsWithAi(), { visible: () => iconset() && !!window.slidomingoDesktop?.sendAgentPrompt })
    reg('icon.applyStyle', () => this.applyIconStyle(), { visible: iconset })
    reg('icon.comment', () => this.commentOnIcons(), { visible: iconset })
    for (const kind of TRANSITION_KINDS) {
      reg(`slide.transition.${kind}`, () => this.setTransition(kind), {
        visible: slidesOnly,
        enabled: noLM,
        checked: () => (this.store.slide.transition ?? 'none') === kind,
      })
    }

    const EDGES = { left: 'left', centerX: 'centerX', right: 'right', top: 'top', middleY: 'middleY', bottom: 'bottom' } as const
    for (const edge of Object.keys(EDGES) as Array<keyof typeof EDGES>) {
      reg(`arrange.${edge}`, () => this.alignSelection(edge), { enabled: hasSel })
    }
    // a figure or icon set aligns to its canvas
    reg('arrange.centerSlide', () => this.centerSelectionOnSlide(), { enabled: hasSel, menuLabel: () => (this.isCanvasDoc ? 'Center on canvas' : undefined) })
    reg('arrange.toSlide', () => this.toggleAlignToSlide(), { checked: () => this.panel.alignRef === 'slide', menuLabel: () => (this.isCanvasDoc ? 'Relative to canvas' : undefined) })
    reg('arrange.distX', () => this.distributeSelection('x'), { enabled: hasSel })
    reg('arrange.distY', () => this.distributeSelection('y'), { enabled: hasSel })
    reg('arrange.group', () => this.groupSelection(true), { enabled: hasSel })
    reg('arrange.ungroup', () => this.groupSelection(false), { enabled: hasSel })

    reg('view.sorter', () => this.openSlideSorter(), { visible: withList, enabled: noLM, menuLabel: () => (iconset() ? 'All icons' : undefined) })
    reg('view.panelSlides', () => this.togglePanel('left'), { visible: withList, checked: () => !this.sidebar.classList.contains('ed-collapsed'), menuLabel: () => (iconset() ? 'Icons' : undefined) })
    // an icon set's Slide menu holds the icon commands (menumodel.ts)
    this.commands.menuTitle = (key) => (key === 'slide' && iconset() ? 'Icons' : undefined)
    reg('view.panelFormat', () => this.togglePanel('right'), { checked: () => !this.props.classList.contains('ed-collapsed') })
    reg('view.panelNotes', () => this.toggleNotes(), { visible: slidesOnly, checked: () => !this.notesPane.el.classList.contains('ed-collapsed') })
    reg('view.safeZone', () => this.toggleSafeZone(), { checked: () => !!this.canvas?.showSafeZone })
    reg('view.buildBadges', () => this.toggleBuildBadges(), { visible: slidesOnly, checked: () => !!this.canvas?.showBuildBadges })
    reg('view.grid', () => this.toggleGrid(), { checked: () => !!this.canvas?.gridOn })
    reg('view.gridSnap', () => this.openGridSnap())
    reg('view.guides', () => this.togglePrefFlag('showGuides'), { checked: () => loadGridPref().showGuides })
    reg('view.layoutGrid', () => this.togglePrefFlag('showLayout'), {
      enabled: () => !!this.store.doc.layoutGrid,
      checked: () => !!this.store.doc.layoutGrid && loadGridPref().showLayout,
    })
    reg('view.checkDeck', () => this.openDeckCheck(), { visible: notIcons })
    reg('view.ribbon', () => this.ribbonToggle?.(), { visible: () => this.ribbonToggle !== null, checked: () => !this.ribbonCollapsed() })
    reg('view.customize', () => { this.canvas.commitTextEdit(); this.openSettings('customize') })
    for (const c of localeChoices()) reg(`view.lang.${c.code}`, () => this.changeLocale(c.code))

    reg('play.slideshow', () => this.present(false, true), { visible: slidesOnly })
    reg('play.inTab', () => this.present(false, false), { visible: slidesOnly })
    reg('play.kiosk', () => {
      const p = this.store.doc.present
      void this.present(true, true, false, { seconds: p?.autoAdvance ?? 10, loop: p?.loop ?? true })
    }, { visible: slidesOnly })
    reg('play.noSpeaker', () => this.present(false, true, false), { visible: () => slidesOnly() && !!window.slidomingoDesktop?.presentBegin })
    reg('play.sendComments', () => this.sendOpenComments(), {
      visible: () => withList() && !!window.slidomingoDesktop?.sendAgentPrompt,
      enabled: () => commentStats(this.store.doc).openCount > 0,
    })

    reg('help.shortcuts', () => this.openHelp())
    reg('help.keymap', () => { this.canvas.commitTextEdit(); this.openSettings('shortcuts') })
  }

  /** Re-send the menu model when anything it depends on changes. */
  private wireMenuSync() {
    if (!window.slidomingoDesktop?.setMenuModel) return
    for (const ev of ['selection', 'current', 'doc'] as const) this.store.on(ev, () => this.scheduleMenuSync())
    // main keeps the last model per window, but state can change without a
    // store event (a window switch, a panel drag) — refresh on every focus
    window.addEventListener('focus', () => this.flushMenuSync(true))
    this.flushMenuSync(true)
  }

  /** Debounced (~100 ms) — selection and doc events come in bursts. */
  private scheduleMenuSync() {
    if (!window.slidomingoDesktop?.setMenuModel) return
    clearTimeout(this.menuSyncTimer)
    this.menuSyncTimer = window.setTimeout(() => this.flushMenuSync(), 100)
  }

  private flushMenuSync(force = false) {
    const api = window.slidomingoDesktop
    if (!api?.setMenuModel) return
    clearTimeout(this.menuSyncTimer)
    const model = this.menuModel()
    const json = JSON.stringify(model)
    if (!force && json === this.menuSyncLast) return
    this.menuSyncLast = json
    api.setMenuModel(model)
  }

  /** The model the native menu is drawn from (also the e2e/scripting handle). */
  menuModel() {
    return this.commands.serialize()
  }

  /**
   * The browser menu bar's stand-ins for the blocks desktop MAIN owns
   * (menumodel.ts `{ slot }`, desktop menu.ts SLOTS). Each is an existing
   * Editor method or nothing: New Window / New Layout / Recent / Start Page,
   * Close / Quit, UI zoom (the browser's own), the Claude terminal & chats,
   * Developer and the Window menu have no browser equivalent and are left
   * out — never a silent no-op.
   */
  private webMenuSlot(name: string, model: MenuModel): BarItem[] {
    const live = !this.presenting
    switch (name) {
      case 'file-open':
        // File System Access only (Chromium); elsewhere a deck opens by drop
        return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
          ? [{ label: model.labels['Open…'] ?? t('Open…'), accel: 'CmdOrCtrl+O', enabled: live, run: () => void this.openViaPicker() }]
          : []
      case 'edit-roles':
        // the roles' web equivalents: Cut/Copy fire the same copy/cut events
        // the keys do (wireCopy, or a text field's own); Paste reads the
        // clipboard like the context menu's Paste
        return [
          { label: t('Cut'), accel: 'CmdOrCtrl+X', enabled: live, run: () => { document.execCommand('cut') } },
          { label: t('Copy'), accel: 'CmdOrCtrl+C', enabled: live, run: () => { document.execCommand('copy') } },
          // (in a field or text edit: just the words, at the caret)
          { label: t('Paste'), accel: 'CmdOrCtrl+V', enabled: live, run: () => void this.pasteFromClipboardAsync({ plain: this.textOwnsClipboard() }) },
          { label: model.labels['Paste without Design'] ?? t('Paste without Design'), accel: 'CmdOrCtrl+Shift+V', enabled: live,
            run: () => void this.pasteFromClipboardAsync({ plain: true }) },
        ]
      case 'file-quit': {
        // no app menu in a browser: Settings… closes File, as on Windows/Linux
        const app = model.menus.find((m) => m.key === 'app')?.items ?? []
        return [{ type: 'separator' }, ...(app as BarItem[])]
      }
      case 'help-links':
        return [{ type: 'separator' }, {
          label: model.labels['BeeSlides on GitHub'] ?? t('BeeSlides on GitHub'), enabled: true,
          run: () => { window.open('https://github.com/miqsoft/beeslides', '_blank', 'noopener') },
        }]
      default:
        return []
    }
  }

  /** The per-install UI profile (editor/customize/): applied now, again on
   *  every change (this window, another window, an AI), after every rebuild. */
  private wireCustomizer() {
    const profiles = new UiProfileStore()
    const customizer = new UiCustomizer({
      store: this.store,
      commands: this.commands,
      ribbon: () => this.ribbonHandle,
      webSlot: () => this.myToolsSlot,
      commitTextEdit: () => this.canvas.commitTextEdit(),
      blocked: () => this.presenting || this.layoutManagerOpen,
      menuChanged: () => this.scheduleMenuSync(),
      minibarChanged: () => { this.miniToolbar?.invalidate(); this.quickBar?.invalidate() },
      panelChanged: () => this.panel?.refresh(),
      toast: (m) => this.toast(m),
      openCustomize: () => this.openSettings('customize'),
    }, profiles)
    this.customizer = customizer
    profiles.onChange((c) => customizer.onChange(c))
    customizer.refresh()
    document.addEventListener('pointerdown', (ev) => {
      const slot = this.myToolsSlot
      if (slot && !slot.contains(ev.target as Node)) slot.classList.remove('open')
    })
  }

  /** Scripting/e2e handle for the UI profile — `window.beeslides.uiProfile`. */
  uiProfileApi() {
    const c = this.customizer!
    return {
      get: () => c.profiles.current(),
      active: () => c.active,
      write: (p: unknown, summary = '') => c.profiles.write(p as UiProfile | null, 'settings', summary),
      validate: (p: unknown) => validateProfile(p, 'strict'),
      history: () => c.profiles.history(),
      revert: (rev: number) => c.profiles.revert(rev),
      reset: () => c.profiles.reset(),
      run: (target: string) => c.runTarget(target),
    }
  }

  // --- paste: external objects + cross-deck elements/slides ---------------------

  private wirePaste() {
    // A dropped .beeslides.html OPENS as a deck (and adopts a writable handle);
    // anything else falls through to the existing image/media drop behaviour.
    document.addEventListener('dragover', (ev: DragEvent) => {
      if ([...(ev.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) ev.preventDefault()
    })
    document.addEventListener('drop', (ev: DragEvent) => { void this.openDroppedDeck(ev) })

    // ⌘⇧V / Ctrl+Shift+V: "paste without design". Only ARMS the flag — the
    // paste event itself still comes from the browser default (or, in the
    // desktop app, the Edit menu's pasteAndMatchStyle; menu.ts), so nothing
    // is prevented here. Capture phase: a text edit's own keydown handlers
    // run before any bubbling listener could see the key.
    document.addEventListener('keydown', (ev) => {
      if (!((ev.metaKey || ev.ctrlKey) && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'v')) return
      if (this.presenting) return
      armPlainPaste()
      // Chrome and Safari on macOS bind Paste and Match Style to ⌥⇧⌘V, so a
      // browser there fires NO paste event for ⌘⇧V. Such an event, where one
      // comes (Ctrl+Shift+V on Windows/Linux), is dispatched while this very
      // keydown is handled — so a flag still armed a moment later means none
      // is coming, and the clipboard is read directly instead. Not in the
      // desktop app: its paste arrives later, through the Edit menu.
      if (isDesktopShell()) return
      setTimeout(() => { if (takePlainPaste()) void this.pasteFromClipboardAsync({ plain: true }) }, 50)
    }, true)

    document.addEventListener('paste', (ev: ClipboardEvent) => {
      // taken first, whatever happens below, so an armed flag never leaks
      // into the NEXT ⌘V (a text edit's own paste handler, canvas.ts, runs
      // before this one and takes it itself)
      const plain = takePlainPaste()
      if (this.presenting) return
      if (this.textOwnsClipboard()) return
      const dt = ev.clipboardData
      if (!dt) return
      // 1) an image from the OS clipboard (screenshot, copied picture…)
      const imgItem = [...dt.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file) { ev.preventDefault(); this.pasteImageFile(file); return }
      }
      // 2) onto selected table cells: copied cells or tab-separated text
      if (!this.slidesFocused() && this.canvas.tableRange.paste(ev, (s) => !!parseClip(s))) return
      const text = dt.getData('text/plain')
      // 3) BeeSlides elements / slides copied from this or another deck
      const clip = parseClip(text)
      if (clip?.kind === 'elements') {
        ev.preventDefault()
        let added: SlideElement[] = []
        this.store.commit(() => { added = insertElements(clip, this.store.doc, this.store.slide, { plain }) })
        if (clip.fonts?.length && !plain) injectFonts(this.store.doc)
        this.store.select(added.map((e) => e.id))
        this.toast(added.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: added.length }))
        return
      }
      // whole slides paste as they are, ⌘⇧V or not: a slide's design IS
      // most of what was copied
      if (clip?.kind === 'slides') {
        ev.preventDefault()
        this.pasteSlides(clip)
        return
      }
      // 4) plain text → a text element
      if (text && text.trim()) {
        ev.preventDefault()
        const esc = plainTextHtml(text.trim().slice(0, 4000))
        const { width } = this.store.doc.size
        const el = defaultText({ ...textDefaultsFor(this.store.doc, this.store.slide), html: esc, x: Math.round(width / 2 - 300), y: 260, w: 600 })
        this.store.commit(() => this.store.slide.elements.push(el))
        this.store.select([el.id])
        this.toast(t('Text pasted'))
      }
    })
  }

  /** Pasted slides land after the current slide — after the LAST selected
   *  one while the slide panel has focus — and past any states (and, for a
   *  normal slide, the extras run) that follow it; they become the selection. */
  private pasteSlides(clip: NonNullable<ReturnType<typeof parseClip>>) {
    const sel = this.slidesFocused() ? this.selectedSlideIndices() : [this.store.currentIndex]
    // a pasted state becomes a normal slide (insertSlides) unless it is hidden
    const at = this.afterSlideBlock(sel[sel.length - 1], (clip.slides ?? []).some((s) => !s.hidden))
    let made: Slide[] = []
    this.store.commit(() => { made = insertSlides(clip, this.store.doc, at) }, 'slides')
    if (clip.fonts?.length) injectFonts(this.store.doc)
    this.rebuildSidebar()
    this.setSlideSel(made.map((s) => s.id), at, made[0]?.id)
    this.toast(made.length === 1 ? t('Pasted 1 slide') : t('Pasted {n} slides', { n: made.length }))
  }

  /** A focused field or text edit owns copy/cut/paste — the canvas only
   *  handles them when nothing text-like has focus. */
  private textOwnsClipboard(): boolean {
    const a = document.activeElement as HTMLElement | null
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
  }

  // --- copy / cut: the native events, so no clipboard permission is needed ---

  /**
   * ⌘C / ⌘X ride the browser's own `copy`/`cut` events, which may write the
   * clipboard synchronously without any permission — the same in a tab and
   * in the desktop app (whose Edit menu's copy/cut roles fire them). The
   * keydown handler no longer copies: the async clipboard API it used is
   * refused outright when the embedder grants no clipboard permission, and
   * that failure was silent.
   */
  private wireCopy() {
    const handle = (ev: ClipboardEvent, cut: boolean) => {
      if (this.presenting || !ev.clipboardData) return
      if (this.textOwnsClipboard()) return
      // text the user selected somewhere on the page (a comment, a panel
      // hint) copies as that text, the browser default. Not a selection
      // left inside the canvas by a finished text edit: there the objects
      // the user selected are what ⌘C means.
      const sel = window.getSelection()
      const at = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement
      if (sel && !sel.isCollapsed && sel.toString().trim() && !at?.closest('.ed-stage')) return
      const slides = this.slidesFocused()
      // selected table cells copy as cells (editor/tablerange.ts)
      if (!slides && this.canvas.tableRange.copy(ev, cut)) return
      if (cut && !slides && !this.store.selection.length) return
      const clip = this.clipPayload()
      if (!clip) return
      ev.clipboardData.setData('text/plain', clip.text)
      ev.preventDefault()
      if (cut && slides) this.deleteSlides(clip.slideIds)
      else if (cut) this.panel.deleteEls(clip.els)
      else if (clip.kind === 'slide') {
        this.toast(clip.slideIds.length > 1
          ? t('{n} slides copied — ⌘V in any deck to paste them', { n: String(clip.slideIds.length) })
          : t('Slide copied — ⌘V in any deck to paste it'))
      }
    }
    document.addEventListener('copy', (ev) => handle(ev, false))
    document.addEventListener('cut', (ev) => handle(ev, true))
  }

  /** What a copy puts on the clipboard: the selected slides while the slide
   *  panel has focus, else the selected elements, or — with nothing
   *  selected — the whole current slide. */
  private clipPayload(): { text: string; kind: 'elements' | 'slide'; els: SlideElement[]; slideIds: string[] } | null {
    if (this.slidesFocused()) {
      const ids = this.selectedSlideIds()
      const byId = new Map(this.store.doc.slides.map((s) => [s.id, s]))
      const slides = ids.map((id) => byId.get(id)).filter((s): s is Slide => !!s)
      if (slides.length) return { text: serializeSlides(slides, this.store.doc), kind: 'slide', els: [], slideIds: ids }
    }
    const els = this.store.selectedElements
    if (els.length) return { text: serializeElements(els, this.store.doc), kind: 'elements', els, slideIds: [] }
    const slide = this.store.slide
    if (!slide) return null
    return { text: serializeSlides([slide], this.store.doc), kind: 'slide', els: [], slideIds: [slide.id] }
  }

  /** The async clipboard write the context menu needs (a menu click has no
   *  copy event to ride). Refused by some embedders — say so, and point at
   *  the shortcut that always works. */
  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      this.toast(t('Couldn’t access the clipboard — use ⌘C'))
      return false
    }
  }

  private pasteImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const place = (w: number, h: number) => {
        const { width, height } = this.store.doc.size
        const el = defaultImage(src, { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h, fit: 'contain' })
        // via canvas.insert, so a pasted photo is interned into doc.assets on
        // the same path as every other embed — otherwise it stays inline and
        // live collab can never send it.
        this.canvas.insert(el)
        this.toast(t('Image pasted'))
      }
      const img = new Image()
      img.onload = () => {
        let w = img.naturalWidth || 400, h = img.naturalHeight || 300
        const sc = Math.min(1, 640 / w, 480 / h); place(Math.round(w * sc), Math.round(h * sc))
      }
      img.onerror = () => place(400, 300)
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  // --- brand palette → referenced literals ---------------------------------

  private paletteSig = ''
  /**
   * Re-derive every colour that points at a palette slot, whenever the palette
   * moves. Same shape as the table→chart binding below: guarded by a signature
   * so it cannot loop, and DERIVE-NOT-COMMIT — the literals are a pure function
   * of `doc.theme`, so each collaborating replica computes the same values
   * without an operation crossing the wire.
   *
   * Runs across the whole document, not just the current slide: a palette edit
   * changes slide 40 as much as slide 1, and nothing else will visit it.
   */
  private syncThemeRefs() {
    const sig = paletteSignature(this.store.doc)
    if (sig === this.paletteSig) return
    this.paletteSig = sig
    if (resolveThemeRefs(this.store.doc)) {
      this.canvas.render()
      this.scheduleThumbs()
    }
  }

  // --- live table→chart binding -------------------------------------------------

  private tableSig = ''
  /** Re-derive any chart linked to a table on the current slide when that
   *  table's content changes. Guarded by a content signature so it can't loop,
   *  and skipped when nothing is linked. */
  private syncLinkedCharts() {
    const slide = this.store.slide
    const linked = slide.elements.filter((e): e is ChartElement => e.type === 'chart' && !!(e as ChartElement).source)
    if (!linked.length) { this.tableSig = ''; return }
    const tables = slide.elements.filter((e): e is TableElement => e.type === 'table')
    const sig = slide.id + '|' + tables.map((tb) => `${tb.id}:${tb.columns.length}:${JSON.stringify(tb.rows)}`).join('|')
    if (sig === this.tableSig) return
    this.tableSig = sig
    let changed = false
    for (const chart of linked) {
      const table = tables.find((tb) => tb.id === chart.source!.tableId)
      if (table && syncLinkedChart(chart, table)) changed = true
    }
    // the triggering table edit already dirtied the doc + drives collab/autosave;
    // each replica derives identically from the synced table, so just re-render.
    if (changed) this.canvas.render()
  }

  /** Re-route connectors (line shapes anchored to elements via from/to) when
   *  anything on the slide moves. Derived, not committed — every replica computes
   *  the same endpoints from the element boxes (mirrors syncLinkedCharts). */
  private syncConnectors() {
    if (rerouteConnectors(this.store.slide).length) this.canvas.render()
  }

  /** Re-derive every container child's absolute box from its parent + stored
   *  `parentOffset` when anything on the slide moves. Derived, not committed
   *  — every replica computes the same boxes from the parent's current box
   *  (mirrors syncConnectors, including its float-churn guard and its
   *  current-slide-only scope: a container moved on a slide nobody has open
   *  stays un-derived until someone visits it, same accepted limitation as
   *  connectors and syncLayoutInstances' linkedSlides scoping). A dangling
   *  parentId (container deleted) is dropped — the child keeps its last
   *  absolute position, which is how deleting a container "orphans" its
   *  children for free. Registered BEFORE syncConnectors (see constructor)
   *  so a connector anchored to a container child sees the child's
   *  just-resynced box, not a stale one. */
  private syncContainers() {
    if (deriveContainerChildren(this.store.slide).length) this.canvas.render()
  }

  // --- Layout Manager (live layout / building-block sync) ------------------

  /** True while the full-screen Layout Manager overlay is open — see
   *  openLayoutManager()/editor/layoutmanager.ts. Gates the global keyboard
   *  handler (wireKeyboard) the same way `presenting` does, since the
   *  overlay covers the whole screen and owns keyboard focus. */
  private layoutManagerOpen = false

  /** Editor-only nav cursor for the Layout Manager overlay (which tab, which
   *  sub-editor within it, which master) — see layoutmanager.ts's
   *  `LayoutManagerNavState`. Mirrors `layoutManagerOpen`'s discipline:
   *  never saved, never touches Store (store.editingSurface is a narrower
   *  render-surface fact, not a nav cursor). Null until the very first open
   *  this session; lazily constructed and reused in place on every reopen
   *  in openLayoutManager() so the overlay resumes where you left it.
   *  Session-only by design — does not survive a reload, same as every
   *  other nav cursor in the app. */
  private layoutManagerNav: LayoutManagerNavState | null = null

  /** The live overlay session while `layoutManagerOpen` is true — lets
   *  `openLayoutManager()` refresh an already-open overlay in place
   *  (re-entrant call, e.g. the empty-state jump link fired from inside a
   *  sub-editor) instead of stacking a second overlay on top. Null whenever
   *  `layoutManagerOpen` is false; cleared in the overlay's own exit callback. */
  private layoutManagerSession: LayoutManagerSession | null = null

  /** True while the full-screen Slide Sorter/Outline View overlays are open
   *  — see openSlideSorter()/openOutlineView() below. Mirrors
   *  `layoutManagerOpen`'s bookkeeping, but in the OTHER direction: those
   *  two views already refuse to open while the Layout Manager owns the
   *  screen (`layoutManagerOpen` check in each), and openLayoutManager()
   *  below returns the favor so the gating is symmetric — both overlays are
   *  full-screen and neither makes sense stacked under (or over) the other. */
  private slideSorterOpen = false
  private outlineViewOpen = false

  /**
   * While a surface is open for editing (`store.editingSurface` — a slide
   * type, i.e. Slide Master mode, or the document's shared building blocks),
   * re-apply it to every slide that tracks it live whenever it changes —
   * DERIVE-NOT-COMMIT, same idiom as syncLinkedCharts/syncConnectors above:
   * this runs inside the 'doc' handler for the commit that edited the
   * surface, so every resync rides that same undo checkpoint (one undo step
   * for the whole edit). Editing a slide type resyncs every slide linked to
   * IT OR ANY OF ITS DESCENDANTS — `linkedSlides(doc, layoutId)` (model.ts)
   * walks each candidate slide's own layout's `ancestorChain`, so N-level
   * resync (editing a root re-syncs slides several tiers down) comes for
   * free with no extra logic here. Each target still resyncs through its
   * OWN slide type's `effectiveLayout` (frame/typography still come from the
   * slide's own slide type; only the edited ancestor's contribution
   * changed).
   *
   * Zombie-element fix: applyLayout's "drop layout-owned leftovers" pass only
   * recognises ids in `layoutElementIds(doc)`, which reflects the CURRENT
   * layout content. If this edit just DELETED an element, its id has already
   * fallen out of that set by the time we get here, so a copy still sitting
   * on an already-synced slide reads as ordinary user content and would
   * survive forever. Fix: union in `store.surfaceSyncIds`, the id set
   * store.ts's enterSurface() captured when this surface was entered (before
   * any edit) — so an id deleted by the very first edit after entering is
   * still recognised as surface-owned for this one resync pass.
   */
  private syncLayoutInstances() {
    const surface = this.store.editingSurface
    if (!surface) return
    // Reusable objects have no live-link concept — nothing in `doc.slides`
    // ever tracks one (see model.ts's `reusableObjects` doc comment), so
    // there is never anything to resync here. Explicit rather than relying
    // on `doc.layouts?.find` coincidentally returning undefined for an
    // object id.
    if (surface.kind === 'reusableObject') return
    const doc = this.store.doc
    const content = doc.layouts?.find((l) => l.id === surface.id)
    if (!content) return
    const sig = JSON.stringify(content)
    if (sig === this.store.surfaceSyncSig) return
    const known = layoutElementIds(doc)
    for (const id of this.store.surfaceSyncIds) known.add(id)
    const current = new Set(content.elements.map((e) => e.id))
    // Deleted from the surface by this edit: where the surface is an
    // ancestor, their copies are inherited chrome and go even with text.
    const retired = new Set([...this.store.surfaceSyncIds].filter((id) => !current.has(id)))
    this.store.surfaceSyncSig = sig
    this.store.surfaceSyncIds = current
    if (resyncLinkedSlides(doc, surface.id, known, retired)) { this.canvas.render(); this.scheduleThumbs() }
  }

  // --- auto-save + crash recovery -----------------------------------------------

  private autosaveTimer = 0
  private lastVersionAt = 0
  private lastBackupAt = 0
  private selectionContextTimer = 0

  private wireAutosave() {
    if (this.store.doc.readonly) return // player file — nothing to autosave
    void pruneOld()
    // "The file as opened" — a kept checkpoint the timeline prune never
    // evicts (kernel autosave `keep`). Skipped for a blank desktop draft:
    // there is nothing to go back to.
    const blankDraft = desktopKind() === 'draft' && !desktopLaunch()?.text
    if (!isEncryptionActive() && !blankDraft) void addVersion(this.store.doc, { label: 'opened', keep: true })
    void this.checkRecovery()
    this.noticeIfCannotWriteInPlace()
    this.store.on('doc', () => this.scheduleAutosave())
  }

  private scheduleAutosave() {
    // a gated (newer-format) document is never written anywhere, not even as
    // a recovery snapshot: restoring one would be a write by another route
    if (this.store.doc.readonly || formatGate()) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => { void this.runAutosave() }, 2500)
  }

  private async runAutosave() {
    const doc = this.store.doc
    if (doc.readonly || formatGate()) return
    // Never write an encrypted deck's plaintext to IndexedDB; its file
    // write-back below stays encrypted via serializeAuto.
    let snapshotted = false
    if (!isEncryptionActive()) {
      // only true if it REALLY stored — see putRecovery; no IndexedDB (Safari
      // private browsing, some file:// contexts) must not read as "backed up"
      snapshotted = await putRecovery(doc)
      if (Date.now() - this.lastVersionAt > 120_000) { this.lastVersionAt = Date.now(); await addVersion(doc) }
    }
    // Desktop: the file itself, through main (editor/desktopdoc.ts).
    if (desktopBound()) { await this.desktopWriteNow(); return }
    // Silent file write-back once we hold a writable handle (Chrome/Edge).
    if (hasFileHandle()) {
      try {
        await writeUpdatedFile(await serializeAuto(doc))
        this.store.setDirty(false)
        this.flashSaved()
        return
      } catch { /* keep dirty; the IndexedDB snapshot is the backstop */ }
    }
    // No handle (Safari/Firefox/iOS) or the write failed: the file on disk is
    // STALE and the deck stays dirty — saying "Saved" here would be a lie. But
    // the snapshot means the work is not lost, and that was previously
    // invisible: nothing was shown at all, so the only signal was an amber dot
    // that never cleared. Say what is actually true.
    //
    // Deliberately silent for an ENCRYPTED deck: those are never snapshotted to
    // IndexedDB (plaintext-to-disk), so on a browser that cannot write back
    // there is no backstop, and claiming one would be the worst kind of wrong.
    if (snapshotted) {
      this.lastBackupAt = Date.now()
      this.flashSaved(t('Backed up in this browser'))
      this.refreshDirtyHint()
    }
  }

  /** Keep the dirty dot's tooltip honest about the backstop — the file is still
   *  stale, but the work is recoverable, and the user should be able to find
   *  that out by hovering the thing that is worrying them. */
  private refreshDirtyHint() {
    if (canWriteInPlace() || !this.lastBackupAt) return
    const when = new Date(this.lastBackupAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    this.activeSaveIndicator().dirtyDot.title = t('Unsaved changes — kept in this browser at {when} and offered back if you reopen. ⌘S downloads an updated copy.', { when })
  }

  // --- desktop: the deck is always saved (editor/desktopdoc.ts) -----------------
  //
  // A desktop window is BOUND to a file (or a draft under userData/Drafts) and
  // every autosave writes it through main. Three rules keep that from ever
  // writing the wrong thing:
  //  - a deck is never rewritten unless its content changed — the
  //    last-written-body guard (bodyKey, i.e. everything but `modified`; NOT
  //    docContentKey, which ignores meta/present) — so opening a file and
  //    closing it leaves it byte-for-byte alone;
  //  - this page's deck is never swapped for a different one: Open, imports
  //    and "Duplicate as new deck" ask main, which flushes this deck and then
  //    boots the other in a NEW doc view (desktop windows.ts replaceDocument),
  //    so autosave can't write deck B into deck A's file;
  //  - a conflict (the file changed on disk) or a missing file stops writes
  //    until the user picks what happens.

  /** What was last written to (or read from) the bound file; null = the file
   *  doesn't have this deck yet (a seeded draft). */
  private lastWrittenBody: string | null = null
  /** The deck as booted, for "untouched blank" (a fresh draft nobody typed in). */
  private initialBody = ''
  private touched = false
  /** wireDesktopDoc ran (build() calls syncWindowTitle before it does). */
  private desktopWired = false
  private desktopFailToastAt = 0

  private wireDesktopDoc() {
    const doc = this.store.doc
    const launch = desktopLaunch()
    this.desktopWired = true
    // An import carries its fidelity report: handed over from another window
    // (in the seed text), or picked on the start page (main.ts).
    const pending = (doc as { __importReport?: ImportContext }).__importReport
    if (pending) delete (doc as { __importReport?: unknown }).__importReport
    this.initialBody = bodyKey(doc)
    // A seeded draft (an import, a template, a backup) has no file yet: write
    // it at once, so it survives even if nobody edits it. A start-page import
    // boots a blank draft (no text) but is just as much work to redo.
    // A figure picked on the start page is the same: its size choice is the
    // work, and it must show up under Figure even if nothing is drawn yet.
    const freshFigure = doc.kind === 'figure' || doc.kind === 'iconset'
    const seededDraft = launch?.kind === 'draft' && launch.mtimeMs == null && (!!launch.text || !!pending || freshFigure)
    this.lastWrittenBody = seededDraft ? null : this.initialBody
    this.touched = !(launch?.kind === 'draft' && !launch.text && !pending && !freshFigure)
    if (seededDraft) this.scheduleAutosave()
    setFlushHandler((kind) => this.flushForClose(kind))
    this.store.on('dirty', () => this.reportDesktopState())
    // main renamed this window's file (a template rename): retitle
    let fileName = desktopFileName()
    onDesktopStatus(() => {
      if (desktopFileName() === fileName) return
      fileName = desktopFileName()
      this.syncWindowTitle()
      this.layoutManagerSession?.refresh()
    })
    window.slidomingoDesktop?.onFileChangedOnDisk?.((info) => void this.onFileChangedOnDisk(info))
    if (pending) {
      queueMicrotask(() => {
        if (pending.kind === 'pptx') void this.afterPptxImport(pending)
        else this.showImportReport(pending.name, pending.report)
      })
    } else if (launch?.opened && launch.name) {
      // replaced another deck in this window
      const name = fileBase(launch.name)
      queueMicrotask(() => this.toast(t('Opened {name}', { name })))
    }
    this.reportDesktopState()
    const disabled = desktopWritesDisabled()
    if (disabled) queueMicrotask(() => this.toast(disabled))
  }

  /** A fresh draft nobody has edited — closing it keeps nothing, and opening
   *  something else from it may close it. */
  private isUntouched(): boolean {
    if (!this.desktopWired || this.touched || desktopKind() !== 'draft') return false
    if (bodyKey(this.store.doc) !== this.initialBody) this.touched = true
    return !this.touched
  }

  private reportDesktopState() {
    if (!desktopBound() || !this.desktopWired) return
    reportDocState({ dirty: this.store.dirty, title: document.title, untouched: this.isUntouched(), docId: this.store.doc.docId })
  }

  /** Write the deck to its bound file now, if it changed. */
  private async desktopWriteNow(opts?: { force?: boolean }): Promise<'clean' | 'flushed' | 'failed' | 'unsaveable'> {
    // read-only behind the reader gate: there is nothing this window may
    // write, so closing it has nothing to flush (the banner said so)
    if (this.store.doc.readonly || formatGate()) return 'clean'
    if (!opts?.force && bodyKey(this.store.doc) === this.lastWrittenBody) {
      this.store.setDirty(false)
      return 'clean'
    }
    if (desktopWritesDisabled()) return 'unsaveable'
    const st = desktopStatus()
    if (!opts?.force && (st === 'conflict' || st === 'missing')) return 'unsaveable'
    let written = ''
    const result = await writeDesktop(async () => {
      // serialized when this write's turn in the chain comes, from the doc as
      // it is THEN — and that is exactly the body recorded as written
      const doc = this.store.doc
      written = bodyKey(doc)
      return this.serializeForDisk(doc)
    }, opts)
    if ('ok' in result) {
      this.lastWrittenBody = written
      if (bodyKey(this.store.doc) === written) this.store.setDirty(false)
      document.querySelector('.ed-diskbanner')?.remove()
      return 'flushed'
    }
    if ('conflict' in result) { this.showDiskBanner('conflict'); return 'unsaveable' }
    if ('missing' in result) { this.showDiskBanner('missing'); return 'unsaveable' }
    // don't repeat the same failure every 2.5s while someone keeps typing
    if (Date.now() - this.desktopFailToastAt > 30_000) {
      this.desktopFailToastAt = Date.now()
      this.toast(this.saveErrorText(result.error))
    }
    return 'failed'
  }

  /** The bytes for this window's own file: a template window writes the
   *  template (templateFileDoc — plain, never encrypted); a deck is
   *  encryption-aware as always. */
  private serializeForDisk(doc: import('../model').SlidomingoDoc): Promise<string> {
    return this.templateMode ? Promise.resolve(serializeFile(templateFileDoc(doc, this.templateId))) : serializeAuto(doc)
  }

  /** Doc text read back from this window's file, parsed the way it booted. */
  private parseFromDisk(text: string): import('../model').SlidomingoDoc | null {
    return this.templateMode ? parseTemplateForEditing(text) : parseDoc(text)
  }

  private saveErrorText(code: string): string {
    switch (code) {
      case 'not-a-template': return t('Couldn’t save — this window only writes layouts.')
      case 'open-elsewhere': return t('That file is open in another window — choose a different name.')
      case 'drafts-folder': return t('Choose a folder outside BeeSlides’ drafts.')
      case 'not-a-shell': return t('Couldn’t save — the app file this deck is saved into is incomplete.')
      default: return t('Couldn’t save: {reason}', { reason: code })
    }
  }

  /** ⌘S / Save on desktop. A file: write now + a kept "saved" checkpoint. A
   *  draft: Save as… (it becomes a real file). Save a copy…: elsewhere. */
  private async saveDesktop(forcePicker: boolean) {
    if (forcePicker) { await this.desktopSaveAs('copy'); return }
    if (desktopKind() === 'draft') { await this.desktopSaveAs('move'); return }
    clearTimeout(this.autosaveTimer)
    const r = await this.desktopWriteNow()
    if (r === 'clean' || r === 'flushed') {
      this.checkpointSaved()
      this.flashSaved()
    } else if (r === 'unsaveable') {
      this.toast(desktopWritesDisabled() ?? t('Not saved — resolve the message at the bottom first'))
    }
  }

  private async desktopSaveAs(mode: 'move' | 'copy'): Promise<boolean> {
    if (refuseGatedWrite((m) => this.toast(m))) return false
    this.canvas.commitTextEdit()
    const doc = this.store.doc
    // main's box when the name it adds `.beeslides.html` to is already taken
    // ({name} is filled in there — only main knows the final file name)
    const strings = {
      replaceMessage: t('“{name}” already exists. Replace it?'),
      replaceDetail: t('A deck with this name is already in that folder. Replacing it overwrites its contents.'),
      replace: t('Replace'),
      cancel: t('Cancel'),
    }
    const res = await saveDesktopAs(await this.serializeForDisk(doc), suggestedFileName(doc), mode, strings)
    if ('cancelled' in res) return false
    if ('error' in res) { this.toast(this.saveErrorText(res.error)); return false }
    if (mode === 'move') {
      this.lastWrittenBody = bodyKey(doc)
      this.touched = true
      if (bodyKey(this.store.doc) === this.lastWrittenBody) this.store.setDirty(false)
      clearDesktopProblem()
      document.querySelector('.ed-diskbanner')?.remove()
      // A deck still at the default title takes the name just typed for it, so
      // title and file stay in sync. Any other title was set on purpose (by
      // the user or a template) and is never overwritten. This is committed
      // after the clean state above, so it is an ordinary pending edit that
      // autosave writes to the newly bound file.
      const chosen = fileBase(res.name)
      if (this.store.doc.title === 'Untitled' && chosen && chosen !== 'Untitled') {
        this.store.commit(() => { this.store.doc.title = chosen })
      }
      this.syncWindowTitle()
    }
    this.checkpointSaved()
    this.toast(mode === 'move'
      ? t('Saved as {name}', { name: fileBase(res.name) })
      : t('Saved a copy as {name}', { name: fileBase(res.name) }))
    return true
  }

  /** main's close/quit flush (desktop windows.ts): get pending edits on disk,
   *  and say what happened. The strings are for main's fallback box. */
  private async flushForClose(kind: 'flush' | 'save-as'): Promise<FlushAnswer> {
    const name = desktopFileName() ? fileBase(desktopFileName()!) : this.store.doc.title
    const strings = {
      message: t('“{name}” couldn’t be saved.', { name }),
      detail: desktopWritesDisabled() ?? desktopError()
        ?? (desktopStatus() === 'conflict' ? t('The file was changed by another app since it was opened.')
          : desktopStatus() === 'missing' ? t('The file was moved or deleted.')
            : t('Your latest changes are not on disk yet.')),
      saveAs: t('Save as…'),
      dontSave: t('Don’t save'),
      cancel: t('Cancel'),
    }
    try { this.canvas.commitTextEdit() } catch { /* no live edit */ }
    clearTimeout(this.autosaveTimer)
    if (kind === 'save-as') {
      const ok = await this.desktopSaveAs('move')
      return { status: ok ? 'flushed' : 'failed', strings }
    }
    if (this.isUntouched()) return { status: 'clean' }
    const status = await this.desktopWriteNow()
    await desktopWritesSettled()
    return { status, strings }
  }

  /** A kept "saved" checkpoint (+ recovery baseline), as every explicit save does. */
  private checkpointSaved() {
    if (isEncryptionActive()) return
    void putRecovery(this.store.doc)
    void addVersion(this.store.doc, { label: 'saved', keep: true })
    this.lastVersionAt = Date.now()
  }

  /** Before replacing the whole deck in place (Replace from JSON, restoring a
   *  version, reloading from disk): keep what's there as a checkpoint. */
  private checkpointBeforeReplace() {
    if (isEncryptionActive() || this.store.doc.readonly) return
    void addVersion(this.store.doc, { label: 'before-replace', keep: true })
  }

  /**
   * Desktop: an imported deck opens as a NEW draft in this window's place —
   * main flushes this deck first, and the draft shows the import report —
   * unless this window is an untouched blank, which the import may simply
   * become in place. Returns true when it handed the deck off.
   */
  private async openImportedAsDraft(next: import('../model').SlidomingoDoc, ctx: ImportContext): Promise<boolean> {
    if (!desktopBound() || this.isUntouched() || !window.slidomingoDesktop?.openAsDraft) return false
    const seed = { ...next, __importReport: ctx }
    return window.slidomingoDesktop.openAsDraft(JSON.stringify(seed))
  }

  private async onFileChangedOnDisk(info: { changed?: boolean; missing?: boolean }) {
    if (info.missing) { markDesktopProblem('missing'); this.showDiskBanner('missing'); return }
    if (!info.changed) return
    // Nothing unsaved here: follow the file, like any editor would.
    if (bodyKey(this.store.doc) === this.lastWrittenBody && await this.reloadFromDisk(true)) return
    markDesktopProblem('conflict')
    this.showDiskBanner('conflict')
  }

  /** Replace this deck with the bound file's current content (undoable). */
  private async reloadFromDisk(quiet = false): Promise<boolean> {
    const r = await window.slidomingoDesktop?.reloadFromDisk?.()
    if (!r?.text) { if (!quiet) this.toast(t('Couldn’t read the file')); return false }
    // An encrypted file needs the password gate: boot again (the window
    // re-reads its file on every load).
    if (parseEnvelope(r.text)) { location.reload(); return true }
    const next = this.parseFromDisk(r.text)
    if (!next) { if (!quiet) this.toast(t('Couldn’t read the file')); return false }
    // the file on disk became a newer-format document: boot again, which
    // opens it read-only behind the gate instead of adopting it here
    if (refuseNewerDoc(next, null, () => { /* reboot below says it */ })) { location.reload(); return true }
    this.canvas.commitTextEdit()
    this.checkpointBeforeReplace()
    this.store.replaceDoc(next)
    this.canvas.render()
    this.lastWrittenBody = bodyKey(this.store.doc)
    this.store.setDirty(false)
    clearDesktopProblem()
    document.querySelector('.ed-diskbanner')?.remove()
    this.toast(quiet ? t('Reloaded — the file changed on disk') : t('Reloaded from disk — ⌘Z brings your version back'))
    return true
  }

  private showDiskBanner(kind: 'conflict' | 'missing') {
    document.querySelector('.ed-diskbanner')?.remove()
    const bar = div('ed-recover ed-diskbanner')
    const name = desktopFileName() ? fileBase(desktopFileName()!) : this.store.doc.title
    const msg = document.createElement('span')
    msg.textContent = kind === 'conflict'
      ? t('“{name}” was changed by another app. Your edits here are not saved until you choose.', { name })
      : t('“{name}” was moved or deleted, so it can’t be saved there.', { name })
    const button = (label: string, primary: boolean, run: () => void) => {
      const b = document.createElement('button')
      b.className = primary ? 'ed-btn ed-btn-primary' : 'ed-btn'
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }
    bar.appendChild(msg)
    if (kind === 'conflict') {
      bar.append(
        button(t('Reload'), false, () => void this.reloadFromDisk()),
        button(t('Keep mine'), true, () => void this.desktopWriteNow({ force: true }).then((r) => {
          if (r === 'flushed' || r === 'clean') { clearDesktopProblem(); bar.remove(); this.flashSaved() }
        })),
        button(t('Save a copy…'), false, () => void this.desktopSaveAs('copy')),
      )
    } else {
      bar.append(button(t('Save as…'), true, () => void this.desktopSaveAs('move')))
    }
    document.body.appendChild(bar)
  }

  // --- desktop: live selection context for Claude Code --------------------

  /** The Slide Sorter's multi-select (see openSlideSorter) — ids of the
   *  slides "selected for Claude", surfaced in selection.json as
   *  selectedSlideIds and fetchable in full via the get_slide/write_slide MCP
   *  tools. Stays populated after the sorter closes; only a fresh selection
   *  (or the slides it names being deleted) changes it. */
  private slideSelectionForClaude: string[] = []

  /** 400ms — deliberately much shorter than autosave's 2.5s: this is a small
   *  JSON blob with no disk-heavy cost, and "live" should not read as
   *  seconds behind the user's clicks. Still coalesces a marquee-drag's
   *  rapid-fire selection events into one write. */
  private scheduleSelectionContext() {
    clearTimeout(this.selectionContextTimer)
    this.selectionContextTimer = window.setTimeout(() => this.writeSelectionContext(), 400)
  }

  private writeSelectionContext() {
    if (isEncryptionActive()) return // never write a plaintext derivative of an encrypted deck
    const doc = this.store.doc
    const liveSlideIds = new Set(doc.slides.map((s) => s.id))
    // What `slideId` actually is — without this an agent sees a slide type's
    // id and an empty selection and goes hunting for a deck slide/selection
    // instead of editing the slide type the user is looking at.
    const es = this.store.editingSurface
    const surfaceSlide = this.store.slide
    const lmOpen = this.layoutManagerOpen
    const surface = {
      kind: es?.kind ?? 'slide',
      id: surfaceSlide.id,
      name: surfaceSlide.name ?? null,
      parentId: es?.kind === 'layout' ? surfaceSlide.parentId ?? null : null,
      layoutManagerOpen: lmOpen,
      layoutManagerTab: lmOpen ? this.layoutManagerNav?.tab ?? null : null,
    }
    const ctx = {
      schema: 1,
      writtenAt: new Date().toISOString(),
      docTitle: doc.title,
      slideId: surfaceSlide.id,
      surface,
      // "content slides" etc. must resolve to a slide-type id without a
      // doc_info round trip — ids + names only, so it stays small. Listed
      // always, not only while the Layout Manager is open: that request is
      // just as likely from the deck view.
      slideTypes: (doc.layouts ?? []).map((l) => ({ id: l.id, name: l.name ?? null, parentId: l.parentId ?? null, ...(l.parentOnly ? { parentOnly: true } : {}) })),
      selection: this.store.selectedElements.map((e) => ({
        id: e.id,
        type: e.type,
        role: e.role,
        frame: { x: e.x, y: e.y, w: e.w, h: e.h },
        text: e.type === 'text' || e.type === 'code'
          ? stripHtml(e.type === 'text' ? e.html : e.content).slice(0, 200)
          : e.type === 'math' ? e.tex.slice(0, 200) : undefined,
      })),
      // What sits around the selection (within 48px of its union box), and
      // the arrows ending on it — an edit to "this" is only safe when the
      // agent can see what it might bump into. Ids + frames only.
      neighbours: selectionNeighbours(doc, surfaceSlide, this.store.selectedElements),
      // Slide Sorter multi-select, ids only — no titles/content, so this stays
      // tiny even for a deck-wide selection. Filtered against the CURRENT
      // slide list so a slide deleted outside the sorter never dangles here.
      selectedSlideIds: this.slideSelectionForClaude.filter((id) => liveSlideIds.has(id)),
      // open comments flagged for Claude on this slide — a count only; the
      // `comments` query verb has the content
      openAgentComments: (surfaceSlide.comments ?? []).filter((c) => c.forAgent && !c.resolved).length,
      // Slides a chat tab wrote in its current turn (store.ts locks, released
      // when the turn ends), so each tab's digest can name the OTHER tabs' work.
      agentWork: [...this.store.locks].flatMap(([slideId, lock]) => {
        const slide = resolveAgentSlide(doc, slideId)?.slide
        if (!slide) return []
        const idx = doc.slides.indexOf(slide)
        return [{ slideId, number: idx >= 0 ? idx + 1 : null, name: slide.name ?? null, sessionId: lock.sessionId, at: new Date(lock.at).toISOString() }]
      }),
    }
    window.slidomingoDesktop?.writeSelectionContext(JSON.stringify(ctx, null, 2))
  }

  /** The write-back half of the terminal panel's context channel: `claude`
   *  writes edit.json, the main process forwards it here (see
   *  terminalPanel.ts processEditFile), and this applies it the same way a
   *  canvas text/code edit is committed (canvas.ts commitTextEdit) — walking
   *  ALL slides by id, since the selection may be stale by the time `claude`
   *  responds, and always toasting so an external edit is never silent. */
  private applyExternalEdit(cmd: { elementId?: string; text?: string; html?: string; sessionId?: string }) {
    // sessionId is echoed back unchanged on every response below — it carries
    // no lock semantics here (edit.json is not one of the lock-triggering MCP
    // verbs), but the main process needs it to route the write-back into the
    // right session's own subfolder (see terminalPanel.ts's per-session
    // contextDir).
    const respond = (result: { ok: boolean; summary?: string; error?: string }) =>
      window.slidomingoDesktop?.sendApplyEditResult({ ...result, sessionId: cmd.sessionId })
    // Explicit, even though selection.json (and so this whole channel) is
    // never populated for an encrypted deck in practice — the MCP tools below
    // reach applyExternalSlideWrite/respondSlideRequest by construction, not
    // by reading selection.json first, so this guard can't rely on that.
    if (isEncryptionActive()) { respond({ ok: false, error: 'encrypted' }); return }
    if (this.store.readOnly) { respond({ ok: false, error: 'This deck is open read-only.' }); return }
    const id = cmd.elementId
    if (!id) { respond({ ok: false, error: 'Missing elementId.' }); return }
    // Same owner order as resolveAgentSlide: deck slides, then reusable
    // objects, then slide types — so a selection.json element picked on a
    // slide type in the Layout Manager is editable here too.
    let el: import('../model').SlideElement | undefined
    let owner: Slide | undefined
    const doc = this.store.doc
    for (const slide of [...doc.slides, ...(doc.reusableObjects ?? []), ...(doc.layouts ?? [])]) {
      el = slide.elements.find((e) => e.id === id)
      if (el) { owner = slide; break }
    }
    if (!el || !owner) { respond({ ok: false, error: `No element with id ${id} in this deck.` }); return }
    if (el.type !== 'text' && el.type !== 'code' && el.type !== 'math') {
      respond({ ok: false, error: `Element ${id} is a ${el.type} element — only text, code and equation elements can be edited this way.` })
      return
    }
    this.canvas.commitTextEdit() // no-op if nothing is being edited; flushes a live edit before we overwrite the model
    if (el.type === 'math') {
      // `text` is the raw LaTeX (no $ delimiters); the box fits the new formula
      this.canvas.cancelMathEdit()
      const tex = cmd.text ?? cmd.html ?? ''
      this.commitAgentWrite(owner.id, () => {
        const m = el as import('../model').MathElement
        m.tex = tex
        Object.assign(m, fitMathFrame(m, this.store.doc))
      })
    } else if (el.type === 'text') {
      const html = cmd.html != null ? sanitizeHtml(cmd.html) : sanitizeHtml(cmd.text ?? '')
      this.commitAgentWrite(owner.id, () => { (el as import('../model').TextElement).html = html })
    } else {
      this.commitAgentWrite(owner.id, () => { (el as import('../model').CodeElement).content = cmd.text ?? cmd.html ?? '' })
    }
    this.toast(t('Claude Code edited “{id}”', { id }))
    respond({ ok: true, summary: `Updated ${el.type} element ${id}.` })
  }

  /** get_slide's write-back half: the MCP server (desktop/src/mcp/
   *  slides-mcp-server.mjs) drops slide-request-<id>.json, terminalPanel.ts
   *  forwards it here over slidomingo:slide-request, and this answers through the
   *  matching slide-response-<id>.json the tool call is polling on. Read-only
   *  — no store mutation, so no readOnly gate is needed here (unlike the
   *  write side below). */
  private respondSlideRequest(req: { requestId: string; slideId?: string }) {
    const respond = (result: { requestId: string; ok: boolean; slide?: Slide; error?: string }) =>
      window.slidomingoDesktop?.sendSlideResponse(result)
    if (isEncryptionActive()) { respond({ requestId: req.requestId, ok: false, error: 'encrypted' }); return }
    const slide = req.slideId ? resolveAgentSlide(this.store.doc, req.slideId)?.slide : undefined
    if (!slide) { respond({ requestId: req.requestId, ok: false, error: 'no-such-slide' }); return }
    respond({ requestId: req.requestId, ok: true, slide })
  }

  /** Shared by write_slide and the agent-action write verbs: a non-blocking
   *  validateDoc() pass filtered to one slide, so a successful write's
   *  response can carry immediate overflow/off-canvas/etc. feedback without
   *  a separate validate() round trip. Kept as ONE method so "does this
   *  write verb check for overflow" has one answer, not one per call site. */
  private warningsForSlide(sid: string): Finding[] {
    const doc = this.store.doc
    const findings = validateDoc(doc, { measure: true, measureOnly: sid }).findings.filter((f) => f.slide === sid)
    // validateDoc only walks doc.slides — a slide type / reusable object gets
    // at least the TEXT OVERFLOW check, the one an agent most needs back.
    if (!doc.slides.some((s) => s.id === sid)) {
      const owner = resolveAgentSlide(doc, sid)?.slide
      if (owner) findings.push(...overflowFindings(doc, owner))
    }
    return findings
  }

  /** store.commit for an agent write addressed at `slideId`. A slide type
   *  that is NOT the Layout Manager's open surface gets no
   *  syncLayoutInstances pass (that only watches the open surface), so its
   *  linked deck slides are resynced here in the same undo step — "edit the
   *  content slide type" must reach every slide using it either way.
   *
   *  The layout guard (layoutguard.ts) runs inside the same commit, after the
   *  mutation: text that no longer fits grows, neighbours keep their gaps,
   *  arrows stay attached — so ⌘Z reverts the edit AND its fix-ups together.
   *  `reflow:false` (the agent placed something deliberately) reports what
   *  the guard would flag without changing anything; `guard:false` skips it
   *  for structural writes (relinking a slide to its type moves every box on
   *  purpose). The result is left in `lastLayout` for the response the
   *  caller is about to send. */
  private commitAgentWrite(slideId: string, mutate: () => void, event?: Parameters<Store['commit']>[1], opts: { reflow?: boolean; guard?: boolean; placed?: boolean } = {}) {
    const doc = this.store.doc
    const es = this.store.editingSurface
    const isClosedLayout = !!doc.layouts?.some((l) => l.id === slideId) && !(es?.kind === 'layout' && es.id === slideId)
    // Captured BEFORE the mutation so an element the write deletes/replaces
    // is still recognised as layout-owned (same zombie rule as syncLayoutInstances).
    const known = isClosedLayout ? layoutElementIds(doc) : null
    const target = resolveAgentSlide(doc, slideId)?.slide
    const before = target && opts.guard !== false ? snapshotSlide(target) : null
    let layout: GuardResult | null = null
    this.store.commit(() => {
      mutate()
      // re-resolved: write_slide REPLACES the slide object
      const slide = before ? resolveAgentSlide(doc, slideId)?.slide : undefined
      if (slide && before) {
        try {
          layout = guardLayout(doc, slide, before, {
            apply: opts.reflow !== false,
            measure: this.layoutMeasure,
            canvas: this.agentCanvasSize(slideId),
            placed: opts.placed,
          })
          if (opts.reflow === false) reanchorEditedChildren(slide, before)
        } catch (err) {
          // the guard is a helper: a bug in it must never cost the write itself
          console.warn('layout guard failed', err)
        }
      }
      if (known) resyncLinkedSlides(doc, slideId, known)
    }, event)
    this.lastLayout = layout
    if (known) this.scheduleThumbs()
  }

  /** The `elements` agent tool's way onto a slide (agentops.ts SlideWrites):
   *  the same commit, guard and text measurement as every other agent write. */
  private readonly agentSlideWrites: SlideWrites = {
    commit: (slideId, mutate, opts) => {
      const target = resolveAgentSlide(this.store.doc, slideId)
      if (!target) return null
      this.commitAgentWrite(slideId, () => mutate(target.slide), undefined, { reflow: opts.reflow, placed: opts.placed })
      const layout = this.lastLayout
      this.lastLayout = null
      return layout
    },
    check: (slideId, elementIds) => {
      const slide = resolveAgentSlide(this.store.doc, slideId)?.slide
      return slide ? checkLayout(this.store.doc, slide, { elementIds, measure: this.layoutMeasure, canvas: this.agentCanvasSize(slideId) }) : []
    },
  }

  /** The `slide_html` tool's layout engine: this page (htmlslide.ts lays
   *  the HTML out in a script-less iframe, htmlemit.ts writes it back). */
  private readonly agentHtml: HtmlLayout = {
    compile: (slide, src) => compileSlideHtml(this.store.doc, slide, src, this.agentCanvasSize(slide.id)),
    read: (slide) => slideToHtml(this.store.doc, slide, this.agentCanvasSize(slide.id),
      (s, src) => compileSlideHtml(this.store.doc, s, src, this.agentCanvasSize(s.id))),
    // the person watching sees the slide land (not while another view is open)
    show: (slideId) => {
      const idx = this.store.doc.slides.findIndex((s) => s.id === slideId)
      if (idx < 0 || idx === this.store.currentIndex || this.store.editingSurface || this.layoutManagerOpen || this.slideSorterOpen || this.outlineViewOpen || this.presenting) return
      this.store.goTo(idx)
    },
  }

  /** commitAgentWrite's guard result, for the response that follows it. */
  private lastLayout: GuardResult | null = null

  /** `{ layout }` for a write response — omitted when the guard had nothing
   *  to say, so a quiet write costs the agent no extra tokens. */
  private layoutReport(): { layout?: GuardResult } {
    const l = this.lastLayout
    this.lastLayout = null
    return l && (l.adjusted.length || l.issues.length) ? { layout: l } : {}
  }

  /** Measured content height of a text element, through the real renderer. */
  private readonly layoutMeasure = (el: TextElement) => measureElement(el, this.store.doc).height

  private agentCanvasSize(slideId: string): { width: number; height: number } {
    return this.store.doc.reusableObjects?.some((o) => o.id === slideId) ? REUSABLE_OBJECT_CANVAS : this.store.doc.size
  }

  /** write_slide's write-back half — same request/response file pattern as
   *  respondSlideRequest, but replaces a WHOLE slide (unlike
   *  applyExternalEdit's single-element edit.json channel) via store.commit
   *  so undo/re-render/collab all see it as one ordinary edit. `warnings` on
   *  a success is warningsForSlide() — same signal insert_elements/set_frame/
   *  etc. already return — so an agent sees a resulting overflow immediately,
   *  without a separate validate() call. */
  private applyExternalSlideWrite(cmd: { requestId: string; slideId?: string; slide?: unknown; sessionId?: string; reflow?: boolean }) {
    const respond = (result: { requestId: string; ok: boolean; summary?: string; error?: string; warnings?: Finding[]; layout?: GuardResult }) =>
      window.slidomingoDesktop?.sendSlideWriteResult(result)
    if (isEncryptionActive()) { respond({ requestId: cmd.requestId, ok: false, error: 'encrypted' }); return }
    if (this.store.readOnly) { respond({ requestId: cmd.requestId, ok: false, error: 'This deck is open read-only.' }); return }
    // cmd.slide arrives as unknown (raw JSON off disk, via the MCP server) —
    // the checks below are the validation; cast once they've run enough to
    // treat it as a Slide, same posture as checkRecovery's JSON.parse cast.
    const slide = cmd.slide as Slide | undefined
    if (!slide || !cmd.slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or slide.' }); return }
    if (slide.id !== cmd.slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'slide.id must equal slideId.' }); return }
    if (!Array.isArray(slide.elements)) { respond({ requestId: cmd.requestId, ok: false, error: 'slide.elements must be an array.' }); return }
    const seenIds = new Set<string>()
    for (const el of slide.elements) {
      if (!el || typeof el.id !== 'string' || !el.id) {
        respond({ requestId: cmd.requestId, ok: false, error: 'Every element needs a non-empty string id.' })
        return
      }
      if (seenIds.has(el.id)) {
        respond({ requestId: cmd.requestId, ok: false, error: `Duplicate element id: ${el.id}` })
        return
      }
      seenIds.add(el.id)
    }
    const resolved = resolveAgentSlide(this.store.doc, cmd.slideId)
    if (!resolved) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
    // Record this session as the slide's latest writer (sidebar badge only —
    // acquireLock never refuses; several sessions may share a slide).
    if (cmd.sessionId) this.store.acquireLock(cmd.slideId, cmd.sessionId)

    // new svg artwork is refused (agentsvg.ts); a round trip of what is there passes
    { const bad = agentSvgViolation(this.store.doc, slide.elements, { existing: resolved.array[resolved.idx].elements }); if (bad) { respond({ requestId: cmd.requestId, ok: false, error: bad }); return } }

    // Same sanitizer the canvas itself runs text/cell edits through — this
    // slide arrived as raw JSON from outside the app, not a canvas commit.
    for (const el of slide.elements) {
      if (el.type === 'text') el.html = sanitizeHtml(el.html ?? '')
      if (el.type === 'table') {
        for (const row of el.rows ?? []) {
          for (const cell of row.cells ?? []) cell.html = sanitizeHtml(cell.html ?? '')
        }
      }
    }

    this.commitAgentWrite(cmd.slideId, () => { resolved.array[resolved.idx] = slide }, 'slides', { reflow: cmd.reflow !== false })
    this.toast(this.isIconset
      ? t('Claude Code drew the icon “{name}”', { name: slide.name || t('Untitled icon') })
      : t('Claude Code edited slide “{id}”', { id: cmd.slideId }))
    const layout = this.layoutReport()
    respond({ requestId: cmd.requestId, ok: true, summary: `Updated slide ${cmd.slideId}.`, warnings: this.warningsForSlide(cmd.slideId), ...layout })
  }

  // --- agent context & actions (slidomingo/desktop terminal integration) ---------
  //
  // Progressive disclosure for a `claude` session with no browser of its own:
  // selection.json (tier 0, scheduleSelectionContext above) is push-only and
  // small; these two request/response channels (desktop/src/mcp/
  // slides-mcp-server.mjs's agent-query/agent-action tools, forwarded by
  // terminalPanel.ts's agent watcher) are pull-based and let an agent ask for
  // exactly the slice it needs — a doc summary, one slide's outline, whether a
  // box of text fits — before ever touching write_slide's whole-slide
  // replace, let alone a full-document round-trip. The five write verbs below
  // are the SIBLING to applyExternalEdit/applyExternalSlideWrite: structural
  // edits (insert/move/duplicate/delete/reorder) an agent can make WITHOUT
  // reconstructing and resending an entire slide for a one-element change.

  /** Cheap, allowlisted document summary — built field by field rather than by
   *  cloning `store.doc`, so a new document field doesn't silently widen what
   *  an agent's cheap summary call exposes. See docForAgent() below for the
   *  "whole document" case. */
  private agentDocInfo(): Record<string, unknown> {
    const doc = this.store.doc
    return {
      format: doc.format,
      version: doc.version,
      docId: doc.docId,
      title: doc.title,
      size: { ...doc.size },
      theme: JSON.parse(JSON.stringify(doc.theme)),
      meta: doc.meta ? { ...doc.meta } : undefined,
      present: doc.present ? { ...doc.present } : undefined,
      slideCount: doc.slides.length,
      // One row per `doc.layouts` entry, so an agent can discover valid
      // `sourceId`/`layoutId` values for create_slide_type/rename_slide_type/
      // reorder_slide_type/promote_to_reusable_object without guessing —
      // added alongside those MCP verbs (2026-09-20 redesign, part 4).
      // placeholders + contentArea (layoutbrief.ts): where a slide of the
      // type takes its content, so filling one needs no probe slide.
      slideTypes: (doc.layouts ?? []).map((l) => ({ id: l.id, name: l.name, parentId: l.parentId, ...(l.parentOnly ? { parentOnly: true } : {}), ...layoutBrief(doc, l, marginFor(doc)) })),
      // What deck section_* ops address (agentops.ts).
      sections: sectionRows(this.store),
      // What deck_settings header_footer / theme set (read back after a write).
      headerFooter: doc.headerFooter ? JSON.parse(JSON.stringify(doc.headerFooter)) : undefined,
      palette: paletteOf(doc),
      // The column grid people see and snap to (deck_settings layout_grid);
      // elements arrange fills a span of it with within "columns 7-12".
      layoutGrid: agentLayoutGrid(doc),
      guides: doc.guides ? normalizeGuides(doc.guides, doc.size) : undefined,
      kind: doc.kind,
      iconset: this.agentIconsetInfo(),
      // which file this is (no folder), and whether it is a hidden instance's
      // that nobody sees (desktop background.ts): then the user picks designs
      // in Claude Code's BeeSlides pane, not in a compare view
      file: desktopFileName() ?? undefined,
      background: desktopBackground() || undefined,
    }
  }

  /** An icon set's grid and style, plus `pathElement`: one path in that style,
   *  drawn on the whole canvas with the grid as its pathBox, so `d` is written
   *  in grid units (the draw-icons prompt points here). */
  private agentIconsetInfo(): Record<string, unknown> | undefined {
    const info = iconsetInfo(this.store.doc)
    if (!info) return undefined
    const st = info.style
    const { width, height } = this.store.doc.size
    // the examples as SVG text: what an agent reads, not the stored structure
    const examples = readIconExamples(info.examples).map((ex) => ({ name: ex.name, svg: exampleSvg(ex) }))
    return {
      ...info,
      examples: examples.length ? examples : undefined,
      paddingBox: [st.padding, st.padding, info.grid - st.padding, info.gridH - st.padding],
      pathElement: {
        type: 'shape', shape: 'path', x: 0, y: 0, w: width, h: height, rotation: 0, opacity: 1, radius: 0,
        pathBox: [0, 0, info.grid, info.gridH], d: `M${st.padding} ${info.gridH / 2} H${info.grid - st.padding}`,
        fill: 'transparent', stroke: st.color, strokeWidth: st.strokeWidth * info.scale, strokeCap: st.cap, strokeJoin: st.join,
      },
      note: 'One icon per slide (slide name = icon name; slide.icon.prompt = what it shows). The canvas is grid units wide and gridH units high (not always square). Draw with path elements like pathElement only; a filled detail sets fill to the ink and stroke to transparent. ' +
        'Add iconPart to every path (pathElement has none, so a copy is guessed): body = the main closed silhouette(s), detail = inner lines and dots, accent = at most one small closed highlight. ' +
        'examples (when there) are icons the user likes, from other libraries: draw like them — the same line weight, corner rounding, amount of detail and proportions — but draw your own paths, never copy theirs. ' +
        'variants are the set\'s extra styles (icons op style adds one): they only repaint the same drawings, so never redraw an icon for a style. ' +
        'A variant\'s tweaks (slide id → element id → fill/stroke/hide) paint single icons their own way in it (icons op tweak).',
    }
  }

  /** One summary row per slide — O(slide count): element/role/preview scans
   *  touch each slide's elements once, but nothing here renders or measures
   *  (that is the separate, explicitly-requested `measure`/`validate` verbs). */
  private agentOutline(): Array<Record<string, unknown>> {
    return this.store.doc.slides.map((s, index) => {
      const roles = Array.from(new Set(s.elements.map((e) => e.role).filter((r): r is string => !!r)))
      const firstText = s.elements.find((e): e is TextElement => e.type === 'text' && !!e.html?.trim())
      return {
        id: s.id,
        index,
        name: s.name,
        hidden: !!s.hidden,
        stateOf: s.stateOf,
        slideType: s.layoutId,
        elementCount: s.elements.length,
        roles,
        preview: firstText ? stripHtml(firstText.html).slice(0, 120) : undefined,
        icon: s.icon ? { ...s.icon } : undefined,
      }
    })
  }

  /** One summary row per saved reusable object — same shape idiom as
   *  agentOutline(), scoped to `doc.reusableObjects` so an agent can discover
   *  ids/names before addressing one via get_slide/write_slide/
   *  insert_elements/set_frame/etc. (all generalized onto reusable objects
   *  via resolveAgentSlide, see model.ts). */
  private agentReusableObjects(): Array<Record<string, unknown>> {
    return (this.store.doc.reusableObjects ?? []).map((o, index) => ({
      id: o.id,
      index,
      name: o.name,
      elementCount: o.elements.length,
    }))
  }

  /** Find one element addressed by an EXPLICIT slideId — unlike
   *  applyExternalEdit's cross-slide-by-id search, every agent-action verb
   *  always carries the slide it means, so there is no ambiguity to resolve. */
  private findAgentTarget(slideId: string, elementId: string): { slide: Slide; el: SlideElement; idx: number } | null {
    const resolved = resolveAgentSlide(this.store.doc, slideId)
    if (!resolved) return null
    const idx = resolved.slide.elements.findIndex((e) => e.id === elementId)
    if (idx < 0) return null
    return { slide: resolved.slide, el: resolved.slide.elements[idx], idx }
  }

  /** Read-only bridge for doc_info/outline/measure/validate/comments — same
   *  encryption veto as respondSlideRequest, no readOnly gate (nothing here
   *  mutates the store). */
  private respondAgentQuery(req: { requestId: string; verb?: string; args?: Record<string, unknown> }) {
    const respond = (result: { requestId: string; ok: boolean; result?: unknown; error?: string }) =>
      window.slidomingoDesktop?.sendAgentQueryResponse(result)
    if (isEncryptionActive()) { respond({ requestId: req.requestId, ok: false, error: 'encrypted' }); return }
    const args = req.args ?? {}
    switch (req.verb) {
      case 'doc_info':
        respond({ requestId: req.requestId, ok: true, result: this.agentDocInfo() })
        return
      case 'outline':
        respond({ requestId: req.requestId, ok: true, result: this.agentOutline() })
        return
      case 'list_reusable_objects':
        respond({ requestId: req.requestId, ok: true, result: this.agentReusableObjects() })
        return
      case 'measure': {
        const spec = args.spec as TextMeasureSpec | undefined
        const elementId = typeof args.elementId === 'string' ? args.elementId : undefined
        if (spec) { respond({ requestId: req.requestId, ok: true, result: measureText(spec, this.store.doc) }); return }
        if (elementId) {
          for (const s of this.store.doc.slides) {
            const el = s.elements.find((e) => e.id === elementId && e.type === 'text')
            if (el) { respond({ requestId: req.requestId, ok: true, result: measureElement(el as TextElement, this.store.doc) }); return }
          }
          respond({ requestId: req.requestId, ok: false, error: `No text element with id ${elementId}.` })
          return
        }
        respond({ requestId: req.requestId, ok: false, error: 'Provide elementId or spec.' })
        return
      }
      case 'validate':
        // The MCP tool sends measure/margin top-level; `opts` is the older shape.
        respond({ requestId: req.requestId, ok: true, result: validateDoc(this.store.doc, (args.opts as ValidateOpts | undefined) ?? {
          measure: typeof args.measure === 'boolean' ? args.measure : undefined,
          margin: typeof args.margin === 'number' ? args.margin : undefined,
        }) })
        return
      case 'comments': {
        const filter: CommentFilter = {
          resolved: typeof args.resolved === 'boolean' ? args.resolved : undefined,
          forAgent: typeof args.forAgent === 'boolean' ? args.forAgent : undefined,
          slideId: typeof args.slideId === 'string' ? args.slideId : undefined,
        }
        respond({ requestId: req.requestId, ok: true, result: commentEntries(this.store.doc, filter) })
        return
      }
      case 'recent_changes': {
        // Compact entries — changed field names + before/after VALUES for
        // just those fields, not full element snapshots — so an agent sees
        // what actually happened without re-deriving it itself.
        const elementId = typeof args.elementId === 'string' ? args.elementId : undefined
        const slideId = typeof args.slideId === 'string' ? args.slideId : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const entries = this.store.actionLog.recent({ elementId, slideId, limit }).map(({ record, change }) => {
          const { before, after } = compactChange(change)
          return {
            id: record.id,
            at: record.at,
            elementId: change.elementId,
            elementType: change.elementType,
            slideId: change.slideId,
            changedFields: changedFieldKeys(change),
            before,
            after,
          }
        })
        respond({ requestId: req.requestId, ok: true, result: entries })
        return
      }
      case 'render_preview': {
        // The pixel capture itself happens in the MAIN process (terminalPanel.ts's
        // slidomingo:agent-query-response handler): of this window's doc view
        // when the slide is on the canvas, else of `offscreen` (see snapshotFor).
        const currentId = this.store.doc.slides[this.store.currentIndex]?.id
        const wanted = typeof args.slideId === 'string' ? args.slideId : undefined
        const sid = wanted ?? currentId
        if (!sid) { respond({ requestId: req.requestId, ok: false, error: 'no-such-slide' }); return }
        if (!this.onCanvas(sid)) {
          const shot = this.snapshotFor(sid, args, 'render_preview')
          if (typeof shot === 'string') { respond({ requestId: req.requestId, ok: false, error: shot }); return }
          respond({ requestId: req.requestId, ok: true, result: { slideId: sid, rect: null, offscreen: shot.offscreen, ...(shot.region ? { area: shot.region } : {}) } })
          return
        }
        const region = this.captureRegion(sid, args)
        if (typeof region === 'string') { respond({ requestId: req.requestId, ok: false, error: region }); return }
        // `rect` = where the slide (or the asked part) is on screen, so main
        // crops the capture to it (no editor chrome) — see prepareCapture
        void this.prepareCapture(region).then((rect) =>
          respond({ requestId: req.requestId, ok: true, result: { slideId: sid, rect, ...(region ? { area: region } : {}) } }))
        return
      }
      case 'find_text': {
        const query = typeof args.query === 'string' ? args.query : ''
        if (!query.trim()) { respond({ requestId: req.requestId, ok: false, error: 'find_text needs a non-empty query' }); return }
        const limit = typeof args.limit === 'number' && args.limit >= 1 ? Math.min(Math.round(args.limit), 200) : 40
        respond({ requestId: req.requestId, ok: true, result: agentFindText(this.store.doc, query, limit, stripHtml) })
        return
      }
      case 'check_layout': {
        // The layout guard's checks against the slide AS IT IS (no baseline):
        // partial overlaps, overflowing text, text off the canvas. What an
        // agent calls after fixing a ⚠ LAYOUT banner, until `clean`.
        const sid = typeof args.slideId === 'string' ? args.slideId : this.store.slide.id
        const slide = resolveAgentSlide(this.store.doc, sid)?.slide
        if (!slide) { respond({ requestId: req.requestId, ok: false, error: 'no-such-slide' }); return }
        const elementIds = Array.isArray(args.elementIds) ? args.elementIds.filter((v): v is string => typeof v === 'string') : undefined
        const issues = checkLayout(this.store.doc, slide, { elementIds, measure: this.layoutMeasure, canvas: this.agentCanvasSize(sid) })
        respond({ requestId: req.requestId, ok: true, result: { slideId: sid, clean: issues.length === 0, issues } })
        return
      }
      case 'review_slide': {
        // check_layout + a compact frame list + (added by main) a screenshot
        // cropped to the slide — one call for the agent's design-review pass.
        // A slide that isn't on the canvas is shot off screen (snapshotFor):
        // the agent never moves the user's view.
        const sid = typeof args.slideId === 'string' ? args.slideId : this.store.slide.id
        const slide = resolveAgentSlide(this.store.doc, sid)?.slide
        if (!slide) { respond({ requestId: req.requestId, ok: false, error: 'no-such-slide' }); return }
        const shot = this.onCanvas(sid) ? null : this.snapshotFor(sid, args, 'review_slide')
        if (typeof shot === 'string') { respond({ requestId: req.requestId, ok: false, error: shot }); return }
        const region = shot ? shot.region : this.captureRegion(sid, args)
        if (typeof region === 'string') { respond({ requestId: req.requestId, ok: false, error: region }); return }
        const issues = checkLayout(this.store.doc, slide, { measure: this.layoutMeasure, canvas: this.agentCanvasSize(sid) })
        const elements = slide.elements.map((e) => agentFrameLine(e))
        const result = (rect: { x: number; y: number; width: number; height: number } | null) => ({
          slideId: sid, size: this.agentCanvasSize(sid), clean: issues.length === 0, issues, elements, rect,
          ...(shot ? { offscreen: shot.offscreen } : {}),
          ...(region ? { area: region } : {}),
          comments: commentEntries(this.store.doc, { slideId: sid, resolved: false, forAgent: true }),
        })
        if (shot) { respond({ requestId: req.requestId, ok: true, result: result(null) }); return }
        void this.prepareCapture(region).then((rect) => respond({ requestId: req.requestId, ok: true, result: result(rect) }))
        return
      }
      default:
        respond({ requestId: req.requestId, ok: false, error: `Unknown verb: ${req.verb}` })
    }
  }

  /** Whether `slideId` is what the editing canvas shows right now. Never
   *  during a show: the window shows the presentation, so a capture of it
   *  would be whatever slide the audience sees. */
  private onCanvas(slideId: string): boolean {
    // A hidden instance's window is never on screen (desktop background.ts):
    // every deck slide is shot off screen, which needs no painted window.
    if (desktopBackground() && this.store.doc.slides.some((s) => s.id === slideId)) return false
    return this.store.slide.id === slideId && !this.slideSorterOpen && !this.outlineViewOpen && !this.presenting
  }

  /** A screenshot of a deck slide that is NOT on the canvas: a standalone
   *  page of it (figureexport.ts slideSnapshotHtml) that main renders in a
   *  hidden window — the user keeps working wherever they are. Open comment
   *  areas for the agent are outlined, as on the canvas. A string = the error. */
  private snapshotFor(slideId: string, args: Record<string, unknown>, verb: string):
    { offscreen: { html: string; width: number; height: number }; region: CaptureRegion | undefined } | string {
    const slide = this.store.doc.slides.find((s) => s.id === slideId)
    if (!slide) return `${verb} can show a slide type or reusable object only while it is open in the editor; "${slideId}" is not.`
    const region = this.captureRegion(slideId, args)
    if (typeof region === 'string') return region
    const { width, height } = this.agentCanvasSize(slideId)
    const area = region ?? { x: 0, y: 0, w: width, h: height }
    const outlines = commentEntries(this.store.doc, { slideId, resolved: false, forAgent: true })
      .flatMap((c) => (c.anchor.type === 'area' ? [{ x: c.anchor.x, y: c.anchor.y, w: c.anchor.w, h: c.anchor.h }] : []))
    return { offscreen: { html: slideSnapshotHtml(this.store.doc, slide, area, outlines), width: area.w, height: area.h }, region }
  }

  /** Hide editor chrome (selection handles, line handles, guides, comment
   *  pins) for the screenshot the main process takes right after this
   *  query's response, frame the slide (or `region`, slide px) to fill the
   *  view, and report where it is on screen. Chrome and the user's zoom come
   *  back on a timer: main captures within milliseconds of the response and
   *  there is no "done" leg to wait for. */
  private async prepareCapture(region?: CaptureRegion): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const root = document.documentElement
    root.classList.add('ed-capturing')
    clearTimeout(this.captureTimer)
    this.captureRestore?.() // a capture still pending: the view to keep is the user's, not its framing
    const { rect, restore } = this.canvas.frameForCapture(region)
    this.captureRestore = restore
    this.captureTimer = window.setTimeout(() => {
      root.classList.remove('ed-capturing')
      this.captureRestore?.()
      this.captureRestore = undefined
    }, 1500)
    // two frames, so the hidden chrome (and a slide switch or zoom) is painted
    // before capturePage runs; the timeout covers a hidden window, where rAF stalls
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 150)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
    })
    return rect
  }
  private captureTimer = 0
  private captureRestore: (() => void) | undefined

  /** The part of `slideId` a render_preview / review_slide screenshot shows:
   *  `elementIds` (their bounds plus a margin) or `area` (slide px), clamped
   *  to the slide; undefined = the whole slide, a string = the error. */
  private captureRegion(slideId: string, args: Record<string, unknown>): CaptureRegion | undefined | string {
    const { width, height } = this.agentCanvasSize(slideId)
    let box: CaptureRegion | undefined
    if (Array.isArray(args.elementIds) && args.elementIds.length) {
      const slide = resolveAgentSlide(this.store.doc, slideId)?.slide
      const ids = args.elementIds.filter((v): v is string => typeof v === 'string')
      const els = ids.map((id) => slide?.elements.find((e) => e.id === id))
      const missing = ids.filter((_, i) => !els[i])
      if (missing.length || !ids.length) return `No element ${missing.join(', ') || '(none given)'} on slide "${slideId}".`
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const e of els as SlideElement[]) {
        // a rotated frame's corners, so the screenshot holds all of it
        const rad = ((e.rotation ?? 0) * Math.PI) / 180
        const hw = (Math.abs(e.w * Math.cos(rad)) + Math.abs(e.h * Math.sin(rad))) / 2
        const hh = (Math.abs(e.w * Math.sin(rad)) + Math.abs(e.h * Math.cos(rad))) / 2
        const cx = e.x + e.w / 2, cy = e.y + e.h / 2
        x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh); x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh)
      }
      const pad = Math.max(16, 0.08 * Math.max(x1 - x0, y1 - y0)) // what sits next to them shows too
      box = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
    } else if (args.area && typeof args.area === 'object') {
      const a = args.area as Record<string, unknown>
      const [x, y, w, h] = [a.x, a.y, a.w, a.h].map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN))
      if ([x, y, w, h].some(Number.isNaN)) return 'area needs numbers x, y, w and h (slide px).'
      box = { x, y, w, h }
    }
    if (!box) return undefined
    const x = Math.max(0, box.x), y = Math.max(0, box.y)
    const w = Math.min(width, box.x + box.w) - x, h = Math.min(height, box.y + box.h) - y
    if (w < 4 || h < 4) return `That area is not on the ${width}x${height} slide.`
    const r = Math.round
    return { x: r(x), y: r(y), w: r(w), h: r(h) }
  }
  /** Slides agents added or duplicated in this session (agentops.ts `delete`). */
  private agentCreatedSlides = new Set<string>()
  /** The `icons` tool's view of the icon library; its refs outlive one call. */
  private readonly agentIcons: IconLibraryAccess<IconResult> = {
    refs: new Map(),
    search: (q) => searchIconLibrary(q),
    insert: async (slideId, icon, frame, alt) => {
      let picked: Awaited<ReturnType<IconResult['load']>>
      try { picked = await icon.load() } catch (e) {
        return { error: `Could not fetch that icon: ${e instanceof Error ? e.message : String(e)}` }
      }
      // the fetch took time: the deck may have been locked or the slide deleted meanwhile
      if (isEncryptionActive() || this.store.readOnly) return { error: 'The deck cannot be edited right now.' }
      const key = uid('a')
      const provenance = Object.keys(icon.provenance).length ? icon.provenance : undefined
      const spec = picked.kind === 'svg'
        ? { id: 'agent-icon', type: 'svg', ...frame, rotation: 0, opacity: 1, asset: key, alt, ...(provenance ? { provenance } : {}) }
        : { ...defaultImage(picked.dataUrl, { ...frame, fit: 'contain' }), id: 'agent-icon', alt, ...(provenance ? { provenance } : {}) }
      const r = this.agentInsertElements(slideId, [spec], picked.kind === 'svg' ? { [key]: picked.markup } : undefined, { nudge: false })
      if ('error' in r) return r
      return r.added[0] ? { elementId: r.added[0].id } : { error: 'The icon could not be inserted.' }
    },
  }

  /** insert_elements: an agent's element specs through the SAME untrusted-
   *  fragment pipeline a paste goes through (clipboard.ts) — exactly as
   *  trusted as clipboard contents, no more — as one agent write. */
  private agentInsertElements(slideId: string, specs: unknown, assets: unknown, opts: { nudge: boolean; reflow?: boolean; fonts?: unknown }): { added: SlideElement[] } | { error: string } {
    const slide = resolveAgentSlide(this.store.doc, slideId)?.slide
    if (!slide) return { error: 'no-such-slide' }
    // insertElements remints every id, so an agent need not invent one:
    // a spec without an id gets a placeholder rather than being dropped
    // (sanitizeElement rejects id-less elements, which cost a retry turn).
    const elements = Array.isArray(specs)
      ? specs.map((e, i) => (e && typeof e === 'object' && !Array.isArray(e) && typeof (e as { id?: unknown }).id !== 'string' ? { ...e, id: `agent-${i}` } : e))
      : specs
    const raw = { __slidomingo: 'clip' as const, kind: 'elements' as const, elements, assets, fonts: opts.fonts }
    const payload = parseClipPayload(raw)
    if (!payload) return { error: 'No valid elements to insert.' }
    let added: SlideElement[] = []
    this.commitAgentWrite(slideId, () => { added = insertElements(payload, this.store.doc, slide, { nudge: opts.nudge }) }, undefined, { reflow: opts.reflow !== false })
    if (payload.fonts?.length) injectFonts(this.store.doc)
    return { added }
  }

  /** The five write verbs (insert_elements/set_frame/duplicate_element/
   *  delete_element/reorder_element) — one undo step each, refused on
   *  encryption or read-only same as applyExternalEdit, and always toasting
   *  so a human watching the editor sees what Claude just did. `warnings` on
   *  a success is a non-blocking validateDoc() pass filtered to the touched
   *  slide, so an agent gets an immediate signal (off-canvas, overflowing
   *  text, …) without a separate validate() round trip. */
  private applyAgentAction(cmd: { requestId: string; verb?: string; args?: Record<string, unknown>; sessionId?: string }) {
    const respond = (result: Record<string, unknown> & { requestId: string; ok: boolean }) =>
      window.slidomingoDesktop?.sendAgentActionResult(result)
    if (isEncryptionActive()) { respond({ requestId: cmd.requestId, ok: false, error: 'encrypted' }); return }
    if (this.store.readOnly) { respond({ requestId: cmd.requestId, ok: false, error: 'This deck is open read-only.' }); return }
    const args = cmd.args ?? {}
    const slideId = typeof args.slideId === 'string' ? args.slideId : undefined
    const elementId = typeof args.elementId === 'string' ? args.elementId : undefined
    const sessionId = cmd.sessionId
    // Records this session as the slide's latest writer for the sidebar badge;
    // never refuses (several sessions may share a slide). Always returns null.
    const lockError = (sid: string): string | null => {
      if (sessionId) this.store.acquireLock(sid, sessionId)
      return null
    }

    // An agent program (the `execute` tool, desktop agentexec.ts) brackets its
    // calls: every edit between begin and commit is ONE undo step, and a
    // program that fails is rolled back whole.
    if (cmd.verb === 'program') {
      const op = args.op
      if (op === 'begin') this.store.beginUndoGroup()
      else if (op === 'commit') {
        this.store.endUndoGroup()
        if (args.changed) this.toast(t('AI ran a program on this deck (one undo step)'))
      } else if (op === 'rollback') {
        if (!this.store.rollbackUndoGroup()) { respond({ requestId: cmd.requestId, ok: false, error: 'An undo since the program started: nothing was rolled back.' }); return }
      } else { respond({ requestId: cmd.requestId, ok: false, error: 'op must be begin, commit or rollback.' }); return }
      respond({ requestId: cmd.requestId, ok: true })
      return
    }

    // Grouped op tools (`deck`, …): agentops.ts checks the args against
    // ../agentops/spec.ts and runs the op as one undo step.
    if (isAreaTool(cmd.verb)) {
      if ((cmd.verb === 'icons' || cmd.verb === 'elements' || cmd.verb === 'slide_html') && slideId) lockError(slideId)
      void Promise.resolve(runAreaOp(cmd.verb!, args, { store: this.store, created: this.agentCreatedSlides, icons: this.agentIcons, writes: this.agentSlideWrites, html: this.agentHtml, variants: this.agentVariants })).then((r) => {
        if (r.ok && r.toast) this.toast(r.toast)
        respond({ requestId: cmd.requestId, ...r })
      })
      return
    }

    switch (cmd.verb) {
      case 'insert_elements': {
        if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
        if (!resolveAgentSlide(this.store.doc, slideId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        // new svg artwork is refused (agentsvg.ts); the icons tool is the way in
        { const bad = agentSvgViolation(this.store.doc, args.elements, { existing: resolveAgentSlide(this.store.doc, slideId)?.slide.elements, assets: args.assets }); if (bad) { respond({ requestId: cmd.requestId, ok: false, error: bad }); return } }
        const r = this.agentInsertElements(slideId, args.elements, args.assets, { nudge: args.nudge !== false, reflow: args.reflow !== false, fonts: args.fonts })
        if ('error' in r) { respond({ requestId: cmd.requestId, ok: false, error: r.error }); return }
        const { added } = r
        this.toast(t('Claude Code added elements to slide “{id}”', { id: slideId }))
        const layout = this.layoutReport()
        respond({ requestId: cmd.requestId, ok: true, elementIds: added.map((e) => e.id), warnings: this.warningsForSlide(slideId), ...layout })
        return
      }
      case 'set_frame': {
        if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
        const target = this.findAgentTarget(slideId, elementId)
        if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        const patch: Partial<Record<'x' | 'y' | 'w' | 'h' | 'rotation', number>> = {}
        for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) {
          if (args[key] === undefined) continue
          const check = checkElementProp(target.el.type, key, args[key])
          if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid ${key}.` }); return }
          patch[key] = check.value as number
        }
        // a container child's parentOffset follows inside the guard
        // (layoutguard reanchorChild), so syncContainers keeps the new spot
        this.commitAgentWrite(slideId, () => { Object.assign(target.el, patch) }, undefined, { reflow: args.reflow !== false })
        this.toast(t('Claude Code moved or resized an element on slide “{id}”', { id: slideId }))
        const layout = this.layoutReport()
        respond({
          requestId: cmd.requestId, ok: true,
          frame: { x: target.el.x, y: target.el.y, w: target.el.w, h: target.el.h, rotation: target.el.rotation },
          warnings: this.warningsForSlide(slideId),
          ...layout,
        })
        return
      }
      case 'update_element': {
        // Shallow property patch on ONE element — the cheap alternative to a
        // get_slide + write_slide round trip for a colour/font/border change,
        // and it cannot clobber a concurrent edit to the rest of the slide.
        // Every key goes through the same per-key check set_frame uses; a
        // null value removes an optional key. id/type are never patchable.
        if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
        const props = args.props
        if (!props || typeof props !== 'object' || Array.isArray(props) || !Object.keys(props).length) {
          respond({ requestId: cmd.requestId, ok: false, error: 'props must be a non-empty object.' })
          return
        }
        const target = this.findAgentTarget(slideId, elementId)
        if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
        const set: Record<string, unknown> = {}
        const unset: string[] = []
        for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
          if (key === 'id' || key === 'type') { respond({ requestId: cmd.requestId, ok: false, error: `${key} cannot be changed.` }); return }
          // a crop of the whole picture cuts nothing: it removes the crop, like null
          if (value === null || (key === 'crop' && target.el.type === 'image' && isWholePictureCrop(value))) {
            if ((REQUIRED_KEYS[target.el.type] ?? []).includes(key)) {
              respond({ requestId: cmd.requestId, ok: false, error: `${key} is required on a ${target.el.type} element.` })
              return
            }
            unset.push(key)
            continue
          }
          const check = checkElementProp(target.el.type, key, value)
          if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid or unknown prop "${key}" for a ${target.el.type} element.` }); return }
          let val = check.value
          // Same sanitizer write_slide runs rich text through.
          if (key === 'html') val = sanitizeHtml(val as string)
          if (key === 'rows' && Array.isArray(val)) {
            for (const row of val as TableElement['rows']) {
              for (const cell of row.cells ?? []) cell.html = sanitizeHtml(cell.html ?? '')
            }
          }
          set[key] = val
        }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        { const bad = agentSvgPatchViolation(this.store.doc, target.el, set); if (bad) { respond({ requestId: cmd.requestId, ok: false, error: bad }); return } }
        this.commitAgentWrite(slideId, () => {
          const el = target.el as unknown as Record<string, unknown>
          Object.assign(el, set)
          for (const key of unset) delete el[key]
        }, undefined, { reflow: args.reflow !== false })
        this.toast(t('Claude Code edited “{id}”', { id: elementId }))
        const layout = this.layoutReport()
        respond({ requestId: cmd.requestId, ok: true, changed: [...Object.keys(set), ...unset], warnings: this.warningsForSlide(slideId), ...layout })
        return
      }
      case 'duplicate_element': {
        if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
        const target = this.findAgentTarget(slideId, elementId)
        if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        const clone = cloneElement(target.el)
        // same as ⌘D: the copy gets its own group and is never re-parented
        // onto the original's container (syncContainers would snap it there)
        remapCopiedRefs([clone], new Map([[target.el.id, clone.id]]))
        for (const key of ['x', 'y'] as const) {
          if (args[key] === undefined) continue
          const check = checkElementProp(clone.type, key, args[key])
          if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid ${key}.` }); return }
          clone[key] = check.value as number
        }
        this.commitAgentWrite(slideId, () => { target.slide.elements.push(clone) })
        this.toast(t('Claude Code duplicated an element on slide “{id}”', { id: slideId }))
        respond({ requestId: cmd.requestId, ok: true, elementId: clone.id, warnings: this.warningsForSlide(slideId), ...this.layoutReport() })
        return
      }
      case 'delete_element': {
        if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
        const target = this.findAgentTarget(slideId, elementId)
        if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        this.commitAgentWrite(slideId, () => { target.slide.elements.splice(target.idx, 1) })
        this.toast(t('Claude Code deleted an element from slide “{id}”', { id: slideId }))
        respond({ requestId: cmd.requestId, ok: true, warnings: this.warningsForSlide(slideId), ...this.layoutReport() })
        return
      }
      case 'reorder_element': {
        // array order IS paint/z order (render.ts/canvas.ts iterate
        // slide.elements in order) — reimplemented directly against the
        // ADDRESSED slide's array rather than routed through panels.ts's
        // step()/reorder(), which act on whatever slide is currently VIEWED.
        const to = args.to as 'front' | 'back' | 'forward' | 'backward' | undefined
        if (!slideId || !elementId || !to) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId, elementId or to.' }); return }
        const target = this.findAgentTarget(slideId, elementId)
        if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        this.commitAgentWrite(slideId, () => {
          const arr = target.slide.elements
          const i = target.idx
          if (to === 'front' || to === 'back') {
            const [el] = arr.splice(i, 1)
            if (to === 'front') arr.push(el)
            else arr.unshift(el)
          } else {
            const j = i + (to === 'forward' ? 1 : -1)
            if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]] }
          }
        })
        this.toast(t('Claude Code reordered an element on slide “{id}”', { id: slideId }))
        respond({ requestId: cmd.requestId, ok: true, warnings: this.warningsForSlide(slideId), ...this.layoutReport() })
        return
      }
      case 'apply_change_pattern': {
        // Deliberately takes an EXPLICIT target id list — no server-side
        // "find similar" heuristic. Claude already has doc_info/outline to
        // decide "similar" itself; this keeps the mutating verb as small and
        // auditable as the five above. Same patch computeReapplicablePatch
        // produces for the manual armed tool (editor/reapplychange.ts), so a
        // human doing this by hand and Claude calling this verb behave
        // identically for the same source change.
        const sourceElementId = typeof args.sourceElementId === 'string' ? args.sourceElementId : undefined
        const rawTargets = Array.isArray(args.targetElementIds) ? args.targetElementIds : undefined
        if (!slideId || !sourceElementId || !rawTargets?.length) {
          respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId, sourceElementId or targetElementIds.' })
          return
        }
        const source = this.findAgentTarget(slideId, sourceElementId)
        if (!source) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-source-element' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        const change = this.store.actionLog.lastChangeFor(slideId, sourceElementId)
        const patch = change ? computeReapplicablePatch(change) : null
        if (!patch) { respond({ requestId: cmd.requestId, ok: false, error: 'no-reapplicable-change' }); return }
        const targetIds = rawTargets.filter((x): x is string => typeof x === 'string')
        const applied: string[] = []
        const skipped: string[] = []
        for (const id of targetIds) {
          const target = this.findAgentTarget(slideId, id)
          const sameKind = !!target && target.el.type === source.el.type &&
            (source.el.type !== 'shape' || (target.el as ShapeElement).shape === (source.el as ShapeElement).shape)
          if (sameKind) applied.push(id)
          else skipped.push(id)
        }
        if (applied.length) {
          this.commitAgentWrite(slideId, () => {
            for (const id of applied) {
              const target = this.findAgentTarget(slideId!, id)
              if (target) applyReapplicablePatch(patch, target.el)
            }
          })
          this.toast(t('Claude Code applied a recent change to {n} element(s) on slide “{id}”', { n: applied.length, id: slideId }))
        }
        respond({ requestId: cmd.requestId, ok: true, applied, skipped, warnings: this.warningsForSlide(slideId), ...this.layoutReport() })
        return
      }
      case 'propose_variants': {
        // NOT a store.commit — nothing here touches store.doc or the undo
        // stack. Candidates preview from Editor.pendingVariants (see
        // getPendingVariants/variantpicker.ts) until the human picks one via
        // applyVariant, which is the ONLY path that commits anything.
        if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
        const targetSlide = this.store.doc.slides.find((s) => s.id === slideId)
        if (!targetSlide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        void this.proposeVariants(slideId, args).then((r) => respond({ requestId: cmd.requestId, ...r }))
        return
      }
      case 'create_reusable_object': {
        // Same mint-and-append code the "+ New reusable object" button calls
        // (layoutmanager.ts's newReusableObject) — see model.ts's
        // createReusableObject doc comment.
        const name = typeof args.name === 'string' ? args.name.trim() : undefined
        let obj: Slide | undefined
        this.store.commit(() => {
          obj = createReusableObject(this.store.doc)
          if (name) obj.name = name
        })
        this.toast(t('Claude Code created a new reusable object'))
        respond({ requestId: cmd.requestId, ok: true, objectId: obj!.id })
        return
      }
      case 'create_slide_type': {
        // Agent-facing counterpart to the "+ New slide type" dialog
        // (layoutmanager.ts's openNewSlideTypeDialog) — same three mint
        // functions, same rule that a slide type always needs a real name
        // and is based on another slide type or blank, never a built-in.
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (!name) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing or empty name — slide types require a real name.' }); return }
        const mode = args.mode
        if (mode !== 'blank' && mode !== 'parent' && mode !== 'basis') {
          respond({ requestId: cmd.requestId, ok: false, error: 'mode must be one of "blank", "parent", "basis".' })
          return
        }
        let source: Slide | undefined
        if (mode !== 'blank') {
          const sourceId = typeof args.sourceId === 'string' ? args.sourceId : undefined
          source = sourceId ? this.store.doc.layouts?.find((l) => l.id === sourceId) : undefined
          if (!source) { respond({ requestId: cmd.requestId, ok: false, error: `No slide type with id "${sourceId}" to base this on.` }); return }
        }
        let layout!: Slide
        this.store.commit(() => {
          if (mode === 'parent') layout = createSlideTypeAsParentChild(this.store.doc, source!, name)
          else if (mode === 'basis') layout = createSlideTypeAsBasis(this.store.doc, source!, name, remintElements)
          else layout = createSlideTypeBlank(this.store.doc, name)
        })
        this.toast(t('Claude Code created a new slide type “{name}”', { name }))
        respond({ requestId: cmd.requestId, ok: true, layoutId: layout.id })
        return
      }
      case 'rename_slide_type': {
        const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
        if (!name) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing or empty name — slide types require a real name.' }); return }
        const layout = this.store.doc.layouts?.find((l) => l.id === layoutId)
        if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
        this.store.commit(() => { layout.name = name })
        this.toast(t('Claude Code renamed a slide type to “{name}”', { name }))
        respond({ requestId: cmd.requestId, ok: true })
        return
      }
      case 'reorder_slide_type': {
        // `to` is an index among SIBLINGS (children of the same parent, or
        // the top-level roots) — the same list moveLayoutWithinParent's UI
        // caller (the tree's own card grid) operates on, not the flat
        // doc.layouts array. Out-of-range `to` is clamped by moveItem
        // (layoutmanager.ts), matching the UI's own drag/reorder behavior.
        const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
        const to = typeof args.to === 'number' ? args.to : undefined
        if (!layoutId || to === undefined) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId or to.' }); return }
        const doc = this.store.doc
        const layout = doc.layouts?.find((l) => l.id === layoutId)
        if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
        const parentId = layout.parentId
        const siblings = (doc.layouts ?? []).filter((l) => (l.parentId ?? undefined) === (parentId ?? undefined))
        const from = siblings.findIndex((l) => l.id === layoutId)
        this.store.commit(() => { moveLayoutWithinParent(doc, parentId, from, to) })
        this.toast(t('Claude Code reordered a slide type'))
        respond({ requestId: cmd.requestId, ok: true })
        return
      }
      case 'move_slide_type': {
        // Agent-facing counterpart to the Layout Manager sidebar's drag-and-
        // drop (typetree.ts): reorder AND/OR reparent. `parentId: null`
        // makes it a root. Reparenting means "inherit from the new parent"
        // (the look changes); the moved subtree's linked slides resync in
        // the same commit, exactly like the UI drop.
        const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
        if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
        if (args.parentId !== null && typeof args.parentId !== 'string') {
          respond({ requestId: cmd.requestId, ok: false, error: 'parentId must be a slide type id, or null for a top-level slide type.' })
          return
        }
        const parentId = typeof args.parentId === 'string' ? args.parentId : undefined
        const beforeId = typeof args.beforeId === 'string' ? args.beforeId : undefined
        const doc = this.store.doc
        if (!doc.layouts?.some((l) => l.id === layoutId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
        if (parentId && !doc.layouts.some((l) => l.id === parentId)) { respond({ requestId: cmd.requestId, ok: false, error: `No slide type with id "${parentId}" to move under.` }); return }
        let moved = false
        this.store.commit(() => {
          moved = moveSlideTypeInTree(doc, layoutId, parentId, beforeId)
          if (moved) resyncLinkedSlides(doc, layoutId, layoutElementIds(doc))
        })
        if (!moved) { respond({ requestId: cmd.requestId, ok: false, error: 'Refused: a slide type cannot be moved under itself or one of its own descendants.' }); return }
        this.toast(t('Claude Code moved a slide type'))
        respond({ requestId: cmd.requestId, ok: true })
        return
      }
      case 'detach_slide_type': {
        // "Detach from parent (keep look)" — bakes the inherited content in,
        // then drops parentId; linked slides look identical afterwards.
        const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
        if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
        const layout = this.store.doc.layouts?.find((l) => l.id === layoutId)
        if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
        if (!layout.parentId) { respond({ requestId: cmd.requestId, ok: false, error: 'That slide type has no parent to detach from.' }); return }
        this.store.commit(() => detachSlideType(this.store.doc, layoutId))
        this.toast(t('Claude Code detached a slide type from its parent'))
        respond({ requestId: cmd.requestId, ok: true })
        return
      }
      case 'relink_slide_type': {
        // "Change layout…" / a Layout Manager leaf drop, for agents: the deck
        // slide `slideId` follows slide type `layoutId` from now on
        // (`relinkSlide` — re-applied in the same step), or, with
        // `layoutId: null`, follows nothing and keeps its look. The verdict
        // says what found no placeholder (kept, floating on top).
        if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
        const doc = this.store.doc
        const slide = doc.slides.find((s) => s.id === slideId)
        if (!slide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide (relink takes a deck slide id)' }); return }
        if (args.layoutId !== null && typeof args.layoutId !== 'string') {
          respond({ requestId: cmd.requestId, ok: false, error: 'layoutId must be a slide type id, or null to unlink.' })
          return
        }
        const layoutId = args.layoutId
        if (layoutId !== null && !doc.layouts?.some((l) => l.id === layoutId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
        if (layoutId !== null && doc.layouts?.find((l) => l.id === layoutId)?.parentOnly) {
          respond({ requestId: cmd.requestId, ok: false, error: 'parent-only (that slide type is a master: pick one of its children)' })
          return
        }
        { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
        if (layoutId === null) {
          this.commitAgentWrite(slideId, () => { delete slide.layoutId }, undefined, { guard: false })
          this.toast(t('Claude Code unlinked slide “{id}” from its slide type', { id: slideId }))
          respond({ requestId: cmd.requestId, ok: true, layoutId: null })
          return
        }
        let applied = null as RelinkPreview | null
        this.commitAgentWrite(slideId, () => { applied = relinkSlide(doc, slideId, layoutId) }, undefined, { guard: false })
        const p = applied!
        this.toast(t('Claude Code changed the slide type of slide “{id}”', { id: slideId }))
        respond({
          requestId: cmd.requestId, ok: true, layoutId,
          verdict: p.verdict,
          filled: p.filled,
          floating: p.floating.map((e) => e.id),
          emptySlots: p.emptySlots,
          warnings: this.warningsForSlide(slideId),
        })
        return
      }
      case 'promote_to_reusable_object': {
        // Agent-facing counterpart to contextmenu.ts's "Save as reusable
        // object…" item (reusableobjects.ts's promoteToReusableObject,
        // which already handles its own store.commit — do not wrap it in
        // another). slideId resolves against slides, reusable objects AND
        // slide types (resolveAgentSlide, model.ts) since a slide type's
        // sub-editor is just another editing surface.
        const slideId = typeof args.slideId === 'string' ? args.slideId : undefined
        const elementIds = Array.isArray(args.elementIds)
          ? args.elementIds.filter((x): x is string => typeof x === 'string') : []
        if (!slideId || !elementIds.length) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementIds.' }); return }
        const resolved = resolveAgentSlide(this.store.doc, slideId)
        if (!resolved) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
        const matched = elementIds
          .map((id) => resolved.slide.elements.find((e) => e.id === id))
          .filter((e): e is SlideElement => !!e)
        if (matched.length !== elementIds.length) {
          respond({ requestId: cmd.requestId, ok: false, error: 'One or more elementIds do not exist on that slide.' })
          return
        }
        const name = typeof args.name === 'string' ? args.name.trim() || undefined : undefined
        const obj = promoteToReusableObject(this.store, matched, name)
        if (!obj) { respond({ requestId: cmd.requestId, ok: false, error: 'Could not promote the selected elements.' }); return }
        this.toast(t('Claude Code saved a new reusable object from slide “{id}”', { id: slideId }))
        respond({ requestId: cmd.requestId, ok: true, objectId: obj.id })
        return
      }
      case 'resolve_comment': {
        // The agent's ONLY comment write: closes a thread (+ optional reply).
        // Plain store.commit — comments are slide metadata, not layout, so no
        // guard/lock; one undo step.
        const commentId = typeof args.commentId === 'string' ? args.commentId : ''
        const owner = this.store.doc.slides.find((s) => s.comments?.some((c) => c.id === commentId))
        if (!owner) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-comment' }); return }
        const reply = typeof args.reply === 'string' ? args.reply.trim().slice(0, 2000) : ''
        this.store.commit(() => {
          const live = owner.comments!.find((c) => c.id === commentId)!
          if (reply) live.replies = [...(live.replies ?? []), { id: uid('cmt'), author: 'Claude', text: reply, at: new Date().toISOString() }]
          // resolved + agentDone together: old viewers / `comments {resolved:false}`
          // see a plain resolved thread, the user gets a "check" state
          live.resolved = true
          live.agentDone = new Date().toISOString()
        })
        this.canvas.refreshComments()
        actionToast(t('Claude finished a comment'), t('Check'), () => {
          const i = this.store.doc.slides.indexOf(owner)
          if (i < 0) return
          this.store.goTo(i)
          this.canvas.openCommentThread(commentId)
        })
        respond({ requestId: cmd.requestId, ok: true, commentId })
        return
      }
      case 'pane_comment': {
        // The USER's comment writes from the BeeSlides pane of the Claude Code
        // plugin (desktop/src/mcp/claude-mod): the MCP server takes the verb
        // but never lists it, so the model cannot call it and the agent's own
        // comment verb stays resolve_comment alone. add = a new thread on the
        // slide (or one of its elements) flagged for the agent; accept /
        // reopen = the thread footer's two buttons on a thread Claude
        // finished (reopen with the user's reply).
        const op = args.op
        const text = typeof args.text === 'string' ? args.text.trim().slice(0, 2000) : ''
        const at = new Date().toISOString()
        if (op === 'add') {
          const slide = slideId ? this.store.doc.slides.find((s) => s.id === slideId) : undefined
          if (!slide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
          if (!text) { respond({ requestId: cmd.requestId, ok: false, error: 'empty' }); return }
          if (elementId && !slide.elements.some((el) => el.id === elementId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
          const id = uid('cmt')
          this.store.commit(() => {
            slide.comments = [...(slide.comments ?? []), { id, ...(elementId ? { elementId } : {}), author: commentAuthor(), text, at, forAgent: true }]
          })
          this.canvas.refreshComments()
          respond({ requestId: cmd.requestId, ok: true, commentId: id })
          return
        }
        if (op !== 'accept' && op !== 'reopen') { respond({ requestId: cmd.requestId, ok: false, error: 'op must be add, accept or reopen.' }); return }
        const commentId = typeof args.commentId === 'string' ? args.commentId : ''
        const owner = this.store.doc.slides.find((s) => s.comments?.some((c) => c.id === commentId))
        if (!owner) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-comment' }); return }
        this.store.commit(() => {
          const live = owner.comments!.find((c) => c.id === commentId)!
          delete live.agentDone
          if (op === 'reopen') {
            delete live.resolved
            if (text) live.replies = [...(live.replies ?? []), { id: uid('cmt'), author: commentAuthor(), text, at }]
          }
        })
        this.canvas.refreshComments()
        respond({ requestId: cmd.requestId, ok: true, commentId })
        return
      }
      case 'release_slide': {
        // Obsolete (locks no longer exclude anyone); kept as a harmless no-op
        // for sessions started before the change.
        respond({ requestId: cmd.requestId, ok: true })
        return
      }
      default:
        respond({ requestId: cmd.requestId, ok: false, error: `Unknown verb: ${cmd.verb}` })
    }
  }

  /**
   * propose_variants: builds each candidate WITHOUT touching store.doc or the
   * undo stack. A candidate is either a whole slide (`slide`, the
   * write_slide shape) or HTML (`html` + `css`), laid out exactly as a
   * slide_html write would lay it out and merged by id into a copy of the
   * slide — so the one picked keeps the slide's animations, links and
   * comments. One that cannot be made is dropped with its reason, not the
   * whole call; the agent hears which.
   */
  private async proposeVariants(slideId: string, args: Record<string, unknown>): Promise<{ ok: boolean; [k: string]: unknown }> {
    const rawVariants = Array.isArray(args.variants) ? args.variants.slice(0, MAX_VARIANTS) : []
    const survivors: PendingVariant[] = []
    const dropped: string[] = []
    const notes: string[] = []
    for (const [i, raw] of rawVariants.entries()) {
      const n = i + 1
      if (!raw || typeof raw !== 'object') { dropped.push(`variant ${n}: not an object`); continue }
      const candidate = raw as { slide?: unknown; html?: unknown; css?: unknown; label?: unknown; note?: unknown; theme?: unknown }
      const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 60) : undefined
      const note = typeof candidate.note === 'string' && candidate.note.trim() ? candidate.note.trim().slice(0, 240) : undefined
      // a look of its own: laid out and previewed under it, set on Use
      let theme: ThemePatch | undefined
      if (candidate.theme !== undefined) {
        const patch = candidate.theme && typeof candidate.theme === 'object' ? themePatch(candidate.theme as Record<string, unknown>) : 'not an object'
        if (typeof patch === 'string') { dropped.push(`variant ${n}: theme: ${patch}`); continue }
        theme = patch
      }
      if (typeof candidate.html === 'string') {
        const target = this.store.doc.slides.find((s) => s.id === slideId)
        if (!target) return { ok: false, error: 'no-such-slide' }
        const css = typeof candidate.css === 'string' && candidate.css ? candidate.css : undefined
        if (!candidate.html.trim()) { dropped.push(`variant ${n}: html is empty`); continue }
        if (candidate.html.length + (css?.length ?? 0) > MAX_SLIDE_HTML) { dropped.push(`variant ${n}: the HTML is too long (at most ${MAX_SLIDE_HTML} characters)`); continue }
        let compiled: CompileResult
        // components take their colours from the theme as they are laid out
        const layoutDoc = themedDoc(this.store.doc, theme)
        try { compiled = await compileSlideHtml(layoutDoc, target, { html: candidate.html, ...(css ? { css } : {}) }, this.agentCanvasSize(target.id)) } catch (e) {
          dropped.push(`variant ${n}: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        // laid out against the slide as it is NOW (it may have changed meanwhile)
        const now = this.store.doc.slides.find((s) => s.id === slideId)
        if (!now) return { ok: false, error: 'no-such-slide' }
        const made = slideFromCompiled(themedDoc(this.store.doc, theme), now, compiled)
        if (typeof made === 'string') { dropped.push(`variant ${n}: ${made}`); continue }
        // a slide still on the deck's background takes the look's (slides
        // store their background, so it would stay white under a dark look)
        if (theme?.background && made.background?.toLowerCase() === this.store.doc.theme.background.toLowerCase()) made.background = theme.background
        for (const line of compiled.notes) notes.push(`variant ${n}: ${line}`)
        survivors.push({ slide: made, label, note, ...(theme ? { theme } : {}) })
        continue
      }
      // Same untrusted-fragment rebuild write_slide runs a whole slide
      // through (applyExternalSlideWrite) — a candidate is exactly as
      // trusted as an agent's write_slide payload, no more. A bad
      // element type or an oversized field is dropped by sanitizeSlide
      // (per-element, same as a malicious paste); a mismatched slide.id
      // drops the WHOLE candidate here.
      const sanitized = sanitizeSlide(candidate.slide)
      if (!sanitized) { dropped.push(`variant ${n}: give html (+ css) or a whole slide`); continue }
      if (sanitized.id !== slideId) { dropped.push(`variant ${n}: slide.id must be "${slideId}"`); continue }
      survivors.push({ slide: sanitized, label, note, ...(theme ? { theme } : {}) })
    }
    if (!survivors.length) return { ok: false, error: `no-valid-variants${dropped.length ? ` (${dropped.join('; ')})` : ''}` }
    const target = this.store.doc.slides.find((s) => s.id === slideId)
    if (!target) return { ok: false, error: 'no-such-slide' }
    const replacing = !!this.pendingVariants
    this.pendingVariants = {
      slideId,
      variants: survivors,
      assets: sanitizeAssets(args.assets),
      fonts: sanitizeFonts(args.fonts),
      baseline: JSON.stringify(target),
    }
    this.updateVariantBadge()
    const num = this.store.doc.slides.indexOf(target) + 1
    const one = survivors.length === 1
    const message = replacing
      ? (one ? t('Claude proposed a new design — it replaces the ones you had not picked from') : t('Claude proposed {n} new designs — they replace the ones you had not picked from', { n: survivors.length }))
      : (one ? t('Claude proposed a design for slide {num}', { num }) : t('Claude proposed {n} designs for slide {num}', { n: survivors.length, num }))
    // never over a text being typed or another dialog: say so and wait.
    // Nobody sees a hidden instance's window: the pane shows the designs.
    if (desktopBackground()) { /* variants previews */ }
    else if (this.canvas.isEditingText || document.querySelector('dialog[open]')) actionToast(message, t('Compare'), () => this.openVariants())
    else this.openVariants()
    return {
      ok: true,
      count: survivors.length,
      ...(dropped.length ? { dropped } : {}),
      ...(notes.length ? { notes: notes.slice(0, 30) } : {}),
      shown: desktopBackground()
        ? `Nobody sees the app: call variants {op:"previews", slideId:"${slideId}"} so the user sees the designs in the BeeSlides pane, then go on with other work. variants {op:"status"} tells you later what they picked; do not wait or poll.`
        : `The user now compares them side by side with the current slide and picks one or keeps the slide. variants {op:"status"} tells you later what they picked; do not wait or poll.`,
    }
  }

  /** Opens the compare view for the pending designs (no-op without any). */
  openVariants() {
    if (this.pendingVariants) openVariantPicker(this, this.store)
  }

  /** Shows/hides and labels the topbar's propose_variants badge — called
   *  after pendingVariants is set (propose_variants) or cleared
   *  (applyVariant/discardVariants). No-op on the web topbar, which never
   *  builds variantBadge (propose_variants is desktop-shell-only, same as
   *  every other agent-action verb). */
  private updateVariantBadge() {
    if (!this.variantBadge) return
    if (this.pendingVariants) {
      this.variantBadge.innerHTML = `${ICONS.sparkle}<span>${this.pendingVariants.variants.length}</span>`
      this.variantBadge.style.display = ''
    } else {
      this.variantBadge.style.display = 'none'
    }
    this.rebuildSidebar()
  }

  /** Read-only view of the pending propose_variants set for variantpicker.ts
   *  — the field itself stays private so nothing outside
   *  applyAgentAction/applyVariant/discardVariants can assign to it. */
  getPendingVariants(): PendingVariants | null {
    return this.pendingVariants
  }

  /**
   * Commit the chosen candidate: merges its pending assets/fonts into
   * doc.assets/doc.fonts (collision-safe remap via clipboard.ts's
   * mergeClipResources — the same merge insertElements/insertSlides use),
   * rewrites the chosen slide's own refs through that remap, and replaces
   * the target slide — all inside ONE store.commit, so the whole thing is a
   * single undo step even when it also brought in new assets/fonts.
   */
  applyVariant(index: number, by: 'user' | 'agent' = 'user') {
    const pending = this.pendingVariants
    if (!pending) return
    const chosen = pending.variants[index]
    if (!chosen) return
    const idx = this.store.doc.slides.findIndex((s) => s.id === pending.slideId)
    if (idx < 0) {
      this.toast(t('That slide no longer exists — discarding the proposed variants.'))
      this.clearPendingVariants()
      return
    }
    this.store.commit(() => {
      const doc = this.store.doc
      // Deep-clone before mutating refs — pending.variants[index].slide must
      // stay untouched in case the picker is reopened before this commit
      // (it won't be, since clearPendingVariants runs right after, but a
      // clone costs nothing and avoids a stale-reference footgun).
      const slide = JSON.parse(JSON.stringify(chosen.slide)) as Slide
      mergeClipResources({ assets: pending.assets, fonts: pending.fonts }, doc, slide.elements)
      doc.slides[idx] = slide
      if (chosen.theme) applyThemePatch(doc, chosen.theme)
    }, 'slides')
    if (pending.fonts.length) injectFonts(this.store.doc)
    this.clearPendingVariants()
    if (idx !== this.store.currentIndex && !this.store.editingSurface) this.store.goTo(idx)
    const label = chosen.label ?? t('Design {n}', { n: index + 1 })
    this.variantOutcomes.set(pending.slideId, { kind: 'picked', index, label: chosen.label ?? `Design ${index + 1}`, by, ...(chosen.theme ? { themed: true } : {}) })
    this.toast(t('Used “{label}” on slide {num} — undo brings the old slide back', { label, num: idx + 1 }))
  }

  /** Discard the pending set without touching store.doc/store.commit/the
   *  undo stack in any way — just clears editor-local state and closes the
   *  picker/badge. */
  discardVariants(by: 'user' | 'agent' = 'user') {
    if (!this.pendingVariants) return
    this.variantOutcomes.set(this.pendingVariants.slideId, { kind: 'kept', by })
    this.clearPendingVariants()
    this.toast(t('Kept the current slide.'))
  }

  /** What became of each set of designs this session (the `variants` tool's
   *  status): set where Use and Keep act, never by "Decide later". */
  private readonly variantOutcomes = new Map<string, VariantOutcome>()

  /** The `variants` tool's view of the designs (agentops.ts). */
  private readonly agentVariants: VariantAccess = {
    pending: () => {
      const p = this.pendingVariants
      return p ? { slideId: p.slideId, labels: p.variants.map((v, i) => v.label ?? `Design ${i + 1}`) } : null
    },
    outcomes: () => this.variantOutcomes,
    snapshots: (slideId) => {
      const p = this.pendingVariants
      if (!p || p.slideId !== slideId) return `No designs are waiting for ${slideId}.`
      // rendered against a throwaway doc with the designs' assets, as the
      // compare view does (variantpicker.ts) — store.doc is never touched.
      // The design stands in its slide's place, so {{page}} and the like
      // read as they will once it is used.
      const { width, height } = this.store.doc.size
      const area = { x: 0, y: 0, w: width, h: height }
      return p.variants.map((v) => {
        const previewDoc: SlidomingoDoc = {
          ...themedDoc(this.store.doc, v.theme),
          assets: { ...this.store.doc.assets, ...p.assets },
          slides: this.store.doc.slides.map((s) => (s.id === p.slideId ? v.slide : s)),
        }
        return { html: slideSnapshotHtml(previewDoc, v.slide, area), width, height }
      })
    },
    use: (index) => {
      const p = this.pendingVariants
      if (!p?.variants[index]) return 'No such design.'
      if (!this.store.doc.slides.some((s) => s.id === p.slideId)) {
        this.clearPendingVariants()
        return 'That slide no longer exists; the designs were dropped.'
      }
      this.applyVariant(index, 'agent')
      return null
    },
    keep: () => {
      if (!this.pendingVariants) return 'No designs are waiting.'
      this.discardVariants('agent')
      return null
    },
  }

  private clearPendingVariants() {
    this.pendingVariants = null
    this.updateVariantBadge()
    closeVariantPicker()
  }

  private async checkRecovery() {
    if (formatGate()) return // nothing may replace a gated document in place
    // Desktop: the file on disk IS the document (autosaved straight to it, and
    // edited by Claude sessions behind the editor's back), so the browser-side
    // snapshot is always just an older copy of it. Offering it on every open
    // was pure noise — and Restore would have clobbered newer on-disk edits.
    if (desktopBound()) return
    const doc = this.store.doc
    const snap = await getRecovery(doc.docId)
    if (!snap) return
    let recovered: import('../model').SlidomingoDoc
    try { recovered = JSON.parse(snap.json) } catch { return }
    if (docContentKey(recovered) === docContentKey(doc)) return // the file already has these edits
    this.showRecoveryBanner(snap, recovered)
  }

  /**
   * Say ONCE, before any work is at risk, that this browser cannot rewrite the
   * open file. Shown on Safari/Firefox and every iOS browser (all WebKit, none
   * of which ship the File System Access API).
   *
   * Timing is the point. The editor used to state the opposite in its tooltips
   * and only correct itself in a toast AFTER the first save — by which time the
   * author had already trusted "⌘S rewrites this file" and, on a deck opened
   * from disk, had no idea their edits were going to Downloads instead.
   *
   * Once per browser, not per deck: it is a property of the browser, and
   * repeating it every time a file opens would be nagging.
   */
  /**
   * Tab title = deck title, plus the FILE name once one is known.
   *
   * `openedFileName()` answers this from the handle, or from the URL when a
   * `.beeslides.html` was opened directly — so it is right for a dropped file, a
   * saved file, and a double-clicked one alike, and null for the hosted demo.
   */
  private syncWindowTitle() {
    // Order matters. A handle is the truth. Failing that, a deck opened by drop
    // is named by the file it came from — the URL is stale the moment a drop
    // replaces the document, and would otherwise label this deck with the name
    // of the file still sitting in the address bar.
    // Desktop: the binding is the truth — the live page is always the app
    // shell now (windows.ts), so openedFileName() would name the shell.
    const bound = desktopBound()
    const file = bound ? desktopFileName() : (currentFileName() ?? this.openedAs ?? openedFileName())
    const named = file && fileBase(file) !== this.store.doc.title
    // Two segments, never three: a tab is narrow, and once a file name is
    // shown the app name is the least informative thing competing for it.
    // A template window is named by its template (the file), not its title.
    document.title = this.templateMode
      ? t('{name} — Layout', { name: this.templateName() })
      : named
        ? `${this.store.doc.title} — ${file}`
        : bound && desktopKind() === 'draft'
          ? `${this.store.doc.title} — ${t('Draft')}`
          : `${this.store.doc.title} — ${appConfig().appName}`
    this.reportDesktopState()
    this.syncTemplateBanner()
    if (!this.fileChip) return
    if (this.templateMode) {
      this.fileChip.hidden = false
      this.fileChip.textContent = this.templateName()
      this.fileChip.title = t('Saved automatically into this layout file as you work')
      return
    }
    if (bound) {
      this.fileChip.hidden = !named
      if (file) {
        this.fileChip.textContent = fileBase(file)
        this.fileChip.title = t('Saved automatically to this file as you work')
      }
      return
    }
    this.fileChip.hidden = !named
    if (!file) return
    this.fileChip.textContent = fileBase(file)
    // Three states, because two would lie: with the API but no handle yet, ⌘S
    // asks first and only then owns a file.
    this.fileChip.title = !canWriteInPlace()
      ? t('⌘S saves a copy — this browser can’t rewrite the file in place')
      : hasFileHandle()
        ? t('⌘S rewrites this file in place')
        : t('⌘S asks where to save, then rewrites that file in place')
  }

  /**
   * Open a `.beeslides.html` dropped onto the editor, adopting a WRITABLE handle
   * where the browser offers one.
   *
   * This is the only route to in-place saving for a deck that arrived from
   * disk. A file double-clicked in Finder opens on `file://` with no handle, so
   * every ⌘S re-runs the save picker and asks the user to navigate to the file
   * they already have open. `getAsFileSystemHandle()` returns a real handle for
   * a dropped file (Chromium only), so one permission prompt converts that deck
   * into one BeeSlides can rewrite.
   *
   * Guards, in order: images and everything else keep their existing paste/drop
   * behaviour; an encrypted deck is refused rather than half-opened, because the
   * password gate lives in boot and there is nothing here to prompt with; and
   * unsaved work is confirmed before being replaced, since this is destructive
   * in a way dropping a picture is not.
   */
  private async openDroppedDeck(ev: DragEvent): Promise<boolean> {
    const item = [...(ev.dataTransfer?.items ?? [])].find((i) => i.kind === 'file')
    const named = ev.dataTransfer?.files?.[0]?.name ?? ''
    if (!item || !hasDocExt(named)) return false
    ev.preventDefault()

    // Desktop: the dropped deck replaces this one (main flushes it first);
    // ⌘/⌥ held while dropping opens it in a new window.
    if (desktopBound()) {
      const dropped = ev.dataTransfer?.files?.[0]
      let path = ''
      try { path = dropped ? (window.slidomingoDesktop?.getPathForFile(dropped) ?? '') : '' } catch { /* no path */ }
      if (path) void window.slidomingoDesktop?.openDocument?.(path, { newWindow: ev.metaKey || ev.altKey })
      return true
    }

    if (this.store.dirty && !confirm(t('Open {name}? Unsaved changes in this deck will be lost.', { name: named }))) return true

    // The handle is the prize; a plain File still opens, just without write-back.
    //
    // ORDER MATTERS: requestPermission() needs a live user gesture, and the drop
    // is it. Reading the file first (600KB+ of text(), then DOMParser and
    // JSON.parse) spends the activation, so the request throws SecurityError and
    // the deck opens read-only — ⌘S then re-runs the save picker, which is the
    // whole thing this feature exists to avoid. So: handle, permission, THEN read.
    const anyItem = item as unknown as { getAsFileSystemHandle?: () => Promise<any> }
    let handle: any = null
    try { handle = await anyItem.getAsFileSystemHandle?.() } catch { /* not supported — read-only open */ }

    let writable = false
    if (handle?.requestPermission) {
      try { writable = await handle.requestPermission({ mode: 'readwrite' }) === 'granted' }
      catch { /* denied, or activation already spent — opens read-only */ }
    }

    const file: File | null = handle ? await handle.getFile() : (ev.dataTransfer?.files?.[0] ?? null)
    if (!file) return true

    await this.openFileLike(file, writable ? handle : null, named)
    return true
  }

  /**
   * Shared core of "replace this window's deck with a file the user picked":
   * both the drag-drop path (openDroppedDeck) and the picker path
   * (openViaPicker, used by the desktop shell's File → Open…) parse and adopt
   * the same way — this is the one place that logic lives.
   */
  private async openFileLike(file: File, handle: any | null, named: string): Promise<void> {
    const html = await file.text()
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector(DOC_BLOCK_SELECTOR)
    // resolved against the file's own asset store (kernel/src/assetstore.ts)
    const block = resolveDocText(el?.textContent?.trim() ?? '', html)
    // A pristine, never-saved shell ships an EMPTY block — the blank deck is
    // generated at runtime, not stored. That file is a perfectly good BeeSlides
    // document; it just has nothing in it yet, so say that rather than call it
    // a foreign file.
    if (el && !block) { alert(t('{name} is an empty copy of BeeSlides, not a saved deck. Open it on its own to start one.', { name: named })); return }
    let parsed: unknown
    try { parsed = JSON.parse(block) } catch { alert(t('{name} isn’t a BeeSlides document.', { name: named })); return }
    if (isEncFormat((parsed as { format?: string })?.format)) {
      alert(t('{name} is password-protected. Open it directly to unlock it.', { name: named }))
      return
    }
    const next = parseDoc(JSON.stringify(parsed))
    if (!next) { alert(t('{name} isn’t a BeeSlides document.', { name: named })); return }
    if (refuseNewerDoc(next, named, (m) => alert(m))) return

    if (handle) adoptFileHandle(handle)
    this.openedAs = named
    this.store.replaceDoc(next)
    this.canvas.render()
    this.syncWindowTitle()
    this.flashSaved(hasFileHandle() ? t('Opened {name}', { name: named }) : t('Opened {name} — ⌘S will save a copy', { name: named }))
    this.recordRecentDesktop(file)
  }

  /** Best-effort: resolves a File's OS path (desktop only — webUtils has no
   *  web equivalent) and records it in File ▸ Open Recent. Covers the two
   *  gaps windows.ts's own addRecent misses — in-app Open…/⌘O (this method)
   *  and a first Save (see save()) — never blocks the open/save itself. */
  private recordRecentDesktop(file: File) {
    if (!isDesktopShell()) return
    try {
      const path = window.slidomingoDesktop?.getPathForFile(file)
      if (path) window.slidomingoDesktop?.recordRecent(path)
    } catch { /* best effort — Recent Files just won't gain this entry */ }
  }

  /**
   * File → Open… (⌘O): the File System Access picker equivalent of
   * drag-drop, for a window that already has a deck open. On desktop the
   * native menu owns ⌘O and opens main's own dialog (menu.ts), so this is
   * reached only from the page's keydown; a plain browser tab has no menu,
   * so ⌘O is its only entry point. No-ops
   * silently where showOpenFilePicker doesn't exist (desktop Chromium always
   * has it; that's the whole feature this exists for).
   */
  async openViaPicker(opts: { newWindow?: boolean } = {}): Promise<void> {
    // Desktop: main's native dialog; the pick replaces this window's deck
    // (flushed first), or opens in a new window with `newWindow`.
    if (desktopBound() && window.slidomingoDesktop?.openDialog) { await window.slidomingoDesktop.openDialog(opts); return }
    const picker = (window as any).showOpenFilePicker
    if (typeof picker !== 'function') return
    let handle: any
    try {
      ;[handle] = await picker({
        types: [{ description: 'BeeSlides deck', accept: { 'text/html': ['.html'] } }],
        excludeAcceptAllOption: false,
        multiple: false,
      })
    } catch { return } // cancelled
    const file: File = await handle.getFile()
    const named = file.name
    if (!hasDocExt(named)) { alert(t('{name} isn’t a BeeSlides document.', { name: named })); return }
    if (this.store.dirty && !confirm(t('Open {name}? Unsaved changes in this deck will be lost.', { name: named }))) return

    let writable = false
    if (handle.requestPermission) {
      try { writable = await handle.requestPermission({ mode: 'readwrite' }) === 'granted' }
      catch { /* opens read-only */ }
    }
    await this.openFileLike(file, writable ? handle : null, named)
  }

  private noticeIfCannotWriteInPlace() {
    if (canWriteInPlace()) return
    if (lsGet(SAVE_NOTICE_KEY) === 'seen') return
    const bar = div('ed-recover')
    const msg = document.createElement('span')
    msg.textContent = t('This browser can’t rewrite files in place. ⌘S will download an updated copy instead — your work is also kept in this browser and offered back if you reopen.')
    const ok = document.createElement('button')
    ok.className = 'ed-btn ed-btn-primary'
    ok.textContent = t('Got it')
    ok.addEventListener('click', () => { lsSet(SAVE_NOTICE_KEY, 'seen'); bar.remove() })
    bar.append(msg, ok)
    document.body.appendChild(bar)
  }

  private showRecoveryBanner(snap: Snapshot, recovered: import('../model').SlidomingoDoc) {
    document.querySelector('.ed-recover')?.remove()
    const bar = div('ed-recover')
    const when = new Date(snap.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
    const msg = document.createElement('span')
    msg.textContent = t('Unsaved changes from {when} were found.', { when })
    const restore = document.createElement('button')
    restore.className = 'ed-btn ed-btn-primary'
    restore.textContent = t('Restore')
    restore.addEventListener('click', () => {
      this.checkpointBeforeReplace()
      this.store.replaceDoc(recovered)
      this.canvas.render()
      bar.remove()
      this.toast(t('Restored your unsaved changes'))
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'ed-btn'
    dismiss.textContent = t('Discard')
    dismiss.addEventListener('click', () => { void clearRecovery(this.store.doc.docId); bar.remove() })
    bar.append(msg, restore, dismiss)
    document.body.appendChild(bar)
  }

  /** Browse and restore the locally-kept auto-save timeline for this deck. */
  async openVersionHistory() {
    const versions = await listVersions(this.store.doc.docId)
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-version-box')
    const h = document.createElement('h2')
    h.textContent = t('Version history')
    box.appendChild(h)
    if (!versions.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-about-fine'
      empty.textContent = t('No saved versions yet — they accumulate as you edit and save.')
      box.appendChild(empty)
    } else {
      const list = div('ed-version-list')
      versions.forEach((v, i) => {
        const rowEl = document.createElement('button')
        rowEl.className = 'ed-version-row'
        const when = new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        const tag = [i === 0 ? t('most recent') : '', versionLabelText(v.label)].filter(Boolean).join(' · ')
        rowEl.innerHTML = `<span class="vh-when">${when}</span>` +
          `<span class="vh-tag"></span>` +
          `<span class="vh-do">${t('Restore')}</span>`
        rowEl.querySelector('.vh-tag')!.textContent = tag
        rowEl.addEventListener('click', () => {
          try {
            const restored = JSON.parse(v.json)
            if (refuseNewerDoc(restored, null, (m) => this.toast(m))) return
            this.checkpointBeforeReplace()
            this.store.replaceDoc(restored)
            this.canvas.render()
            overlay.remove()
            this.toast(t('Restored the version from {when} — ⌘Z undoes', { when }))
          } catch { this.toast(t('That version could not be read')) }
        })
        list.appendChild(rowEl)
      })
      box.appendChild(list)
    }
    // Desktop: the file's own bytes as they were before this app first
    // rewrote them in a session (desktop documents.ts) — opened as a copy.
    if (desktopBound() && window.slidomingoDesktop?.listBackups) {
      const backups = await window.slidomingoDesktop.listBackups()
      if (backups.length) {
        const sub = document.createElement('h3')
        sub.textContent = t('Earlier copies of the file')
        box.appendChild(sub)
        const list = div('ed-version-list')
        for (const b of backups) {
          const when = new Date(b.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          const rowEl = document.createElement('button')
          rowEl.className = 'ed-version-row'
          rowEl.innerHTML = `<span class="vh-when"></span><span class="vh-tag"></span><span class="vh-do"></span>`
          rowEl.querySelector('.vh-when')!.textContent = t('File as opened at {when}', { when })
          rowEl.querySelector('.vh-do')!.textContent = t('Open as copy')
          rowEl.addEventListener('click', () => {
            void window.slidomingoDesktop?.openBackup?.(b.path).then((ok) => {
              if (ok) { overlay.remove(); this.toast(t('Opened a copy in a new window')) }
            })
          })
          list.appendChild(rowEl)
        }
        box.appendChild(list)
      }
    }
    const fine = div('ed-about-fine')
    fine.textContent = desktopBound()
      ? t('Versions are kept on this computer, never in the file or online. Restoring is undoable.')
      : t('Versions are stored only in this browser, never in the file or online. Restoring is undoable.')
    box.appendChild(fine)
    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  /** Shortcuts + tips overlay (press ? or the topbar help button). */
  private openHelp() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-help-box')
    // The mark, animated like the boot splash (bee flies in, needle drops,
    // record turns, sound rings) — click it to play it again.
    const head = div('ed-help-head')
    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'ed-help-logo'
    mark.title = t('Play again')
    mark.setAttribute('aria-label', t('Play again'))
    const play = () => {
      mark.innerHTML = logoSvg(88, { animated: true })
      // restart the tile's own pop-in and sheen too
      mark.classList.remove('play')
      void mark.offsetWidth
      mark.classList.add('play')
    }
    mark.addEventListener('click', play)
    play()
    const titles = div('ed-help-titles')
    const word = div('ed-help-word')
    word.innerHTML = WORDMARK_HTML
    const h = document.createElement('h2')
    h.textContent = t('Shortcuts & tips')
    titles.append(word, h)
    head.append(mark, titles)
    box.appendChild(head)
    // Two explicit columns, placed by hand for balance + theme: LEFT = general
    // shortcuts & tips, RIGHT = the line/curve/path pointer-editing features.
    // (Auto column-count balanced poorly with these chunky, unsplittable sections.)
    const cols = div('ed-help-cols')
    box.appendChild(cols)
    const colL = div('ed-help-col')
    const colR = div('ed-help-col')
    cols.append(colL, colR)
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
    const section = (col: HTMLElement, title: string, rows: Array<[string, string]>) => {
      const sec = div('ed-help-sec')
      const st = document.createElement('h3'); st.textContent = title; sec.appendChild(st)
      for (const [k, d] of rows) {
        const r = div('ed-help-row')
        r.innerHTML = `<kbd></kbd><span></span>`
        r.querySelector('kbd')!.textContent = k
        r.querySelector('span')!.textContent = d
        sec.appendChild(r)
      }
      col.appendChild(sec)
    }
    section(colL, t('Editing'), [
      [`${mod}S`, t('Save')],
      [`${mod}Z · ${mod}⇧Z`, t('Undo · redo')],
      [`${mod}C · ${mod}V`, t('Copy · paste — elements, or the whole slide when nothing is selected')],
      [`${mod}⇧C`, t('Copy special: PowerPoint, picture, PNG, SVG or HTML — then press 1–6')],
      [`${mod}D`, t('Duplicate selection')],
      [mod === '⌘' ? '⌘F · ⌥⌘F' : 'Ctrl+F · Ctrl+H', t('Find · find and replace (text, tables, charts, notes)')],
      ['G · ⇧G', t('Group / ungroup the selection · always ungroup')],
      [`${mod}G`, t('Toggle the drawing grid')],
      [t('Alt/⌥-click'), t('Select the element underneath (repeat to go deeper)')],
      [t('Right-click ▸ Select'), t('Pick from overlapping elements, including locked and hidden ones')],
      [mod === '⌘' ? '⌥⇧T' : 'Alt+Shift+T', t('Tidy around the selection: fit text, keep gaps and arrows')],
      [mod === '⌘' ? '⌥⇧ L C R · U M B' : 'Alt+Shift+ L C R · U M B', t('Align left, centers, right · top, middles, bottom')],
      [mod === '⌘' ? '⌥⇧H · ⌥⇧V · ⌥⇧E' : 'Alt+Shift+H · V · E', t('Distribute horizontally · vertically · center on slide')],
      [mod === '⌘' ? '⌥⇧S' : 'Alt+Shift+S', t('Align and distribute relative to the slide (on/off)')],
      ['C', t('Comment mode')],
      ['Alt+F10', t('Jump to the quick-format toolbar (← → to move, Esc to leave)')],
      [`${mod},`, t('Settings')],
      ['?', t('This help')],
    ])
    section(colL, t('Canvas'), [
      [t('Space-drag'), t('Pan the canvas, including past the edges of the slide')],
      [t('Middle-drag'), t('Pan as well, if your mouse has a middle button')],
      [`${mod}-${t('scroll')}`, t('Zoom in and out')],
      [t('Margin guides'), t('Show the side margins as dashed lines (View menu)')],
      [t('Check slides'), t('Find cut-off text, missing pictures and broken links before presenting (View menu)')],
    ])
    const mac = mod === '⌘'
    section(colR, t('Slides'), [
      ['← → · PgUp PgDn', t('Previous · next slide, when nothing is selected')],
      ['Home · End', t('First · last slide')],
      [`${mod}D`, t('Duplicate the current slide, when nothing is selected')],
      [`${mod}1 · ${mod}2`, t('Slide Sorter · Outline View')],
      ['[ · ]', t('Hide or show the slide panel · the properties panel')],
    ])
    section(colR, t('Slide panel'), [
      [t('Click a thumbnail'), t('The keys below then act on the selected slides')],
      [`⇧-${t('click')} · ${mod}-${t('click')}`, t('Select a range · add or remove one slide')],
      ['↑ ↓ · ⇧↑ ⇧↓', t('Move through the thumbnails · extend the selection')],
      ['Delete', t('Delete the selected slides')],
      [`${mod}D · ${mod}A`, t('Duplicate the selected slides · select all')],
      [`${mod}C · ${mod}X · ${mod}V`, t('Copy · cut · paste slides')],
      [`${mod}↑ · ${mod}↓`, t('Move the selected slides up · down')],
      [`${mod}⇧↑ · ${mod}⇧↓`, t('Move them to the start · end')],
      [mac ? 'Enter' : 'Enter · Ctrl+M', t('New slide after the current one')],
      ['Esc', t('Back to the canvas')],
    ])
    section(colR, t('Lines & curves'), [
      [t('Shape ▾'), t('Draw a line, curved line or connector — then drag on the canvas')],
      [t('Drag a point'), t('Move an endpoint or anchor; drag the body to move the whole line')],
      [t('Click a point'), t('Reveal its bézier handles for a precise curve')],
      [`${t('Alt')}-${t('drag')}`, t('Break a smooth point into a sharp corner')],
      [t('Double-click'), t('Add a point on the line; double-click a point to remove it')],
    ])
    section(colR, t('Motion paths'), [
      [t('Presenting ▸ Loop'), t('Give an element a motion-path loop, then Edit path on canvas')],
      [t('Drag points'), t('Shape the trajectory — the first point is the element’s rest spot')],
      [t('Click a point'), t('Reveal bézier handles; Alt-drag one for a sharp corner')],
      [t('Double-click'), t('Add a point on the path; double-click a point to remove it')],
      [t('Scroll a point'), t('Set how fast the element moves through that point')],
    ])
    section(colL, t('Presenting'), [
      ['F5', t('Present')],
      ['F', t('Swap full screen and a window while presenting')],
      ['S', t('Speaker view — notes on a second screen if you have one')],
      ['K', t('Kiosk — the show advances by itself (the deck’s timing, else 10 s); press again to stop')],
      ['L', t('Toggle laser pointer while presenting')],
      ['M', t('Reduce motion — pause animations (also honours your OS setting)')],
      ['X', t('Open / leave the hidden extra slides after this slide')],
      ['P · H · E', t('Pen · highlighter · eraser — draw on the slide while presenting (never saved)')],
      ['C', t('Clear the drawing on this slide')],
      ['12 ↵', t('Type a slide number, then Enter, to jump to it')],
      ['← · →', t('Previous · next slide')],
      ['Esc', t('End the show')],
    ])
    const tips = div('ed-help-sec')
    const tt = document.createElement('h3'); tt.textContent = t('Good to know'); tips.appendChild(tt)
    const ul = document.createElement('ul'); ul.className = 'ed-help-tips'
    for (const tip of [
      t('Paste an image or text straight onto the canvas with ⌘V.'),
      t('Copy a slide (⌘C with nothing selected) and paste it into another BeeSlides deck.'),
      t('Make a chart from a table and it stays linked — edit the table, the chart updates.'),
      t('Your work auto-saves; restore earlier versions from Save → Version history.'),
    ]) { const li = document.createElement('li'); li.textContent = tip; ul.appendChild(li) }
    tips.appendChild(ul); colL.appendChild(tips)
    const more = div('ed-help-more')
    const keys = document.createElement('button')
    keys.type = 'button'
    keys.className = 'ed-help-keys'
    keys.textContent = t('Change shortcuts…')
    keys.title = t('Every command and its keys — search, change, reset')
    keys.addEventListener('click', () => { close(); this.openSettings('shortcuts') })
    more.appendChild(keys)
    const link = document.createElement('a')
    link.href = 'https://github.com/miqsoft/beeslides/blob/main/docs/agents.md'
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = t('Full guide on GitHub →')
    more.appendChild(link)
    box.appendChild(more)
    overlay.appendChild(box)
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  /** Whichever Save indicator is actually visible right now — the main
   *  editor's own, or the Layout Manager overlay's while it owns the screen
   *  (its head bar covers the main topbar entirely). */
  private activeSaveIndicator(): SaveIndicator {
    return (this.layoutManagerOpen && this.layoutManagerSession?.saveIndicator) || this.saveIndicator
  }

  private flashSaved(message = t('Saved')) {
    this.activeSaveIndicator().flash(message)
  }

  async save(forcePicker: boolean) {
    if (refuseGatedWrite((m) => this.toast(m))) return
    this.canvas.commitTextEdit()
    if (desktopBound()) { await this.saveDesktop(forcePicker); return }
    try {
      const result = await saveFile(this.store.doc, forcePicker)
      if (result === 'cancelled') return
      // A brand-new handle was just picked (first save, or Save As) — record
      // it in Recent Files now, since a never-reopened new deck otherwise
      // never appears there (see recordRecentDesktop above).
      if (result === 'saved-as' && isDesktopShell()) {
        const handle = currentFileHandle() as { getFile?: () => Promise<File> } | null
        void handle?.getFile?.().then((file) => this.recordRecentDesktop(file)).catch(() => { /* best effort */ })
      }
      this.store.setDirty(false)
      // the file name is knowable from here on — put it in the tab and the chip
      this.syncWindowTitle()
      // record a recovery baseline + a version checkpoint at each manual save
      this.checkpointSaved()
      // A save from the WEB changes what this page is: the deck now lives in a
      // file, and this URL will hand out a fresh starter next time. Said here,
      // persistently, so the next visit is not a surprise — and deliberately
      // NOT as a block, because this tab keeps working and keeps writing.
      noteSavedFromWeb(currentFileName() ?? suggestedFileName(this.store.doc), {
        fsAccess: canWriteInPlace(), canWrite: hostCan('write'),
      })
      this.toast(result === 'downloaded'
        ? t('This browser can’t rewrite files in place — a fresh copy went to Downloads')
        : t('Saved'))
    } catch (err) {
      console.error(err)
      this.toast(t('Save failed — see console'))
    }
  }

  // --- keyboard ------------------------------------------------------------------

  private wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (this.presenting) return
      const mod = ev.metaKey || ev.ctrlKey
      // The mini toolbar owns its own plain keys (arrows move between its
      // buttons, Esc leaves it) — they must not also nudge or delete the
      // selection. Modifier shortcuts (⌘Z, ⌘S…) still work from there.
      if (!mod && ev.target instanceof Element && ev.target.closest('.ed-minibar')) return
      // Alt+F10 — keyboard access to the mini toolbar (PowerPoint's chord)
      if (ev.altKey && ev.key === 'F10') {
        if (this.quickBar.focus() || this.miniToolbar.focus()) ev.preventDefault()
        return
      }
      const inField =
        ev.target instanceof Element &&
        ev.target.closest('input, textarea, select, [contenteditable="true"]') != null

      // ⌘, — Settings, also from inside a field and over the
      // Layout Manager (Settings stacks above it). In the desktop app the
      // native menu accelerator (menu.ts) usually wins first; a second
      // openSettings() just replaces the overlay, so a double-fire is harmless.
      if (mod && ev.key === ',') {
        ev.preventDefault()
        this.canvas.commitTextEdit()
        this.openSettings()
        return
      }

      if (this.layoutManagerOpen) {
        // The overlay owns the screen, so every other shortcut below stays a
        // no-op here (Present/Slide Sorter/Outline/PDF export/etc. already
        // toast or have no meaning while it's open) — except Delete/
        // Backspace, Undo/Redo, Duplicate, and Save, which operate on
        // store.slide/store.selectedElements/store.commit (or, for Save,
        // this.canvas/this.store generically) and already resolve to the
        // right sub-editor via store.editingSurface. Falling through (rather
        // than reimplementing) reaches their existing handling further down
        // in this same handler.
        if (inField) return
        const allowed =
          ev.key === 'Delete' ||
          ev.key === 'Backspace' ||
          (mod && ev.key.toLowerCase() === 'z') ||
          (mod && ev.key.toLowerCase() === 'y') ||
          (mod && ev.key.toLowerCase() === 'd') ||
          (mod && ev.key.toLowerCase() === 's')
        if (!allowed) return
      }

      if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        this.save(false)
        return
      }
      // ⌘P = File ▸ Export PDF… wherever the menu shows it (native or in-page
      // menu bar) — printing the editor UI itself is never what's wanted
      if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'p' && this.ribbonChrome && !this.isCanvasDoc) {
        ev.preventDefault()
        void this.exportPdf()
        return
      }
      if (mod && ev.key.toLowerCase() === 'o') {
        ev.preventDefault()
        void this.openViaPicker({ newWindow: ev.shiftKey })
        return
      }
      // ⌘/Ctrl + − 0 are NOT handled here: they zoom the whole UI (the browser
      // natively, desktop via View ▸ Zoom — docs/DECISIONS.md 2026-10-11). The
      // slide canvas zooms with ⌘/Ctrl+wheel, pinch and the zoom bar.
      if (ev.key === 'F5') {
        ev.preventDefault()
        this.present(!ev.shiftKey)
        return
      }
      // ⌘F find / ⌥⌘F (Ctrl+H) find and replace — from the canvas, from an
      // inline text edit (seeded with the selected words; the edit commits as
      // the bar takes focus), from the notes and from the bar itself. Any
      // OTHER field (panel inputs, dialogs, the terminal) keeps the key.
      const chord = findChord(ev)
      if (chord) {
        const target = ev.target instanceof Element ? ev.target : null
        const canvasEdit = !!target?.closest('.ed-canvas-wrap [contenteditable="true"]')
        if (!inField || canvasEdit || target?.closest('.ed-findbar, .ed-notes-pane')) {
          ev.preventDefault()
          this.openFind(chord === 'replace', canvasEdit || target?.closest('.ed-notes-pane') ? selectedWords() : undefined)
          return
        }
      }
      if (inField) return

      if (!mod && (ev.key === '?' || (ev.key === '/' && ev.shiftKey))) {
        ev.preventDefault()
        this.openHelp()
        return
      }
      // The slide panel has focus: Delete/⌘D/arrows/… act on the selected
      // slides, ahead of every element shortcut below.
      if (this.slidesFocused() && this.handleSlidePanelKey(ev, mod)) {
        ev.preventDefault()
        return
      }
      // selected table cells take arrows/Tab/Enter/Delete/Esc before the
      // element shortcuts (which would nudge or delete the whole table)
      if (!this.slidesFocused() && this.canvas.tableRange.handleKey(ev)) {
        ev.preventDefault()
        return
      }
      if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'a') {
        ev.preventDefault()
        this.canvas.selectAllElements()
        return
      }
      // ⌥⇧ + letter — Align / Distribute (menumodel.ts shows them). By code,
      // like ⌥⇧T: on a Mac ⌥ changes the character. Before plain C, which
      // would otherwise read ⌥⇧C as "comment" off a Mac.
      if (ev.altKey && ev.shiftKey && !mod) {
        const cmd = ALIGN_KEYS[ev.code]
        if (cmd) {
          ev.preventDefault()
          this.commands.run(cmd)
          return
        }
      }
      if (!mod && ev.key.toLowerCase() === 'c') {
        ev.preventDefault()
        if (!this.layoutManagerOpen) this.canvas.toggleCommentMode()
        return
      }
      // ⌥⇧T — Tidy around the selection (layout guard on your own edit). By
      // code, not key: on a Mac ⌥⇧T types a character, not "t".
      if (ev.altKey && ev.shiftKey && !mod && ev.code === 'KeyT') {
        ev.preventDefault()
        if (this.store.selection.length) this.panel.tidy(this.store.selectedElements)
        return
      }
      // ⌘G toggles the grid (⇧⌘G is deliberately unbound — no group/ungroup here any more)
      if (mod && ev.key.toLowerCase() === 'g') {
        ev.preventDefault()
        if (!ev.shiftKey && !this.layoutManagerOpen) this.toggleGrid()
        return
      }
      // G groups (ungroups when the selection already is exactly one group); ⇧G always ungroups
      if (!mod && !ev.altKey && ev.key.toLowerCase() === 'g') {
        ev.preventDefault()
        if (this.layoutManagerOpen) return
        const els = this.store.selectedElements
        if (ev.shiftKey) this.panel.ungroup(els)
        else {
          const gid = els[0]?.groupId
          const isOneGroup = !!gid && els.every((e) => e.groupId === gid) &&
            this.store.slide.elements.filter((e) => e.groupId === gid).length === els.length
          if (isOneGroup) this.panel.ungroup(els)
          else if (els.length >= 2) this.panel.group(els)
        }
        return
      }
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault()
        ev.shiftKey ? this.redo() : this.undo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault()
        this.redo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'd') {
        ev.preventDefault()
        // nothing selected: the current slide — the way ⌘C copies it then
        if (this.store.selection.length || this.layoutManagerOpen) this.duplicateSelection()
        else this.duplicateSlide(this.store.currentIndex)
        return
      }
      // Mirrors Keynote's ⌘1 (Light Table)/⌘2 (Outline) — neither view had a
      // shortcut before; both already no-op with a toast while the Layout
      // Manager owns the screen (openSlideSorter/openOutlineView's own
      // layoutManagerOpen check), and the layoutManagerOpen allow-list above
      // already filters ⌘1/⌘2 out before they'd reach here.
      if (mod && ev.key === '1') {
        ev.preventDefault()
        this.openSlideSorter()
        return
      }
      // ⌘C / ⌘X / ⌘V are the browser's (or the desktop Edit menu's) own
      // copy/cut/paste events — wireCopy and wirePaste — so they can write
      // the clipboard without a permission and receive images and cross-deck
      // payloads. Nothing to do here; returning keeps plain-letter shortcuts
      // below from seeing them. ⇧⌘C opens Copy special (pictures, SVG,
      // HTML), which no copy event can carry.
      if (mod && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') {
        ev.preventDefault()
        this.openCopySpecial()
        return
      }
      if (mod && ['c', 'x', 'v'].includes(ev.key.toLowerCase())) return
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this.store.selection.length) {
          ev.preventDefault()
          // Routes through the panel's deleteEls — NOT a raw filter here —
          // so deleting a container by keyboard gets the same orphan-impact
          // confirm() as the panel's own trash button.
          this.panel.deleteEls(this.store.selectedElements)
        }
        return
      }
      // nothing selected → arrows walk slides (Left/Up = prev, Right/Down = next);
      // when an element IS selected they nudge it (branch below). inField already
      // returned above, so this never fires mid text/cell edit.
      if (ev.key.startsWith('Arrow') && !this.store.selection.length && !this.canvas.isPathEditing) {
        ev.preventDefault()
        this.store.goToLinear(ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (ev.key.startsWith('Arrow') && this.store.selection.length) {
        ev.preventDefault()
        if (this.store.selectedElements.some((el) => el.locked)) return // locked: no nudging
        const step = ev.shiftKey ? 10 : 1
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0
        this.store.commit(() => {
          for (const el of this.store.selectedElements) {
            el.x += dx
            el.y += dy
          }
        })
        return
      }
      if (ev.key === '[') {
        this.togglePanel('left')
        return
      }
      if (ev.key === ']') {
        this.togglePanel('right')
        return
      }
      if (ev.key === 'Escape') {
        if (this.canvas.isDrawing) this.canvas.cancelDraw()
        else if (this.canvas.isPathEditing) this.canvas.stopPathEdit(true)
        else this.store.select([])
        return
      }
      if (ev.key === 'PageDown') {
        ev.preventDefault()
        this.store.goToLinear(1)
        return
      }
      if (ev.key === 'PageUp') {
        ev.preventDefault()
        this.store.goToLinear(-1)
        return
      }
      if ((ev.key === 'Home' || ev.key === 'End') && !mod && !this.store.selection.length) {
        ev.preventDefault()
        const slides = this.store.doc.slides
        const linear = slides.map((s, i) => (inLinearFlow(s) ? i : -1)).filter((i) => i >= 0)
        const to = ev.key === 'Home' ? linear[0] : linear[linear.length - 1]
        if (to != null) this.store.goTo(to)
      }
    })
  }

  /** wireKeyboard's slide-panel branch (PowerPoint's thumbnail-pane keys).
   *  True = handled. ⌘C/⌘X/⌘V are not here: they ride the native clipboard
   *  events, whose handlers (wireCopy/wirePaste) check slidesFocused(). */
  private handleSlidePanelKey(ev: KeyboardEvent, mod: boolean): boolean {
    const k = ev.key
    if (ev.altKey) return false
    const up = k === 'ArrowUp' || k === 'ArrowLeft'
    if (!mod && (k === 'Delete' || k === 'Backspace')) {
      this.deleteSlides(this.selectedSlideIds())
      return true
    }
    if (mod && !ev.shiftKey && k.toLowerCase() === 'd') {
      this.duplicateSlides(this.selectedSlideIds())
      return true
    }
    if (mod && !ev.shiftKey && k.toLowerCase() === 'a') {
      this.setSlideSel(this.store.doc.slides.map((s) => s.id))
      return true
    }
    // Enter, or Ctrl+M as in PowerPoint — never ⌘M, macOS's Minimize
    if ((!mod && !ev.shiftKey && k === 'Enter') || (ev.ctrlKey && !ev.metaKey && k.toLowerCase() === 'm')) {
      this.newSlideAfterCurrent()
      return true
    }
    if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
      this.moveSelectedSlides(ev.shiftKey ? (up ? 'start' : 'end') : (up ? -1 : 1))
      return true
    }
    if (!mod && k.startsWith('Arrow')) {
      this.stepSlidePanel(up ? 'prev' : 'next', ev.shiftKey)
      return true
    }
    if (!mod && (k === 'Home' || k === 'End')) {
      this.stepSlidePanel(k === 'Home' ? 'first' : 'last', ev.shiftKey)
      return true
    }
    if (k === 'Escape') {
      const id = this.store.doc.slides[this.store.currentIndex]?.id
      this.setSlideSel(id ? [id] : [])
      this.sidebar.blur()
      return true
    }
    return false
  }

  /** The context menu's Copy: elements when any are selected, otherwise the
   *  current slide, onto the system clipboard as a BeeSlides payload (works
   *  across decks/tabs, not just this session). ⌘C does the same through
   *  the native copy event (wireCopy). */
  copySelection() {
    if (this.copyTableCells(false)) return
    const clip = this.clipPayload()
    if (!clip) return
    void this.writeClipboard(clip.text).then((ok) => {
      if (ok && clip.kind === 'slide') this.toast(t('Slide copied — ⌘V in any deck to paste it'))
    })
  }

  /** Copy special (⇧⌘C, right-click, Edit): the formats of
   *  editor/copyspecial.ts as a numbered popup at `at`, or under the
   *  selection (the canvas's middle with none). */
  openCopySpecial(at?: { x: number; y: number }) {
    const n = this.store.selectedElements.length
    if (!at) {
      const boxes = this.store.selection
        .map((id) => document.querySelector(`.ed-stage-scale .beeslides-el[data-el-id="${CSS.escape(id)}"]`)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r)
      const stage = document.querySelector('.ed-stage-scale')?.getBoundingClientRect()
      at = boxes.length
        ? { x: Math.min(...boxes.map((r) => r.left)), y: Math.max(...boxes.map((r) => r.bottom)) + 8 }
        : stage ? { x: stage.left + stage.width / 2 - 140, y: stage.top + stage.height / 3 } : { x: 200, y: 200 }
    }
    openCopySpecialMenu({
      ...at,
      caption: n === 0 ? t('Copy the slide as') : n === 1 ? t('Copy the object as') : t('Copy {n} objects as', { n }),
      pick: (f) => this.copyAs(f),
      settings: () => this.openSettings('copy'),
    })
  }

  /** The selected elements, or the current slide, onto the clipboard as `format`. */
  copyAs(format: CopyFormat) {
    const els = this.store.selectedElements
    copySpecial(format, this.store.doc, this.store.slide, els.length ? els : null).then(
      (msg) => this.toast(msg),
      () => this.toast(t('Could not copy')),
    )
  }

  /** Context-menu Cut: copy, then delete — no separate clipboard state, so
   *  a plain ⌘V (or the menu's own Paste) is what un-cuts it. Deletes only
   *  once the copy has landed: a refused write must not lose the objects. */
  cutSelection() {
    if (this.copyTableCells(true)) return
    const els = this.store.selectedElements
    if (!els.length) return
    void this.writeClipboard(serializeElements(els, this.store.doc)).then((ok) => {
      if (ok) this.panel.deleteEls(els)
    })
  }

  /** The context menu's Copy / Cut on selected table cells: the cells as
   *  tab-separated text plus an html table (the async clipboard carries no
   *  custom type; tablerange.ts remembers the block, so pasting that text
   *  back keeps its merged cells). Cut clears the cells once the copy landed.
   *  False = no cells selected. */
  private copyTableCells(cut: boolean): boolean {
    const cells = this.canvas.tableRange
    if (this.slidesFocused()) return false
    const data = cells.copyData()
    if (!data) return false
    const write = async () => {
      try {
        if (typeof ClipboardItem === 'function' && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([data.text], { type: 'text/plain' }),
            'text/html': new Blob([data.html], { type: 'text/html' }),
          })])
        } else await navigator.clipboard.writeText(data.text)
        return true
      } catch {
        return this.writeClipboard(data.text)
      }
    }
    void write().then((ok) => { if (ok && cut) cells.run('clear') })
    return true
  }

  /** Context-menu Paste. The real paste handler (wirePaste) rides the
   *  browser's native 'paste' event, which a menu click can't dispatch — so
   *  this reads the clipboard directly and feeds the same parseClip/
   *  insertElements path. Only text payloads are reachable this way (no
   *  clipboard-image permission prompt from a menu click). */
  async pasteFromClipboardAsync(opts: { plain?: boolean } = {}) {
    const plain = !!opts.plain
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      this.toast(t('Couldn’t access the clipboard'))
      return
    }
    if (this.presenting) return
    // the ⌘⇧V fallback (wirePaste) can land in a focused field or text
    // edit: there it is just the words, at the caret
    if (plain && this.textOwnsClipboard()) {
      if (text) insertLiteralText(text)
      return
    }
    // onto selected table cells: copied cells or tab-separated text
    if (!this.slidesFocused() && this.canvas.tableRange.pasteData(null, text, (s) => !!parseClip(s))) return
    const clip = parseClip(text)
    if (clip?.kind === 'elements') {
      let added: SlideElement[] = []
      this.store.commit(() => { added = insertElements(clip, this.store.doc, this.store.slide, { plain }) })
      if (clip.fonts?.length && !plain) injectFonts(this.store.doc)
      this.store.select(added.map((e) => e.id))
      this.toast(added.length === 1 ? t('Pasted 1 item') : t('Pasted {n} items', { n: added.length }))
      return
    }
    if (clip?.kind === 'slides') {
      this.pasteSlides(clip)
      return
    }
    if (text && text.trim()) {
      const esc = plainTextHtml(text.trim().slice(0, 4000))
      const { width } = this.store.doc.size
      const el = defaultText({ ...textDefaultsFor(this.store.doc, this.store.slide), html: esc, x: Math.round(width / 2 - 300), y: 260, w: 600 })
      this.store.commit(() => this.store.slide.elements.push(el))
      this.store.select([el.id])
      this.toast(t('Text pasted'))
    }
  }

  private duplicateSelection() {
    const els = this.store.selectedElements
    if (!els.length) return
    const clones = els.map((el) => cloneElement(el))
    // the copies form their own group/container/connector set, not the originals'
    remapCopiedRefs(clones, new Map(els.map((el, k) => [el.id, clones[k].id])))
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  // --- toast ------------------------------------------------------------------

  // --- about & updates ------------------------------------------------------

  /** About dialog: version, user-initiated update check, licenses. */
  /**
   * Small, pure-branding panel: logo/wordmark, version, the promo blurb and
   * license credits. Opened from the topbar/titlebar logo. Everything with an
   * actual control on it (theme, updates, offline, icons, language, document
   * properties) lives in openSettings() instead — see docs/DECISIONS.md for
   * why the two were split (this dialog used to be a 350-line scroll mixing
   * both).
   */
  private openAboutPanel() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')

    const head = div('ed-about-head')
    // The logo/wordmark links to the project's GitHub repo (new tab).
    head.innerHTML =
      `<a class="ed-about-logo" href="https://github.com/miqsoft/beeslides" target="_blank" rel="noopener">` +
      logoSvg(28) +
      `<div><b>${WORDMARK_HTML}</b><span>v${APP_VERSION} · format v${FORMAT_VERSION}</span></div>` +
      `</a>`
    head.querySelector('a')?.setAttribute('title', t('Visit BeeSlides on GitHub (opens in a new tab)'))
    box.appendChild(head)

    // Engagement nudge back to the project's GitHub repo (agent guide, issues).
    const promo = div('ed-about-promo')
    promo.innerHTML = t(
      'New to BeeSlides? Find the AI editing guide and more at {gh} — or ⭐ it there.',
      {
        gh: '<a href="https://github.com/miqsoft/beeslides" target="_blank" rel="noopener">GitHub</a>',
      },
    )
    box.appendChild(promo)

    const row = div('ed-about-row')
    const settingsB = document.createElement('button')
    settingsB.className = 'ed-btn ed-btn-primary'
    settingsB.textContent = t('Settings')
    settingsB.addEventListener('click', () => { overlay.remove(); this.openSettings() })
    row.appendChild(settingsB)
    box.appendChild(row)

    const fine = div('ed-about-fine')
    fine.textContent = t('Free software under the AGPL-3.0 · Includes reveal.js, Moveable, Selecto (MIT) · Fraunces + Instrument Sans typefaces (OFL-1.1) — full notices travel in this file’s source.')
    box.appendChild(fine)

    overlay.appendChild(box)
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  }

  /** Ordered so the sidebar reads by how often a person opens each one;
   *  Keyboard shortcuts sits high because people look for it first. */
  private static readonly SETTINGS_CATEGORIES: Array<{ id: SettingsCategoryId; icon: string; label: () => string; title: () => string; keywords: () => string }> = [
    { id: 'general', icon: ICONS.settings, label: () => t('General'), title: () => t('General app preferences'), keywords: () => `language locale translation appearance theme dark light offline network quick-format toolbar ${t('Language')} ${t('Appearance')} ${t('Offline mode — block all network features')}` },
    { id: 'shortcuts', icon: ICONS.keyboard, label: () => t('Keyboard shortcuts'), title: () => t('Every command and its keys — search, change, reset'), keywords: () => `keys keymap hotkeys accelerator ${t('Shortcut')}` },
    { id: 'copy', icon: ICONS.copy, label: () => t('Copy special'), title: () => t('Picture resolution, background and text outlines for Copy special'), keywords: () => `clipboard png svg html powerpoint picture ${t('Picture resolution')}` },
    { id: 'customize', icon: ICONS.paintbrush, label: () => t('Customize'), title: () => t('Your own tabs, buttons, menus, styles and look for this editor'), keywords: () => 'customise ui profile' },
    { id: 'ai', icon: ICONS.terminal, label: () => t('AI chat'), title: () => t('Profiles for the chat panel: Claude Code commands and API chats'), keywords: () => 'claude api key model provider openai anthropic profile' },
    { id: 'icons', icon: ICONS.sparkle, label: () => t('Icon library'), title: () => t('Manage the icon library used when inserting icons'), keywords: () => 'icons server folder token source' },
    { id: 'document', icon: ICONS.notes, label: () => t('Document properties'), title: () => t('Edit document metadata like author, company, and subject'), keywords: () => `author company subject title fonts clean up metadata ${t('Fonts in use')}` },
  ]

  /** Settings ▸ Customize's tabs, for the Settings search. */
  private static readonly CUSTOMIZE_KEYWORDS: Record<CustomizeTab, string> = {
    buttons: 'ribbon tab toolbar button hide group my tools',
    menus: 'right-click context menu quick-format bar minibar pin hide',
    styles: 'style preset selection save look',
    look: 'density compact accent colour color chrome',
    backup: 'import export history reset share file backup undo',
  }

  /**
   * Real, categorized app settings: a sidebar of categories + a content pane
   * (+ on Customize and Keyboard shortcuts, the "Customize with AI" chat as a
   * sidebar on the right, desktop only). A search field above the categories
   * finds settings, Customize's tabs and commands' shortcuts. ONE layout for
   * every category. Closed by the Close button, Esc, or ⌘, again. Replaces the
   * old openAbout()'s flat scroll and the separate openLanguages() modal.
   *
   * Restores whichever category was open last (persisted per-browser, not
   * per-doc — a UI preference, like theme).
   */
  openSettings(open?: SettingsCategoryId, opts: { query?: string; tab?: CustomizeTab } = {}) {
    if (this.presenting) return // ⌘, from the native menu reaches here mid-show
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay ed-settings-overlay')
    const box = div('ed-about ed-settings-box')

    const head = div('ed-settings-head')
    const title = document.createElement('div')
    title.className = 'ed-about-h'
    title.textContent = t('Settings')
    const chatB = document.createElement('button')
    chatB.type = 'button'
    chatB.className = 'ed-settings-chatbtn'
    chatB.innerHTML = `${ICONS.sparkle}<span>${t('Ask AI')}</span>`
    chatB.title = t('Show or hide the AI chat that customizes the editor for you')
    chatB.hidden = true
    const closeB = document.createElement('button')
    closeB.className = 'ed-settings-close'
    closeB.title = t('Close')
    closeB.append(t('Close') + ' ', Object.assign(document.createElement('kbd'), { textContent: 'Esc' }))
    closeB.addEventListener('click', () => close())
    head.append(title, chatB, closeB)
    box.appendChild(head)

    const body = div('ed-settings-body')
    const nav = div('ed-settings-nav')
    const content = div('ed-settings-content')
    const aside = div('ed-settings-chat')
    aside.hidden = true
    body.append(nav, content, aside)
    box.appendChild(body)

    const saved = lsGet('slidomingo-settings-cat') as SettingsCategoryId | null
    // AI profiles exist only in the desktop app (their storage lives in main).
    const categories = Editor.SETTINGS_CATEGORIES.filter((c) => c.id !== 'ai' || aiSettingsAvailable())
    const known = new Set(categories.map((c) => c.id))
    let active: SettingsCategoryId = open && known.has(open) ? open : saved && known.has(saved) ? saved : 'general'

    // ---- the AI chat sidebar (desktop, Customize + Keyboard shortcuts) ----
    const bridge = chatBridge()
    let chatMounted = false
    const chatWanted = () => lsGet('slidomingo-settings-chat') !== 'off'
    const syncChat = () => {
      const fits = !!bridge && (active === 'customize' || active === 'shortcuts')
      chatB.hidden = !fits
      const show = fits && chatWanted()
      chatB.classList.toggle('active', show)
      chatB.setAttribute('aria-pressed', String(show))
      aside.hidden = !show
      if (show && !chatMounted && bridge) {
        chatMounted = true
        renderChatPane(aside, {
          store: this.store, profiles: this.customizer!.profiles, bridge,
          openAiSettings: known.has('ai') ? () => select('ai') : undefined,
          onClose: () => setChat(false),
        })
      }
    }
    const setChat = (on: boolean, focus = false) => {
      lsSet('slidomingo-settings-chat', on ? 'on' : 'off')
      syncChat()
      if (on && focus) aside.querySelector<HTMLTextAreaElement>('.ed-czc-input')?.focus()
    }
    chatB.addEventListener('click', () => setChat(aside.hidden, true))

    const navButtons = new Map<SettingsCategoryId, HTMLElement>()
    const renderCategory = (id: SettingsCategoryId, o: { query?: string; tab?: CustomizeTab } = {}) => {
      content.innerHTML = ''
      content.scrollTop = 0
      if (id === 'general') this.renderGeneralCategory(content)
      else if (id === 'shortcuts') renderKeymapPane(content, { profiles: this.customizer!.profiles, toast: (m) => this.toast(m), query: o.query, openHelp: () => { close(); this.openHelp() } })
      else if (id === 'copy') renderCopySettings(content)
      else if (id === 'icons') this.renderIconsCategory(content)
      else if (id === 'ai') renderAiCategory(content, (m) => this.toast(m))
      else if (id === 'customize') {
        renderCustomizePane(content, {
          customizer: this.customizer!, store: this.store, toast: (m) => this.toast(m), tab: o.tab,
          openShortcuts: () => select('shortcuts'),
          openChat: bridge ? () => setChat(true, true) : undefined,
        })
      } else renderDocumentMetaForm(content, this.store)
    }
    const select = (id: SettingsCategoryId, o: { query?: string; tab?: CustomizeTab } = {}) => {
      active = id
      lsSet('slidomingo-settings-cat', id)
      for (const [cid, b] of navButtons) b.classList.toggle('active', cid === id)
      renderCategory(id, o)
      syncChat()
    }

    // ---- search -------------------------------------------------------------
    const searchBox = document.createElement('label')
    searchBox.className = 'ed-settings-search'
    searchBox.innerHTML = ICONS.search
    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = t('Search settings…')
    search.setAttribute('aria-label', t('Search settings…'))
    searchBox.appendChild(search)
    const items = div('ed-settings-navitems')
    const results = div('ed-settings-results')
    results.hidden = true
    nav.append(searchBox, items, results)

    type Hit = { label: string; where: string; go: () => void }
    const hits = (q: string): Hit[] => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean)
      const match = (s: string) => words.every((w) => s.toLowerCase().includes(w))
      const out: Hit[] = []
      for (const c of categories) {
        if (match(`${c.label()} ${c.title()} ${c.keywords()}`)) out.push({ label: c.label(), where: t('Settings'), go: () => select(c.id) })
      }
      if (known.has('customize')) {
        for (const tab of CUSTOMIZE_TABS) {
          if (match(`${customizeTabLabel(tab)} ${Editor.CUSTOMIZE_KEYWORDS[tab]}`)) out.push({ label: customizeTabLabel(tab), where: t('Customize'), go: () => select('customize', { tab }) })
        }
      }
      const p = this.customizer!.profiles.current().profile
      const rows = filterRows(buildKeymap(p, { targetLabel: (id) => targetLabel(p ?? emptyProfile(), id), t }), q, isMacOS())
      for (const r of rows.slice(0, 8)) {
        const keys = r.keys.filter((k) => !k.off && !k.movedTo).map((k) => keyText(k.chord, isMacOS())).join(' · ')
        out.push({ label: keys ? `${r.label} — ${keys}` : r.label, where: t('Keyboard shortcuts'), go: () => select('shortcuts', { query: r.label }) })
      }
      if (rows.length > 8) out.push({ label: t('All {n} matching commands…', { n: rows.length }), where: t('Keyboard shortcuts'), go: () => select('shortcuts', { query: q }) })
      return out
    }
    let shown: Hit[] = []
    const paintResults = () => {
      const q = search.value.trim()
      items.hidden = !!q
      results.hidden = !q
      results.replaceChildren()
      if (!q) return
      shown = hits(q)
      for (const h of shown) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-settings-hit'
        const l = document.createElement('span')
        l.textContent = h.label
        const w = document.createElement('small')
        w.textContent = h.where
        b.append(l, w)
        b.addEventListener('click', () => h.go())
        results.appendChild(b)
      }
      if (!shown.length) {
        const none = document.createElement('p')
        none.className = 'ed-hint'
        none.textContent = t('Nothing matches “{q}”', { q })
        results.appendChild(none)
      }
    }
    search.addEventListener('input', paintResults)
    search.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter' && shown[0]) { ev.preventDefault(); shown[0].go() }
      else if (ev.key === 'Escape' && search.value) { ev.preventDefault(); search.value = ''; paintResults() }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); results.querySelector<HTMLElement>('.ed-settings-hit')?.focus() }
    })
    results.addEventListener('keydown', (ev) => {
      const list = [...results.querySelectorAll<HTMLElement>('.ed-settings-hit')]
      const i = list.indexOf(document.activeElement as HTMLElement)
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        ev.stopPropagation()
        const n = ev.key === 'ArrowDown' ? i + 1 : i - 1
        if (n < 0) search.focus(); else list[Math.min(n, list.length - 1)]?.focus()
      }
    })

    for (const cat of categories) {
      const b = document.createElement('button')
      b.className = 'ed-settings-navitem'
      b.innerHTML = `${cat.icon}<span>${cat.label()}</span>`
      b.title = cat.title()
      b.addEventListener('click', () => select(cat.id))
      items.appendChild(b)
      navButtons.set(cat.id, b)
    }
    select(active, opts)

    overlay.appendChild(box)
    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      // Esc belongs to a dialog opened from here (name a style…), to a key
      // recorder (it cancels) and to the fields that clear or stop with it
      const target = ev.target as HTMLElement | null
      if (target?.closest?.('dialog, .ed-cz-chord, .ed-km-listening, .ed-czc-input')) return
      // a search field with text in it clears first; the next Esc closes
      if (target?.matches?.('.ed-km-search input, .ed-settings-search input') && (target as HTMLInputElement).value) return
      ev.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    if (!opts.query && active !== 'shortcuts') search.focus({ preventScroll: true })
  }

  /** General / Appearance + the offline switch — viewer-scoped display and
   *  privacy preferences. */
  private renderGeneralCategory(host: HTMLElement) {
    // the interface language — the VIEWER's, never the file's (View ▸ Language on desktop too)
    const langRow = document.createElement('label')
    langRow.className = 'ed-about-auto'
    const langSel = document.createElement('select')
    for (const c of localeChoices()) {
      const o = document.createElement('option')
      o.value = c.code
      o.textContent = c.label
      if (c.code === locale()) o.selected = true
      langSel.appendChild(o)
    }
    // reopen on General so this dialog, too, speaks the new language
    langSel.addEventListener('change', () => { this.changeLocale(langSel.value); this.openSettings('general') })
    langRow.append(document.createTextNode(t('Language') + ' '), langSel)
    host.appendChild(langRow)

    const themeRow = document.createElement('label')
    themeRow.className = 'ed-about-auto'
    const themeSel = document.createElement('select')
    for (const c of THEME_CHOICES) {
      const o = document.createElement('option')
      o.value = c
      o.textContent = c === 'auto' ? t('Match my system') : c === 'light' ? t('Light') : t('Dark')
      if (c === themeChoice()) o.selected = true
      themeSel.appendChild(o)
    }
    themeSel.addEventListener('change', () => setTheme(themeSel.value as never))
    themeRow.append(document.createTextNode(t('Appearance') + ' '), themeSel)
    host.appendChild(themeRow)

    // the hard no-network switch: blocks every network-touching feature for
    // this browser. Same-machine tab sync is not networking and stays on.
    const offRow = document.createElement('label')
    offRow.className = 'ed-about-auto'
    const offCb = document.createElement('input')
    offCb.type = 'checkbox'
    offCb.checked = offlineEnabled()
    offCb.addEventListener('change', () => {
      // setOffline reports whether the preference PERSISTED. It holds for this
      // session either way (net.ts keeps it in memory), but a switch that
      // silently forgets itself on reload has to say so — it used to show
      // "on" over a setting that had never been stored.
      const stuck = setOffline(offCb.checked)
      this.toast(
        !stuck
          ? t('Offline mode is on for this tab, but could not be saved — this browser is blocking site data, so it will not survive a reload')
          : offCb.checked
            ? t('Offline mode on — nothing leaves this computer')
            : t('Offline mode off — online features re-enabled'),
      )
    })
    offRow.append(offCb, document.createTextNode(' ' + t('Offline mode — block all network features')))
    host.appendChild(offRow)

    // where the quick-format bar shows — part of the UI profile (Customize),
    // so it is exported, shared and reset along with the rest of the layout
    const miniRow = document.createElement('label')
    miniRow.className = 'ed-about-auto'
    miniRow.title = t('The most-used formatting controls for what you select: docked above the slide, floating next to the selection, or both (Alt+F10 to reach it from the keyboard)')
    miniRow.append(document.createTextNode(t('Quick-format bar') + ' '))
    miniRow.appendChild(quickBarPlaceSelect(this.quickBar.placement(), (v) => void this.setQuickBarPlace(v)))
    host.appendChild(miniRow)
  }

  /** Icon library (#8) — the sources the "Icons" toolbar search looks in (iconsettings.ts). */
  private renderIconsCategory(host: HTMLElement) {
    renderIconSources(host, { toast: (m) => this.toast(m) })
  }

  // Doesn't touch `this` — showToast() below is the free-function form, used
  // by the section mutation-surface helpers that build UI outside the class.
  toast(message: string) {
    showToast(message)
  }
}

/**
 * A plain-text report → a real list (the import report uses it).
 *
 * One "• " bullet per line. A pre-wrap block gave every wrapped bullet a
 * flush-left second line, which at 320px was most of them — so one item read
 * as two and the box looked like a wall. Split per line and hang the indent
 * instead.
 *
 * Always textContent, never innerHTML: the text names elements from an
 * imported file and is not safe to run.
 */
/** How an imported deck's design was settled (editor/importfix.ts): the
 *  report line, the deck as the file had it (for "Keep the file's own
 *  design") and content a restyle left without a slot. */
interface ImportDesign { line: string; fileDesign: import('../model').SlidomingoDoc; floating: RepairItem[] }

/** A picked file's absolute path on desktop (Electron webUtils), else
 *  undefined — what "Fix with Claude" copies in beside the session. */
function pickedPath(file: File): string | undefined {
  try { return window.slidomingoDesktop?.getPathForFile?.(file) || undefined } catch { return undefined }
}

function reportList(notes: string): HTMLElement {
  const box = div('ed-about-release')
  for (const raw of notes.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const bullet = /^[•*-]\s+/.test(text)
    const item = div(bullet ? 'ed-about-note' : 'ed-about-more')
    item.textContent = bullet ? text.replace(/^[•*-]\s+/, '') : text
    box.appendChild(item)
  }
  return box
}

/**
 * The document as handed to an AI agent — a deep clone, kept as its own
 * function (rather than agent call sites reading `window.beeslides.doc`
 * directly) for API stability: this used to also strip live-collaboration
 * credentials (see docs/DECISIONS.md, 2026-08-28 "the agent-facing copy of a
 * document is not stripped"), a concern that no longer applies now that live
 * collaboration has been removed outright (docs/DECISIONS.md, 2026-09-02).
 */
export function docForAgent(doc: import('../model').SlidomingoDoc): import('../model').SlidomingoDoc {
  return JSON.parse(JSON.stringify(doc)) as import('../model').SlidomingoDoc
}

/** Deep-clone an element with a fresh id (same-slide duplicates must not share ids). */
function cloneElement(el: SlideElement): SlideElement {
  return { ...JSON.parse(JSON.stringify(el)), id: uid(el.type[0]), x: el.x + 24, y: el.y + 24 }
}

// --- figure-folder pick (the markdown importer's repair action) -------------
//
// `quarto render --to markdown` writes figures into a sibling `_files/` folder,
// and a file dialog cannot select across folders in one pass — so the second
// pass asks for the FOLDER. Two routes, because neither is everywhere:
// showDirectoryPicker (Chromium, so also Electron) reads it directly, and
// `webkitdirectory` on a plain input is the fallback every browser has had for
// a decade. Same shape as save.ts's own hostCan/adoptFileHandle split.

function pickFolderSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function') return true
  return 'webkitdirectory' in document.createElement('input')
}

/** How many files one folder pick may read. A figure folder is a handful; a
 *  mis-pick (someone's home directory) must not read the disk into memory,
 *  and the check has to be PER FILE — a single flat folder of ten thousand
 *  files never recurses, so a check only at directory entry never fires. */
/** A deck's content for "did it change since we last wrote it" — the whole
 *  document except the `modified` stamp, which store.commit bumps on every
 *  edit even when the edit was undone. Deliberately broader than autosave's
 *  docContentKey (which ignores meta/present): a property change must still
 *  reach the file. */
/** A version's label code (kernel autosave `label`) as display text —
 *  translated here, at render time, never stored translated. */
function versionLabelText(code: string | undefined): string {
  switch (code) {
    case 'opened': return t('as opened')
    case 'saved': return t('saved')
    case 'before-replace': return t('before replacing')
    default: return ''
  }
}

function bodyKey(doc: import('../model').SlidomingoDoc): string {
  return JSON.stringify({ ...doc, modified: undefined })
}

const FOLDER_PICK_LIMIT = 400

/** Walk a picked directory, keyed by path relative to the pick. */
async function collectDir(dir: FileSystemDirectoryHandle, prefix: string, into: Record<string, Uint8Array>) {
  for await (const [name, handle] of (dir as unknown as {
    entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>
  }).entries()) {
    if (Object.keys(into).length >= FOLDER_PICK_LIMIT) return
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') await collectDir(handle as FileSystemDirectoryHandle, path, into)
    else {
      const f = await (handle as FileSystemFileHandle).getFile()
      if (f.size <= MEDIA_EMBED_BUDGET) into[path] = new Uint8Array(await f.arrayBuffer())
    }
  }
}

function pickDirectoryViaInput(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // Not in the DOM lib's HTMLInputElement, but shipped everywhere.
    ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.style.display = 'none'
    const done = (files: File[] | null) => {
      input.remove()
      if (files?.length) resolve(files)
      else reject(new Error('cancelled'))
    }
    input.addEventListener('change', () => done(Array.from(input.files ?? [])))
    // Dismissing the dialog fires 'cancel', never 'change' — without this the
    // hidden input stays in the DOM and the promise never settles.
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

// tiny DOM helpers
/** Hide a control in an icon set (styles.css .ed-iconset .ed-not-iconset). */
function notIconset<T extends HTMLElement>(el: T): T {
  el.classList.add('ed-not-iconset')
  return el
}

/** Keep a slides-only control in an icon set (the slide list and the sorter — styles.css .ed-iconset). */
function iconsetToo<T extends HTMLElement>(el: T): T {
  el.classList.add('ed-iconset-too')
  return el
}

/** Hide a control in Figure mode (slide list, present, notes — see styles.css .ed-figure). */
function slidesOnly<T extends HTMLElement>(el: T): T {
  el.classList.add('ed-slides-only')
  return el
}

/** doc_info's `layoutGrid`: the settings plus every column's (and row's) box. */
function agentLayoutGrid(doc: SlidomingoDoc): Record<string, unknown> | undefined {
  const g = normalizeLayoutGrid(doc.layoutGrid, doc.size)
  if (!g) return undefined
  const { columns, rows } = layoutTracks(g, doc.size)
  return {
    ...g,
    columns: columns.map((c, i) => ({ n: i + 1, x: c.start, w: c.size })),
    rows: rows.length ? rows.map((r, i) => ({ n: i + 1, y: r.start, h: r.size })) : undefined,
    count: { columns: g.columns, rows: g.rows ?? 0 },
  }
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

/** Text of stored element HTML, parsed INERT into a <template>'s content
 *  (no browsing context: nothing loads, no handler runs). `innerHTML` on a
 *  detached div is NOT inert — its nodes belong to the live document, so a
 *  stored `<img src=x onerror=…>` from an opened file or a pasted clip ran
 *  in the editor (the outline view, the agent selection context). */
function stripHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content.textContent ?? ''
}

/** `doc.layouts` grouped for the slide-type pickers: one group per root
 *  that has descendants (labelled with the root's name, root first, then
 *  its subtree depth-first — an imported .pptx with several masters stays
 *  readable), and every childless root gathered into one trailing group.
 *  A label of `undefined` means "no family to name" — when nothing has
 *  children the whole list is that one group. A `parentOnly` type (a
 *  master) is never an entry: its name heads its family, and a group left
 *  with no entries is dropped. */
function slideTypeFamilies(doc: SlidomingoDoc): Array<[string | undefined, Slide[]]> {
  const families: Array<[string | undefined, Slide[]]> = []
  const loose: Slide[] = []
  const rows = slideTypeRows(doc)
  rows.forEach((r, i) => {
    const pickable = !r.layout.parentOnly
    if (r.depth > 0) { if (pickable) families[families.length - 1]?.[1].push(r.layout); return }
    if (rows[i + 1]?.depth > 0) families.push([r.layout.name || t('Untitled'), pickable ? [r.layout] : []])
    else if (pickable) loose.push(r.layout)
  })
  if (loose.length) families.push([families.length ? t('Other slide types') : undefined, loose])
  return families.filter(([, layouts]) => layouts.length)
}

/** The picker's per-entry verdict: "fits" (everything finds a place), "N items
 *  float" (kept, but on top of the new layout), or "current". */
function fitBadge(p: RelinkPreview, current: boolean): HTMLElement {
  const badge = document.createElement('span')
  const n = p.floating.length
  badge.className = `ed-layoutpick-verdict ${current ? 'is-current' : n ? 'is-partial' : 'is-fit'}`
  badge.textContent = current ? t('current') : !n ? t('fits') : n === 1 ? t('1 item floats') : t('{n} items float', { n })
  const lines = [n
    ? t('{n} item(s) have no matching placeholder here — they are kept, on top of the slide type', { n })
    : t('Everything on this slide finds a placeholder here')]
  if (p.emptySlots.length) lines.push(t('{n} placeholder(s) stay empty', { n: p.emptySlots.length }))
  badge.title = lines.join('\n')
  return badge
}

function btn(
  icon: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  title?: string,
): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

/** A small icon button that acts on the SECOND click: the first arms it
 *  (it spells out `armedLabel`, e.g. “Delete?”), a second click within 3 s
 *  — or a double click — runs `run`. Leaving it or waiting disarms. For the
 *  thumbnail hover tools, where one stray click duplicated or deleted. */
function confirmBtn(icon: string, armedLabel: string, run: () => void, title: string, tone?: 'danger'): HTMLElement {
  let timer = 0
  const disarm = () => {
    window.clearTimeout(timer)
    b.classList.remove('armed')
    b.innerHTML = icon
  }
  const b = btn(icon, '', (ev) => {
    ev.stopPropagation()
    if (b.classList.contains('armed')) { disarm(); run(); return }
    b.classList.add('armed')
    b.innerHTML = `${icon}<span>${armedLabel}</span>`
    timer = window.setTimeout(disarm, 3000)
  }, title)
  b.classList.add('ed-confirm-btn')
  if (tone) b.classList.add(tone)
  b.addEventListener('mouseleave', disarm)
  return b
}

/** Free-function form of Editor.toast() — doesn't need `this`, so the
 *  section mutation-surface helpers below (which build UI outside the
 *  class) can raise one without threading an Editor instance through. */
function showToast(message: string) {
  document.querySelector('.ed-toast')?.remove()
  const el = div('ed-toast')
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 2200)
}

/** App-owned hover tooltips. In the Electron shell, the native OS/Chromium
 *  tooltip for `title` can take several seconds to appear (Electron #49843,
 *  #12861 closed wontfix) — worse still through the child-`WebContentsView`
 *  + `hiddenInset` titlebar this app's desktop window uses. `btn()` already
 *  sets `.title` on every icon-only button, so this reads that text and
 *  displays it itself on a short timer instead of trusting native delivery.
 *  Wired ONCE (`wireTooltips` is idempotent) via delegated document
 *  listeners — build() reruns on locale switches etc., but this must not
 *  re-register. */
const TOOLTIP_DELAY_MS = 400
let tooltipsWired = false
let tooltipEl: HTMLElement | null = null
let tooltipTimer: ReturnType<typeof setTimeout> | null = null
let tooltipTarget: HTMLElement | null = null

function positionTooltip(target: HTMLElement) {
  if (!tooltipEl) return
  const r = target.getBoundingClientRect()
  const gap = 8
  const tw = tooltipEl.offsetWidth
  const th = tooltipEl.offsetHeight
  let top = r.bottom + gap
  if (top + th > window.innerHeight - 4) top = r.top - th - gap
  top = Math.max(4, top)
  let left = r.left + r.width / 2 - tw / 2
  left = Math.max(4, Math.min(left, window.innerWidth - tw - 4))
  tooltipEl.style.top = `${top}px`
  tooltipEl.style.left = `${left}px`
}

function hideTooltip() {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null }
  if (tooltipTarget) {
    const saved = tooltipTarget.dataset.tipText
    if (saved !== undefined) tooltipTarget.title = saved
    delete tooltipTarget.dataset.tipText
    tooltipTarget = null
  }
  tooltipEl?.classList.remove('show')
}

function wireTooltips() {
  if (tooltipsWired) return
  tooltipsWired = true

  document.addEventListener('pointerover', (ev) => {
    if (ev.buttons !== 0) return // don't pop up mid-drag (Moveable/Selecto)
    const el = (ev.target as Element | null)?.closest?.('[title]') as HTMLElement | null
    if (!el || el === tooltipTarget) return
    if ((el as HTMLButtonElement).disabled) return
    const title = el.title
    if (!title) return
    hideTooltip()
    tooltipTarget = el
    el.dataset.tipText = title
    el.title = ''
    tooltipTimer = setTimeout(() => {
      tooltipTimer = null
      if (!tooltipTarget) return
      const text = tooltipTarget.dataset.tipText
      if (!text) return
      if (!tooltipEl) {
        tooltipEl = div('ed-tooltip')
        document.body.appendChild(tooltipEl)
      }
      tooltipEl.textContent = text
      positionTooltip(tooltipTarget)
      tooltipEl.classList.add('show')
    }, TOOLTIP_DELAY_MS)
  }, true)

  document.addEventListener('pointerout', (ev) => {
    if (!tooltipTarget) return
    const related = ev.relatedTarget as Node | null
    if (related && tooltipTarget.contains(related)) return // moved to a child, still hovering
    hideTooltip()
  }, true)

  document.addEventListener('pointerdown', hideTooltip, true)
  window.addEventListener('scroll', hideTooltip, true)
  window.addEventListener('resize', hideTooltip)
}

// =============================================================================
// Sections — single shared mutation surface + UI.
//
// Free functions (not Editor methods) taking `store` explicitly: sections
// are read via model.ts's sectionsInOrder/sectionOf/sectionRange from three
// independent surfaces (sidebar, Outline View, Slide Sorter), and this is
// the one place all of them write. See model.ts's `Section` doc comment for
// why membership is DERIVED (a boundary marker) rather than a per-slide tag.
// =============================================================================

/** localStorage key for one document's per-section collapse state — pure
 *  VIEW state, deliberately never in the document (see `Section`'s doc
 *  comment). Mirrors the properties panel accordion's `slidomingo-panel-open`
 *  convention (panels.ts applyAccordion), scoped per-doc via docId since
 *  section ids can collide across different decks. */
const sectionsOpenKey = (doc: SlidomingoDoc): string => `slidomingo-sections-open-${doc.docId}`

/** A section's collapse state. Default: expanded. */
function isSectionOpen(doc: SlidomingoDoc, sectionId: string): boolean {
  return lsJson<Record<string, boolean>>(sectionsOpenKey(doc), {})[sectionId] ?? true
}

function setSectionOpen(doc: SlidomingoDoc, sectionId: string, open: boolean) {
  const key = sectionsOpenKey(doc)
  const state = lsJson<Record<string, boolean>>(key, {})
  state[sectionId] = open
  lsSet(key, JSON.stringify(state))
}

/** Slide indices hidden because they belong to a COLLAPSED section — the
 *  one place "is this slide currently shown" is computed, so a surface's
 *  full render and its cheap incremental refresh (editor.ts scheduleThumbs)
 *  cannot disagree about how many thumbnails should exist. */
function collapsedSlideIndices(
  doc: SlidomingoDoc,
  ranges: Array<{ section: Section; start: number; end: number }> =
    sectionsInOrder(doc).map((section) => ({ section, ...sectionRange(doc, section) })),
): Set<number> {
  const hidden = new Set<number>()
  for (const r of ranges) {
    if (isSectionOpen(doc, r.section.id)) continue
    for (let i = r.start; i < r.end; i++) hidden.add(i)
  }
  return hidden
}

/**
 * The ONE collapsible section-header row — built identically for the
 * sidebar, Outline View, and Slide Sorter; each surface interleaves it the
 * same way (walking doc.slides and sectionsInOrder() in lockstep, see
 * editor.ts rebuildSidebar/renderOutline/renderGrid) and supplies its own
 * re-render/select callbacks. A header is: a collapse chevron, a name
 * (renamed in place on double-click — never window.prompt), and hover-
 * revealed tools (mirrors .ed-thumb-tools): ungroup, delete-with-slides,
 * and a grip. Two SEPARATE confirms (matching deleteSlide's window.confirm
 * style) rather than one dialog trying to offer two custom-labelled choices
 * — window.confirm only ever has OK/Cancel, so "ungroup" (safe, primary) and
 * "delete N slides too" (destructive, secondary) are two distinct, clearly-
 * labelled controls, each behind its own confirm.
 *
 * The whole row is the handle that drags the section (the grip is only the
 * affordance); drops are owned by the surface's wireSlideDrop, never by the
 * header. While the name is being edited the row stops being draggable, so
 * text selection inside it works.
 */
function buildSectionHeader(opts: {
  store: Store
  section: Section
  open: boolean
  onToggle: (open: boolean) => void
  /** Slide Sorter only: clicking the header body (not chevron/name/tools)
   *  seeds the multi-select with this section's index range. */
  onSelectRange?: () => void
}): HTMLElement {
  const { store, section } = opts
  const head = div('ed-section-head')
  head.dataset.sectionId = section.id
  head.classList.toggle('closed', !opts.open)
  head.draggable = true
  head.title = t('Drag to move the whole section')

  const chevron = document.createElement('button')
  chevron.className = 'ed-section-chevron'
  chevron.title = opts.open ? t('Collapse section') : t('Expand section')
  chevron.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onToggle(!opts.open) })
  head.appendChild(chevron)

  const name = document.createElement('div')
  name.className = 'ed-section-name'
  name.spellcheck = false
  name.textContent = section.name
  name.title = t('Double-click to rename')
  const startRename = () => {
    if (name.isContentEditable) return
    head.draggable = false
    name.contentEditable = 'plaintext-only'
    name.focus()
    window.getSelection()?.selectAllChildren(name)
  }
  const stopRename = () => {
    name.contentEditable = 'false'
    head.draggable = true
  }
  name.addEventListener('blur', () => {
    if (!name.isContentEditable) return
    stopRename()
    const val = (name.textContent ?? '').trim() || t('Untitled section')
    if (val !== section.name) renameSection(store, section.id, val)
    else name.textContent = section.name
  })
  name.addEventListener('keydown', (ev) => {
    if (!name.isContentEditable) return
    if (ev.key === 'Enter') { ev.preventDefault(); name.blur() }
    else if (ev.key === 'Escape') { name.textContent = section.name; name.blur() }
    ev.stopPropagation() // don't let typed text bubble into slide-nav shortcuts
  })
  name.addEventListener('mousedown', (ev) => { if (name.isContentEditable) ev.stopPropagation() })
  name.addEventListener('click', (ev) => ev.stopPropagation())
  // createSectionAt opens a brand-new section straight into rename
  name.addEventListener(SECTION_RENAME_EVENT, startRename)
  head.addEventListener('dblclick', (ev) => {
    if ((ev.target as HTMLElement).closest('.ed-section-tools, .ed-section-chevron')) return
    ev.preventDefault()
    startRename()
  })
  head.appendChild(name)

  const { start, end } = sectionRange(store.doc, section)
  const count = Math.max(0, end - start)

  const tools = div('ed-section-tools')
  const ungroup = btn('⊟', '', (ev) => {
    ev.stopPropagation()
    if (window.confirm(t('Ungroup “{name}”? Its {n} slide(s) stay in the deck.', { name: section.name, n: String(count) }))) {
      deleteSection(store, section.id, { deleteSlides: false })
    }
  }, t('Ungroup — remove the section, keep its slides'))
  tools.appendChild(ungroup)
  const del = btn(ICONS.trash, '', (ev) => {
    ev.stopPropagation()
    if (window.confirm(t('Delete “{name}” and its {n} slide(s)? ⌘Z undoes this.', { name: section.name, n: String(count) }))) {
      deleteSection(store, section.id, { deleteSlides: true })
    }
  }, t('Delete section and its {n} slide(s)', { n: String(count) }))
  tools.appendChild(del)
  const grip = document.createElement('div')
  grip.className = 'ed-section-grip'
  grip.textContent = '⠿'
  tools.appendChild(grip)
  head.appendChild(tools)

  head.addEventListener('dragstart', (ev) => {
    if (!ev.dataTransfer) return
    ev.dataTransfer.setData(SECTION_MIME, section.id)
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setDragImage(head, 12, 12)
    activeDrag = { kind: 'section', ids: [section.id] }
    head.classList.add('dragging')
  })
  head.addEventListener('dragend', endSlideDrag)

  if (opts.onSelectRange) {
    head.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement
      if (target === name || target.closest('.ed-section-tools, .ed-section-chevron')) return
      opts.onSelectRange!()
    })
  }

  return head
}

// -----------------------------------------------------------------------------
// Slide and section drag-drop — one controller per surface (sidebar, Slide
// Sorter, Outline View), never per item. The model side is slideorder.ts: the
// panel is a list of tokens (headers and slide blocks), every drop is "these
// tokens go in front of token N", and dropSlots() says which N are valid. This
// side only maps each slot onto the rendered rows, picks the one nearest the
// pointer and draws a single insertion line there — so where the line is IS
// where the drop lands, in both directions.

const SLIDE_MIME = 'text/beeslides-slide'
const SECTION_MIME = 'text/slidomingo-section'
const SECTION_RENAME_EVENT = 'slidomingo:rename-section'

/** The drag in flight. dataTransfer can't be read during dragover (only its
 *  types), and section mode needs to know WHICH section to skip its no-op
 *  slots — so the source records it here. */
let activeDrag: { kind: 'slides' | 'section'; ids: string[] } | null = null

/** A thumb's dragstart: carries the ids (a JSON list), dims every dragged
 *  thumb, and sets a ghost that is just the slide surface — or a small
 *  "N slides" stack for a multi-drag. */
function startSlideDrag(ev: DragEvent, ids: string[], source: HTMLElement, container: HTMLElement) {
  if (!ev.dataTransfer) return
  ev.dataTransfer.setData(SLIDE_MIME, JSON.stringify(ids))
  ev.dataTransfer.effectAllowed = 'move'
  activeDrag = { kind: 'slides', ids }
  const surface = source.querySelector<HTMLElement>('.beeslides-thumb-surface')
  if (ids.length > 1 && surface) {
    const ghost = div('ed-drag-stack')
    const copy = surface.cloneNode(true) as HTMLElement
    const badge = div('ed-drag-stack-count')
    badge.textContent = activeDragDoc(container)?.kind === 'iconset'
      ? t('{n} icons', { n: String(ids.length) })
      : t('{n} slides', { n: String(ids.length) })
    ghost.append(copy, badge)
    document.body.appendChild(ghost)
    ev.dataTransfer.setDragImage(ghost, 16, 16)
    setTimeout(() => ghost.remove(), 0)
  } else if (surface) {
    const r = surface.getBoundingClientRect()
    ev.dataTransfer.setDragImage(surface, ev.clientX - r.left, ev.clientY - r.top)
  }
  // the blocks travel whole, so a dragged parent dims its states and extras too
  const doc = activeDragDoc(container)
  const moving = doc ? movingSlideIds(doc, ids) : new Set(ids)
  container.querySelectorAll<HTMLElement>(':scope > [data-slide-id]').forEach((el) => {
    if (moving.has(el.dataset.slideId!)) el.classList.add('dragging')
  })
}

/** The doc a surface renders — wireSlideDrop records it on the container. */
const dropDocs = new WeakMap<HTMLElement, () => SlidomingoDoc>()
const activeDragDoc = (container: HTMLElement) => dropDocs.get(container)?.()

function endSlideDrag() {
  activeDrag = null
  document.querySelectorAll('.ed-drop-line').forEach((el) => el.remove())
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
  document.querySelectorAll('.ed-drop-target').forEach((el) => el.classList.remove('ed-drop-target'))
}

/** One candidate position for the insertion line, in viewport px. */
interface DropSegment { x0: number; y0: number; x1: number; y1: number; indent?: boolean }

function segmentDistance(seg: DropSegment, x: number, y: number): number {
  const dx = seg.x1 - seg.x0
  const dy = seg.y1 - seg.y0
  const len = dx * dx + dy * dy
  const u = len ? Math.max(0, Math.min(1, ((x - seg.x0) * dx + (y - seg.y0) * dy) / len)) : 0
  return Math.hypot(x - (seg.x0 + u * dx), y - (seg.y0 + u * dy))
}

/**
 * Wire a surface's drop controller. `container` holds the rows as direct
 * children: thumbs carry `data-slide-id`, headers `data-section-id` (the
 * sidebar's insert-gaps and New-slide button are ignored). Rebuilding the
 * rows mid-drag is fine — slots are re-measured on every dragover.
 */
function wireSlideDrop(store: Store, container: HTMLElement, opts: {
  /** 'y' = a vertical list (sidebar, outline); 'grid' = the Slide Sorter */
  axis: 'y' | 'grid'
  /** Dropping a slide in the RIGHT part of a list, beside a slide, makes it
   *  an extra of THAT slide (moved to the end of its extras run AND hidden;
   *  beside an extra = joins the same run); a plain drop of an extra takes
   *  it out again (moved AND shown) — the sidebar only. */
  nestable?: boolean
  /** the element that scrolls — auto-scrolled near its top/bottom edge */
  scroller: HTMLElement
  /** after a committed move: reselect / reveal what moved */
  onDropped: (kind: 'slides' | 'section', ids: string[]) => void
}) {
  dropDocs.set(container, () => store.doc)
  let line: HTMLElement | null = null
  let picked: DropSlot | null = null
  let pickedNest = false
  /** the token index of a nest drop (extraDropAt), valid while pickedNest */
  let nestAt = 0
  let target: HTMLElement | null = null

  const setTarget = (el: HTMLElement | null) => {
    if (target === el) return
    target?.classList.remove('ed-drop-target')
    target = el
    target?.classList.add('ed-drop-target')
  }

  const rows = () => [...container.querySelectorAll<HTMLElement>(':scope > [data-slide-id], :scope > [data-section-id]')]

  /** Viewport segments where `slot`'s line may be drawn — every slot sits in
   *  the gap between two rendered rows (`before`/`after`, either may be
   *  absent). A list has one horizontal line there; the grid has a vertical
   *  one beside each neighbouring tile (so "after the last tile of a row" is
   *  reachable without aiming at the next row) or a horizontal one next to a
   *  full-width header. */
  const segmentsFor = (slot: DropSlot, list: HTMLElement[]): DropSegment[] => {
    const find = (sel: string) => list.findIndex((el) => el.matches(sel))
    let ai = -1
    let bi = -1
    if (slot.anchor === 'beforeThumb') ai = find(`[data-slide-id="${CSS.escape(slot.id!)}"]`)
    else if (slot.anchor === 'beforeHeader') ai = find(`[data-section-id="${CSS.escape(slot.id!)}"]`)
    if (ai >= 0) bi = ai - 1
    if (slot.anchor === 'afterHeader') {
      bi = find(`[data-section-id="${CSS.escape(slot.id!)}"]`)
      if (bi >= 0 && bi + 1 < list.length) ai = bi + 1
    }
    if (slot.anchor === 'end') bi = list.length - 1
    const before = bi >= 0 ? list[bi] : undefined
    const after = ai >= 0 ? list[ai] : undefined
    if (!before && !after) return []
    const indent = slot.anchor === 'afterHeader'
    if (opts.axis === 'y') {
      const box = container.getBoundingClientRect()
      const x0 = box.left + 6 + (indent ? 14 : 0)
      const x1 = box.left + container.clientWidth - 6
      const b = before?.getBoundingClientRect()
      const a = after?.getBoundingClientRect()
      const y = b && a ? (b.bottom + a.top) / 2 : b ? b.bottom + 5 : a!.top - 5
      return [{ x0, x1, y0: y, y1: y, indent }]
    }
    const segs: DropSegment[] = []
    const gap = 9
    for (const [el, side] of [[after, 'after'], [before, 'before']] as const) {
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (el.dataset.sectionId) {
        const y = side === 'after' ? r.top - 6 : r.bottom + 6
        segs.push({ x0: r.left + (indent ? 14 : 0), x1: r.right, y0: y, y1: y, indent })
      } else {
        const x = side === 'after' ? r.left - gap : r.right + gap
        segs.push({ x0: x, x1: x, y0: r.top + 4, y1: r.bottom - 4 })
      }
    }
    return segs
  }

  const hide = () => {
    line?.remove()
    line = null
    picked = null
    pickedNest = false
    setTarget(null)
  }

  /** "Drop beside a slide": the slide row whose vertical span (grown by half
   *  the gap to each neighbour) holds `y`, and — when the dragged slides can
   *  become its extras — where they land and the row the line goes under
   *  (the target's last extra, or the target itself). Rows being dragged are
   *  never targets. */
  const nestHit = (list: HTMLElement[], y: number, ids: string[]) => {
    const doc = store.doc
    for (let i = 0; i < list.length; i++) {
      const row = list[i]
      const id = row.dataset.slideId
      if (!id || row.classList.contains('dragging')) continue
      const r = row.getBoundingClientRect()
      const prev = list[i - 1]?.getBoundingClientRect()
      const next = list[i + 1]?.getBoundingClientRect()
      const lo = prev ? (prev.bottom + r.top) / 2 : r.top - 6
      const hi = next ? (r.bottom + next.top) / 2 : r.bottom + 6
      if (y < lo || y >= hi) continue
      const at = extraDropAt(doc, id)
      if (at === null || !moveSlidesAsExtras(doc, ids, at)) return null
      // the line goes under the last row before the landing slot that isn't being dragged
      const before = tokensOf(doc)[at - 1]
      const lastId = before?.kind === 'block' ? before.slides[before.slides.length - 1].id : id
      let li = list.findIndex((el) => el.dataset.slideId === lastId)
      while (li > i && list[li].classList.contains('dragging')) li--
      return { at, target: row, landing: li >= i ? li : i }
    }
    return null
  }

  const autoScroll = (y: number) => {
    const r = opts.scroller.getBoundingClientRect()
    const edge = 40
    if (y < r.top + edge) opts.scroller.scrollTop -= Math.ceil((r.top + edge - y) / 3)
    else if (y > r.bottom - edge) opts.scroller.scrollTop += Math.ceil((y - (r.bottom - edge)) / 3)
  }

  container.addEventListener('dragover', (ev) => {
    const types = ev.dataTransfer?.types ?? []
    const kind = types.includes(SECTION_MIME) ? 'section' : types.includes(SLIDE_MIME) ? 'slides' : null
    if (!kind || !activeDrag || activeDrag.kind !== kind) return
    ev.preventDefault()
    ev.dataTransfer!.dropEffect = 'move'
    autoScroll(ev.clientY)
    const doc = store.doc
    const list = rows()
    // pointer in the right part of the list, beside a slide = "as an extra of that slide", when possible
    const box = container.getBoundingClientRect()
    const nest = opts.nestable && kind === 'slides' && ev.clientX >= box.left + box.width * 0.55
      ? nestHit(list, ev.clientY, activeDrag.ids) : null
    if (nest) {
      picked = null
      pickedNest = true
      nestAt = nest.at
      setTarget(nest.target)
      const r = list[nest.landing].getBoundingClientRect()
      const below = list[nest.landing + 1]?.getBoundingClientRect()
      const y = below ? (r.bottom + below.top) / 2 : r.bottom + 5
      placeLine({ x0: box.left + 6 + 28, x1: box.left + container.clientWidth - 6, y0: y, y1: y }, true)
      return
    }
    pickedNest = false
    setTarget(null)
    let best: { slot: DropSlot; seg: DropSegment; d: number } | null = null
    for (const slot of dropSlots(doc, kind, collapsedSlideIndices(doc), kind === 'section' ? activeDrag.ids[0] : undefined)) {
      for (const seg of segmentsFor(slot, list)) {
        const d = segmentDistance(seg, ev.clientX, ev.clientY)
        if (!best || d < best.d) best = { slot, seg, d }
      }
    }
    // Too far from any valid slot (a section dragged over the rows it can't
    // land between) = no drop, rather than snapping to a distant one.
    if (!best || best.d > (opts.axis === 'y' ? 64 : 140)) {
      hide()
      ev.dataTransfer!.dropEffect = 'none'
      return
    }
    picked = best.slot
    placeLine(best.seg, false)
  })

  /** Draw the insertion line on `seg`. "As an extra" has its own look (honey,
   *  thicker) — the section-start slot's indent tick is a different thing. */
  const placeLine = (seg: DropSegment, extra: boolean) => {
    if (!line || !line.isConnected) {
      line = div('ed-drop-line')
      document.body.appendChild(line)
    }
    const vertical = seg.x0 === seg.x1
    line.classList.toggle('extra', extra)
    line.classList.toggle('vertical', vertical)
    line.classList.toggle('indent', !!seg.indent)
    line.style.left = `${Math.round(vertical ? seg.x0 - 1 : seg.x0)}px`
    line.style.top = `${Math.round(vertical ? seg.y0 : seg.y0 - 1)}px`
    line.style.width = vertical ? '' : `${Math.round(seg.x1 - seg.x0)}px`
    line.style.height = vertical ? `${Math.round(seg.y1 - seg.y0)}px` : ''
  }

  container.addEventListener('dragleave', (ev) => {
    const to = ev.relatedTarget as Node | null
    if (!to || !container.contains(to)) hide()
  })

  container.addEventListener('drop', (ev) => {
    const drag = activeDrag
    const slot = picked
    const nest = pickedNest
    const at = nestAt
    hide()
    if (!drag || (!slot && !nest)) return
    ev.preventDefault()
    endSlideDrag()
    const doc = store.doc
    if (nest) {
      if (drag.kind !== 'slides') return
      const asExtras = moveSlidesAsExtras(doc, drag.ids, at)
      if (!asExtras) return
      store.commit(() => {
        applyTokens(store.doc, asExtras.tokens)
        for (const s of asExtras.heads) s.hidden = true
      }, 'slides')
      opts.onDropped(drag.kind, drag.ids)
      return
    }
    if (!slot) return
    if (opts.nestable && drag.kind === 'slides') {
      const out = moveSlidesOutOfExtras(doc, drag.ids, slot.at)
      if (!out) return
      store.commit(() => {
        applyTokens(store.doc, out.tokens)
        for (const s of out.heads) delete s.hidden
      }, 'slides')
      opts.onDropped(drag.kind, drag.ids)
      return
    }
    const next: Token[] | null = drag.kind === 'section'
      ? moveSectionTo(doc, drag.ids[0], slot.at)
      : moveSlidesTo(doc, drag.ids, slot.at)
    if (!next) return
    store.commit(() => { applyTokens(store.doc, next) }, 'slides')
    opts.onDropped(drag.kind, drag.ids)
  })
}

/** One line per element for review_slide: `id type @x,y wxh "text…"` —
 *  connectors as `from→to`. Enough to address any element by id and see the
 *  geometry next to the screenshot, without a get_slide. */
function agentFrameLine(e: SlideElement): string {
  const r = Math.round
  let line = `${e.id} ${e.type === 'shape' ? `shape:${e.shape}` : e.type}${e.role ? ` role=${e.role}` : ''} @${r(e.x)},${r(e.y)} ${r(e.w)}x${r(e.h)}`
  if (e.rotation) line += ` rot=${r(e.rotation)}`
  if (e.parentId) line += ` in=${e.parentId}`
  if (e.type === 'shape' && (e.from || e.to)) line += ` ${e.from?.el ?? '·'}→${e.to?.el ?? '·'}`
  const text = e.type === 'text' ? stripHtml(e.html) : e.type === 'code' ? e.content : e.type === 'math' ? e.tex : ''
  if (text.trim()) {
    const one = text.replace(/\s+/g, ' ').trim()
    line += ` "${one.length > 60 ? one.slice(0, 60) + '…' : one}"`
  }
  return line
}

/** writeSelectionContext's `neighbours`: elements whose box comes within
 *  48px of the selection's union box (nearest first, capped), plus every
 *  connector with an end on a selected element. */
function selectionNeighbours(doc: SlidomingoDoc, slide: Slide, selected: SlideElement[]): Array<Record<string, unknown>> {
  if (!selected.length) return []
  const ids = new Set(selected.map((e) => e.id))
  const box = {
    x0: Math.min(...selected.map((e) => e.x)), y0: Math.min(...selected.map((e) => e.y)),
    x1: Math.max(...selected.map((e) => e.x + e.w)), y1: Math.max(...selected.map((e) => e.y + e.h)),
  }
  const gapTo = (e: SlideElement) => Math.hypot(
    Math.max(box.x0 - (e.x + e.w), 0, e.x - box.x1),
    Math.max(box.y0 - (e.y + e.h), 0, e.y - box.y1))
  const frame = (e: SlideElement) => ({ x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.w), h: Math.round(e.h) })
  const out: Array<Record<string, unknown>> = []
  const arrows = new Set<string>()
  for (const e of slide.elements) {
    if (ids.has(e.id) || e.type !== 'shape' || !(e.from || e.to)) continue
    if ((e.from && ids.has(e.from.el)) || (e.to && ids.has(e.to.el))) {
      arrows.add(e.id)
      out.push({ id: e.id, type: 'connector', from: e.from?.el ?? null, to: e.to?.el ?? null })
    }
  }
  const near = slide.elements
    .filter((e) => !ids.has(e.id) && !arrows.has(e.id) && !isFullBleed(e, doc) && gapTo(e) <= 48)
    .sort((a, b) => gapTo(a) - gapTo(b))
    .slice(0, 12)
  for (const e of near) {
    const text = e.type === 'text' ? stripHtml(e.html).trim().slice(0, 40) : undefined
    out.push({ id: e.id, type: e.type === 'shape' ? `shape:${e.shape}` : e.type, frame: frame(e), ...(text ? { text } : {}) })
  }
  return out
}

/** Sidebar thumb badge state: 'check' (Claude marked a thread done) wins over
 *  plain 'open'. */
function thumbCommentState(slide: Slide): 'check' | 'open' | null {
  if (slide.comments?.some((c) => c.agentDone)) return 'check'
  if (slide.comments?.some((c) => !c.resolved)) return 'open'
  return null
}

/** The words selected where ⌘F was pressed (an inline text edit or the
 *  notes) — the find bar's seed. One short line only, never a paragraph. */
function selectedWords(): string | undefined {
  const a = document.activeElement
  const s = a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement
    ? a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0)
    : document.getSelection()?.toString() ?? ''
  return s.trim() && s.length <= 100 && !/[\r\n]/.test(s) ? s : undefined
}

/** Marks a toolbar control with its UI profile id (customize/catalog.ts
 *  TOOLBAR_ITEMS) — what a profile hides and orders by CSS. */
function tagTool<T extends HTMLElement>(el: T, id: string): T {
  el.dataset.uiTool = id
  return el
}

/** Display words for where the quick-format bar shows. */
export function quickBarPlaceLabel(p: QuickBarPlace): string {
  return { top: t('At the top'), floating: t('Next to the selection'), both: t('Both'), off: t('Off') }[p]
}

/** A select of the four places (Settings ▸ General, Customize). */
export function quickBarPlaceSelect(value: QuickBarPlace, onChange: (v: QuickBarPlace) => void): HTMLSelectElement {
  const sel = document.createElement('select')
  sel.className = 'ed-quickbar-place'
  for (const p of QUICKBAR_PLACES) {
    const o = document.createElement('option')
    o.value = p
    o.textContent = quickBarPlaceLabel(p)
    o.selected = p === value
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => onChange(sel.value as QuickBarPlace))
  return sel
}
