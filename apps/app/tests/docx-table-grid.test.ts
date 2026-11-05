import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import JSZip from "jszip";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { toProseDoc, fromProseDoc, headerFooterToProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { EditorState } from "prosemirror-state";
import { TableMap, fixTables } from "prosemirror-tables";
import type { Node } from "prosemirror-model";

const grid = [4535, 283, 51, 4484, 51];
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text: string, span = 1, merge = "") => `<w:tc><w:tcPr><w:gridSpan w:val="${span}"/>${merge}</w:tcPr>${paragraph(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (rows: string[], widths = grid) => `<w:tbl><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
const fullRow = row(cell("Left column"), cell("", 2), cell("Right column", 2));
const shortRow = row(cell("A long paragraph that belongs in the wide left column. ".repeat(10)), cell(""), cell("Right column", 2));

async function documentWith(content: string) {
  const zip = await JSZip.loadAsync(await readFile(new URL("../scripts/fixtures/legal-review.docx", import.meta.url)));
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}<w:sectPr/></w:body></w:document>`);
  return DocxReviewer.fromBuffer(await zip.generateAsync({ type: "arraybuffer" }));
}

function assertStableGrid(doc: Node) {
  doc.descendants(node => {
    if (node.type.name === "table") assert.equal(TableMap.get(node).problems, null);
  });
  assert.equal(fixTables(EditorState.create({ doc })), undefined, "table repair must not reposition imported cells");
}

test("consecutive short Word rows keep text out of narrow spacer columns in both module formats", async () => {
  const source = (await documentWith(table([fullRow, shortRow, shortRow, fullRow]))).toDocument();
  const commonjs = createRequire(import.meta.url)("@eigenpal/docx-editor-core/prosemirror/conversion");
  for (const convert of [toProseDoc, commonjs.toProseDoc]) {
    const doc: Node = convert(source);
    assertStableGrid(doc);
    const imported = doc.firstChild!;
    for (const index of [1, 2]) {
      const cells = imported.child(index);
      assert.match(cells.firstChild!.textContent, /^A long paragraph/);
      assert.equal(cells.child(2).textContent, "Right column");
      assert.equal(cells.child(2).attrs.colspan, 2);
      assert.equal(cells.lastChild!.textContent, "");
      assert.equal(cells.childCount, 4);
    }
    assert.deepEqual(imported.attrs.columnWidths, grid);
  }
});

test("grid padding counts vertical continuations and horizontal spans without duplicating merged cells", async () => {
  const source = await documentWith(table([
    row(cell("Merged left", 1, '<w:vMerge w:val="restart"/>'), cell("", 2), cell("Right", 2)),
    row(cell("", 1, '<w:vMerge w:val="continue"/>'), cell(""), cell("Right", 2)),
    fullRow,
  ]));
  const doc = toProseDoc(source.toDocument());
  assertStableGrid(doc);
  const imported = doc.firstChild!;
  assert.equal(imported.child(0).firstChild!.attrs.rowspan, 2);
  assert.equal(imported.child(1).childCount, 3);
  assert.equal(imported.child(1).child(1).textContent, "Right");
  assert.equal(imported.child(1).child(1).attrs.colspan, 2);
  assert.equal(imported.child(1).lastChild!.attrs.colspan, 1);
});

test("short first rows and multiple missing columns use the inferred grid when tblGrid is absent", async () => {
  const source = (await documentWith(table([row(cell("First"), cell("Second")), fullRow]))).toDocument();
  const imported = source.package.document.content[0];
  assert.equal(imported.type, "table");
  if (imported.type !== "table") throw new Error("Expected table");
  imported.columnWidths = undefined;
  const doc = toProseDoc(source);
  assertStableGrid(doc);
  assert.equal(doc.firstChild!.firstChild!.firstChild!.textContent, "First");
  assert.equal(doc.firstChild!.firstChild!.child(1).textContent, "Second");
  assert.equal(doc.firstChild!.firstChild!.lastChild!.attrs.colspan, 3);
});

test("nested tables and header/footer conversion preserve the same grid positions", async () => {
  const nested = table([fullRow, shortRow, shortRow]);
  const source = (await documentWith(table([row(`<w:tc>${nested}${paragraph("")}</w:tc>`)], [9404]))).toDocument();
  assertStableGrid(toProseDoc(source));
  assertStableGrid(headerFooterToProseDoc(source.package.document.content));
});

test("saving and reopening a padded table preserves text and its column positions", async () => {
  const source = (await documentWith(table([fullRow, shortRow, shortRow, fullRow]))).toDocument();
  const doc = toProseDoc(source);
  const saved = new DocxReviewer(fromProseDoc(doc, source));
  const reopened = toProseDoc((await DocxReviewer.fromBuffer(await saved.toBuffer())).toDocument());
  assertStableGrid(reopened);
  assert.equal(reopened.textContent, doc.textContent);
  assert.equal(reopened.firstChild!.child(2).firstChild!.textContent, doc.firstChild!.child(2).firstChild!.textContent);
  assert.equal(reopened.firstChild!.child(2).child(2).attrs.colspan, 2);
});
