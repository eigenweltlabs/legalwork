import { toProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { Fragment } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import { docxEditOperationSchema } from "@legalwork/types/office-editor";
import { wordParagraphTarget, wordWritingLocations } from "./docx-agent-locations";

// Word paragraph IDs use positive 31-bit values. Keep handles stable on reparse.
const newParagraphId = () => (Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 8), 16) & 0x7fffffff).toString(16).padStart(8, "0").toUpperCase();

/** Inserting a document section is structural, never a multiline span appended
 * to the first paragraph in a flattened read. Start/end always address the root. */
export function insertWordParagraphs(state: EditorState, document: Document, rawArgs: Record<string, unknown>) {
  const args = docxEditOperationSchema.parse({ operation: "insert_paragraphs", placement: rawArgs.placement, paraId: rawArgs.paraId, area: rawArgs.area, paragraphs: rawArgs.paragraphs });
  if (args.operation !== "insert_paragraphs") throw new Error("Expected insert_paragraphs.");
  const rootPlacement = args.placement === "start" || args.placement === "end";
  if (rootPlacement && (args.area !== "main" || args.paraId !== undefined)) throw new Error("start/end inserts in the main text flow and must omit paraId. Use before/after with an explicit area for a nested container.");
  const target = rootPlacement ? undefined : wordParagraphTarget(state.doc, args.paraId, args.area);
  if (args.placement === "replace_empty" && target && (target.node.childCount || target.text.trim())) throw new Error("replace_empty requires an empty paragraph without fields or note markers. Use before/after to preserve existing content.");
  const ids = new Set(wordWritingLocations(state.doc).map(item => item.paraId));
  const styles = new Set(document.package.styles?.styles.map(style => style.styleId));
  const inherited = ["styleId", "alignment", "spaceBefore", "spaceAfter", "lineSpacing", "lineSpacingRule", "spacingExplicit", "indentLeft", "indentRight", "indentFirstLine", "hangingIndent", "defaultTextFormatting", "keepNext", "keepLines", "contextualSpacing", "bidi"];
  const paragraphs = args.paragraphs.map((paragraph, index) => {
    let id = args.placement === "replace_empty" && index === 0 && target ? target.paraId : newParagraphId();
    while (ids.has(id) && !(args.placement === "replace_empty" && index === 0 && id === target?.paraId)) id = newParagraphId();
    ids.add(id);
    // Resolve the document's native default/style chain for new text too.
    // Bare schema.text nodes otherwise paint with fallback fonts while Word
    // resolves the exported runs against the template's real style.
    const prototype = toProseDoc({ ...document, package: { ...document.package, document: { ...document.package.document, content: [{ type: "paragraph", formatting: { styleId: paragraph.styleId ?? target?.node.attrs.styleId }, content: [{ type: "run", formatting: paragraph.styleId ? undefined : target?.node.attrs.defaultTextFormatting ?? undefined, content: [{ type: "text", text: "x" }] }] }] } } }, { styles: document.package.styles }).firstChild!;
    const attrs: Record<string, unknown> = { paraId: id };
    for (const key of inherited) {
      const value = !paragraph.styleId && target?.node.attrs[key] != null ? target.node.attrs[key] : prototype.attrs[key];
      if (value !== null && value !== undefined) attrs[key] = value;
    }
    const marks = prototype.firstChild?.marks;
    if (paragraph.styleId) {
      if (!styles.has(paragraph.styleId)) throw new Error(`Style ${paragraph.styleId} does not exist in this document. Read its styles and use an existing ID.`);
      attrs.styleId = paragraph.styleId;
    }
    if (paragraph.alignment) attrs.alignment = paragraph.alignment;
    else if (/[\r\n]/.test(paragraph.text) && ["both", "distribute"].includes(String(attrs.alignment))) attrs.alignment = "left";
    if (args.placement === "replace_empty" && target) {
      if (index === 0 && target.node.attrs.bookmarks) attrs.bookmarks = target.node.attrs.bookmarks;
      if (index === args.paragraphs.length - 1) for (const key of ["sectionBreakType", "_sectionProperties"]) if (target.node.attrs[key]) attrs[key] = target.node.attrs[key];
    }
    const content = paragraph.text.split(/\r\n|\r|\n/).flatMap((line, lineIndex) => [
      ...(lineIndex ? [state.schema.nodes.hardBreak.create(null, null, marks)] : []), ...(line ? [state.schema.text(line, marks)] : []),
    ]);
    return state.schema.nodes.paragraph.create(attrs, content);
  });
  const from = args.placement === "start" ? 0 : args.placement === "end" ? state.doc.content.size : target!.pos + (args.placement === "after" ? target!.node.nodeSize : 0);
  const to = args.placement === "replace_empty" ? from + target!.node.nodeSize : from;
  return { transaction: state.tr.replaceWith(from, to, Fragment.fromArray(paragraphs)), paragraphIds: paragraphs.map(paragraph => String(paragraph.attrs.paraId)), area: args.area };
}
