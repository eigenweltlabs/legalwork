import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractDeliverableText, MAX_EXTRACTED_CHARS } from "./extract-text.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "benchmark-extract-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeZip(name: string, entries: Record<string, string>): string {
  const path = join(dir, name);
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)]))));
  return path;
}

describe("extractDeliverableText", () => {
  test("docx paragraphs with entities, tabs and breaks", async () => {
    const path = writeZip("memo.docx", {
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:body>' +
        "<w:p><w:r><w:t>Section A &amp; B</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Item</w:t></w:r><w:tab/><w:r><w:t>Value</w:t></w:r></w:p>" +
        "</w:body></w:document>",
    });
    const text = await extractDeliverableText(path);
    expect(text).toContain("Section A & B");
    expect(text).toContain("Item\tValue");
  });

  test("xlsx rows with shared strings", async () => {
    const path = writeZip("table.xlsx", {
      "xl/sharedStrings.xml": "<sst><si><t>Market</t></si><si><t>Share</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        "<worksheet><sheetData>" +
        '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
        "<row><c><v>61</v></c></row>" +
        "</sheetData></worksheet>",
    });
    const text = await extractDeliverableText(path);
    expect(text).toContain("Market\tShare");
    expect(text).toContain("61");
  });

  test("pptx slides in order", async () => {
    const path = writeZip("deck.pptx", {
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
    });
    const text = await extractDeliverableText(path);
    expect(text!.indexOf("First")).toBeLessThan(text!.indexOf("Second"));
  });

  test("plain text formats pass through; long content truncates", async () => {
    const mdPath = join(dir, "notes.md");
    writeFileSync(mdPath, "# Heading\nBody");
    expect(await extractDeliverableText(mdPath)).toBe("# Heading\nBody");

    const longPath = join(dir, "long.txt");
    writeFileSync(longPath, "x".repeat(MAX_EXTRACTED_CHARS + 500));
    const truncated = await extractDeliverableText(longPath);
    expect(truncated!.endsWith("[… truncated]")).toBe(true);
  });

  test("unsupported or corrupt files return null", async () => {
    const pdfPath = join(dir, "doc.pdf");
    writeFileSync(pdfPath, "%PDF-1.4 …");
    expect(await extractDeliverableText(pdfPath)).toBeNull();

    const fakeDocx = join(dir, "broken.docx");
    writeFileSync(fakeDocx, "not a zip at all");
    expect(await extractDeliverableText(fakeDocx)).toBeNull();

    expect(await extractDeliverableText(join(dir, "missing.docx"))).toBeNull();
  });
});
