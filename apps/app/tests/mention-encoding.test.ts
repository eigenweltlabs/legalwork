import { describe, expect, test } from "bun:test";

import {
  createLegalMemoryComposerMention,
  createLegalMemoryFolderComposerMention,
  decodeComposerMentionValue,
  encodeComposerMentionValue,
  legalMemoryComposerInstruction,
  legalMemoryComposerDisplayText,
  parseLegalMemoryComposerMention,
  parseLegalMemoryFolderComposerMention,
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

  test("turns a dropped folder into one pill pointing at the copied folder", () => {
    const value = createLegalMemoryFolderComposerMention(
      "source-7",
      "Pleadings",
      ".legalmemory/Pleadings",
      12,
    );
    expect(parseLegalMemoryFolderComposerMention(value)).toEqual({
      sourceId: "source-7",
      label: "Pleadings",
      localPath: ".legalmemory/Pleadings",
      files: 12,
    });
    const instruction = legalMemoryComposerInstruction(value);
    expect(instruction).toContain('LegalMemory folder "Pleadings"');
    expect(instruction).toContain("12 documents");
    expect(instruction).toContain('workspace folder ".legalmemory/Pleadings"');
    expect(legalMemoryComposerDisplayText(value)).toBe("[Pleadings](.legalmemory/Pleadings)");
  });

  test("keeps folder and document mentions apart", () => {
    const folder = createLegalMemoryFolderComposerMention("source-7", "Pleadings", ".legalmemory/Pleadings", 1);
    const document = createLegalMemoryComposerMention("doc-123", "Answer.docx", ".legalmemory/Answer.docx");
    expect(parseLegalMemoryComposerMention(folder)).toBeNull();
    expect(parseLegalMemoryFolderComposerMention(document)).toBeNull();
    // A single-document folder still reads as a folder, not as one file.
    expect(legalMemoryComposerInstruction(folder)).toContain("Its 1 document was copied");
  });
});
