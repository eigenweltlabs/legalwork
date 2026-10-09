import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveErrorDetails } from "./error-export.mjs";

const uuid = "f219a80c-3408-45ca-b75d-95ca1d2d5e0a";
const contents = JSON.stringify({ uuid, event: "$exception", properties: { status_code: 401 } });

test("error export keeps exact details until the native destination is chosen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legalwork-error-export-"));
  const file = path.join(directory, "error.json");
  /** @type {(destination: { canceled: boolean; filePath: string }) => void} */
  let choose = () => { throw new Error("Save dialog not ready"); };
  const pending = new Promise(resolve => { choose = resolve; });
  try {
    const saving = saveErrorDetails(contents, async options => {
      assert.equal(options.defaultPath, `legalwork-error-${uuid}.json`);
      return pending;
    }, writeFile);
    await assert.rejects(stat(file), { code: "ENOENT" });
    choose({ canceled: false, filePath: file });
    assert.equal(await saving, true);
    assert.equal(await readFile(file, "utf8"), contents);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancelled and invalid error exports never write", async () => {
  const write = () => assert.fail("unexpected write");
  assert.equal(await saveErrorDetails(contents, async () => ({ canceled: true }), write), false);
  const choose = () => assert.fail("unexpected dialog");
  for (const value of [null, "x".repeat(32_000_001), "{}", JSON.stringify({ uuid: "../file", event: "$exception" })]) {
    await assert.rejects(saveErrorDetails(value, choose, write));
  }
});

test("full reports larger than the old 128 KB limit save without losing details", async () => {
  const full = JSON.stringify({ uuid, event: "$exception", properties: { error_details: { logs: "diagnostic line\n".repeat(20_000) } } });
  let saved;
  assert.equal(await saveErrorDetails(full, async () => ({ canceled: false, filePath: "/chosen/report.json" }), async (_file, text) => { saved = text; }), true);
  assert.equal(saved, full);
});
