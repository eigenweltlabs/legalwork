import { describe, expect, test } from "bun:test";

import {
  createLegalMemoryComposerMention,
  decodeComposerMentionValue,
  encodeComposerMentionValue,
  legalMemoryComposerInstruction,
  legalMemoryComposerDisplayText,
  parseLegalMemoryComposerMention,
} from "../src/react-app/domains/session/surface/composer/mention-encoding";

describe("mention-encoding", () => {
  test("round-trips paths with spaces", () => {
    const value = "docs/foo bar.md";
    expect(decodeComposerMentionValue(encodeComposerMentionValue(value))).toBe(value);
    expect(encodeComposerMentionValue(value)).toBe("docs/foo%20bar.md");
  });

  test("preserves literal percent-encoded sequences in paths", () => {
    const value = "docs/foo%20bar.md";
    expect(encodeComposerMentionValue(value)).toBe("docs/foo%2520bar.md");
    expect(decodeComposerMentionValue("docs/foo%2520bar.md")).toBe(value);
  });

  test("round-trips percent signs", () => {
    const value = "docs/100% done.md";
    expect(decodeComposerMentionValue(encodeComposerMentionValue(value))).toBe(value);
  });

  test("keeps a memory filename for the pill and a canonical URI for the agent", () => {
    const value = createLegalMemoryComposerMention("doc-123", "Member consent final.docx");
    expect(parseLegalMemoryComposerMention(value)).toEqual({
      documentId: "doc-123",
      label: "Member consent final.docx",
      uri: "legalmemory://document/doc-123",
    });
    const instruction = legalMemoryComposerInstruction(value);
    expect(instruction).toContain('fetch and read "Member consent final.docx"');
    expect(instruction).toContain("legalmemory://document/doc-123");
    expect(instruction).toContain("not a local workspace file");
  });

  test("keeps a downloaded workspace path as memory metadata instead of an attachment", () => {
    const value = createLegalMemoryComposerMention(
      "doc-123",
      "Member consent final.docx",
      ".legalmemory/Member consent final.docx",
    );
    expect(parseLegalMemoryComposerMention(value)).toEqual({
      documentId: "doc-123",
      label: "Member consent final.docx",
      localPath: ".legalmemory/Member consent final.docx",
      uri: "legalmemory://document/doc-123",
    });
    const instruction = legalMemoryComposerInstruction(value);
    expect(instruction).toContain('workspace path ".legalmemory/Member consent final.docx"');
    expect(instruction).toContain("extract or convert DOCX");
    expect(instruction).toContain("not a binary chat attachment");
    expect(legalMemoryComposerDisplayText(value)).toBe(
      "[Member consent final.docx](legalmemory://document/doc-123)",
    );
  });
});
