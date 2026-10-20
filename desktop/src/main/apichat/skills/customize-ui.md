---
name: customize-ui
description: Change how this slides editor looks and works for the user — ribbon tabs and buttons, the right-click menu and the quick-format bar, toolbar buttons, keyboard shortcuts (including taking over built-in keys), saved styles and presets, chrome colours and density, personal default styles — through the ui_profile tool. Not for editing the deck.
---

You are customizing the user's **editor**, not their deck. Everything goes through one tool, `ui_profile` (in Claude Code it is `mcp__beeslides__ui_profile`). A UI profile is DATA: ids from a closed catalog, labels the user will read, and element property values. There is no way to add code, CSS, HTML or URLs — don't try, and don't promise anything that needs them.

1. **Look first.** `ui_profile {op:"get"}` shows what is already customized — keep it unless the user asks to remove it.
2. **Load only the catalog you need.** `ui_profile {op:"catalog"}` returns a short index of sections. Then ask for the sections the request touches, e.g. `{op:"catalog", section:"menus"}`. Each section gives the ids you may use AND how to write that part — follow its `howto`. Typical picks:
   - a button on a tab → `ribbon` + `commands`
   - "in the right-click menu" / "on the little bar under a selection" → `menus`
   - hide or reorder single toolbar buttons → `toolbar`
   - a keyboard shortcut, or "make ⌘D do X" → `shortcuts`
   - "my heading look", a callout style, a reusable element → `styles`
   - colours, compact, rounded → `tokens`
   - every button, shortcut and pin runs a *target*: a command id from `commands` (has a dot) or one of the profile's own actions (no dot; `schema` shows the action kinds).
3. **Write the smallest change** with `ui_profile {op:"patch", patch:{…}, summary:"…"}` — an RFC 7386 merge patch (`null` deletes a key; arrays replace whole, so send the full list). The `summary` is one short line the user sees next to an Undo button, e.g. "Added Callout to the right-click menu for text". Use `dryRun:true` first when the change is large.
4. **Fix what it reports.** A refused write changes nothing and lists every problem with its path; correct those and send the patch again (at most 3 tries). Warnings mean it worked — if one says a built-in key was replaced, tell the user what that key did before.
5. **Confirm in a few lines**: what changed, where to find it (which tab, menu, shortcut), and that Settings ▸ Customize ▸ History — or the toast's Undo — takes it back. Don't paste the profile JSON. Sharing is the user's: Settings ▸ Customize ▸ Export… picks parts to put in a file, Import… adds a file's parts to theirs.

Never edit the deck while customizing (no slide tools), unless the user asks for both.
