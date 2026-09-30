import { BUILTIN_JEV_FALLBACKS, builtinReviewLibrary } from "./builtin-library.js";
import type { ReviewColumn } from "./schema.js";

const catalog = (version: 2 | 3) => new Map(["en", "de"].flatMap(language => {
  if (language !== "en" && language !== "de") throw new Error("Unsupported builtin language");
  return builtinReviewLibrary(language, version).flatMap(entry => entry.columns.map(column => [
    `${entry.id}:${column.key}`, { column, language },
  ] satisfies [string, { column: ReviewColumn; language: "en" | "de" }]));
}));
const previous = catalog(2), current = catalog(3);
function lookup(column: ReviewColumn) { return `${column.libraryId}:${column.libraryColumnKey}`; }
function samePrompt(left: ReviewColumn, right: ReviewColumn) {
  return left.kind === right.kind && left.question === right.question && left.hint === right.hint
    && JSON.stringify(left.options) === JSON.stringify(right.options);
}

/** Update only known, untouched builtin decisions. Preserve user labels and IDs. */
export function upgradeBuiltinReviewColumn(column: ReviewColumn): ReviewColumn {
  if (column.libraryVersion !== 2) return column;
  const old = previous.get(lookup(column)), next = current.get(lookup(column));
  if (!old || !next || next.column.kind !== "classification" || !samePrompt(column, old.column)) return column;
  return { ...next.column, key: column.key, label: column.label };
}

/** Criteria descriptions make silence distinct from an evidenced negative. */
export function builtinJevFallback(column: ReviewColumn) {
  const entry = current.get(lookup(column));
  if (!entry || column.libraryVersion !== 3 || column.kind !== "classification" || !samePrompt(column, entry.column)) return null;
  const labels = BUILTIN_JEV_FALLBACKS[entry.language];
  return { ...labels, criteria: {
    [labels.absent]: "No relevant provision or information answering the question was found. Absence of evidence must not be treated as No or as a substantive category.",
    [labels.irrelevant]: "The subject of this question does not apply to this document or transaction.",
    [labels.uncertain]: "The evidence is ambiguous, conflicting or insufficient to support a definite answer. Do not guess.",
    [entry.language === "en" ? "Yes" : "Ja"]: "The document provides evidence that the proposition is true.",
    [entry.language === "en" ? "No" : "Nein"]: "The document provides evidence that the proposition is false. Silence or irrelevant evidence is not No.",
  } satisfies Record<string, string> };
}
