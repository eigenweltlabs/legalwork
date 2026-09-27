import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrInstaller } from "./installer.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "ocr-installer-")); roots.push(path); return path; }
const missing = async () => { throw new Error("not installed"); };

test("supported hosts can set up uv without a PATH prerequisite; explicit overrides are respected", async () => {
  const path = await root();
  expect(await new OcrInstaller(path, "", missing).available()).toBe(true);
  const override = new OcrInstaller(path, "/explicit/uv", missing);
  expect(await override.available()).toBe(false);
  await expect(override.ensure(new AbortController().signal)).rejects.toThrow("not installed");
});

test("reuses an existing installer without downloading, and checks cancellation first", async () => {
  const calls: string[] = [], path = await root();
  const installer = new OcrInstaller(path, "", async command => { calls.push(command); });
  const command = await installer.ensure(new AbortController().signal);
  expect(command).toContain(path); expect(await installer.ensure(new AbortController().signal)).toBe(command); expect(calls.length).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(installer.ensure(controller.signal)).rejects.toThrow(); expect(calls.length).toBe(1);
});

test("rejects an unverified or oversized archive and removes temporary downloads", async () => {
  const path = await root();
  const download = spyOn(globalThis, "fetch").mockResolvedValue(new Response("not a signed release asset"));
  try {
    await expect(new OcrInstaller(path, "", missing).ensure(new AbortController().signal)).rejects.toThrow("checksum");
    const versionDir = join(path, "installer", "0.12.19");
    expect(await readdir(versionDir)).toEqual([]);
    download.mockResolvedValue(new Response("too large", { headers: { "content-length": String(65 * 1024 * 1024) } }));
    await expect(new OcrInstaller(path, "", missing).ensure(new AbortController().signal)).rejects.toThrow("download");
    expect(await readdir(versionDir)).toEqual([]);
  } finally { download.mockRestore(); }
});
