# Security policy

## Reporting a vulnerability

Please report security problems **privately**, never in a public issue or
Discussion: on GitHub, open the repository's **Security** tab and choose
**Report a vulnerability**. Include the version (shown in the About dialog),
the browser or desktop build, and a file or steps that reproduce it.

You will get an answer as soon as the maintainer can look at it. Please give
us a reasonable time to ship a fix before you publish details.

## What counts

A BeeSlides document is a program as well as a document, so these matter
most:

- A document that runs script, reaches the network, or reads local files when
  someone else opens it (sanitizing untrusted decks, pasted SVG, imported
  PowerPoint files).
- Anything that reaches the network outside the single chokepoint in
  `kernel/src/net.ts`, or while offline mode is on.
- Weaknesses in password encryption (`docs/security.md`), or a
  password-protected file that leaks content in plaintext (for example in its
  preview).
- In the desktop app: a document or web page that gains access to the
  terminal, the file system beyond what was granted, or stored API keys.

## Supported versions

Only the latest release gets security fixes. Every saved document carries its
own copy of the app, so an existing file keeps its older runtime until it is
opened and saved again in a fixed version.

See [`docs/security.md`](docs/security.md) for the security model.
