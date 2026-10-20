# BeeSlides security, plainly

*How the file is the security boundary, how password encryption works, and
how to prove no bytes ever leave your machine. Written for the skeptic.
Everything here matches the code; links point at it.*

BeeSlides is a slide app where **one HTML file is the whole document** — viewer,
editor, and content in a single file you own. There is no server, no
account, and no cloud it depends on. This page explains the security of
that file without hand-waving.

## The model in one line

**The file is the security boundary.** A saved copy opens standalone,
forever, with zero knowledge of a server, and nothing about your document
ever touches the network.

> **Decoupling note (2026-09):** live collaboration (an end-to-end-encrypted
> relay layer) and signed self-update checking have been removed outright —
> not disabled, not feature-flagged. Neither exists in this codebase any
> more. See `docs/DECISIONS.md` for the dated entry; the design this page
> used to summarize is preserved in git history for anyone auditing the
> decision, not as live documentation.

## Password encryption

A document can be **password-encrypted at rest**: the on-disk `#beeslides-doc`
block holds a `beeslides/enc` envelope — AES-GCM-256 over the document JSON,
with the key derived from your password via **PBKDF2-SHA-256, 600,000
iterations** (the current OWASP figure for PBKDF2-HMAC-SHA256;
[`kernel/src/save.ts`](../kernel/src/save.ts)). The password is held only in
memory so autosave and every subsequent save keep writing encrypted.

**Files encrypted by older builds still open.** The iteration count travels
in the envelope itself (`it`), and decryption derives with *that* number —
so a deck written at an older iteration count is unaffected, and re-saving
it re-encrypts at the current count.

## Offline mode — nothing leaves this computer

An **Offline switch** (in the About dialog) hard-blocks every network touch
at one chokepoint ([`kernel/src/net.ts`](../kernel/src/net.ts)):
`netFetch`/`netWebSocket` refuse outright when the switch is on, and
`scripts/test-offline.ts` fails the build if any file outside `net.ts` calls
`fetch`/`WebSocket` directly.

There is no telemetry, no analytics, no phone-home, with the switch on or
off — flip it on and you can watch the network tab stay silent regardless.

## Reporting a vulnerability

Found something? Please report it privately — see
[`SECURITY.md`](../SECURITY.md) for the disclosure process and scope. Don't
open a public issue for a security bug.
