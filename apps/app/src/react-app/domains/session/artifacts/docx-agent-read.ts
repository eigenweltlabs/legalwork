import { docxReadSchema } from "@legalwork/types/office-editor";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import type { Layout } from "@eigenpal/docx-editor-core/layout-engine";
import { headerFooterToProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import type { Node } from "prosemirror-model";
import { readWordStructure } from "./docx-agent-structure";
import { readWordFormatting } from "./docx-agent-formatting";
import type { WordMetadata } from "./docx-word-package";
import { wordParagraphText, wordWritingLocations } from "./docx-agent-locations";
import { wordDocumentAreas, wordPageLayout } from "./docx-agent-layout";

/** Reads cover the whole document unless the caller requests a window. Coverage explicitly
 * reports omitted paragraphs; reading never selects or changes the editor. */
export function readWordDocument(doc: Node, document: Document, layout: Layout | null, metadata: WordMetadata, rawArgs: Record<string, unknown>, liveStories?: Map<string, Node>) {
  const args = docxReadSchema.parse(rawArgs);
  const full = readWordStructure(doc, document, layout, metadata);
  const matches = args.paraId ? full.paragraphs.filter(item => item.paraId === args.paraId) : [];
  const focused = matches.length === 1 ? matches[0] : undefined;
  if (args.paraId && !focused) throw new Error("Paragraph is missing or ambiguous. Read the live document again.");
  const from = focused?.index ?? args.fromIndex ?? 0;
  const limit = focused ? 1 : args.toIndex !== undefined ? args.toIndex - from + 1 : args.limit ?? Math.max(1, full.paragraphs.length - from);
  const paragraphs = full.paragraphs.slice(from, from + limit);
  const ids = new Set(paragraphs.map(item => item.paraId));
  const view = args.view ?? "all";
  const writing = wordWritingLocations(doc, layout);
  const structure = view === "all" || view === "structure" || view === "layout" ? {
    ...full, paragraphs,
    fields: full.fields.filter(item => ids.has(item.paraId)),
    bookmarks: full.bookmarks.filter(item => ids.has(item.paraId)),
    headings: full.headings.filter(item => ids.has(item.paraId)),
    controls: full.controls.filter(item => item.paraIds.some(id => ids.has(id))),
    notes: full.notes.filter(item => item.references.some(ref => ids.has(ref.paraId))),
    styles: full.styles.slice(0, 200), stylesTruncated: full.styles.length > 200,
    counts: { fields: full.fields.length, bookmarks: full.bookmarks.length, headings: full.headings.length, notes: full.notes.length, controls: full.controls.length },
    headerFooterFields: from === 0 ? Array.from(new Map([...(document.package.headers ?? []), ...(document.package.footers ?? [])])).flatMap(([rid, story]) => readWordStructure(liveStories?.get(rid) ?? headerFooterToProseDoc(story.content, { styles: document.package.styles }), document, null, metadata, rid, doc, false).fields) : undefined,
    writingAreas: from === 0 || view === "layout" ? wordDocumentAreas(doc, document, layout, liveStories) : undefined,
  } : undefined;
  return {
    view, structure,
    formattingWarnings: readWordFormatting(doc, document, { fromIndex: from, limit }).paragraphs.flatMap(item => item.warnings.map(message => ({ paraId: item.paraId, message }))),
    text: view === "all" || view === "text" ? wordParagraphText(writing.slice(from, from + limit)) : undefined,
    layout: view === "layout" ? wordPageLayout(doc, document, layout, args.page ?? 1, liveStories) : undefined,
    formatting: view === "all" || view === "formatting" ? readWordFormatting(doc, document, { ...args, fromIndex: from, limit }) : undefined,
    coverage: { fromIndex: from, toIndex: paragraphs.at(-1)?.index ?? null, totalParagraphs: full.paragraphs.length, nextIndex: !focused && from + paragraphs.length < full.paragraphs.length ? from + paragraphs.length : null },
    textArgs: { fromIndex: from, ...(focused || args.toIndex !== undefined || args.limit !== undefined ? { toIndex: from + limit - 1 } : {}) },
  };
}
