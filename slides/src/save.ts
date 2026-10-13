// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Facade: self-save + slidomingo/enc encryption live in the shared kernel now
// (kernel/src/save.ts). This path stays alive so slides code keeps importing
// './save' unchanged — see docs/PLATFORM.md §9.
//
// The four entry points that turn a document into file text are wrapped here
// (explicit exports win over `export *`) so every slides write path declares
// its content-derived `requires` names (`rich-text`, `table-merge` —
// model.syncContentRequires) exactly when the document uses them — not only the
// ones that pass through the Store (library items, template updates and
// template stamps serialize a doc the Store never saw). The wrapper syncs a
// SHALLOW COPY: the caller's doc is never mutated.
import {
  serializeAuto as kernelSerializeAuto,
  serializeDocInto as kernelSerializeDocInto,
  serializeFile as kernelSerializeFile,
  serializeWith as kernelSerializeWith,
} from '../../kernel/src/save.ts'
import { syncContentRequires } from './model.ts'

export * from '../../kernel/src/save.ts'

/** `doc`, or a shallow copy of it with `requires` matched to its content
 *  (rich text, merged table cells). */
export function withContentRequires<T extends object>(doc: T): T {
  const copy = { ...doc } as T & { requires?: unknown }
  return syncContentRequires(copy) ? copy : doc
}

/** The rich-text-era name of `withContentRequires` (it syncs every
 *  content-derived name now). */
export const withRichTextRequires = withContentRequires

export function serializeFile(doc: Parameters<typeof kernelSerializeFile>[0]): string {
  return kernelSerializeFile(withContentRequires(doc))
}

export function serializeWith(shell: Document, doc: Parameters<typeof kernelSerializeWith>[1]): string {
  return kernelSerializeWith(shell, withContentRequires(doc))
}

export function serializeDocInto(shell: Document, doc: Parameters<typeof kernelSerializeDocInto>[1]): Promise<string> {
  return kernelSerializeDocInto(shell, withContentRequires(doc))
}

export function serializeAuto(doc: Parameters<typeof kernelSerializeAuto>[0]): Promise<string> {
  return kernelSerializeAuto(withContentRequires(doc))
}
