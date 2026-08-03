import { describe, expect, test } from "bun:test";
import { formatExportSize, parseLegalMemoryDownload } from "@/lib/legalmemory-download";
import { isLegalMemoryDownloadToolPart } from "@/lib/build-in-tools";

const TOKEN = "Ab3-_x9y8Z7w6V5u4T3s2R1q";
const URL_ = `https://ki.firm.com/api/downloads/${TOKEN}/Agreement%20for%20Lease.docx`;

describe("parseLegalMemoryDownload", () => {
  test("reads the structured metadata the tool returns", () => {
    expect(
      parseLegalMemoryDownload({
        document_id: "doc-afl",
        filename: "Agreement for Lease.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes: 245_760,
        download_url: URL_,
      }),
    ).toEqual({ url: URL_, filename: "Agreement for Lease.docx", sizeBytes: 245_760 });
  });

  test("accepts the payload as serialized JSON", () => {
    const parsed = parseLegalMemoryDownload(JSON.stringify({ download_url: URL_, filename: "Deed.docx" }));
    expect(parsed).toMatchObject({ url: URL_, filename: "Deed.docx" });
  });

  test("finds the link inside MCP resource-link content", () => {
    const parsed = parseLegalMemoryDownload([
      { type: "text", text: "Exact original ready: Agreement for Lease.docx" },
      { type: "resource_link", name: "Agreement for Lease.docx", uri: URL_, size: 245_760 },
    ]);
    expect(parsed).toMatchObject({ url: URL_, filename: "Agreement for Lease.docx", sizeBytes: 245_760 });
  });

  test("falls back to the save_command text when that is all that arrives", () => {
    const text = `Exact original ready: Agreement for Lease.docx (245760 bytes, SHA-256 abc). Run this from the current workspace now:\ncurl --fail --location --output 'Agreement for Lease.docx' '${URL_}'`;
    expect(parseLegalMemoryDownload(text)).toEqual({
      url: URL_,
      filename: "Agreement for Lease.docx",
    });
  });

  test("returns null when there is no download link to find", () => {
    expect(parseLegalMemoryDownload("document is unavailable")).toBeNull();
    expect(parseLegalMemoryDownload({ document_id: "doc-afl" })).toBeNull();
    expect(parseLegalMemoryDownload(null)).toBeNull();
  });

  test("ignores a link that is not the appliance download route", () => {
    expect(parseLegalMemoryDownload({ download_url: "https://evil.example/x.docx" })).toBeNull();
  });
});

describe("formatExportSize", () => {
  test("reads at a glance", () => {
    expect(formatExportSize(512)).toBe("512 B");
    expect(formatExportSize(245_760)).toBe("240 KB");
    expect(formatExportSize(5_400_000)).toBe("5.1 MB");
  });

  test("says nothing when the size is unknown", () => {
    expect(formatExportSize(undefined)).toBeNull();
    expect(formatExportSize(0)).toBeNull();
  });
});

describe("isLegalMemoryDownloadToolPart", () => {
  const part = (toolName: string) => ({ type: "dynamic-tool" as const, toolName }) as never;

  test("matches under any server name", () => {
    expect(isLegalMemoryDownloadToolPart(part("legalmemory_download_document"))).toBe(true);
    expect(isLegalMemoryDownloadToolPart(part("knowledge-index_download_document"))).toBe(true);
  });

  test("does not swallow get_document", () => {
    expect(isLegalMemoryDownloadToolPart(part("legalmemory_get_document"))).toBe(false);
  });
});
