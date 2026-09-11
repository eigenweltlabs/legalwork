import { describe, expect, test } from "bun:test";
import { LEGALMEMORY_EXPORT_DIR, safeExportFilename, safeExportRelativePath } from "./legalmemory-export.js";

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

describe("LEGALMEMORY_EXPORT_DIR", () => {
  test("is a workspace-relative folder of its own", () => {
    expect(LEGALMEMORY_EXPORT_DIR).toBe(".legalmemory");
    // Relative and single-segment: joined onto the workspace root, it cannot
    // escape it.
    expect(LEGALMEMORY_EXPORT_DIR.includes("/")).toBe(false);
    expect(LEGALMEMORY_EXPORT_DIR.startsWith("/")).toBe(false);
  });
});

describe("safeExportRelativePath", () => {
  test("keeps the shape of a folder dragged out of the drive", () => {
    expect(safeExportRelativePath("Pleadings/Answer.docx")).toBe("Pleadings/Answer.docx");
    expect(safeExportRelativePath("Korrespondenz\\2026\\Anlage_3 – Gebühren.pdf"))
      .toBe("Korrespondenz/2026/Anlage_3 – Gebühren.pdf");
  });

  test("refuses a path that would leave the export folder", () => {
    expect(safeExportRelativePath("../../etc/passwd")).toBeNull();
    expect(safeExportRelativePath("Pleadings/../../../evil.docx")).toBeNull();
    expect(safeExportRelativePath("/absolute/Deed.docx")).toBe("absolute/Deed.docx");
  });

  test("refuses a path with an unusable segment rather than flattening it", () => {
    expect(safeExportRelativePath(".hidden/Deed.docx")).toBeNull();
    expect(safeExportRelativePath("Pleadings/Deed\u0000.docx")).toBeNull();
    expect(safeExportRelativePath("")).toBeNull();
    expect(safeExportRelativePath("///")).toBeNull();
  });
});
