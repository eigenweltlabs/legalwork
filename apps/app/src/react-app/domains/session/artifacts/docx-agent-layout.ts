import type { Node } from "prosemirror-model";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import type { Layout } from "@eigenpal/docx-editor-core/layout-engine";
import { footnoteToProseDoc, headerFooterToProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { wordPageGeometry } from "./docx-page-geometry";
import { wordWritingLocations } from "./docx-agent-locations";

export function wordDocumentAreas(doc: Node, document: Document, layout: Layout | null, liveStories?: Map<string, Node>) {
  const paragraphs = wordWritingLocations(doc, layout);
  const groups = new Map<string, typeof paragraphs>();
  groups.set("body/main", []);
  for (const item of paragraphs) {
    const id = item.location.containers.length ? `body/${item.location.containers.map(container => container.id).join("/")}` : "body/main";
    const group = groups.get(id) ?? [];
    group.push(item); groups.set(id, group);
  }
  const body = Array.from(groups, ([id, items]) => ({
    id, story: "body", area: items[0]?.location.area ?? "main", containers: items[0]?.location.containers ?? [],
    purpose: id === "body/main" ? "Main text flow. Insert new letters and document sections here." : "Nested container. Select this area explicitly only when the requested content belongs inside it.",
    paragraphCount: items.length, paragraphIds: items.map(item => item.paraId),
    emptyParagraphIds: items.filter(item => !item.text.trim() && !item.node.childCount && item.editable).map(item => item.paraId),
    editableWith: "inapp_docx_edit / insert_paragraphs or inapp_docx_suggest_change", text: items.map(item => item.text).join("\n").slice(0, 500), textTruncated: items.reduce((n, item) => n + item.text.length + 1, 0) > 500,
  }));
  const stories = (["header", "footer"] satisfies ("header" | "footer")[]).flatMap(story => {
    const entries = story === "header" ? document.package.headers : document.package.footers;
    return Array.from(entries ?? [], ([rid, value]) => {
      const doc = liveStories?.get(rid) ?? headerFooterToProseDoc(value.content, { styles: document.package.styles });
      const items = wordWritingLocations(doc, null, `${story}:${rid}`);
      const text = items.map(item => item.text).join("\n");
      return { id: `${story}:${rid}`, story, area: story, purpose: "Repeating page content. Do not put ordinary letter text here.", paragraphCount: items.length, text: text.slice(0, 500), textTruncated: text.length > 500, editableWith: null };
    });
  });
  const notes = [...document.package.footnotes ?? [], ...document.package.endnotes ?? []].map(note => {
    const items = wordWritingLocations(footnoteToProseDoc(note.content), null, `${note.type}:${note.id}`);
    const text = items.map(item => item.text).join("\n");
    return { id: `${note.type}:${note.id}`, story: note.type, area: note.type, noteId: note.id, purpose: "Linked note content. Use edit_note only when the user requests a note edit.", paragraphCount: items.length, text: text.slice(0, 500), textTruncated: text.length > 500, editableWith: note.verbatimXml ? null : "inapp_docx_edit / edit_note" };
  });
  return [...body, ...stories, ...notes];
}

export function wordPageLayout(doc: Node, document: Document, layout: Layout | null, pageNumber: number, liveStories?: Map<string, Node>) {
  const page = layout?.pages.find(page => page.number === pageNumber);
  if (layout && !page) throw new Error(`Page ${pageNumber} is unavailable. This draft has ${layout.pages.length} pages.`);
  const geometry = wordPageGeometry(document, layout, pageNumber, liveStories);
  return {
    wrappingExclusions: geometry.wrappingExclusions,
    warnings: geometry.hasPageBackgroundImage ? ["This page has a large image behind the body. Word dark-page mode can display light body text on its white image background. View > Switch Modes shows the light-page/print appearance. Word also dims inactive headers on screen; this is not image opacity."] : [],
    units: "CSS pixels at 100% zoom", page: pageNumber, totalPages: layout?.pages.length ?? null,
    size: page?.size, margins: page?.margins,
    mainTextBounds: page ? { x: page.margins.left, y: page.margins.top, width: page.size.w - page.margins.left - page.margins.right, height: page.size.h - page.margins.top - page.margins.bottom } : undefined,
    areas: wordDocumentAreas(doc, document, layout, liveStories),
    guidance: "Use the main text flow for new document content. A text box or table may be positioned anywhere on the page. Header/footer and note IDs are not body paragraph handles. wrappingExclusions reserve space even when the object is transparent or behind text. The editor wraps body text around these objects automatically; do not guess a large paragraph indent from a screenshot. Read formatting to diagnose spacing. Image previews are optional and consume image tokens; request one only for a visual question or unresolved layout uncertainty.",
  };
}
