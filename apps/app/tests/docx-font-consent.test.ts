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

/**
 * A .docx whose body text defers to the theme, the way Word writes a new
 * document: the styles name a slot, and only the theme says which family it is.
 */
async function docxWithTheme(options: {
  major: string;
  minor: string;
  /** How the document refers to the theme; omit for a theme nothing uses. */
  reference?: "minor" | "major" | "drawing-minor" | "drawing-major" | "none";
}): Promise<ArrayBuffer> {
  const { default: JSZip } = await import("jszip");
  const reference = options.reference ?? "minor";
  const styles =
    reference === "minor"
      ? '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>'
      : reference === "major"
        ? '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>'
        : "";
  const drawing =
    reference === "drawing-minor"
      ? '<a:latin typeface="+mn-lt"/>'
      : reference === "drawing-major"
        ? '<a:latin typeface="+mj-lt"/>'
        : "";
  const zip = new JSZip();
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0"?><w:styles xmlns:w="x"><w:docDefaults><w:rPrDefault><w:rPr>${styles}</w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x" xmlns:a="y"><w:body><w:p><w:r><w:rPr>${drawing}</w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`,
  );
  zip.file(
    "word/theme/theme1.xml",
    `<?xml version="1.0"?><a:theme xmlns:a="y"><a:themeElements><a:fontScheme name="Office">` +
      `<a:majorFont><a:latin typeface="${options.major}" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="${options.minor}" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
      `</a:fontScheme></a:themeElements></a:theme>`,
  );
  return await zip.generateAsync({ type: "arraybuffer" });
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

  test("flags the theme font of a document that defers to the theme", async () => {
    // What Word 365 writes for a new blank document: no font named in the text,
    // Aptos in the theme. Missing this meant the app's most common document
    // silently fell back to another face.
    const buffer = await docxWithTheme({ major: "Aptos Display", minor: "Aptos" });
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Aptos"]);
  });

  test("flags the major theme font when a heading style uses that slot", async () => {
    const buffer = await docxWithTheme({ major: "Aptos Display", minor: "Aptos", reference: "major" });
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Aptos Display"]);
  });

  test("reads +mn-lt and +mj-lt references from shape text", async () => {
    const minor = await docxWithTheme({ major: "Aptos Display", minor: "Aptos", reference: "drawing-minor" });
    expect(await unresolvedDocumentFonts(minor)).toEqual(["Aptos"]);
    const major = await docxWithTheme({ major: "Aptos Display", minor: "Aptos", reference: "drawing-major" });
    expect(await unresolvedDocumentFonts(major)).toEqual(["Aptos Display"]);
  });

  test("ignores a theme font when nothing defers to the theme", async () => {
    const buffer = await docxWithTheme({ major: "Aptos Display", minor: "Aptos", reference: "none" });
    expect(await unresolvedDocumentFonts(buffer)).toEqual([]);
  });

  test("ignores a theme font that is bundled anyway", async () => {
    // The older Office theme, still in most documents in circulation.
    const buffer = await docxWithTheme({ major: "Calibri Light", minor: "Calibri" });
    expect(await unresolvedDocumentFonts(buffer)).toEqual([]);
  });

  test("names a font used only by shape text", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="x" xmlns:a="y"><w:body><w:p><w:r><w:rPr>' +
        '<a:latin typeface="Zeta Display"/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>',
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    expect(await unresolvedDocumentFonts(buffer)).toEqual(["Zeta Display"]);
  });

  test("the shipped fixture needs no font download", async () => {
    // legal-review.docx is set in Arial, which maps to the bundled Arimo.
    expect(await unresolvedDocumentFonts(fixture("legal-review.docx"))).toEqual([]);
  });
});
