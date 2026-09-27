import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractCorpusText, officeText } from "./extract.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import { OcrManager } from "../ocr/manager.js";
import { OcrService } from "../ocr/service.js";

test("extracts XLSX shared strings/values, slide text and OpenDocument content", () => {
  const xlsx = zipSync({ "xl/sharedStrings.xml": strToU8('<sst><si><t>Germany</t></si></sst>'), "xl/worksheets/sheet1.xml": strToU8('<worksheet><row><c t="s"><v>0</v></c><c><v>42</v></c></row></worksheet>') });
  expect(officeText(xlsx, ".xlsx")).toContain("Germany\t42");
  expect(officeText(zipSync({ "ppt/slides/slide1.xml": strToU8('<p:sld><a:p><a:t>Assignment &amp; consent</a:t></a:p></p:sld>') }), ".pptx")).toContain("Assignment & consent");
  expect(officeText(zipSync({ "content.xml": strToU8('<text:p>Contract term</text:p>') }), ".odt")).toContain("Contract term");
});

test("native text, DOCX and searchable PDFs avoid OCR; images automatically use it", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-extract-")); let ocrCalls = 0;
  const prep = new DocumentPreparation(new OcrManager(join(root, "ocr")), { snapshot: async () => ({ fingerprint: "test", service: new OcrService([{ info: { id: "fixture", label: "Fixture", execution: "local", model: "fixture", languages: null, regions: false, warnings: [] }, recognize: async () => { ocrCalls++; return { text: "The document contains an assignment clause.", regions: [], truncated: false }; } }], "fixture") }) });
  try {
    const signal = new AbortController().signal;
    await writeFile(join(root, "a.txt"), "Original text.");
    expect((await extractCorpusText(root, "a.txt", prep, signal)).text).toBe("Original text.");
    await writeFile(join(root, "a.docx"), zipSync({ "word/document.xml": strToU8('<w:document><w:p><w:t>Assignment needs consent.</w:t></w:p></w:document>') }));
    expect((await extractCorpusText(root, "a.docx", prep, signal)).text).toContain("Assignment needs consent.");
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("This document permits assignment with the prior written consent of the counterparty.", { font, size: 12 });
    await writeFile(join(root, "a.pdf"), await pdf.save());
    const native = await extractCorpusText(root, "a.pdf", prep, signal);
    expect(native.extraction).toBe("native"); expect(native.text).toContain("prior written consent"); expect(ocrCalls).toBe(0);
    await writeFile(join(root, "scan.png"), await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url)));
    const image = await extractCorpusText(root, "scan.png", prep, signal);
    expect(image.extraction).toBe("ocr"); expect(image.text).toContain("assignment clause"); expect(ocrCalls).toBe(1);
  } finally { prep.stop(); await rm(root, { recursive: true, force: true }); }
});
