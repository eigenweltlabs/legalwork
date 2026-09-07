import { describe, expect, test } from "bun:test";
import { importViewerFile } from "../src/react-app/domains/session/panel/import-viewer-file";

describe("viewer working copies", () => {
  test("preserves bytes, separates duplicate names and selects the matching viewer", async () => {
    const bytes = new Uint8Array([80, 75, 0, 255, 128]);
    const client = { writeWorkspaceBinaryFile: async (workspace: string, payload: { path: string; data: ArrayBuffer }) => {
      expect(workspace).toBe("ws-test");
      expect(new Uint8Array(payload.data)).toEqual(bytes);
      return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 42 };
    } };
    const first = await importViewerFile(client, "ws-test", new File([bytes], "Budget [final].xlsx"));
    const second = await importViewerFile(client, "ws-test", new File([bytes], "Budget [final].xlsx"));
    expect(first.value).toStartWith(".legalwork/tmp/");
    expect(first.value).not.toBe(second.value);
    expect(first).toMatchObject({ label: "Budget [final].xlsx", preview: "sheet", size: bytes.length, updatedAt: 42 });
    const unknown = await importViewerFile(client, "ws-test", new File([bytes], "archive.custom"));
    expect(unknown.preview).toBe("external");
  });

  test("failed copies do not create usable tabs", async () => {
    await expect(importViewerFile({ writeWorkspaceBinaryFile: async () => ({ ok: false, path: "", bytes: 0, updatedAt: 0 }) }, "ws-test", new File(["draft"], "draft.txt")))
      .rejects.toThrow("could not be copied");
  });
});
