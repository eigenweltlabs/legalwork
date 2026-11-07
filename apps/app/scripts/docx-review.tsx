import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { getCaretPositionFromDom } from "@eigenpal/docx-editor-core/layout-bridge";
import JSZip from "jszip";
import { writingTemplate } from "./fixtures/writing-template";
import { letterheadTemplate } from "./fixtures/letterhead-template";
import { readWordMetadata } from "../src/react-app/domains/session/artifacts/docx-word-package";
import { ArtifactDocxEditor, type DocxEditorApi } from "../src/react-app/domains/session/artifacts/artifact-docx-editor";
import { ArtifactFrame } from "../src/react-app/domains/session/artifacts/artifact-frame";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/sonner";
import "../src/app/index.css";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function records(value: unknown) { return Array.isArray(value) ? value.filter(record) : []; }
function base64(buffer: ArrayBuffer) { let binary = ""; const bytes = new Uint8Array(buffer); for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(binary); }

// Development-only harness: real production editor, synthetic contract, in-memory persistence.
function ReviewHarness({ initial, fixture }: { initial: ArrayBuffer; fixture: string }) {
  const api = useRef<DocxEditorApi | null>(null);
  const [content, setContent] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loaded original");
  const [narrow, setNarrow] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [failSave, setFailSave] = useState(false);
  const [savedReport, setSavedReport] = useState("");
  const [agentReport, setAgentReport] = useState("");
  const [previewImage, setPreviewImage] = useState("");
  const agentRead = async () => {
    const combined: Record<string, unknown> = {};
    let next: number | null = 0;
    while (next !== null) {
      const result = await api.current?.executeAgentTool("read_document", { view: "structure", fromIndex: next, limit: 50 });
      if (!result?.success || !record(result.data) || !record(result.data.structure)) throw new Error(result?.error || "Agent structure read failed");
      const data = result.data;
      if (combined.documentId && (combined.documentId !== data.documentId || combined.draftRevision !== data.draftRevision)) throw new Error("Draft changed during paginated reads");
      for (const [key, value] of Object.entries(data.structure)) combined[key] = Array.isArray(value) ? [...records(combined[key]), ...value] : value;
      combined.documentId = data.documentId; combined.draftRevision = data.draftRevision;
      next = typeof data.nextIndex === "number" ? data.nextIndex : null;
    }
    for (const key of ["notes", "controls"]) combined[key] = [...new Map(records(combined[key]).map(item => [`${item.type}:${item.id}`, item])).values()];
    return combined;
  };
  const agentRun = async (tool: string, args: Record<string, unknown>, snapshot?: Record<string, unknown>) => {
    const structure = snapshot ?? await agentRead();
    const identity = { documentId: structure.documentId, draftRevision: structure.draftRevision };
    const result = tool === "save_document" ? await api.current?.executeAgentTool("edit", { ...identity, action: "save" })
      : tool === "fill_content_control" ? await api.current?.executeAgentTool("fill_template", { ...identity, controlId: args.controlId, value: args.text })
      : ["create_clean_copy", "create_comparison_copy"].includes(tool) ? await api.current?.executeAgentTool(tool, { ...identity, ...args })
      : await api.current?.executeAgentTool("edit", { ...identity, operations: [{ operation: tool, ...args }] });
    if (!result?.success) throw new Error(`${tool}: ${result?.error}`);
    return result;
  };
  const runAgentWorkflow = async () => {
    setAgentReport("Running production agent tools…");
    try {
      const first = await agentRead();
      if (record(first.protection) && first.protection.mode !== "none") await agentRun("set_protection", { mode: "none" });
      const structure = await agentRead(); const source = records(structure.fields).find((field) => field.type === "REF");
      const target = records(structure.bookmarks).find((mark) => mark.name === "Rueckbau");
      if (!source || !target) throw new Error("Complex Word fixture is required.");
      await agentRun("insert_cross_reference", { paraId: source.paraId, targetParaId: target.paraId, kind: "number", search: "" }, structure);
      const stale = await api.current?.executeAgentTool("edit", { documentId: structure.documentId, draftRevision: structure.draftRevision, operations: [{ operation: "insert_cross_reference", paraId: source.paraId, bookmark: "Rueckbau", kind: "number", search: "" }] });
      if (stale?.success) throw new Error("Stale revision unexpectedly permitted");
      let fresh = await agentRead();
      const created = records(fresh.fields).filter((field) => field.paraId === source.paraId).at(-1);
      if (!created) throw new Error("New reference is not visible to the agent");
      await agentRun("edit_cross_reference", { paraId: created.paraId, ordinal: created.ordinal, bookmark: "Verguetung", kind: "number" });
      fresh = await agentRead(); const control = records(fresh.controls).find((control) => control.text === "Windpark Nordfeld");
      if (!control) throw new Error("Template control is missing");
      await agentRun("set_protection", { mode: "forms" });
      await agentRun("fill_content_control", { controlId: control.id, text: "Agent Word Demo" });
      fresh = await agentRead();
      const protectedEdit = await api.current?.executeAgentTool("edit", { documentId: fresh.documentId, draftRevision: fresh.draftRevision, operations: [{ operation: "create_bookmark", paraId: source.paraId, bookmark: "BlockedAgentBookmark" }] });
      if (protectedEdit?.success) throw new Error("Protected boilerplate edit unexpectedly permitted");
      await agentRun("set_protection", { mode: "none" });
      await agentRun("edit_note", { noteType: "footnote", noteId: 1, search: "Musterwerte", replaceWith: "Agent geprüfte Demowerte" });
      await agentRun("insert_note", { noteType: "footnote", paraId: source.paraId, search: "", text: "Agent created this native linked footnote." });
      await agentRun("set_page_numbering", { sectionIndex: 0, format: "upperRoman", start: 1 });
      await agentRun("update_fields", {});
      fresh = await agentRead();
      const native = records(fresh.fields).find((field) => field.instruction === "REF Verguetung \\w \\h");
      const note = records(fresh.notes).find((note) => typeof note.text === "string" && note.text.includes("Agent created"));
      if (!native || !note || native.resolvedText !== "4") throw new Error("Final reference or linked note verification failed");
      setAgentReport(JSON.stringify({ passed: true, staleRevisionBlocked: true, protectedBoilerplateBlocked: true, reference: native, notes: fresh.notes, sections: fresh.sections, control: records(fresh.controls).find((item) => item.id === control.id), saved: true }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const verifyAgentData = async () => {
    try {
      const structure = await agentRead();
      const reference = records(structure.fields).find((field) => field.instruction === "REF Verguetung \\w \\h");
      const notes = records(structure.notes);
      const newNote = notes.find((note) => typeof note.text === "string" && note.text.includes("Agent created"));
      const control = records(structure.controls).find((item) => item.text === "Agent Word Demo");
      if (!newNote || records(newNote.references).length !== 1) throw new Error(`Native note backlink: ${JSON.stringify(newNote)}`);
      if (!reference || reference.resolvedText !== "4" || notes.length !== 3 || !notes.some((note) => typeof note.text === "string" && note.text.includes("Agent geprüfte")) || !control || records(structure.sections)[0]?.format !== "upperRoman") throw new Error("Saved structure differs from the agent edits");
      setAgentReport(JSON.stringify({ reopenedPassed: true, referenceInstruction: reference.instruction, resolvedNumber: reference.resolvedText, footnotes: notes.length, newNoteLinked: records(notes.find((note) => typeof note.text === "string" && note.text.includes("Agent created"))?.references).length === 1, editedNotePreserved: true, templateValue: control.text, sectionFormat: records(structure.sections)[0].format }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const testAgentCopies = async () => {
    try {
      setAgentReport("Testing agent copies…");
      const first = await agentRead();
      const clean = await agentRun("create_clean_copy", { categories: ["properties", "comments", "revisions"] });
      if (!record(clean.data) || typeof clean.data.bufferBase64 !== "string") throw new Error("No clean copy returned");
      const cleanBuffer = Uint8Array.from(atob(clean.data.bufferBase64), (char) => char.charCodeAt(0)).buffer;
      const cleanReviewer = await DocxReviewer.fromBuffer(cleanBuffer);
      if (cleanReviewer.getChanges().length || cleanReviewer.getComments().length) throw new Error("Clean copy retains selected review markup");
      const original = await api.current?.getBuffer(); if (!original) throw new Error("No source draft");
      const zip = await JSZip.loadAsync(original); const xml = await zip.file("word/document.xml")!.async("string");
      zip.file("word/document.xml", xml.replaceAll("48.000", "60.000"));
      const draft = await zip.generateAsync({ type: "arraybuffer" });
      const comparison = await agentRun("create_comparison_copy", { versions: [{ base64: base64(draft), author: "Agent QA Counsel" }] });
      if (!record(comparison.data) || !records(comparison.data.changes).some((change) => change.author === "Agent QA Counsel")) throw new Error("No native comparison changes returned");
      const last = await agentRead(); const sourceReviewer = await DocxReviewer.fromBuffer(original);
      if (first.draftRevision !== last.draftRevision || !sourceReviewer.getChanges().length || !sourceReviewer.getComments().length) throw new Error("Copy operation changed the source");
      setAgentReport(JSON.stringify({ copiesPassed: true, cleanComments: cleanReviewer.getComments().length, cleanRevisions: cleanReviewer.getChanges().length, cleanSectionFormat: (await readWordMetadata(cleanBuffer)).pages[0].format, comparisonAuthor: "Agent QA Counsel", comparisonChanges: records(comparison.data.changes).length, sourceChanged: false }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const readAgentFormatting = async () => {
    const structure = await agentRead(); const title = records(structure.paragraphs).find((item) => item.styleId === "Title");
    if (!title) throw new Error("Complex Word fixture required");
    const result = await api.current?.executeAgentTool("read_document", { view: "formatting", paraId: title.paraId });
    if (!result?.success || !record(result.data)) throw new Error(result?.error || "Formatting read failed");
    if (!record(result.data.formatting)) throw new Error("Formatting is missing");
    const paragraph = records(result.data.formatting.paragraphs)[0]; const run = records(paragraph?.runs)[0];
    if (!paragraph || !run || !record(run.formatting) || !record(paragraph.formatting)) throw new Error("Formatting missing from agent read");
    return { structure, paragraph, run, marks: run.formatting, properties: paragraph.formatting };
  };
  const testAgentFormatting = async () => {
    setAgentReport("Testing production agent formatting…");
    try {
      const before = await readAgentFormatting();
      const args = { paraId: before.paragraph.paraId, marks: { bold: false, italic: true, fontSize: 18, fontFamily: { ascii: "Times New Roman" }, color: { rgb: "223344" } }, paragraph: { alignment: "right", spaceAfter: 12, indentLeft: 24, keepNext: false, keepLines: true } };
      if (readOnly) {
        const blocked = await api.current?.executeAgentTool("edit", { documentId: before.structure.documentId, draftRevision: before.structure.draftRevision, operations: [{ operation: "apply_formatting", ...args }] });
        if (blocked?.success) throw new Error("Read-only formatting unexpectedly permitted");
        setAgentReport(JSON.stringify({ formattingReadOnlyPassed: true, formattingReadable: true, formattingBlocked: true, error: blocked?.error }, null, 2)); return;
      }
      await agentRun("apply_formatting", args, before.structure);
      const stale = await api.current?.executeAgentTool("edit", { documentId: before.structure.documentId, draftRevision: before.structure.draftRevision, operations: [{ operation: "apply_formatting", ...args }] });
      if (stale?.success) throw new Error("Stale formatting edit unexpectedly permitted");
      await agentRun("apply_formatting", args); // Repeating an already-applied value is an idempotent success.
      const after = await readAgentFormatting();
      if (after.marks.bold !== false || after.marks.italic !== true || after.marks.fontSize !== 18 || after.properties.alignment !== "right" || after.properties.spaceAfter !== 12 || after.properties.indentLeft !== 24 || after.properties.keepNext !== false || after.properties.keepLines !== true) throw new Error("Agent cannot observe its own formatting edit");
      setAgentReport(JSON.stringify({ formattingPassed: true, staleRevisionBlocked: true, idempotentEditPassed: true, saved: true, font: after.marks.fontFamily, size: after.marks.fontSize, bold: after.marks.bold, italic: after.marks.italic, paragraph: after.properties }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const verifyReopenedFormatting = async () => {
    try {
      const after = await readAgentFormatting();
      if (after.marks.bold !== false || after.marks.italic !== true || after.marks.fontSize !== 18 || !record(after.marks.fontFamily) || after.marks.fontFamily.ascii !== "Times New Roman" || after.properties.alignment !== "right" || after.properties.spaceAfter !== 12 || after.properties.indentLeft !== 24 || after.properties.keepNext !== false || after.properties.keepLines !== true) throw new Error("Reopened formatting differs from the saved edit");
      setAgentReport(JSON.stringify({ reopenedFormattingPassed: true, inheritedBoldRemoved: true, font: after.marks.fontFamily.ascii, points: after.marks.fontSize, alignment: after.properties.alignment, spacingPoints: after.properties.spaceAfter, indentPoints: after.properties.indentLeft, keepNext: after.properties.keepNext, keepLines: after.properties.keepLines }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const testNativeBatch = async () => {
    try {
      const first = await agentRead(); const source = records(first.fields).find(field => field.type === "REF");
      const target = records(first.bookmarks).find(mark => mark.name === "Rueckbau");
      const title = records(first.paragraphs).find(item => item.styleId === "Title");
      if (!source || !target || !title) throw new Error("Complex fixture required");
      const bookmark = `BatchTarget${Date.now()}`;
      const result = await api.current?.executeAgentTool("edit", { documentId: first.documentId, draftRevision: first.draftRevision, operations: [
        { operation: "create_bookmark", paraId: target.paraId, bookmark },
        { operation: "insert_cross_reference", paraId: source.paraId, bookmark, kind: "number", search: "" },
        { operation: "apply_formatting", paraId: title.paraId, marks: { bold: false, italic: true, fontSize: 18, fontFamily: { ascii: "Times New Roman" } }, paragraph: { alignment: "right", spaceAfter: 12, indentLeft: 24, keepNext: false, keepLines: true } },
      ] });
      const after = await agentRead(); const field = records(after.fields).find(field => field.target === bookmark);
      if (readOnly) { if (result?.success) throw new Error("Read-only batch was allowed"); setAgentReport(JSON.stringify({ batchReadOnlyPassed: true, error: result?.error })); return; }
      if (!field || field.resolvedText !== "8") throw new Error(`Batch reference missing: ${JSON.stringify(result)}`);
      if (failSave) { if (result?.success || result?.saved || !record(result?.data) || records(result.data.operations).length !== 3) throw new Error("Applied edits not reported after save failure"); }
      else if (!result?.success || !result.saved) throw new Error(`Batch failed: ${JSON.stringify(result)}`);
      setAgentReport(JSON.stringify({ nativeBatchPassed: true, saveFailurePassed: failSave, reference: field, result }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const testPartialBatch = async () => {
    try {
      const first = await agentRead(); const target = records(first.bookmarks).find(mark => mark.name === "Rueckbau");
      if (!target) throw new Error("Complex fixture required");
      const bookmark = `Partial${Date.now()}`;
      const result = await api.current?.executeAgentTool("edit", { documentId: first.documentId, draftRevision: first.draftRevision, operations: [
        { operation: "create_bookmark", paraId: target.paraId, bookmark },
        { operation: "insert_cross_reference", paraId: target.paraId, bookmark: "MissingBookmark", kind: "text", search: "" },
        { operation: "set_protection", mode: "forms" },
      ] });
      if (result?.success || !result?.saved || !record(result.data) || result.data.failedIndex !== 1) throw new Error(`Partial result incorrect: ${JSON.stringify(result)}`);
      const after = await agentRead();
      if (!records(after.bookmarks).some(mark => mark.name === bookmark) || !record(after.protection) || after.protection.mode !== "none") throw new Error("Partial batch did not stop at its failed operation");
      setAgentReport(JSON.stringify({ partialBatchPassed: true, firstEditSaved: true, thirdEditNotApplied: true, result }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const verifyReferences = async () => {
    const first = await agentRead(); const fields = records(first.fields);
    if (fields.length !== 2 || fields.some(field => field.status !== "linked")) throw new Error("Native reference fields are missing");
    const short = fields.find(field => field.resolvedText === "§ 2 Schlussbestimmungen");
    if (!short || !records(first.bookmarks).some(mark => mark.name === short.target && mark.text === "§ 2 Schlussbestimmungen" && mark.scope === "range")) throw new Error("Short target is not a native range");
    const text = await api.current?.executeAgentTool("read_document", { view: "text" });
    if (!text?.success || !JSON.stringify(text.data).includes("§ 2 Schlussbestimmungen")) throw new Error("Plain agent read omitted reference display");
    const spans = Array.from(document.querySelectorAll<HTMLElement>('[data-word-field-result="true"]'));
    const full = fields.find(field => field !== short)!;
    const fragments = spans.filter(span => span.dataset.wordBookmark === full.target);
    const clipped = spans.some(span => {
      const paragraph = span.closest(".layout-paragraph"); if (!paragraph) return true;
      const bounds = paragraph.getBoundingClientRect(), rect = span.getBoundingClientRect();
      return rect.left < bounds.left - 2 || rect.right > bounds.right + 2;
    });
    if (fragments.length < 2 || clipped) throw new Error(`Reference wrapping failed: ${fragments.length} fragments, clipped=${clipped}`);
    const last = fragments.at(-1)!; const overlay = document.body.getBoundingClientRect();
    const caret = getCaretPositionFromDom(document.body, Number(last.dataset.pmEnd), overlay);
    if (!caret || Math.abs(caret.y - (last.getBoundingClientRect().top - overlay.top)) > 4) throw new Error("Caret after a wrapped field must land on its final line");
    setAgentReport(JSON.stringify({ referencesPassed: true, nativeLinkedFields: fields.length, shortTarget: short.resolvedText, wrappedFragments: fragments.length, clipped, caretOnFinalLine: true, nativeRanges: first.bookmarks, textRead: text.data }, null, 2));
  };
  const testReferences = async () => {
    try {
      const first = await agentRead(), paragraphs = records(first.paragraphs);
      const result = await api.current?.executeAgentTool("edit", { documentId: first.documentId, draftRevision: first.draftRevision, operations: [
        { operation: "insert_cross_reference", paraId: paragraphs[0].paraId, targetParaId: paragraphs[1].paraId, kind: "text", search: "[FULL]" },
        { operation: "insert_cross_reference", paraId: paragraphs[0].paraId, targetParaId: paragraphs[1].paraId, targetSearch: "§ 2 Schlussbestimmungen", kind: "text", search: "[SHORT]" },
        { operation: "update_fields" },
      ] });
      if (!result?.success || !result.saved) throw new Error(`Reference edit failed: ${JSON.stringify(result)}`);
      await verifyReferences();
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const testReviewToolbar = async () => {
    try {
      const first = await agentRead(), source = records(first.paragraphs)[0];
      const result = await api.current?.executeAgentTool("suggest_change", { documentId: first.documentId, draftRevision: first.draftRevision, paraId: source.paraId, area: "main", search: "Vollständiger Verweis", replaceWith: "Vollständige Referenz" });
      if (!result?.success) throw new Error(`Tracked edit failed: ${JSON.stringify(result)}`);
      const toolbar = document.querySelector('.docx-word-tools[role="toolbar"]');
      if (!toolbar || toolbar.querySelectorAll("button").length !== 4) throw new Error("Fields and review commands must share one toolbar");
      setAgentReport(JSON.stringify({ combinedToolbarPassed: true, commands: Array.from(toolbar.querySelectorAll("button")).map(button => button.textContent) }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  const verifyWriting = async () => {
    const current = await agentRead();
    const paragraphs = records(current.paragraphs);
    const letter = paragraphs.filter(paragraph => paragraph.text === "Writing test letter" || paragraph.text === "Dear recipient," || paragraph.text === "This belongs in the main text flow." || paragraph.text === "Kind regards");
    if (letter.length !== 4 || letter.some(paragraph => !record(paragraph.location) || paragraph.location.area !== "main")) throw new Error("Letter paragraphs are outside the main text flow");
    const box = paragraphs.filter(paragraph => record(paragraph.location) && paragraph.location.area === "textBox");
    if (box.length !== 2 || box[0].text !== "Reserved bottom box" || box[1].text !== "") throw new Error("The positioned box was modified");
    const buffer = await api.current?.getBuffer(); if (!buffer) throw new Error("No saved draft");
    const zip = await JSZip.loadAsync(buffer);
    for (const path of ["word/header1.xml", "word/footer1.xml", "word/footnotes.xml"]) if ((await zip.file(path)!.async("string")).includes("Writing test letter")) throw new Error(`Letter escaped into ${path}`);
    return { mainParagraphs: letter.length, nestedBoxUnchanged: true, notesAndPageStoriesUnchanged: true };
  };
  const testWriting = async () => {
    setAgentReport("Testing writing destinations…");
    try {
      const first = await agentRead();
      const paragraphs = records(first.paragraphs);
      const table = paragraphs.find(paragraph => paragraph.text === "Second table paragraph");
      const main = paragraphs.find(paragraph => paragraph.text === "" && record(paragraph.location) && paragraph.location.area === "main");
      const box = paragraphs.find(paragraph => paragraph.text === "" && record(paragraph.location) && paragraph.location.area === "textBox");
      if (!table || !main || !box) throw new Error("The fixture's writing areas are missing");
      const focused = await api.current?.executeAgentTool("read_document", { paraId: table.paraId });
      if (!focused?.success || !record(focused.data) || typeof focused.data.text !== "string" || !focused.data.text.includes(`[${table.paraId}]`) || !focused.data.text.includes("Second table paragraph")) throw new Error("Table read and paragraph identity disagree");
      const blocked = await api.current?.executeAgentTool("suggest_change", { documentId: first.documentId, draftRevision: first.draftRevision, paraId: box.paraId, search: "", replaceWith: "Must not enter bottom box" });
      if (blocked?.success || !blocked?.error?.includes("textBox")) throw new Error("A main-flow request entered a text box");
      await agentRun("insert_paragraphs", { placement: "replace_empty", paraId: main.paraId, paragraphs: [{ text: "Writing test letter" }, { text: "Dear recipient," }, { text: "This belongs in the main text flow." }, { text: "Kind regards" }] });
      const stale = await api.current?.executeAgentTool("suggest_change", { documentId: first.documentId, draftRevision: first.draftRevision, paraId: main.paraId, search: "", replaceWith: "Stale edit" });
      if (stale?.success) throw new Error("Stale proposal was allowed");
      const verified = await verifyWriting();
      const preview = await api.current?.executeAgentTool("preview", { page: 1 });
      if (!preview?.success || !record(preview.data) || !record(preview.data.preview) || typeof preview.data.preview.dataUrl !== "string") throw new Error(`Preview unavailable: ${preview?.error}`);
      setPreviewImage(preview.data.preview.dataUrl);
      setAgentReport(JSON.stringify({ writingDestinationsPassed: true, ...verified, focusedTableReadPassed: true, wrongAreaBlocked: true, staleProposalBlocked: true, annotatedPreviewPassed: true, previewLabels: preview.data.labels }, null, 2));
    } catch (cause) { setAgentReport(String(cause)); }
  };
  return <TooltipProvider><div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
    <div style={{ padding: 10, display: "flex", gap: 16, flexWrap: "wrap", borderBottom: "1px solid #ddd" }}>
      <label>Load local DOCX<input type="file" accept=".docx" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; const buffer = await file.arrayBuffer(); setContent(buffer); setSaved(buffer); setGeneration(value => value + 1); setDirty(false); setAgentReport(""); setPreviewImage(""); setStatus("Loaded local DOCX"); }} /></label>
      <button onClick={async () => { try { const buffer = await api.current?.getBuffer(); if (!buffer) throw new Error("Editor not ready"); setSaved(buffer); setStatus("Exported current draft"); } catch (cause) { setAgentReport(String(cause)); } }}>Export current draft</button>
      <button onClick={() => void api.current?.executeAgentTool("preview", {page: 1, annotate: false}).then(result => { if (record(result.data) && record(result.data.preview) && typeof result.data.preview.dataUrl === "string") setPreviewImage(result.data.preview.dataUrl); else setAgentReport(JSON.stringify(result)); })}>Preview page</button>
      <button onClick={() => void api.current?.executeAgentTool("read_document", {view: "layout"}).then(result => setAgentReport(JSON.stringify(result.data, null, 2)))}>Read page layout</button>
      <button onClick={() => { const url = URL.createObjectURL(new Blob([saved], {type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"})); const link = document.createElement("a"); link.href = url; link.download = "regression-letter.docx"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download saved DOCX</button>
      <button onClick={async () => { try { await agentRun("insert_paragraphs", { placement: "start", paragraphs: [{ text: "Rendering regression letter", alignment: "left" }, { text: "Dear recipient,", alignment: "left" }, { text: "This letter belongs in the main document body.", alignment: "left" }, { text: "Kind regards", alignment: "left" }] }); setAgentReport("Sample letter inserted and saved in the main body."); } catch (cause) { setAgentReport(String(cause)); } }}>Insert sample letter</button>
      <button onClick={async () => { try { const ok = await api.current?.save(); setStatus(ok ? "Saved to workspace" : "Save failed"); } catch { setStatus("Save failed; draft retained"); } }}>Save to workspace</button>
      <button onClick={() => { setContent(saved.slice(0)); setGeneration((value) => value + 1); setDirty(false); setStatus("Reopened saved copy"); }}>Reopen saved copy</button>
      <button onClick={() => setNarrow(!narrow)}>{narrow ? "Full width" : "Narrow panel"}</button>
      {fixture === "writing" && <><button onClick={() => void testWriting()}>Test writing destinations</button><button onClick={() => void verifyWriting().then(result => setAgentReport(JSON.stringify({ reopenedWritingPassed: true, ...result }))).catch(cause => setAgentReport(String(cause)))}>Verify reopened writing</button></>}
      <button onClick={() => void testNativeBatch()}>Test typed native batch</button>
      <button onClick={() => void testPartialBatch()}>Test partial batch</button>
      {fixture === "references" && <button onClick={() => void testReviewToolbar()}>Test review toolbar</button>}
      {fixture === "references" && <><button onClick={() => void testReferences()}>Test references</button><button onClick={() => void verifyReferences().catch(cause => setAgentReport(String(cause)))}>Verify reopened references</button><button onClick={() => void api.current?.executeAgentTool("read_selection", {}).then(result => setAgentReport(JSON.stringify(result, null, 2)))}>Read selection</button></>}
      <button onClick={() => void runAgentWorkflow()}>Test agent Word workflow</button>
      <button onClick={() => void agentRead().then((structure) => setAgentReport(JSON.stringify(structure, null, 2))).catch((cause) => setAgentReport(String(cause)))}>Read agent Word structure</button>
      <button onClick={() => void verifyAgentData()}>Verify reopened agent data</button>
      <button onClick={() => void testAgentCopies()}>Test agent copy tools</button>
      <button onClick={() => void testAgentFormatting()}>Test agent formatting</button>
      <button onClick={() => void verifyReopenedFormatting()}>Verify reopened formatting</button>
      <button onClick={() => void agentRun("save_document", {}).then((result) => setAgentReport(JSON.stringify({ retrySaved: result.saved }, null, 2))).catch((cause) => setAgentReport(String(cause)))}>Retry agent save</button>
      <label><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} /> Read only</label>
      <label><input type="checkbox" checked={failSave} onChange={(event) => setFailSave(event.target.checked)} /> Simulate save failure</label>
      <output aria-label="Document status">{dirty ? "Unsaved changes" : "No unsaved changes"} · {status}</output>
    </div>
    <details><summary>Saved DOCX contents</summary><pre aria-label="Saved DOCX contents" style={{ maxHeight: 160, overflow: "auto" }}>{savedReport}</pre></details>
    {agentReport && <pre aria-label="Agent tool verification" style={{ maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11 }}>{agentReport}</pre>}
    <div style={{ width: narrow ? 620 : "100%", maxWidth: "100%", flex: 1, minHeight: 0 }}>
      <ArtifactFrame title="legal-review.docx" meta={dirty ? "Unsaved changes" : "Saved"} expandable actions={<button onClick={() => void api.current?.save()}>Save</button>}>
      <ArtifactDocxEditor key={generation} name="legal-review.docx" content={content} apiRef={api} readOnly={readOnly} recoveryKey={`synthetic-contract-qa-${fixture}`} baseUpdatedAt={1} onDirtyChange={setDirty} onSave={async (buffer) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (failSave) throw new Error("Simulated workspace write failure");
        setSaved(buffer.slice(0));
        const reopened = await DocxReviewer.fromBuffer(buffer.slice(0));
        setSavedReport(JSON.stringify({ comments: reopened.getComments(), changes: reopened.getChanges(), text: reopened.getContentAsText() }, null, 2));
        setStatus("Saved to workspace");
      }} />
      </ArtifactFrame>
    </div>{previewImage && <details><summary>Annotated page preview</summary><img src={previewImage} alt="Annotated Word page preview" style={{ width: 480, maxWidth: "100%" }} /></details>}<Toaster />
  </div></TooltipProvider>;
}

if (import.meta.env.DEV || import.meta.env.MODE === "docx-review") {
  const root = document.getElementById("root");
  const fixture = new URLSearchParams(location.search).get("fixture");
  const positions = fixture === "positions";
  const response = await fetch(positions
    ? new URL("./fixtures/legal-review-positions.docx", import.meta.url)
    : fixture === "word" ? new URL("./fixtures/legal-word-workflows.docx", import.meta.url) : new URL("./fixtures/legal-review.docx", import.meta.url));
  let initial = await response.arrayBuffer();
  if (fixture === "writing") initial = await writingTemplate();
  if (fixture === "letterhead") initial = await letterheadTemplate();
  if (fixture === "references") {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>§ 1 Vertragsgegenstand: Vollständiger Verweis: [FULL]. Kurzer Verweis: [SHORT].</w:t></w:r></w:p><w:p><w:r><w:t>§ 2 Schlussbestimmungen: Dies ist der zweite Absatz der Test-Datei. Änderungen und Ergänzungen dieses Testdokuments können direkt im Editor vorgenommen werden.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
    initial = await zip.generateAsync({ type: "arraybuffer" });
  }
  if (root) createRoot(root).render(<ReviewHarness initial={initial} fixture={positions ? "positions" : fixture === "word" ? "word" : fixture === "references" ? "references" : fixture === "writing" ? "writing" : "review"} />);
}
