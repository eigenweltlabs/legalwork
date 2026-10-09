/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StorageTransferStatus } from "../src/react-app/domains/session/panel/storage-transfer-status";

describe("folder transfer progress", () => {
  test("shows completed file count, actual speed and a determinate progress bar", () => {
    const html = renderToStaticMarkup(<StorageTransferStatus label="Moving matter…" progress={{ phase: "transferring", completedFiles: 12, totalFiles: 48, elapsedMs: 4000, currentFile: "matter/a.txt" }} />);
    expect(html).toContain("12/48 files");
    expect(html).toContain("3 files/s");
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("matter/a.txt");
  });
  test("does not invent a percentage while the folder's file count is unknown", () => {
    const html = renderToStaticMarkup(<StorageTransferStatus label="Moving matter…" progress={{ phase: "scanning", completedFiles: 12, totalFiles: null, elapsedMs: 500 }} />);
    expect(html).toContain("Counting files: 12");
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("files/s");
  });
  test("keeps verification and source cleanup visible as distinct phases", () => {
    for (const phase of ["verifying", "removing"] satisfies Array<"verifying" | "removing">) {
      const html = renderToStaticMarkup(<StorageTransferStatus label="Moving matter…" progress={{ phase, completedFiles: 24, totalFiles: 48, elapsedMs: 4000 }} />);
      expect(html).toContain(phase === "verifying" ? "Verifying: 24/48 files" : "Finishing move: 24/48 files");
      expect(html).not.toContain("files/s");
    }
  });
});
