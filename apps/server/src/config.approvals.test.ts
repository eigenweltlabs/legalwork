import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerConfig } from "./config.js";

const originalMode = process.env.LEGALWORK_APPROVAL_MODE;
const directories: string[] = [];

afterEach(async () => {
  if (originalMode === undefined) delete process.env.LEGALWORK_APPROVAL_MODE;
  else process.env.LEGALWORK_APPROVAL_MODE = originalMode;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function configFile(approval?: { mode: "manual" | "auto" }) {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-approval-config-"));
  directories.push(directory);
  const configPath = join(directory, "server.json");
  await writeFile(configPath, JSON.stringify({ approval }));
  return { configPath, workspaces: [] };
}

test("desktop fallback preserves explicit environment and file modes", async () => {
  const cli = await configFile({ mode: "manual" });
  delete process.env.LEGALWORK_APPROVAL_MODE;
  expect((await resolveServerConfig(cli, { approvalMode: "auto" })).approval.mode).toBe("manual");
  process.env.LEGALWORK_APPROVAL_MODE = "auto";
  expect((await resolveServerConfig(cli, { approvalMode: "auto" })).approval.mode).toBe("auto");
  process.env.LEGALWORK_APPROVAL_MODE = "manual";
  expect((await resolveServerConfig(await configFile({ mode: "auto" }), { approvalMode: "auto" })).approval.mode).toBe("manual");
});

test("standalone stays manual and desktop can supply its convenience default", async () => {
  delete process.env.LEGALWORK_APPROVAL_MODE;
  const cli = await configFile();
  expect((await resolveServerConfig(cli)).approval.mode).toBe("manual");
  expect((await resolveServerConfig(cli, { approvalMode: "auto" })).approval.mode).toBe("auto");
});

test("an explicit CLI approval mode still has precedence", async () => {
  process.env.LEGALWORK_APPROVAL_MODE = "manual";
  expect((await resolveServerConfig({ ...await configFile(), approvalMode: "auto" })).approval.mode).toBe("auto");
});
