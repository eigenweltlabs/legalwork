import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { EditorState } from "prosemirror-state";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { parseDocx } from "@eigenpal/docx-editor-core/docx";
import { schema } from "@eigenpal/docx-editor-core/prosemirror";
import { fromProseDoc, toProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { executeWordStructureTool, readWordStructure, type WordToolContext } from "../src/react-app/domains/session/artifacts/docx-agent-structure";
import { createWordProtectionPlugin } from "../src/react-app/domains/session/artifacts/docx-protection";
import { finalizeWordPackage, readWordMetadata, emptyWordMetadata } from "../src/react-app/domains/session/artifacts/docx-word-package";
import { resolveWordFields, wordParagraphs } from "../src/react-app/domains/session/artifacts/docx-fields";
import { applyWordFormatting, preserveWordFormatting, readWordFormatting } from "../src/react-app/domains/session/artifacts/docx-agent-formatting";

async function contract(formatting = false) {
  const original = new Uint8Array(await readFile(new URL("../scripts/fixtures/legal-word-workflows.docx", import.meta.url))).buffer;
  let document = await parseDocx(original);
  const metadata = await readWordMetadata(original);
  let doc = toProseDoc(document, formatting ? { styles: document.package.styles } : undefined);
  if (formatting) {
    let state = EditorState.create({ doc }); let tr = state.tr; let index = 0;
    doc.descendants((node, pos) => { if (node.type.name === "paragraph") tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, paraId: `F${String(index++).padStart(7, "0")}` }); });
    doc = tr.doc;
  }
  let state = EditorState.create({ doc, plugins: [createWordProtectionPlugin(() => metadata.protection, () => {})] });
  const context: WordToolContext = { view: { get state() { return state; }, dispatch(tr) { state = state.applyTransaction(tr).state; } }, get document() { return document; }, metadata, layout: null, loadDocument(next) { document = next; state = EditorState.create({ doc: toProseDoc(document) }); } };
  return { context, read: () => readWordStructure(state.doc, document, null, metadata), save: async () => finalizeWordPackage(await preserveWordFormatting(await new DocxReviewer(fromProseDoc(state.doc, document), "LegalWork AI", original).toBuffer(), state.doc, document), metadata) };
}

test("agent reads native reference targets, numbered headings, controls, notes and sections", async () => {
  const { read } = await contract(); const snapshot = read();
  const field = snapshot.fields.find((field) => field.target === "Rueckbau" && field.type === "REF")!;
  assert.equal(field.type, "REF"); assert.equal(field.status, "linked"); assert.equal(field.resolvedText, "8"); assert.match(field.instruction, /REF Rueckbau/);
  assert.equal(snapshot.bookmarks.find((mark) => mark.name === "Rueckbau")?.number, "8");
  assert.equal(snapshot.notes.length, 2); assert.equal(snapshot.notes[0].references.length, 1);
  assert.ok(snapshot.controls.some((control) => control.text === "Windpark Nordfeld" && control.editable)); assert.equal(snapshot.sections.length, 4);
  assert.ok(snapshot.headings.some((heading) => heading.number === "8"));
});

test("agent creates a native bookmark and reference, retargets it and saves/reopens without flattening", async () => {
  const { context, read, save } = await contract();
  const snapshot = read(); const source = snapshot.fields.find((field) => field.type === "REF")!;
  const target = snapshot.bookmarks.find((mark) => mark.name === "Rueckbau")!;
  executeWordStructureTool(context, "create_bookmark", { paraId: target.paraId, bookmark: "AgentTarget" });
  executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, bookmark: "AgentTarget", kind: "number", search: "" });
  const field = read().fields.find((field) => field.target === "AgentTarget")!;
  assert.equal(field.resolvedText, "8"); assert.match(field.instruction, /\\w.*\\h/);
  executeWordStructureTool(context, "edit_cross_reference", { paraId: field.paraId, ordinal: field.ordinal, bookmark: "Verguetung", kind: "number" });
  const saved = await save(); const reopened = await parseDocx(saved);
  const after = readWordStructure(toProseDoc(reopened), reopened, null, await readWordMetadata(saved));
  assert.ok(after.bookmarks.some((mark) => mark.name === "AgentTarget"));
  assert.equal(after.fields.filter((field) => field.target === "Verguetung" && field.type === "REF").length, snapshot.fields.filter((field) => field.target === "Verguetung" && field.type === "REF").length + 1);
  assert.ok(after.fields.some((field) => field.instruction === "REF Verguetung \\w \\h"));
  const xml = await (await JSZip.loadAsync(saved)).file("word/document.xml")!.async("string");
  assert.match(xml, /REF Verguetung \\w \\h/);
});

test("short reference targets use native ranges and follow edits through save/reopen", async () => {
  const { context, read, save } = await contract(true);
  const snapshot = read(); const source = snapshot.fields.find(field => field.type === "REF")!;
  const target = snapshot.headings.find(heading => heading.number === "8")!;
  const label = target.text.slice(0, 8);
  executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, targetParaId: target.paraId, targetSearch: label, kind: "text", search: "" });
  const reference = read().fields.find(field => field.target?.startsWith("_LW_Ref"))!;
  assert.equal(reference.resolvedText, label);
  const mark = read().bookmarks.find(mark => mark.name === reference.target)!;
  assert.equal(mark.scope, "range"); assert.equal(mark.text, label);
  const paragraph = wordParagraphs(context.view.state.doc).find(item => item.node.attrs.paraId === target.paraId)!;
  let start = 0;
  paragraph.node.descendants((node, offset) => { if (node.type.name === "bookmarkStart" && node.attrs.name === mark.name) start = paragraph.pos + offset + 2; });
  context.view.dispatch(context.view.state.tr.insertText(" updated", start + label.length));
  assert.equal(read().bookmarks.find(mark => mark.name === reference.target)?.text, label + " updated");
  const saved = await save(); const reopened = await parseDocx(saved);
  const after = readWordStructure(toProseDoc(reopened), reopened, null, await readWordMetadata(saved));
  assert.equal(after.bookmarks.find(mark => mark.name === reference.target)?.text, label + " updated");
  assert.equal(after.fields.find(field => field.target === reference.target)?.resolvedText, label + " updated");
});

test("imported bookmarks spanning paragraphs retain native boundaries and formatting", async () => {
  const { context, read, save } = await contract();
  const first = schema.nodes.paragraph.create({ paraId: "CROSS1" }, [schema.nodes.bookmarkStart.create({ id: 97, name: "Across" }), schema.text("alpha", [schema.marks.bold.create()])]);
  const second = schema.nodes.paragraph.create({ paraId: "CROSS2" }, [schema.text("beta"), schema.nodes.bookmarkEnd.create({ id: 97 })]);
  const third = schema.nodes.paragraph.create({ paraId: "CROSS3" }, [schema.nodes.bookmarkStart.create({ id: 105, name: "Orphan" }), schema.text("source")]);
  context.view.dispatch(context.view.state.tr.replaceWith(0, context.view.state.doc.content.size, [first, second, third]));
  assert.equal(read().bookmarks.find(mark => mark.name === "Across")?.text, "alpha\nbeta");
  assert.throws(() => executeWordStructureTool(context, "create_bookmark", { paraId: "CROSS3", bookmark: "Orphan" }), /already exists/);
  executeWordStructureTool(context, "create_bookmark", { paraId: "CROSS3", bookmark: "Safe" });
  assert.ok(read().bookmarks.find(mark => mark.name === "Safe")!.id > 105);
  const saved = await save(); const reopened = await parseDocx(saved); const doc = toProseDoc(reopened);
  const after = readWordStructure(doc, reopened, null, await readWordMetadata(saved));
  assert.equal(after.bookmarks.find(mark => mark.name === "Across")?.text, "alpha\nbeta");
  assert.ok(doc.firstChild?.lastChild?.marks.some(mark => mark.type.name === "bold"));
});

test("agent-created reference renumbers with its target and broken targets are visible", async () => {
  const { context, read } = await contract(); const snapshot = read(); const source = snapshot.fields.find((field) => field.type === "REF")!;
  executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, targetParaId: snapshot.headings.find((heading) => heading.number === "8")!.paraId, kind: "number", search: "" });
  const target = wordParagraphs(context.view.state.doc).find((item) => item.bookmark === "Rueckbau")!;
  const clause = schema.nodes.paragraph.create({ ...target.node.attrs, paraId: "NEWCLAUSE", bookmarks: null }, schema.text("New main clause"));
  context.view.dispatch(context.view.state.tr.insert(target.pos, clause));
  const values = resolveWordFields(context.view.state.doc, null, context.metadata);
  assert.ok([...values.values()].includes("9"));
  const missing = schema.nodes.doc.create(null, schema.nodes.paragraph.create({ paraId: "P1" }, schema.nodes.field.create({ fieldType: "REF", instruction: "REF Missing \\h", displayText: "8" })));
  assert.equal(readWordStructure(missing, context.document, null, context.metadata).fields[0].status, "missing_target");
});

test("reference tools reject ambiguous matches, missing targets and pending revisions atomically", async () => {
  const { context, read } = await contract(); const snapshot = read(); const source = snapshot.fields.find((field) => field.type === "REF")!; const before = context.view.state.doc;
  assert.throws(() => executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, bookmark: "Missing", kind: "number", search: "" }), /target/);
  assert.throws(() => executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, bookmark: "Rueckbau", kind: "number", search: "not present" }), /plain-text/);
  assert.throws(() => executeWordStructureTool(context, "create_bookmark", { paraId: source.paraId, bookmark: "rueckbau" }), /already exists/);
  assert.equal(context.view.state.doc, before);
});

test("agent fills native inline controls under forms protection and preserves locks", async () => {
  const { context, read, save } = await contract(); const control = read().controls.find((control) => control.text === "Windpark Nordfeld")!;
  assert.ok(control); context.metadata.protection = { mode: "forms", password: false };
  executeWordStructureTool(context, "fill_content_control", { controlId: control.id, text: "Agent Demo Projekt" });
  assert.equal(read().controls.find((item) => item.id === control.id)?.text, "Agent Demo Projekt");
  const saved = await save(); const reopened = await parseDocx(saved);
  assert.ok(readWordStructure(toProseDoc(reopened), reopened, null, await readWordMetadata(saved)).controls.some((control) => control.text === "Agent Demo Projekt"));
  const before = context.view.state.doc;
  assert.throws(() => executeWordStructureTool(context, "create_bookmark", { paraId: read().fields[0].paraId, bookmark: "Blocked" }), /protection/);
  assert.equal(context.view.state.doc, before);
});

test("agent edits a footnote and creates native linked notes without changing existing ids", async () => {
  const { context, read, save } = await contract(); const originalNotes = read().notes.map((note) => note.id);
  executeWordStructureTool(context, "edit_note", { noteType: "footnote", noteId: 1, search: "Musterwerte", replaceWith: "geprüfte Demowerte" });
  assert.match(read().notes[0].text, /geprüfte Demowerte/);
  const source = read().fields.find((field) => field.type === "REF")!;
  executeWordStructureTool(context, "insert_cross_reference", { paraId: source.paraId, bookmark: "Verguetung", kind: "number", search: "" });
  executeWordStructureTool(context, "insert_note", { noteType: "footnote", paraId: source.paraId, search: "", text: "Agent-created native footnote" });
  executeWordStructureTool(context, "insert_note", { noteType: "endnote", paraId: read().fields.find((field) => field.type === "REF")!.paraId, search: "", text: "Agent-created native endnote" });
  const saved = await save(); const reopened = await parseDocx(saved); const after = readWordStructure(toProseDoc(reopened), reopened, null, emptyWordMetadata());
  assert.deepEqual(after.notes.filter((note) => note.type === "footnote").slice(0, 2).map((note) => note.id), originalNotes);
  assert.equal(after.notes.filter((note) => note.type === "footnote").length, 3);
  assert.equal(after.notes.find((note) => note.type === "footnote" && note.id === 3)?.references.length, 1);
  assert.ok(after.notes.find((note) => note.type === "endnote")?.references.length);
  const zip = await JSZip.loadAsync(saved);
  assert.match(await zip.file("word/footnotes.xml")!.async("string"), /footnoteRef/);
  assert.match(await zip.file("word/endnotes.xml")!.async("string"), /endnoteRef/);
  assert.match(await zip.file("word/document.xml")!.async("string"), /endnoteReference/);
});

test("mandatory tracked-change protection blocks direct structural mutations", async () => {
  const { context, read } = await contract(); context.metadata.protection = { mode: "trackedChanges", password: false };
  const before = context.view.state.doc;
  assert.throws(() => executeWordStructureTool(context, "insert_cross_reference", { paraId: read().fields.find((field) => field.type === "REF")!.paraId, bookmark: "Rueckbau", kind: "number", search: "" }), /tracked-change/);
  assert.throws(() => executeWordStructureTool(context, "edit_note", { noteType: "footnote", noteId: 1, search: "Musterwerte", replaceWith: "Other" }), /protection/);
  assert.equal(context.view.state.doc, before);
});

test("note insertion commits its live marker before the adapter loads note metadata", async () => {
  const { context, read, save } = await contract(); const load = context.loadDocument;
  let markerSeen = false;
  context.loadDocument = (document) => {
    context.view.state.doc.descendants((node) => { if (node.marks.some((mark) => mark.type.name === "footnoteRef" && String(mark.attrs.id) === "3")) markerSeen = true; });
    assert.ok(markerSeen, "The React save path would otherwise overwrite the marker with the old live body");
    load(document);
  };
  executeWordStructureTool(context, "insert_note", { noteType: "footnote", paraId: read().fields.find((field) => field.type === "REF")!.paraId, search: "", text: "Native note regression" });
  const saved = await save(); const reopened = await parseDocx(saved);
  assert.equal(readWordStructure(toProseDoc(reopened), reopened, null, emptyWordMetadata()).notes.find((note) => note.id === 3)?.references.length, 1);
});

test("fields in header and note stories resolve their body targets for the agent", async () => {
  const { context } = await contract();
  const story = schema.nodes.doc.create(null, schema.nodes.paragraph.create({ paraId: "HF1" }, schema.nodes.field.create({ fieldType: "REF", instruction: "REF Rueckbau \\w \\h", displayText: "8" })));
  const structure = readWordStructure(story, context.document, null, context.metadata, "header:1", context.view.state.doc, false);
  assert.equal(structure.fields[0].status, "linked"); assert.equal(structure.fields[0].resolvedText, "8");
  assert.match(structure.fields[0].id, /^header:1:/);
});

test("agent sees resolved formatting, character marks, paragraph handles and style inheritance without dumping the whole contract", async () => {
  const { context, read } = await contract(true);
  const title = read().paragraphs.find((item) => item.styleId === "Title")!;
  const snapshot = readWordFormatting(context.view.state.doc, context.document, { paraId: title.paraId, includeStyles: true });
  assert.equal(snapshot.paragraphs.length, 1); assert.equal(snapshot.paragraphs[0].runs[0].formatting.bold, true);
  assert.equal(snapshot.paragraphs[0].runs[0].formatting.fontSize, 21);
  assert.ok(snapshot.styleDefinitions?.styles.find((style) => style.styleId === "Title")?.rPr?.bold);
  const page = readWordFormatting(context.view.state.doc, context.document, { limit: 2 });
  assert.equal(page.paragraphs.length, 2); assert.equal(page.nextIndex, 2); assert.equal(page.styleDefinitions, undefined);
});

test("agent formatting survives native DOCX save/reopen, including removal of inherited bold and paragraph spacing/keep flags", async () => {
  const { context, read, save } = await contract(true);
  const title = read().paragraphs.find((item) => item.styleId === "Title")!;
  const beforeText = context.view.state.doc.textContent; const beforeReferences = read().fields.filter((field) => field.type === "REF").map((field) => field.instruction);
  const result = applyWordFormatting(context, { paraId: title.paraId, marks: { bold: false, italic: true, fontSize: 18, fontFamily: { ascii: "Times New Roman" }, color: { rgb: "223344" }, highlight: "yellow" }, paragraph: { alignment: "center", spaceBefore: 0, spaceAfter: 12, lineSpacing: 1.5, lineSpacingRule: "auto", indentLeft: 24, keepNext: false, keepLines: true } });
  assert.equal(result.success, true); assert.equal(context.view.state.doc.textContent, beforeText);
  const saved = await save(); const model = await parseDocx(saved); const doc = toProseDoc(model, { styles: model.package.styles });
  const reopenedTitle = readWordStructure(doc, model, null, context.metadata).paragraphs.find((item) => item.styleId === "Title")!;
  const actual = readWordFormatting(doc, model, { paraId: reopenedTitle.paraId }).paragraphs[0];
  assert.equal(actual.styleId, "Title"); assert.equal(actual.runs[0].formatting.bold, false); assert.equal(actual.runs[0].formatting.italic, true); assert.equal(actual.runs[0].formatting.fontSize, 18);
  assert.equal(actual.formatting.alignment, "center"); assert.equal(actual.formatting.spaceBefore, 0); assert.equal(actual.formatting.spaceAfter, 12); assert.equal(actual.formatting.lineSpacing, 1.5); assert.equal(actual.formatting.indentLeft, 24); assert.equal(actual.formatting.keepNext, false); assert.equal(actual.formatting.keepLines, true);
  assert.deepEqual(readWordStructure(doc, model, null, context.metadata).fields.filter((field) => field.type === "REF").map((field) => field.instruction), beforeReferences);
  const xml = await (await JSZip.loadAsync(saved)).file("word/document.xml")!.async("string");
  assert.match(xml, /<w:b w:val="0"\s*\/>/); assert.match(xml, /w:after="240"/); assert.match(xml, /w:line="360"/);
});

test("phrase formatting preserves adjacent text, comments and native references; no-op formatting is idempotent", async () => {
  const { context, read, save } = await contract(true); const title = read().paragraphs.find((item) => item.styleId === "Title")!;
  applyWordFormatting(context, { paraId: title.paraId, search: "Windenergieanlage", marks: { underline: { style: "double" }, smallCaps: true, bold: false } });
  const snapshot = readWordFormatting(context.view.state.doc, context.document, { paraId: title.paraId }).paragraphs[0];
  assert.equal(snapshot.runs[0].formatting.bold, true);
  assert.equal(snapshot.runs.at(-1)?.formatting.bold, false); assert.equal(snapshot.runs.at(-1)?.formatting.smallCaps, true);
  const before = context.view.state.doc;
  assert.deepEqual(applyWordFormatting(context, { paraId: title.paraId, search: "Windenergieanlage", marks: { bold: false } }).data, { applied: false, tracked: false });
  assert.equal(context.view.state.doc, before);
  const model = await parseDocx(await save()); const doc = toProseDoc(model, { styles: model.package.styles });
  const reopenedTitle = readWordStructure(doc, model, null, context.metadata).paragraphs.find((item) => item.styleId === "Title")!;
  const after = readWordFormatting(doc, model, { paraId: reopenedTitle.paraId }).paragraphs[0];
  assert.equal(after.runs[0].formatting.bold, true); assert.equal(after.runs.at(-1)?.formatting.bold, false); assert.ok(model.package.document.comments?.length);
});

test("persisting negative style overrides preserves SDK-injected reply anchors and existing review markup", async () => {
  const { context, read } = await contract(true); const title = read().paragraphs.find((item) => item.styleId === "Title")!;
  applyWordFormatting(context, { paraId: title.paraId, marks: { bold: false } });
  const original = new Uint8Array(await readFile(new URL("../scripts/fixtures/legal-word-workflows.docx", import.meta.url))).buffer;
  const reviewer = new DocxReviewer(fromProseDoc(context.view.state.doc, context.document), "Agent QA", original);
  reviewer.replyTo(0, "Formatting must preserve this reply.");
  const native = await reviewer.toBuffer();
  const saved = await preserveWordFormatting(native, context.view.state.doc, context.document);
  const reopened = await DocxReviewer.fromBuffer(saved);
  assert.match(JSON.stringify(reopened.getComments()), /Formatting must preserve this reply/);
  assert.equal(reopened.getChanges().length, reviewer.getChanges().length);
  const beforeXml = await (await JSZip.loadAsync(native)).file("word/document.xml")!.async("string");
  const afterXml = await (await JSZip.loadAsync(saved)).file("word/document.xml")!.async("string");
  const anchors = (xml: string) => Array.from(xml.matchAll(/<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*w:id="(\d+)"/g), (match) => match[0]);
  assert.deepEqual(anchors(afterXml), anchors(beforeXml));
});

test("formatting rejects protection, locked controls, ambiguity, invalid settings and pending revisions without partial edits", async () => {
  const { context, read } = await contract(true); const title = read().paragraphs.find((item) => item.styleId === "Title")!;
  const before = context.view.state.doc;
  for (const mode of ["readOnly", "forms", "trackedChanges"] satisfies typeof context.metadata.protection.mode[]) {
    context.metadata.protection.mode = mode;
    assert.throws(() => applyWordFormatting(context, { paraId: title.paraId, marks: { bold: false } }), /protection|tracked-change/);
    assert.equal(context.view.state.doc, before);
  }
  context.metadata.protection.mode = "none";
  assert.throws(() => applyWordFormatting(context, { paraId: title.paraId, search: "missing", marks: { bold: false } }), /plain-text/);
  assert.throws(() => applyWordFormatting(context, { paraId: title.paraId, marks: { bold: false, fontSize: -1 } }), /fontSize/);
  assert.equal(context.view.state.doc, before);
  const control = read().controls.find((control) => control.text === "Windpark Nordfeld")!;
  let lock = context.view.state.tr;
  before.descendants((node, pos) => { if (node.type.name === "sdt" && String(node.attrs.id) === control.id) lock = lock.setNodeMarkup(pos, undefined, { ...node.attrs, lock: "contentLocked" }); });
  context.view.dispatch(lock);
  const lockedBefore = context.view.state.doc;
  const locked = wordParagraphs(lockedBefore).find((item) => item.node.textContent.includes(control.text));
  assert.ok(locked);
  assert.throws(() => applyWordFormatting(context, { paraId: locked.node.attrs.paraId, search: control.text, marks: { italic: true } }), /locked|protection/);
  const pending = wordParagraphs(before).find((item) => { let found = false; item.node.descendants((node) => { if (node.marks.some((mark) => mark.type.name === "insertion")) found = true; }); return found; });
  assert.ok(pending);
  assert.throws(() => applyWordFormatting(context, { paraId: pending.node.attrs.paraId, marks: { italic: true } }), /pending revision/);
  assert.equal(context.view.state.doc, lockedBefore);
});

test("character spacing repairs preserve unrelated properties and survive Word export", async () => {
  const { context, read, save } = await contract(true);
  const target = read().paragraphs.find(item => item.text.includes("Windenergieanlage"))!;
  applyWordFormatting(context, { paraId: target.paraId, marks: { characterSpacing: { spacing: -1, scale: 80, kerning: 12 } } });
  applyWordFormatting(context, { paraId: target.paraId, marks: { characterSpacing: { spacing: 0, scale: 100 } } });
  const node = readWordFormatting(context.view.state.doc, context.document, { paraId: target.paraId }).paragraphs[0];
  assert.deepEqual(node.runs[0].marks.find(mark => mark.type === "characterSpacing")?.attrs, { spacing: 0, scale: 100, kerning: 24, position: null });
  const reopened = await parseDocx(await save());
  const doc = toProseDoc(reopened, { styles: reopened.package.styles });
  const output = readWordFormatting(doc, reopened, {}).paragraphs.find(item => item.runs.some(run => run.text.includes("Windenergieanlage")))!;
  assert.equal(output.runs[0].marks.find(mark => mark.type === "characterSpacing")?.attrs.scale, 100);
  assert.equal(output.runs[0].marks.find(mark => mark.type === "characterSpacing")?.attrs.spacing, 0);
});
