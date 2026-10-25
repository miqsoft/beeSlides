/**
 * Deep copy by JSON round trip — the one deep copy for document data.
 *
 * A JSON round trip ON PURPOSE, not `structuredClone`: documents are plain
 * JSON, and the copy must look exactly like what a save → load would give.
 * So `undefined` properties and functions are dropped (`undefined` in an
 * array becomes `null`), NaN/±Infinity become `null`, Dates become ISO
 * strings, prototypes/Maps/Sets are lost. A top-level `undefined` is returned
 * as is (a bare `JSON.parse(JSON.stringify(undefined))` would throw).
 *
 * Import-free on purpose: safe from the viewer bundle, the model, the editor
 * and Node scripts alike.
 */
export function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}
