import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { retireMessagingTools } from "../dist/retired-messaging-tools.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-retired-messaging-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("old connector flags cannot start a messaging process", () => {
  for (const flag of ["--opencode-router", "--no-opencode-router", "--opencode-router-bin", "--opencode-router-health-port", "--opencode-router-required"]) {
    const result = spawnSync(process.execPath, [cli, "start", flag], { encoding: "utf8" });
    assert.equal(result.status, 1, flag);
    assert.match(result.stderr, /Messaging connectors have been removed/);
  }
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.doesNotMatch(help, /opencode-router|Telegram|Slack/);
});

test("retires old bot tools while preserving edits and unrelated tools", () => fixture(async (root) => {
  await mkdir(join(root, "tools"));
  const tools = new Map([
    ["opencode_router_send.ts", "customized send tool"],
    ["opencode_router_status.ts", "customized status tool"],
  ]);
  for (const [name, content] of tools) await writeFile(join(root, "tools", name), content);
  await writeFile(join(root, "tools", "document.ts"), "supported document tool");
  await retireMessagingTools(root);
  assert.deepEqual(await readdir(join(root, "tools")), ["document.ts"]);
  const archived = await readdir(join(root, "retired-messaging-tools"));
  assert.equal(archived.length, 2);
  for (const [name, content] of tools) {
    const backup = archived.find((file) => file.startsWith(`${name}.`) && file.endsWith(".disabled"));
    assert.ok(backup);
    assert.equal(await readFile(join(root, "retired-messaging-tools", backup), "utf8"), content);
  }
  await retireMessagingTools(root);
  assert.deepEqual(await readdir(join(root, "retired-messaging-tools")), archived);
}));

test("retirement preserves previous archives", () => fixture(async (root) => {
  await mkdir(join(root, "tools"));
  await mkdir(join(root, "retired-messaging-tools"));
  await writeFile(join(root, "retired-messaging-tools", "previous.disabled"), "older copy");
  await writeFile(join(root, "tools", "opencode_router_send.ts"), "newer copy");
  await retireMessagingTools(root);
  assert.equal(await readFile(join(root, "retired-messaging-tools", "previous.disabled"), "utf8"), "older copy");
  assert.equal((await readdir(join(root, "retired-messaging-tools"))).length, 2);
}));

test("retires native messaging plugins with local edits and preserves unrelated plugins", () => fixture(async (root) => {
  for (const name of ["legalwork-messaging-send", "legalwork-messaging-status", "legalwork-documents"]) {
    await mkdir(join(root, "plugins", name, "resources"), { recursive: true });
    await writeFile(join(root, "plugins", name, "index.js"), `customized ${name}`);
    await writeFile(join(root, "plugins", name, "resources", "notes.txt"), `local notes ${name}`);
  }
  await retireMessagingTools(root);
  assert.deepEqual(await readdir(join(root, "plugins")), ["legalwork-documents"]);
  const archived = await readdir(join(root, "retired-messaging-tools"));
  assert.equal(archived.length, 2);
  for (const name of ["legalwork-messaging-send", "legalwork-messaging-status"]) {
    const backup = archived.find((entry) => entry.startsWith(`${name}.`) && entry.endsWith(".disabled"));
    assert.ok(backup);
    assert.equal(await readFile(join(root, "retired-messaging-tools", backup, "index.js"), "utf8"), `customized ${name}`);
    assert.equal(await readFile(join(root, "retired-messaging-tools", backup, "resources", "notes.txt"), "utf8"), `local notes ${name}`);
  }
  assert.equal(await readFile(join(root, "plugins", "legalwork-documents", "index.js"), "utf8"), "customized legalwork-documents");
  await retireMessagingTools(root);
  assert.deepEqual(await readdir(join(root, "retired-messaging-tools")), archived);
}));

test("retirement also works on a new installation", () => fixture(async (root) => {
  await retireMessagingTools(root);
  assert.deepEqual(await readdir(join(root, "retired-messaging-tools")), []);
}));
