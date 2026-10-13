# Contributing to BeeSlides

Thanks for wanting to help. A few things to know before you start.

## Before you build

- **Say what you're planning first.** For anything bigger than a small fix,
  check the open issues and PRs, then open an issue
  describing the change before you write it.
- **Read the contracts.** `docs/PLATFORM.md` lists the invariants every
  BeeSlides app must honor (breaking them can make shipped documents
  unreadable); `docs/DECISIONS.md` records settled design decisions.
- **Security issues** are reported privately (GitHub → Security → *Report a
  vulnerability*), never in a public issue.
- **AI-assisted work is welcome; autonomous bot PRs are not merged.** A pull
  request must come from a person who wrote, or reviewed and takes
  responsibility for, every line.

## Checks

Before opening a pull request, run `npm test` from the repository root (after
`npm install` in `slides/` and `desktop/`) and build the shell with
`npm run build:single` in `slides/`. CI runs the same on every pull request.

## Licensing of contributions

BeeSlides is licensed under `AGPL-3.0-or-later` with an additional permission
for documents (see [LICENSING.md](LICENSING.md)). The project also offers
commercial licenses, which pays for its development. To keep that possible,
every contribution is accepted under the following terms. By opening a pull
request you confirm that you agree to them.

1. **You may contribute it.** The contribution is your original work, or you
   have the right to submit it under these terms, and if your employer has
   rights to your work, they have permitted you to contribute it.
2. **AGPL for everyone.** Your contribution is licensed to everyone under
   `AGPL-3.0-or-later`, including the additional permission for documents in
   `LICENSING.md`.
3. **A license to the maintainers.** You also grant the BeeSlides maintainers
   a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to
   use, modify, sublicense and distribute your contribution under other terms,
   including commercial licenses. You keep the copyright in your contribution.
4. **Sign off your commits** (`git commit -s`) to confirm the above. The
   `Signed-off-by:` line also certifies the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Third-party code you add must be under a license compatible with the AGPL (MIT,
BSD, Apache-2.0, ISC, …) and must be listed in `THIRD_PARTY_NOTICES.md`.

## Source file headers

New source files start with:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
```
