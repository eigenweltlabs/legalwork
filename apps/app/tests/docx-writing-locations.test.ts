import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { EditorState } from "prosemirror-state";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { parseDocx } from "@eigenpal/docx-editor-core/docx";
import { schema, ensureParaIdsInState } from "@eigenpal/docx-editor-core/prosemirror";
import { toProseDoc, fromProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { readWordDocument } from "../src/react-app/domains/session/artifacts/docx-agent-read";
import { emptyWordMetadata } from "../src/react-app/domains/session/artifacts/docx-word-package";
import { wordParagraphTarget, wordWritingLocations } from "../src/react-app/domains/session/artifacts/docx-agent-locations";
import { insertWordParagraphs } from "../src/react-app/domains/session/artifacts/docx-insert-paragraphs";
import { docxSuggestSchema, parseDocxEdit } from "@legalwork/types/office-editor";
import { writingTemplate } from "../scripts/fixtures/writing-template";
import { executeWordBatch } from "../src/react-app/domains/session/artifacts/docx-agent-batch";
import { executeWordStructureTool } from "../src/react-app/domains/session/artifacts/docx-agent-structure";

const p = (paraId: string, text: string) => schema.node("paragraph", { paraId }, text ? schema.text(text) : undefined);
async function fixture() {
  const original = new Uint8Array(await readFile(new URL("../scripts/fixtures/legal-word-workflows.docx", import.meta.url))).buffer;
  return { original, document: await parseDocx(original) };
}
function mixed() {
  const cell = schema.node("tableCell", null, [p("CELL1", "First cell paragraph"), p("CELL2", "Second cell paragraph")]);
  const table = schema.node("table", null, [schema.node("tableRow", null, [cell])]);
  const box = schema.node("textBox", { textBoxId: "bottom-box", displayMode: "float", position: { vertical: { relativeTo: "page", posOffset: 9000000 } } }, [p("BOX1", "Bottom box text"), p("BOX2", "")]);
  const control = schema.node("blockSdt", { id: "control-1", tag: "Client", sdtType: "text" }, [p("CONTROL", "Client value")]);
  return schema.node("doc", null, [box, table, control, p("BODY", "Ordinary body text")]);
}

test("text, structure and focused reads address the same nested paragraphs", async () => {
  const { document } = await fixture(); const doc = mixed();
  for (const item of wordWritingLocations(doc)) {
    const read = readWordDocument(doc, document, null, emptyWordMetadata(), { paraId: item.paraId });
    expect(read.structure?.paragraphs.map(paragraph => paragraph.paraId)).toEqual([item.paraId]);
    expect(read.text).toContain(`[${item.paraId}]`);
    expect(read.text).toEndWith(item.text);
    expect(read.text).not.toContain(`[${item.paraId === "BODY" ? "BOX1" : "BODY"}]`);
  }
  const all = readWordDocument(doc, document, null, emptyWordMetadata(), {});
  expect(all.text).toContain("[CELL2] (body; table;");
  expect(all.text).not.toContain("[1]");
  const page = readWordDocument(doc, document, null, emptyWordMetadata(), { fromIndex: 2, limit: 2 });
  expect(page.structure?.paragraphs.map(paragraph => paragraph.paraId)).toEqual(["CELL1", "CELL2"]);
  expect(page.text).toContain("[CELL1]"); expect(page.text).toContain("[CELL2]"); expect(page.text).not.toContain("[BODY]");
});

test("location map distinguishes main flow, table cells, positioned boxes, controls and separate stories", async () => {
  const { document } = await fixture(); const doc = mixed();
  const read = readWordDocument(doc, document, null, emptyWordMetadata(), { view: "layout" });
  expect(wordWritingLocations(doc).map(item => item.location.area)).toEqual(["textBox", "textBox", "table", "table", "contentControl", "main"]);
  expect(wordParagraphTarget(doc, "CELL2", "table").location.containers.at(-1)).toMatchObject({ row: 1, column: 1 });
  expect(read.layout?.areas.find(area => area.id === "body/main")).toMatchObject({ paragraphIds: ["BODY"] });
  expect(read.layout?.areas.some(area => area.story === "header")).toBe(true);
  expect(read.layout?.areas.some(area => area.story === "footer")).toBe(true);
  expect(read.layout?.areas.some(area => area.story === "footnote")).toBe(true);
});

test("a body edit cannot silently target a table, box or control", () => {
  const doc = mixed();
  for (const id of ["BOX1", "CELL1", "CONTROL"]) expect(() => wordParagraphTarget(doc, id)).toThrow("explicitly supply area=");
  expect(wordParagraphTarget(doc, "BODY").location.area).toBe("main");
  expect(wordParagraphTarget(doc, "BOX1", "textBox").paraId).toBe("BOX1");
  expect(() => wordParagraphTarget(doc, "footnote:1")).toThrow("missing or ambiguous");
  const duplicates = schema.node("doc", null, [p("DUP", "First"), p("DUP", "Second")]);
  expect(() => wordParagraphTarget(duplicates, "DUP")).toThrow("missing or ambiguous");
});

test("new letter paragraphs go into the main flow without modifying nested containers or notes", async () => {
  const { document, original } = await fixture();
  const before = mixed(); const state = EditorState.create({ doc: before });
  const noteBefore = JSON.stringify(document.package.footnotes);
  const inserted = insertWordParagraphs(state, document, { placement: "end", paragraphs: [{ text: "Date", alignment: "left" }, { text: "Salutation" }, { text: "Letter body" }, { text: "Closing" }] });
  const after = state.apply(inserted.transaction).doc;
  for (const id of ["BOX1", "BOX2", "CELL1", "CELL2", "CONTROL"]) expect(wordParagraphTarget(after, id, wordWritingLocations(before).find(item => item.paraId === id)!.location.area).node.eq(wordWritingLocations(before).find(item => item.paraId === id)!.node)).toBe(true);
  expect(after.childCount).toBe(before.childCount + 4);
  expect(wordWritingLocations(after).slice(-4).map(item => item.location.area)).toEqual(["main", "main", "main", "main"]);
  const converted = fromProseDoc(after, document);
  expect(JSON.stringify(converted.package.footnotes)).toBe(noteBefore);
  const zip = await JSZip.loadAsync(await new DocxReviewer(converted, "Test", original).toBuffer());
  const body = await zip.file("word/document.xml")!.async("string");
  expect(body).toContain("Letter body");
  expect(await zip.file("word/footnotes.xml")!.async("string")).not.toContain("Letter body");
  expect(await zip.file("word/footer1.xml")!.async("string")).not.toContain("Letter body");
});

test("empty template filling creates paragraphs and preserves the section boundary", async () => {
  const { document } = await fixture();
  const empty = schema.node("paragraph", { paraId: "EMPTY", sectionBreakType: "nextPage", _sectionProperties: { type: "nextPage" } });
  const state = EditorState.create({ doc: schema.node("doc", null, [empty]) });
  const result = insertWordParagraphs(state, document, { placement: "replace_empty", paraId: "EMPTY", paragraphs: [{ text: "First" }, { text: "Second\nAddress line" }] });
  const after = state.apply(result.transaction).doc;
  expect(after.childCount).toBe(2); expect(after.firstChild!.attrs.paraId).toBe("EMPTY");
  expect(after.firstChild!.attrs.sectionBreakType).toBeNull(); expect(after.lastChild!.attrs.sectionBreakType).toBe("nextPage");
  expect(after.lastChild!.childCount).toBe(3); expect(after.lastChild!.child(1).type.name).toBe("hardBreak");
  expect(new Set(result.paragraphIds).size).toBe(2);
  expect(result.paragraphIds[1]).toMatch(/^[0-7][0-9A-F]{7}$/);
});

test("paragraph insertion validates destination and existing text before changing anything", async () => {
  const { document } = await fixture(); const state = EditorState.create({ doc: mixed() });
  for (const args of [
    { placement: "end", area: "textBox" }, { placement: "start", paraId: "BODY" },
    { placement: "after", paraId: "BOX1" }, { placement: "replace_empty", paraId: "BODY" },
    { placement: "after", paraId: "BODY", paragraphs: [{ text: "X", styleId: "DoesNotExist" }] },
  ]) expect(() => insertWordParagraphs(state, document, { paragraphs: [{ text: "Letter" }], ...args })).toThrow();
  const inside = insertWordParagraphs(state, document, { placement: "after", area: "textBox", paraId: "BOX1", paragraphs: [{ text: "Requested box text" }] });
  expect(wordWritingLocations(state.apply(inside.transaction).doc).find(item => item.text === "Requested box text")?.location.area).toBe("textBox");
});

test("tracked text proposals require a document identity and explicit nested area", () => {
  expect(docxSuggestSchema.safeParse({ paraId: "BODY", search: "", replaceWith: "Letter" }).success).toBe(false);
  expect(docxSuggestSchema.parse({ documentId: "draft", draftRevision: 2, paraId: "BODY", search: "", replaceWith: "Letter" }).area).toBe("main");
  expect(parseDocxEdit({ documentId: "draft", draftRevision: 2, operations: [{ operation: "insert_paragraphs", placement: "end", paragraphs: [{ text: "Letter" }] }] }).operations?.length).toBe(1);
  const allocated = ensureParaIdsInState(EditorState.create({ doc: schema.node("doc", null, [schema.node("paragraph"), schema.node("paragraph")]) }));
  for (const item of wordWritingLocations(allocated.doc)) expect(wordParagraphTarget(allocated.doc, item.paraId).editable).toBe(true);
});

test("native text boxes remain writable text after body insertion, export, reopen and an explicit box edit", async () => {
  const original = await writingTemplate();
  let document = await parseDocx(original);
  let state = ensureParaIdsInState(EditorState.create({ doc: toProseDoc(document) }));
  const view = { get state() { return state; }, dispatch(transaction: Parameters<typeof state.apply>[0]) { state = state.applyTransaction(transaction).state; } };
  const context = { view, get document() { return document; }, layout: null, metadata: emptyWordMetadata(), loadDocument() { throw new Error("Not needed"); } };
  const main = wordWritingLocations(state.doc).find(item => item.location.area === "main" && !item.text)!;
  let saves = 0;
  const batch = await executeWordBatch({ documentId: "draft", draftRevision: 0, operations: [{ operation: "insert_paragraphs", placement: "replace_empty", paraId: main.paraId, paragraphs: [{ text: "Main letter" }, { text: "Main closing" }] }] }, async (tool, args) => {
    if (tool === "save_document") { saves++; return { success: true, saved: true }; }
    return executeWordStructureTool(context, tool, args);
  });
  expect(batch.success).toBe(true); expect(saves).toBe(1);
  let buffer = await new DocxReviewer(fromProseDoc(state.doc, document), "Test", original).toBuffer();
  let xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
  expect(xml).toContain("w:txbxContent"); expect(xml).toContain("Reserved bottom box"); expect(xml).toContain("Main letter");
  document = await parseDocx(buffer); state = ensureParaIdsInState(EditorState.create({ doc: toProseDoc(document) }));
  let locations = wordWritingLocations(state.doc);
  expect(locations.filter(item => item.location.area === "textBox").map(item => item.text)).toEqual(["Reserved bottom box", ""]);
  const box = locations.find(item => item.location.area === "textBox" && !item.text)!;
  executeWordStructureTool(context, "insert_paragraphs", { placement: "replace_empty", paraId: box.paraId, area: "textBox", paragraphs: [{ text: "Requested box text" }] });
  buffer = await new DocxReviewer(fromProseDoc(state.doc, document), "Test", buffer).toBuffer();
  document = await parseDocx(buffer); locations = wordWritingLocations(toProseDoc(document));
  expect(locations.find(item => item.text === "Requested box text")?.location.area).toBe("textBox");
  expect(locations.find(item => item.text === "Main letter")?.location.area).toBe("main");
  expect(locations.find(item => item.text === "Main closing")?.location.area).toBe("main");
});


test("new paragraphs inherit native template fonts and export the same run properties", async () => {
  const input = await writingTemplate(); const document = await parseDocx(input);
  const state = EditorState.create({ doc: toProseDoc(document, { styles: document.package.styles }) });
  const inserted = insertWordParagraphs(state, document, { placement: "start", paragraphs: [{ text: "A new letter" }] });
  const doc = state.apply(inserted.transaction).doc;
  expect(doc.firstChild?.firstChild?.marks.find(mark => mark.type.name === "fontSize")?.attrs.size).toBe(22);
  expect(doc.firstChild?.firstChild?.marks.find(mark => mark.type.name === "fontFamily")?.attrs.ascii).toBe("Arial");
  const output = await new DocxReviewer(fromProseDoc(doc, document), "QA", input).toBuffer();
  const zip = await JSZip.loadAsync(output); const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain('<w:sz w:val="22"/>');
  const reopened = toProseDoc(await parseDocx(output), { styles: document.package.styles });
  expect(reopened.firstChild?.attrs.spaceAfter).toBe(doc.firstChild?.attrs.spaceAfter);
});

test("manual line breaks in newly composed justified paragraphs default to left alignment", async () => {
  const document = await parseDocx(await writingTemplate());
  const target = schema.node("paragraph", { paraId: "EMPTY", alignment: "both" });
  const state = EditorState.create({ doc: schema.node("doc", null, [target]) });
  const inserted = insertWordParagraphs(state, document, { placement: "replace_empty", paraId: "EMPTY", paragraphs: [{ text: "Recipient\nStreet\nCity" }, { text: "Explicit\njustification", alignment: "both" }] });
  const doc = state.apply(inserted.transaction).doc;
  expect(doc.firstChild?.attrs.alignment).toBe("left");
  expect(doc.lastChild?.attrs.alignment).toBe("both");
  const read = readWordDocument(doc, document, null, emptyWordMetadata(), {view: "text"});
  expect(read.formattingWarnings).toHaveLength(1);
  expect(read.formattingWarnings[0].paraId).toBe(doc.lastChild?.attrs.paraId);
});
