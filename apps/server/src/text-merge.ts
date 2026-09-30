import { diff3Merge } from "node-diff3";

/**
 * Text a person writes (notes, plain text): when two computers changed it,
 * or the file changed while it was open in the editor, the two versions are
 * merged rather than one kept beside the other.
 */
export function mergeableText(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}

/** Larger text files are neither merged nor their agreed text kept. */
export const MERGEABLE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Lines with their line breaks; and words, the spaces between them and each
 * line break on its own (so a line edited and one added below it stay
 * apart): joined, the text as it was.
 */
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const words = (text: string) => text.match(/\n|[^\S\n]+|\S+/g) ?? [];

function mergeParts(mine: string[], base: string[], theirs: string[], within: ((mine: string, base: string, theirs: string) => string | null) | null): string | null {
  let merged = "";
  for (const region of diff3Merge(mine, base, theirs)) {
    if (region.ok) {
      merged += region.ok.join("");
      continue;
    }
    const conflict = region.conflict;
    const inner = conflict && within ? within(conflict.a.join(""), conflict.o.join(""), conflict.b.join("")) : null;
    if (inner === null) return null;
    merged += inner;
  }
  return merged;
}

/**
 * Two versions of a text that both changed from `base`, merged as Git does,
 * by lines, and where both changed the same lines (a paragraph is one line
 * in a note), by words. Null when both changed the same words differently:
 * then a person has to choose.
 */
export function mergeText(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  return mergeParts(lines(mine), lines(base), lines(theirs), (a, o, b) => mergeParts(words(a), words(o), words(b), null));
}
