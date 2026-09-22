import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rememberFontDecision, unresolvedDocumentFonts } from "../src/react-app/domains/session/artifacts/docx-font-consent";
import { BUNDLED_OFFICE_FONTS } from "../src/react-app/domains/session/artifacts/office-font-families";

const FIXTURES = join(import.meta.dir, "..", "scripts", "fixtures");

function fixture(name: string): ArrayBuffer {
  const file = readFileSync(join(FIXTURES, name));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

/** A minimal .docx: one XML part naming the given fonts, zipped. */
async function docxNaming(...families: string[]): Promise<ArrayBuffer> {
  const { default: JSZip } = await import("jszip");
  const runs = families
    .map((f) => `<w:r><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}"/></w:rPr><w:t>x</w:t></w:r>`)
    .join("");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p>${runs}</w:p></w:body></w:document>`,
  );
  const out = await zip.generateAsync({ type: "arraybuffer" });
  return out;
}

const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: memoryStorage() },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("unresolvedDocumentFonts", () => {
  test("ignores fonts office-fonts.css already bundles", async () => {
    // Every Office family we alias renders locally, so none should be flagged.
    const buffer = await docxNaming(...BUNDLED_OFFICE_FONTS);
    expect(await unresolvedDocumentFonts(buffer)).toEqual([]);
  });

  test("flags a font that is neither bundled nor installed", async () => {
    const buffer = await docxNaming("Nonexistent Brand Sans");
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Nonexistent Brand Sans"]);
  });

  test("reports each family once, sorted, mixing bundled and unknown", async () => {
    const buffer = await docxNaming("Zeta Display", "Calibri", "Alpha Text", "Zeta Display");
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Alpha Text", "Zeta Display"]);
  });

  test("skips Word theme references like +mn-lt", async () => {
    const buffer = await docxNaming("+mn-lt", "+mj-lt");
    expect(await unresolvedDocumentFonts(buffer)).toEqual([]);
  });

  test("does not re-ask once a family has been answered, either way", async () => {
    const buffer = await docxNaming("Allowed Face", "Declined Face");
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Allowed Face", "Declined Face"]);

    rememberFontDecision(["Allowed Face"], true);
    rememberFontDecision(["Declined Face"], false);
    expect(await unresolvedDocumentFonts(buffer)).toEqual([]);
  });

  test("returns nothing for a package it cannot read", async () => {
    expect(await unresolvedDocumentFonts(new ArrayBuffer(8))).toEqual([]);
  });

  test("the shipped fixture needs no font download", async () => {
    // legal-review.docx is set in Arial, which maps to the bundled Arimo.
    expect(await unresolvedDocumentFonts(fixture("legal-review.docx"))).toEqual([]);
  });
});
