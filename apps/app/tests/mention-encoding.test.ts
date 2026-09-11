import { describe, expect, test } from "bun:test";

import {
  createLegalMemoryComposerMention,
  decodeComposerMentionValue,
  encodeComposerMentionValue,
  legalMemoryComposerInstruction,
  legalMemoryComposerDisplayText,
  parseLegalMemoryComposerMention,
  createStorageComposerMention,
  parseStorageComposerMention,
  storageComposerInstruction,
  storageComposerDisplayText,
} from "../src/react-app/domains/session/surface/composer/mention-encoding";
import { STORAGE_LINK_SOURCE, parseStorageRefLink } from "../src/components/markdown/storage-ref";

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

describe("storage mentions", () => {
  test("keeps the filename for the pill and the connection + path for the agent", () => {
    const value = createStorageComposerMention(
      "conn-1",
      "1001-00003/Diligence/competitor-identification-chart.xlsx",
      "competitor-identification-chart.xlsx",
      ".legalwork/storage-downloads/file-UTukY5/competitor-identification-chart.xlsx",
    );
    const mention = parseStorageComposerMention(value);
    expect(mention?.connectionId).toBe("conn-1");
    expect(mention?.path).toBe("1001-00003/Diligence/competitor-identification-chart.xlsx");
    expect(mention?.label).toBe("competitor-identification-chart.xlsx");
    expect(mention?.localPath).toBe(".legalwork/storage-downloads/file-UTukY5/competitor-identification-chart.xlsx");
  });

  test("tells the agent to open the checked-out copy with a format-aware tool", () => {
    const value = createStorageComposerMention(
      "conn-1",
      "a/b/competitor-identification-chart.xlsx",
      "competitor-identification-chart.xlsx",
      ".legalwork/storage-downloads/file-UTukY5/competitor-identification-chart.xlsx",
    );
    const instruction = storageComposerInstruction(value);
    // The binary-read failure came from handing a workspace path to a plain
    // text reader. The instruction must name the copy AND the format caveat.
    expect(instruction).toContain(".legalwork/storage-downloads/file-UTukY5/competitor-identification-chart.xlsx");
    expect(instruction).toContain("document-capable tool");
    expect(instruction).toContain("rather than reading it as plain text");
  });

  test("falls back to fetching through storage tools when there is no local copy", () => {
    const value = createStorageComposerMention("conn-1", "a/b.docx", "b.docx");
    expect(parseStorageComposerMention(value)?.localPath).toBeUndefined();
    expect(storageComposerInstruction(value)).toContain("storage tools");
  });

  test("shows the filename as the badge label and keeps the path behind it", () => {
    const value = createStorageComposerMention(
      "conn-1",
      "a/b/chart.xlsx",
      "chart.xlsx",
      ".legalwork/storage-downloads/file-UTukY5/chart.xlsx",
    );
    const display = storageComposerDisplayText(value);
    // Visible label is just the filename; the checkout path rides in the href
    // so the chip can open the copy without another round-trip.
    expect(display.startsWith("[chart.xlsx](legalworkstorage://conn-1/a%2Fb%2Fchart.xlsx?")).toBe(true);
    expect(display.slice(0, display.indexOf("]("))).toBe("[chart.xlsx");
    expect(parseStorageRefLink(display)?.localPath).toBe(".legalwork/storage-downloads/file-UTukY5/chart.xlsx");
  });

  test("the user-turn renderer recognises the persisted link as one chip token", () => {
    const value = createStorageComposerMention("conn-1", "a/b/chart.xlsx", "chart.xlsx", "copy/chart.xlsx");
    const display = storageComposerDisplayText(value);
    const ref = parseStorageRefLink(display);
    expect(ref?.label).toBe("chart.xlsx");
    expect(ref?.connectionId).toBe("conn-1");
    expect(ref?.path).toBe("a/b/chart.xlsx");
    // The whole link must match as a single token, otherwise it renders raw.
    expect(new RegExp(`^${STORAGE_LINK_SOURCE}$`).test(display)).toBe(true);
  });

  test("round-trips paths containing spaces and unicode", () => {
    const path = "Matters/Acquisition/Übernahme entwurf.docx";
    const value = createStorageComposerMention("conn-2", path, "Übernahme entwurf.docx");
    expect(parseStorageComposerMention(value)?.path).toBe(path);
  });

  test("ignores values that are not storage mentions", () => {
    expect(parseStorageComposerMention("legalmemory://document/abc")).toBeNull();
    expect(parseStorageComposerMention("not a uri")).toBeNull();
    expect(parseStorageComposerMention("legalworkstorage://conn-only")).toBeNull();
  });
});
