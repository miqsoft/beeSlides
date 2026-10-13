---
title: Install
description: Build the desktop app with one command — or open any deck in a browser, no install.
sidebar: { order: 1 }
---

The **desktop app** is the full BeeSlides: native menus, a start page with
your recent decks, and the AI features — a built-in Claude Code terminal, an
AI chat, *Send comments to Claude* and *PowerPoint with AI*.

Every deck also carries its own editor, so anyone you send one to can open,
edit and present it [in a browser](#in-a-browser) without installing anything.

## The desktop app

Build and install it from source with one command:

```bash
git clone https://github.com/miqsoft/beeslides.git
cd beeslides
npm run setup
```

| | Installs to | You need |
|---|---|---|
| **macOS** | `/Applications/BeeSlides.app` (Launchpad, Spotlight) | [Node.js](https://nodejs.org) 22.12+ |
| **Windows** | your user's Programs folder, with a Start menu entry | Node.js 22.12+ |
| **Linux** | `~/.local/share/beeslides`, a menu entry and `~/.local/bin/beeslides` | Node.js 22.12+, `build-essential` (or `gcc-c++` + `make`), `python3` |

Nothing is downloaded pre-built and nothing is signed. An app you build on your
own machine opens without a security warning.

- **Update:** `git pull`, then `npm run setup` again.
- **Uninstall:** `npm run setup -- --uninstall` (your settings stay).
- The same run also leaves the browser editor at
  `slides/dist-single/BeeSlides.beeslides.html`.

## In a browser

Open any `.beeslides.html` file in a modern browser (Chrome, Edge, Safari,
Firefox) to view, edit and present it. To start a new deck without installing
anything, open the blank editor — [this site hosts one](/beeSlides/app/BeeSlides.beeslides.html) —
and save it under a new name.

Chrome and Edge save in place; other browsers download a fresh copy each time.

The browser editor has **no AI features** (Claude Code terminal, AI chat, Send
to Claude, PowerPoint with AI) and no start page with recent decks: those need
the desktop app. To use AI with a deck in the browser, round-trip its JSON
through any chatbot — see [Edit with AI](../../create/ai/#in-the-browser-any-chatbot).
