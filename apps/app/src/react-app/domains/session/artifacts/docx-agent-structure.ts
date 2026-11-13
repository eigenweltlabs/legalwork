import { Fragment, type Node } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import { footnoteToProseDoc, fromProseDoc, proseDocToBlocks } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import type { Layout } from "@eigenpal/docx-editor-core/layout-engine";
import { fieldTarget, pageAtPosition, pageLabels, resolveWordFields, wordParagraphs, withWordSections } from "./docx-fields";
import { permitsWordEdit } from "./docx-protection";
import type { WordMetadata } from "./docx-word-package";
import { wordBookmarkIdentities, wordBookmarks } from "./docx-bookmarks";
import { wordWritingLocations } from "./docx-agent-locations";
import { insertWordParagraphs } from "./docx-insert-paragraphs";

type View = { state: EditorState; dispatch: (transaction: Transaction) => void };
type WordField = { id: string; paraId: string; ordinal: number; type: string; instruction: string; target?: string; displayText: string; resolvedText?: string; status: string; locked: boolean; tracked: boolean };
type WordControl = { paraIds: string[]; id: string; tag: string; alias: string; type: string; text: string; lock: string; editable: boolean };
type WordNote = { id: number; type: string; text: string; references: { id: number; type: string; paraId: string }[]; editable: boolean; fields: WordField[]; controls: WordControl[] };
export type WordToolContext = { view: View; document: Document; layout: Layout | null; metadata: WordMetadata; loadDocument: (document: Document) => void };
export const WORD_STRUCTURE_MUTATIONS = new Set(["create_bookmark", "insert_cross_reference", "edit_cross_reference", "fill_content_control", "edit_note", "insert_note", "insert_paragraphs"]);

function paragraphs(doc: Node) {
  return wordParagraphs(doc).map((paragraph, index) => ({ ...paragraph, paraId: typeof paragraph.node.attrs.paraId === "string" ? paragraph.node.attrs.paraId : `@paragraph:${index}` }));
}

function text(node: Node): string {
  if (node.type.name === "field") return String(node.attrs.displayText ?? "");
  if (node.isText) return node.text ?? "";
  if (node.type.name === "tab") return "\t";
  if (node.type.name === "hardBreak") return "\n";
  const parts: string[] = []; node.forEach((child) => parts.push(text(child)));
  return parts.join(node.isBlock && !node.isTextblock ? "\n" : "");
}

export function readWordStructure(doc: Node, document: Document, layout: Layout | null, metadata: WordMetadata, story = "body", bodyDoc = doc, includeNotes = true) {
  layout = withWordSections(doc, layout);
  const items = paragraphs(doc);
  const bookmarks = wordBookmarks(doc).flatMap(mark => {
    const item = items.find(item => mark.from >= item.pos && mark.from < item.pos + item.node.nodeSize);
    return item ? [{ ...mark, paraId: item.paraId, number: item.marker }] : [];
  });
  const targetBookmarks = wordBookmarks(bodyDoc);
  const values = resolveWordFields(doc, layout, metadata, undefined, bodyDoc);
  const fields: WordField[] = [];
  const controls: WordControl[] = [];
  const noteReferences: { id: number; type: string; paraId: string }[] = [];
  const labels = pageLabels(layout, metadata.pages);
  for (const item of items) {
    let ordinal = 0;
    item.node.descendants((node, offset) => {
      if (node.type.name === "field") {
        const instruction = String(node.attrs.instruction ?? "");
        const target = fieldTarget(instruction);
        const type = String(node.attrs.fieldType);
        fields.push({ id: `${story}:${item.paraId}:field:${ordinal}`, paraId: item.paraId, ordinal: ordinal++, type, instruction, target, displayText: String(node.attrs.displayText ?? ""), resolvedText: values.get(item.pos + 1 + offset), status: target ? targetBookmarks.some((mark) => mark.name === target) ? "linked" : "missing_target" : "field", locked: Boolean(node.attrs.fldLock), tracked: node.marks.some((mark) => ["insertion", "deletion"].includes(mark.type.name)) });
      }
      for (const mark of node.marks) if (mark.type.name === "footnoteRef") noteReferences.push({ id: Number(mark.attrs.id), type: String(mark.attrs.noteType), paraId: item.paraId });
    });
  }
  doc.descendants((node, pos) => {
    if (!["sdt", "blockSdt"].includes(node.type.name)) return;
    const lock = String(node.attrs.lock ?? "");
    const paraIds = items.filter(item => item.pos <= pos && pos < item.pos + item.node.nodeSize || pos <= item.pos && item.pos < pos + node.nodeSize).map(item => item.paraId);
    controls.push({ paraIds, id: String(node.attrs.id), tag: String(node.attrs.tag ?? ""), alias: String(node.attrs.alias ?? ""), type: String(node.attrs.sdtType ?? "text"), text: text(node), lock, editable: !["contentLocked", "sdtContentLocked"].includes(lock) && !node.attrs.dataBinding && ["none", "forms"].includes(metadata.protection.mode) });
  });
  const notes: WordNote[] = includeNotes ? [...(document.package.footnotes ?? []), ...(document.package.endnotes ?? [])].map((note): WordNote => {
    const doc = footnoteToProseDoc(note.content);
    const structure = readWordStructure(doc, document, null, metadata, `${note.type}:${note.id}`, bodyDoc, false);
    return { id: note.id, type: note.type, text: text(doc), references: noteReferences.filter((ref) => ref.id === note.id && ref.type === note.type), editable: !note.verbatimXml && metadata.protection.mode === "none", fields: structure.fields, controls: structure.controls };
  }) : [];
  return {
    story, fields, bookmarks, controls, notes,
    headings: items.filter((item) => item.level !== undefined).map((item) => ({ paraId: item.paraId, level: item.level, text: text(item.node), number: item.marker, page: labels.get(pageAtPosition(layout, item.pos)?.number ?? -1), bookmarks: bookmarks.filter((mark) => mark.paraId === item.paraId).map((mark) => mark.name) })),
    sections: metadata.pages.map((rule, index) => ({ index, ...rule })), protection: metadata.protection, contents: { levels: metadata.tocLevels },
    paragraphs: wordWritingLocations(doc, layout, story).map(item => ({ paraId: item.paraId, index: item.index, styleId: item.node.attrs.styleId ?? null, text: item.text, editable: item.editable, location: item.location })),
    styles: document.package.styles?.styles.map((style) => ({ id: style.styleId, name: style.name, type: style.type, basedOn: style.basedOn })) ?? [],
    capabilities: { bookmarkScope: "paragraph_or_text_range", crossReferenceKinds: ["number", "text", "page"], editableFieldStories: ["body"], structuralEditsTracked: false, noteEditsTracked: false, noteInsertion: true, formattingReadTool: "inapp_docx_read_document", formattingReadView: "formatting", formattingEditTool: "inapp_docx_edit", formattingEditOperation: "apply_formatting", formattingEditsTracked: false, editableFormattingStories: ["body"] },
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]; if (typeof value !== "string") throw new Error(`${key} must be a string.`); return value;
}

export function paragraph(doc: Node, id: string) {
  const matches = paragraphs(doc).filter((item) => item.paraId === id);
  if (matches.length !== 1) throw new Error("Paragraph is missing or ambiguous. Read the live structure again.");
  return matches[0];
}

function bookmarkList(node: Node): { id: number; name: string }[] {
  const value: unknown = node.attrs.bookmarks;
  if (!Array.isArray(value)) return [];
  return value.flatMap((mark: unknown) => mark && typeof mark === "object" && "id" in mark && typeof mark.id === "number" && "name" in mark && typeof mark.name === "string" ? [{ id: mark.id, name: mark.name }] : []);
}

function addBookmark(transaction: Transaction, paraId: string, name: string, search?: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name)) throw new Error("A Word bookmark needs a letter or underscore followed by letters, numbers or underscores (maximum 40 characters).");
  const item = paragraph(transaction.doc, paraId);
  const marks = wordBookmarkIdentities(transaction.doc);
  if (marks.some((mark) => mark.name.toLowerCase() === name.toLowerCase())) throw new Error("That bookmark name already exists. Reuse it or choose another name.");
  const id = Math.max(0, ...marks.map((mark) => mark.id)) + 1;
  if (search) {
    const range = uniqueTextRange(item.node, item.pos, search);
    return transaction.insert(range.to, transaction.doc.type.schema.nodes.bookmarkEnd.create({ id })).insert(range.from, transaction.doc.type.schema.nodes.bookmarkStart.create({ id, name }));
  }
  return transaction.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, bookmarks: [...bookmarkList(item.node), { id, name }] });
}

function referenceInstruction(kind: unknown, bookmark: string) {
  if (!["number", "text", "page"].includes(String(kind))) throw new Error("Reference kind must be number, text or page.");
  return `${kind === "page" ? "PAGEREF" : "REF"} ${bookmark}${kind === "number" ? " \\w" : ""} \\h`;
}

/** Only match ordinary text: never flatten a field, note marker, nested control or pending revision. */
export function uniqueTextRange(node: Node, pos: number, search: string) {
  const matches: { from: number; to: number }[] = [];
  let run = ""; let start = 0; let end = -1;
  const scan = () => { if (!search) return; for (let offset = run.indexOf(search); offset >= 0; offset = run.indexOf(search, offset + 1)) matches.push({ from: start + offset, to: start + offset + search.length }); };
  node.descendants((child, offset) => {
    if (!child.isText || child.marks.some((mark) => ["footnoteRef", "insertion", "deletion"].includes(mark.type.name))) { scan(); run = ""; end = -1; return; }
    const from = pos + 1 + offset;
    if (from !== end) { scan(); run = ""; start = from; }
    run += child.text; end = from + child.nodeSize;
  });
  scan();
  if (matches.length !== 1) throw new Error("Search must match exactly one plain-text phrase, outside notes, fields and pending changes.");
  return matches[0];
}

export function commit(context: WordToolContext, transaction: Transaction) {
  if (!permitsWordEdit(context.view.state.doc, transaction.doc, context.metadata.protection)) throw new Error("Word protection or a locked content control blocks this edit.");
  // These are explicit structural edits, not cached field updates. They cannot
  // use wordFieldUpdate to evade a form lock or mandatory tracked-edit policy.
  if (context.metadata.protection.mode === "trackedChanges") throw new Error("This structural operation is a direct edit and cannot run under mandatory tracked-change protection.");
  const before = context.view.state.doc;
  context.view.dispatch(transaction.setMeta("suggestionModeBypass", true));
  if (before === context.view.state.doc) throw new Error("The editor blocked the edit.");
  return { success: true, data: { applied: true, tracked: false } };
}

export function executeWordStructureTool(context: WordToolContext, tool: string, args: Record<string, unknown>) {
  const { view } = context;
  let tr = view.state.tr;
  if (tool === "insert_paragraphs") {
    const inserted = insertWordParagraphs(view.state, context.document, args);
    const result = commit(context, inserted.transaction);
    return { ...result, data: { ...result.data, paragraphIds: inserted.paragraphIds, location: { story: "body", area: inserted.area } } };
  }
  if (tool === "create_bookmark") return commit(context, addBookmark(tr, requiredString(args, "paraId"), requiredString(args, "bookmark"), typeof args.search === "string" ? args.search : undefined));
  if (tool === "insert_cross_reference" || tool === "edit_cross_reference") {
    let bookmark = typeof args.bookmark === "string" ? args.bookmark : "";
    if (typeof args.targetParaId === "string") {
      const target = paragraph(tr.doc, args.targetParaId);
      const search = typeof args.targetSearch === "string" ? args.targetSearch : undefined;
      const range = search ? uniqueTextRange(target.node, target.pos, search) : { from: target.pos + 1, to: target.pos + target.node.nodeSize - 1 };
      const marks = wordBookmarks(tr.doc);
      bookmark = marks.find(mark => (search ? mark.from === range.from && mark.to === range.to : mark.from >= range.from && mark.to <= range.to && mark.text === text(target.node)) && !/^_(Toc|LW_Toc)/i.test(mark.name))?.name ?? `_LW_Ref${Math.max(0, ...wordBookmarkIdentities(tr.doc).map(mark => mark.id)) + 1}`;
      if (!marks.some(mark => mark.name === bookmark)) tr = addBookmark(tr, args.targetParaId, bookmark, search);
    }
    const targets = wordBookmarks(tr.doc).filter(mark => mark.name === bookmark);
    if (targets.length !== 1) throw new Error("Reference target does not exist or is ambiguous. Read the structure and select a bookmark or targetParaId.");
    const target = paragraphs(tr.doc).find(item => targets[0].from >= item.pos && targets[0].from < item.pos + item.node.nodeSize)!;
    if (args.kind === "number" && !target.marker) throw new Error("The target has no automatic paragraph number. Use text or page instead. For a manually typed label, use kind=text and targetSearch.");
    const instruction = referenceInstruction(args.kind, bookmark);
    const item = paragraph(tr.doc, requiredString(args, "paraId"));
    if (/^TOC\d+$/i.test(String(item.node.attrs.styleId))) throw new Error("The contents entry is generated. Edit its target heading and update fields instead.");
    let from = item.pos + item.node.nodeSize - 1; let to = from;
    let marks = view.state.doc.nodeAt(from - 1)?.marks.filter((mark) => !["hyperlink", "insertion", "deletion", "footnoteRef"].includes(mark.type.name)) ?? [];
    if (tool === "edit_cross_reference") {
      const ordinal = args.ordinal; let index = 0; let found: { node: Node; pos: number } | undefined;
      item.node.descendants((node, offset) => { if (node.type.name === "field" && index++ === ordinal) found = { node, pos: item.pos + 1 + offset }; });
      if (!found || !["REF", "PAGEREF"].includes(found.node.attrs.fieldType) || found.node.attrs.fldLock || found.node.marks.some((mark) => ["insertion", "deletion"].includes(mark.type.name))) throw new Error("Reference is missing, locked or part of a pending revision.");
      from = found.pos; to = from + found.node.nodeSize;
      marks = found.node.marks.filter((mark) => mark.type.name !== "hyperlink");
    } else {
      const search = requiredString(args, "search");
      if (search) ({ from, to } = uniqueTextRange(item.node, item.pos, search));
    }
    if (target.paraId === item.paraId) throw new Error("A paragraph reference cannot target its own paragraph.");
    const field = view.state.schema.nodes.field.create({ fieldType: args.kind === "page" ? "PAGEREF" : "REF", instruction, displayText: args.kind === "number" ? target.marker : args.kind === "text" ? targets[0].text : "", fieldKind: "complex", dirty: true }, null, marks);
    tr = tr.replaceWith(from, to, field);
    const result = commit(context, tr);
    return { ...result, data: { ...result.data, bookmark, instruction } };
  }
  if (tool === "fill_content_control") {
    const id = requiredString(args, "controlId");
    const controls: { node: Node; pos: number }[] = [];
    tr.doc.descendants((node, pos) => { if (["sdt", "blockSdt"].includes(node.type.name) && String(node.attrs.id) === id) controls.push({ node, pos }); });
    if (controls.length !== 1) throw new Error("Content control is missing or ambiguous.");
    const control = controls[0];
    if (control.node.attrs.dataBinding || ["contentLocked", "sdtContentLocked"].includes(control.node.attrs.lock)) throw new Error("Content control is bound or content-locked.");
    if (![null, undefined, "text", "plainText", "richText"].includes(control.node.attrs.sdtType)) throw new Error("Only text controls can be filled with this tool.");
    let structured = false;
    control.node.descendants((node) => { if (node.isLeaf && !node.isText || ["sdt", "blockSdt", "table"].includes(node.type.name) || node.marks.some((mark) => ["insertion", "deletion", "footnoteRef"].includes(mark.type.name))) structured = true; });
    if (structured) throw new Error("This control has structured content. Edit individual paragraphs instead.");
    const value = requiredString(args, "text");
    const template = control.node.isInline ? control.node : control.node.firstChild;
    if (!template || !template.isTextblock && !control.node.isInline || control.node.textContent !== text(control.node) || control.node.content.content.some((child) => !child.isText && control.node.isInline)) throw new Error("This control has structured content. Edit individual paragraphs instead.");
    const marks = template.firstChild?.marks ?? [];
    const content = control.node.isInline ? Fragment.from(value ? view.state.schema.text(value, marks) : null) : Fragment.fromArray(value.split("\n").map((line) => view.state.schema.nodes.paragraph.create({ ...template.attrs, paraId: null }, line ? view.state.schema.text(line, marks) : undefined)));
    return commit(context, tr.replaceWith(control.pos + 1, control.pos + control.node.nodeSize - 1, content));
  }
  if (tool === "edit_note" || tool === "insert_note") {
    if (context.metadata.protection.mode !== "none") throw new Error("Note editing is a direct edit and is blocked by Word protection.");
    const type = args.noteType;
    if (type !== "footnote" && type !== "endnote") throw new Error("noteType must be footnote or endnote.");
    let document = fromProseDoc(view.state.doc, context.document);
    const notes = type === "footnote" ? document.package.footnotes ?? [] : document.package.endnotes ?? [];
    if (tool === "edit_note") {
      const note = notes.find((candidate) => candidate.id === args.noteId);
      if (!note || note.verbatimXml) throw new Error("Note is missing or contains unsupported XML; it cannot be edited safely.");
      const doc = footnoteToProseDoc(note.content);
      const matches = paragraphs(doc).filter((item) => text(item.node).includes(requiredString(args, "search")));
      if (matches.length !== 1) throw new Error("Search must identify one note paragraph.");
      const match = uniqueTextRange(matches[0].node, matches[0].pos, requiredString(args, "search"));
      const state = EditorState.create({ doc }); const value = requiredString(args, "replaceWith");
      const updated = state.tr.replaceWith(match.from, match.to, value ? view.state.schema.text(value, doc.nodeAt(match.from)?.marks) : Fragment.empty).doc;
      if (!permitsWordEdit(doc, updated, context.metadata.protection)) throw new Error("A locked control blocks this note edit.");
      const content = proseDocToBlocks(updated);
      document = { ...document, package: { ...document.package, [type === "footnote" ? "footnotes" : "endnotes"]: notes.map((candidate) => candidate.id === note.id ? { ...candidate, content } : candidate) } };
    } else {
      const item = paragraph(view.state.doc, requiredString(args, "paraId"));
      const search = requiredString(args, "search");
      const position = search ? uniqueTextRange(item.node, item.pos, search).to : item.pos + item.node.nodeSize - 1;
      const id = Math.max(0, ...notes.map((note) => note.id)) + 1;
      const mark = view.state.schema.marks.footnoteRef.create({ id: String(id), noteType: type });
      tr = tr.insert(position, view.state.schema.text(String(id), [mark]));
      if (!permitsWordEdit(view.state.doc, tr.doc, context.metadata.protection)) throw new Error("A locked control blocks this note insertion.");
      const content = [{ type: "paragraph", formatting: { styleId: type === "footnote" ? "FootnoteText" : "EndnoteText" }, content: [{ type: "run", content: [{ type: type === "footnote" ? "footnoteRefMark" : "endnoteRefMark" }, { type: "text", text: ` ${requiredString(args, "text")}` }] }] }] satisfies Document["package"]["document"]["content"];
      // The React adapter saves body content from its live PM view. Commit the
      // marker there before loading note metadata, or its save can overwrite
      // the new model body with the previous view and orphan the note.
      const before = view.state.doc;
      view.dispatch(tr.setMeta("suggestionModeBypass", true));
      if (before === view.state.doc) throw new Error("The editor blocked the note marker insertion.");
      document = fromProseDoc(view.state.doc, document);
      document = { ...document, package: { ...document.package, [type === "footnote" ? "footnotes" : "endnotes"]: [...notes, { type, id, content }] } };
    }
    context.loadDocument(document);
    return { success: true, data: { applied: true, tracked: false } };
  }
  throw new Error(`Unknown Word structure tool: ${tool}`);
}
