import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { receiveRequestFile } from "./file-upload.js";
import { PDF_MAX_BYTES } from "./pdf-read-schema.js";

test("streamed files enforce both declared and actual size and preserve binary bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-upload-test-"));
  try {
    const data = new Uint8Array([0, 255, 128, 10]);
    const saved = await receiveRequestFile(new Request("http://local/upload", { method: "POST", body: data }), join(root, "good"), 4);
    expect(saved.size).toBe(4); expect(new Uint8Array(await readFile(join(root, "good")))).toEqual(data);
    await expect(receiveRequestFile(new Request("http://local/upload", { method: "POST", body: data }), join(root, "overflow"), 3))
      .rejects.toMatchObject({ status: 413, code: "file_too_large" });
    await expect(receiveRequestFile(new Request("http://local/upload", { method: "POST", body: data,
      headers: { "Content-Length": String(PDF_MAX_BYTES + 1) } }), join(root, "declared"), PDF_MAX_BYTES))
      .rejects.toMatchObject({ status: 413, code: "file_too_large" });
    const controller = new AbortController(); controller.abort();
    await expect(receiveRequestFile(new Request("http://local/upload", { method: "POST", body: data, signal: controller.signal }), join(root, "cancelled"), 4))
      .rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
