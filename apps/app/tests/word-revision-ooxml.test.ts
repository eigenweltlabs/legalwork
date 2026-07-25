import { describe, expect, test } from "bun:test";

import { REVISION_AUTHOR, revisionOoxml } from "../src/word-addin/word-document-tools";

/**
 * The w:ins/w:del fallback for Word hosts without WordApi 1.4: the package
 * must be a valid single-paragraph Flat OPC document whose revision runs
 * Word accepts as real tracked changes.
 */
describe("revisionOoxml", () => {
  test("replace = deletion of the old text plus insertion of the new text", () => {
    const pkg = revisionOoxml([
      { kind: "del", text: "old clause" },
      { kind: "ins", text: "new clause" },
    ]);
    expect(pkg).toContain(`<w:delText xml:space="preserve">old clause</w:delText>`);
    expect(pkg).toContain(`<w:t xml:space="preserve">new clause</w:t>`);
    expect(pkg.indexOf("<w:del ")).toBeLessThan(pkg.indexOf("<w:ins "));
    expect(pkg).toContain(`w:author="${REVISION_AUTHOR}"`);
    expect(pkg).toMatch(/w:date="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/);
  });

  test("empty parts are dropped, so a pure deletion has no w:ins", () => {
    const pkg = revisionOoxml([
      { kind: "del", text: "gone" },
      { kind: "ins", text: "" },
    ]);
    expect(pkg).toContain("<w:del ");
    expect(pkg).not.toContain("<w:ins ");
  });

  test("XML metacharacters in document text are escaped", () => {
    const pkg = revisionOoxml([{ kind: "ins", text: `a < b & "c" > d` }]);
    expect(pkg).toContain("a &lt; b &amp; &quot;c&quot; &gt; d");
    expect(pkg).not.toContain(`a < b`);
  });

  test("newlines in inserted text become w:br line breaks", () => {
    const pkg = revisionOoxml([{ kind: "ins", text: "line one\nline two" }]);
    expect(pkg).toContain(
      `<w:t xml:space="preserve">line one</w:t><w:br/><w:t xml:space="preserve">line two</w:t>`,
    );
  });

  test("package is a single-paragraph Flat OPC document", () => {
    const pkg = revisionOoxml([{ kind: "ins", text: "x" }]);
    expect(pkg.startsWith(`<pkg:package `)).toBe(true);
    expect(pkg).toContain(`pkg:name="/word/document.xml"`);
    expect(pkg.match(/<w:p>/g)).toHaveLength(1);
    expect(pkg).toContain("<w:body><w:p>");
  });

  test("revision ids are unique across calls", () => {
    const first = revisionOoxml([{ kind: "ins", text: "a" }]);
    const second = revisionOoxml([{ kind: "ins", text: "b" }]);
    const id = (pkg: string) => pkg.match(/w:id="(\d+)"/)?.[1];
    expect(id(first)).toBeDefined();
    expect(id(second)).toBeDefined();
    expect(id(first)).not.toBe(id(second));
  });
});
