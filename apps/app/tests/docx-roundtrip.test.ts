import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { schema } from "@eigenpal/docx-editor-core/prosemirror";
import { toProseDoc, fromProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { createCleanDocx } from "../src/react-app/domains/session/artifacts/docx-export.ts";

async function fixture() {
  const file = await readFile(new URL("../scripts/fixtures/legal-review.docx", import.meta.url));
  return new Uint8Array(file).buffer;
}

test("clean export accepts changes and removes comments without altering the source", async () => {
  const original = await fixture();
  const clean = await DocxReviewer.fromBuffer(await createCleanDocx(original));
  assert.equal(clean.getChanges().length, 0);
  assert.equal(clean.getComments().length, 0);
  assert.match(clean.getContentAsText(), /within 60 days/);
  const unchanged = await DocxReviewer.fromBuffer(original);
  assert.ok(unchanged.getChanges().length > 0);
  assert.ok(unchanged.getComments().length > 0);
});

test("clean export refuses unsupported review markup in a header", async () => {
  const zip = await JSZip.loadAsync(await fixture());
  const header = Object.keys(zip.files).find((name) => /^word\/header\d+\.xml$/.test(name));
  assert.ok(header);
  const file = zip.file(header);
  assert.ok(file);
  const xml = await file.async("string");
  zip.file(header, xml.replace(/(<w:r[ >][\s\S]*?<\/w:r>)/, '<w:ins w:id="91" w:author="Header reviewer">$1</w:ins>'));
  await assert.rejects(createCleanDocx(await zip.generateAsync({ type: "arraybuffer" })), /cannot yet be removed safely/);
});

test("overlapping comments coexist in the ProseMirror schema", () => {
  const first = schema.marks.comment.create({ commentId: 0 });
  const second = schema.marks.comment.create({ commentId: 3 });
  assert.equal(second.addToSet([first]).length, 2);
});

test("comment replies survive editor conversion, revision rejection and a second save", async () => {
  const original = await fixture();
  const reviewer = await DocxReviewer.fromBuffer(original, "Test Counsel");
  reviewer.replyTo(0, "The 30-day period is agreed.");
  reviewer.addComment(8, "This overlapping review note must also survive.");
  const once = await DocxReviewer.fromBuffer(await reviewer.toBuffer());
  const doc = once.toDocument();
  // Exercise the same OOXML -> editor -> OOXML projection as a live edit.
  const pm = toProseDoc(doc);
  let overlapping = false;
  pm.descendants((node) => {
    if (node.marks.filter((mark) => mark.type.name === "comment").length > 1) overlapping = true;
  });
  assert.ok(overlapping, "both imported comment anchors must reach the editor");
  const converted = fromProseDoc(pm, doc);
  const twice = new DocxReviewer(converted, "Test Counsel", original);
  twice.rejectAll();
  const reopened = await DocxReviewer.fromBuffer(await twice.toBuffer());
  assert.match(JSON.stringify(reopened.getComments()), /The 30-day period is agreed/);
  assert.match(JSON.stringify(reopened.getComments()), /This overlapping review note must also survive/);
  assert.match(reopened.getContentAsText(), /within 30 days/);
});
