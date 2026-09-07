export type MarkdownDraft = { content: string; baseline: string; updatedAt: number | null };

export function loadMarkdownDraft(current: MarkdownDraft | null, content: string, updatedAt: number | null): MarkdownDraft {
  if (current && current.content !== current.baseline) return current;
  return { content, baseline: content, updatedAt };
}

export function savedMarkdownDraft(current: MarkdownDraft, saved: string, updatedAt: number | null): MarkdownDraft {
  return { ...current, baseline: saved, updatedAt };
}

export function replaceMarkdownText(content: string, search: string, replacement: string): string {
  if (!search || !content.includes(search)) throw new Error("The text was not found. Read the document again before editing.");
  if (content.indexOf(search) !== content.lastIndexOf(search)) throw new Error("The text matches more than once. Include more surrounding text.");
  return content.replace(search, () => replacement);
}
