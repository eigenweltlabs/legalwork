import { describe, expect, test } from "bun:test";
import {
  exportSizeRejection,
  legalMemoryOrigins,
  safeExportFilename,
  validateDownloadUrl,
} from "./legalmemory-export.js";

const APPLIANCE = "https://ki.firm.com";
const TOKEN = "Ab3-_x9y8Z7w6V5u4T3s2R1q";
const OK = `${APPLIANCE}/api/downloads/${TOKEN}/Agreement%20for%20Lease.docx`;

describe("legalMemoryOrigins", () => {
  test("collects origins for both server names the firm may use", () => {
    const origins = legalMemoryOrigins([
      { name: "legalmemory", config: { url: `${APPLIANCE}/mcp/` } },
      { name: "knowledge-index", config: { url: "http://127.0.0.1:8000/mcp/" } },
    ]);
    expect(origins).toEqual(new Set([APPLIANCE, "http://127.0.0.1:8000"]));
  });

  test("ignores other MCP servers entirely", () => {
    const origins = legalMemoryOrigins([
      { name: "notion", config: { url: "https://mcp.notion.com/mcp" } },
      { name: "imanage", config: { url: "https://firm.imanage.com/mcp" } },
    ]);
    expect(origins.size).toBe(0);
  });

  test("survives a malformed or missing url without losing a valid appliance", () => {
    const origins = legalMemoryOrigins([
      { name: "legalmemory", config: { url: "not a url" } },
      { name: "legalmemory", config: {} },
      { name: "legalmemory" },
      { name: "knowledge-index", config: { url: `${APPLIANCE}/mcp/` } },
    ]);
    expect(origins).toEqual(new Set([APPLIANCE]));
  });
});

describe("validateDownloadUrl", () => {
  const allowed = new Set([APPLIANCE]);

  test("accepts the appliance's own download route", () => {
    expect(validateDownloadUrl(OK, allowed)).toEqual({
      url: `${APPLIANCE}/api/downloads/${TOKEN}/Agreement%20for%20Lease.docx`,
      filename: "Agreement for Lease.docx",
    });
  });

  test("rejects any origin the firm has not configured", () => {
    expect(validateDownloadUrl(`https://evil.example/api/downloads/${TOKEN}/x.docx`, allowed)).toBeNull();
    // A lookalike host must not pass on a prefix match.
    expect(validateDownloadUrl(`https://ki.firm.com.evil.example/api/downloads/${TOKEN}/x.docx`, allowed)).toBeNull();
    // Same host, different port is a different origin.
    expect(validateDownloadUrl(`https://ki.firm.com:8443/api/downloads/${TOKEN}/x.docx`, allowed)).toBeNull();
  });

  test("rejects other endpoints on an allowed appliance", () => {
    expect(validateDownloadUrl(`${APPLIANCE}/api/graph`, allowed)).toBeNull();
    expect(validateDownloadUrl(`${APPLIANCE}/mcp/`, allowed)).toBeNull();
    expect(validateDownloadUrl(`${APPLIANCE}/api/downloads/${TOKEN}/sub/dir.docx`, allowed)).toBeNull();
    expect(validateDownloadUrl(`${APPLIANCE}/api/downloads/short/x.docx`, allowed)).toBeNull();
  });

  test("rejects non-http schemes", () => {
    expect(validateDownloadUrl(`file:///etc/passwd`, allowed)).toBeNull();
    expect(validateDownloadUrl(`javascript:alert(1)`, allowed)).toBeNull();
  });

  test("allows a plain-http on-prem appliance when that is what is configured", () => {
    const local = new Set(["http://127.0.0.1:8000"]);
    expect(validateDownloadUrl(`http://127.0.0.1:8000/api/downloads/${TOKEN}/Deed.docx`, local)).toEqual({
      url: `http://127.0.0.1:8000/api/downloads/${TOKEN}/Deed.docx`,
      filename: "Deed.docx",
    });
  });

  test("drops any query or fragment rather than forwarding it", () => {
    const result = validateDownloadUrl(`${OK}?redirect=https://evil.example#x`, allowed);
    expect(result?.url).toBe(`${APPLIANCE}/api/downloads/${TOKEN}/Agreement%20for%20Lease.docx`);
  });

  test("collapses an encoded traversal to a bare name in the workspace root", () => {
    // %2f survives URL parsing as part of the segment, so it only becomes a
    // separator once decoded. The name is reduced rather than refused: the
    // result cannot leave the workspace either way.
    expect(validateDownloadUrl(`${APPLIANCE}/api/downloads/${TOKEN}/..%2f..%2fevil.docx`, allowed)).toEqual({
      url: `${APPLIANCE}/api/downloads/${TOKEN}/..%2f..%2fevil.docx`,
      filename: "evil.docx",
    });
  });

  test("rejects a real path traversal in the URL path itself", () => {
    // A literal slash makes the path stop matching the download route.
    expect(validateDownloadUrl(`${APPLIANCE}/api/downloads/${TOKEN}/../../evil.docx`, allowed)).toBeNull();
  });

  test("rejects junk input", () => {
    expect(validateDownloadUrl("", allowed)).toBeNull();
    expect(validateDownloadUrl(null, allowed)).toBeNull();
    expect(validateDownloadUrl(OK, new Set())).toBeNull();
  });
});

describe("safeExportFilename", () => {
  test("keeps the punctuation real legal filenames carry", () => {
    expect(safeExportFilename("Project Meridian - Agreement (Execution Version).docx")).toBe(
      "Project Meridian - Agreement (Execution Version).docx",
    );
    expect(safeExportFilename("Schedule 6 · Landlord's Works.docx")).toBe("Schedule 6 · Landlord's Works.docx");
    expect(safeExportFilename("Anlage_3 – Gebühren, 2026.pdf")).toBe("Anlage_3 – Gebühren, 2026.pdf");
  });

  test("reduces any path to a bare name in the workspace root", () => {
    expect(safeExportFilename("../../etc/passwd")).toBe("passwd");
    expect(safeExportFilename("C:\\Windows\\System32\\evil.dll")).toBe("evil.dll");
    expect(safeExportFilename("/absolute/Deed.docx")).toBe("Deed.docx");
  });

  test("rejects names that are not names", () => {
    expect(safeExportFilename("")).toBeNull();
    expect(safeExportFilename("   ")).toBeNull();
    expect(safeExportFilename("..")).toBeNull();
    expect(safeExportFilename("../")).toBeNull();
  });

  test("rejects a dotfile, which would hide the export from the user", () => {
    expect(safeExportFilename(".env")).toBeNull();
    expect(safeExportFilename(".hidden.docx")).toBeNull();
  });

  test("rejects control characters and shell-hostile names", () => {
    expect(safeExportFilename("Deed\u0000.docx")).toBeNull();
    expect(safeExportFilename("Deed\n.docx")).toBeNull();
    expect(safeExportFilename('Deed".docx')).toBeNull();
    expect(safeExportFilename("Deed|rm.docx")).toBeNull();
  });

  test("caps an absurdly long name", () => {
    expect(safeExportFilename(`${"a".repeat(400)}.docx`)?.length).toBe(200);
  });
});

describe("exportSizeRejection", () => {
  test("rejects a body over the limit", () => {
    expect(exportSizeRejection(String(600 * 1024 * 1024))).toContain("export limit");
  });

  test("accepts a normal document, or one that declares no length", () => {
    expect(exportSizeRejection(String(2 * 1024 * 1024))).toBeNull();
    expect(exportSizeRejection(undefined)).toBeNull();
    expect(exportSizeRejection("not a number")).toBeNull();
  });
});
