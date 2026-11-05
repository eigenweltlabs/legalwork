import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocx } from "@eigenpal/docx-editor-core/docx";
import { toProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { readWordMetadata } from "../src/react-app/domains/session/artifacts/docx-word-package";
import { readWordDocument } from "../src/react-app/domains/session/artifacts/docx-agent-read";
import { executeWordBatch } from "../src/react-app/domains/session/artifacts/docx-agent-batch";
import { executeWordCopy } from "../src/react-app/domains/session/artifacts/docx-agent-copy";
import { docxEditSchema, docxTemplateSchema } from "@legalwork/types/office-editor";
import { isDocumentReadTool } from "../src/react-app/domains/session/artifacts/document-agent-read";
const identity = { documentId: "draft-1", draftRevision: 2 };

test("paged live reads expose native references, notes and formatting with explicit coverage", async () => {
  const buffer = new Uint8Array(await readFile(new URL("../scripts/fixtures/legal-word-workflows.docx", import.meta.url))).buffer;
  const document = await parseDocx(buffer), doc = toProseDoc(document, { styles: document.package.styles }), metadata = await readWordMetadata(buffer);
  const ids = new Set<string>(); let next: number | null = 0, fields = 0, notes = 0, controls = 0;
  while (next !== null) {
    const read = readWordDocument(doc, document, null, metadata, { fromIndex: next, limit: 7 });
    assert.equal(read.structure?.paragraphs.length, read.formatting?.paragraphs.length);
    for (const paragraph of read.structure!.paragraphs) { assert.ok(!ids.has(paragraph.paraId)); ids.add(paragraph.paraId); }
    fields += read.structure!.fields.length; notes += read.structure!.notes.length; controls += read.structure!.controls.length;
    next = read.coverage.nextIndex;
  }
  const all = readWordDocument(doc, document, null, metadata, { view: "structure", limit: 50 });
  assert.equal(ids.size, all.coverage.totalParagraphs); assert.equal(fields, all.structure!.counts.fields);
  assert.ok(notes >= 2); assert.ok(controls >= 1); assert.equal(all.formatting, undefined);
  const field = all.structure!.fields.find(field => field.target === "Rueckbau")!;
  assert.equal(field.status, "linked"); assert.match(field.instruction, /REF Rueckbau/);
  const focused = readWordDocument(doc, document, null, metadata, { view: "formatting", paraId: field.paraId, includeStyles: true });
  assert.equal(focused.formatting!.paragraphs.length, 1); assert.equal(focused.structure, undefined); assert.equal(focused.coverage.nextIndex, null);
  assert.ok(focused.formatting!.styleDefinitions); assert.throws(() => readWordDocument(doc, document, null, metadata, { fromIndex: 2, toIndex: 1 }));
});

test("default live reads cover more than 50 paragraphs and pagination remains opt-in", async () => {
  const buffer = new Uint8Array(await readFile(new URL("../scripts/fixtures/legal-word-workflows.docx", import.meta.url))).buffer;
  const document = await parseDocx(buffer), metadata = await readWordMetadata(buffer);
  const schema = toProseDoc(document, { styles: document.package.styles }).type.schema;
  const doc = schema.node("doc", null, Array.from({ length: 75 }, (_, index) => schema.node("paragraph", { paraId: `P${index}` }, schema.text(`Clause ${index}`))));
  const all = readWordDocument(doc, document, null, metadata, {});
  assert.equal(all.structure!.paragraphs.length, 75);
  assert.equal(all.formatting!.paragraphs.length, 75);
  assert.equal(all.coverage.nextIndex, null);
  assert.deepEqual(all.textArgs, { fromIndex: 0 });
  const text = readWordDocument(doc, document, null, metadata, { view: "text" });
  assert.equal(text.coverage.toIndex, 74); assert.equal(text.coverage.nextIndex, null);
  assert.deepEqual(text.textArgs, { fromIndex: 0 });
  const rest = readWordDocument(doc, document, null, metadata, { fromIndex: 20 });
  assert.equal(rest.structure!.paragraphs.length, 55); assert.equal(rest.coverage.nextIndex, null);
  assert.deepEqual(rest.textArgs, { fromIndex: 20 });
  const range = readWordDocument(doc, document, null, metadata, { fromIndex: 0, toIndex: 74 });
  assert.equal(range.structure!.paragraphs.length, 75);
  assert.deepEqual(range.textArgs, { fromIndex: 0, toIndex: 74 });
  const page = readWordDocument(doc, document, null, metadata, { fromIndex: 10, limit: 60 });
  assert.equal(page.structure!.paragraphs.length, 60); assert.equal(page.formatting!.paragraphs.length, 60);
  assert.equal(page.coverage.nextIndex, 70);
  assert.deepEqual(page.textArgs, { fromIndex: 10, toIndex: 69 });
  const focused = readWordDocument(doc, document, null, metadata, { paraId: "P74" });
  assert.equal(focused.structure!.paragraphs.length, 1); assert.equal(focused.coverage.nextIndex, null);
  assert.deepEqual(focused.textArgs, { fromIndex: 74, toIndex: 74 });
});

test("batch validates every operation before editing and rejects arbitrary formatting JSON", async () => {
  let called = false;
  await assert.rejects(executeWordBatch({ ...identity, operations: [{ operation: "create_bookmark", paraId: "p", bookmark: "Good" }, { operation: "apply_formatting", paraId: "p", marks: { invented: true } }] }, async () => { called = true; return { success: true }; }));
  assert.equal(called, false);
  assert.equal(docxEditSchema.safeParse({ ...identity, operations: [{ operation: "suggest_change", paraId: "p", search: "a", replaceWith: "b" }] }).success, false);
});

test("batch stops on failure, saves earlier edits once and reports its failed index", async () => {
  const calls: { name: string; revision: unknown; persist: boolean }[] = [];
  const result = await executeWordBatch({ ...identity, operations: [
    { operation: "create_bookmark", paraId: "p", bookmark: "First" },
    { operation: "insert_cross_reference", paraId: "p", bookmark: "Missing", kind: "text", search: "" },
    { operation: "set_protection", mode: "forms" },
  ] }, async (name, args, persist) => {
    calls.push({ name, revision: args.draftRevision, persist });
    if (name === "create_bookmark") return { success: true, data: { result: { applied: true }, draftRevision: 3 } };
    return name === "save_document" ? { success: true, saved: true } : { success: false, error: "Missing bookmark" };
  });
  assert.deepEqual(calls, [{ name: "create_bookmark", revision: 2, persist: false }, { name: "insert_cross_reference", revision: 3, persist: false }, { name: "save_document", revision: 3, persist: true }]);
  assert.equal(result.success, false); assert.equal(result.saved, true);
  assert.deepEqual(result.data && Reflect.get(result.data, "appliedOperations"), [0]); assert.equal(result.data && Reflect.get(result.data, "failedIndex"), 1);
});

test("failed saves report applied operations and save-only retry never replays an edit", async () => {
  const result = await executeWordBatch({ ...identity, operations: [{ operation: "set_protection", mode: "forms" }] }, async name => name === "save_document" ? { success: false, saved: false, error: "Disk conflict" } : { success: true, data: { result: { applied: true }, draftRevision: 3 } });
  assert.equal(result.success, false); assert.equal(result.saved, false); assert.equal(result.data && Reflect.get(result.data, "saveError"), "Disk conflict");
  const calls: string[] = [];
  const retry = await executeWordBatch({ ...identity, draftRevision: 3, action: "save" }, async name => { calls.push(name); return { success: true, saved: true }; });
  assert.deepEqual(calls, ["save_document"]); assert.equal(retry.saved, true);
});

test("native control filling requires fresh identity and exactly one ID/tag selector", () => {
  assert.ok(docxTemplateSchema.safeParse({ ...identity, tag: "ProjectName", value: "Nordfeld" }).success);
  for (const input of [{ tag: "ProjectName", value: "Nordfeld" }, { ...identity, controlId: "1", tag: "ProjectName", value: "X" }, { ...identity, tag: "ProjectName", paraId: "p", placeholder: "[X]", value: "X" }]) assert.equal(docxTemplateSchema.safeParse(input).success, false);
  assert.ok(docxTemplateSchema.safeParse({ paraId: "p", placeholder: "[X]", value: "New" }).success);
  assert.ok(isDocumentReadTool("docx", "create_clean_copy")); assert.equal(isDocumentReadTool("docx", "edit"), false);
});

test("comparison copies use the originating project API and create-only writes", async () => {
  const reads: string[] = [], writes: unknown[] = [];
  const result = await executeWordCopy({ executeAgentTool: async (name, args) => {
    assert.equal(name, "create_comparison_copy"); assert.ok(Array.isArray(args.versions));
    return { success: true, data: { bufferBase64: btoa("word copy"), sourceChanged: false, changes: [] } };
  } }, { downloadWorkspaceFile: async (workspace, path) => { reads.push(`${workspace}:${path}`); return { data: new TextEncoder().encode("draft").buffer, contentType: "application/octet-stream" }; },
    writeWorkspaceBinaryFile: async (workspace, payload) => { writes.push({ workspace, path: payload.path, createOnly: payload.createOnly }); return { ok: true, path: payload.path, bytes: 9, updatedAt: 1 }; },
  }, "origin-project", "create_comparison_copy", { ...identity, fileName: "comparison.docx", versions: [{ path: "drafts/partner.docx", author: "Partner" }] });
  assert.deepEqual(reads, ["origin-project:drafts/partner.docx"]); assert.deepEqual(writes, [{ workspace: "origin-project", path: "comparison.docx", createOnly: true }]);
  assert.equal(result.saved, true); assert.equal(result.data && Reflect.get(result.data, "bufferBase64"), undefined);
  await assert.rejects(executeWordCopy({ executeAgentTool: async () => { throw new Error("Must not run"); } }, { downloadWorkspaceFile: async () => { throw new Error("Must not read"); }, writeWorkspaceBinaryFile: async () => { throw new Error("Must not write"); } }, "origin-project", "create_comparison_copy", { ...identity, fileName: "comparison.docx", versions: [{ path: "../foreign.docx", author: "Partner" }] }));
});

test("cancellation between batch edits saves and reports the applied prefix",async()=>{
  const controller=new AbortController(),calls:string[]=[];
  const result=await executeWordBatch({...identity,operations:[
    {operation:"create_bookmark",paraId:"p",bookmark:"First"},
    {operation:"create_bookmark",paraId:"p",bookmark:"Cancelled"},
    {operation:"create_bookmark",paraId:"p",bookmark:"Never"},
  ]},async name=>{
    calls.push(name);
    if(name==="save_document")return {success:true,saved:true};
    controller.signal.throwIfAborted();controller.abort();
    return {success:true,data:{result:{applied:true},draftRevision:3}};
  });
  assert.deepEqual(calls,["create_bookmark","create_bookmark","save_document"]);
  assert.equal(result.success,false);assert.equal(result.saved,true);
  assert.deepEqual(result.data&&Reflect.get(result.data,"appliedOperations"),[0]);
  assert.equal(result.data&&Reflect.get(result.data,"failedIndex"),1);
});
