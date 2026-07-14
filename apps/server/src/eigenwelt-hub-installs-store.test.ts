import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forgetHubInstall,
  readHubInstalls,
  recordHubInstall,
} from "./eigenwelt-hub-installs-store.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeConfig(): Promise<ServerConfig> {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-installs-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // The store resolves the runtime DB from configPath's dir.
  return { configPath: join(dir, "legalwork.json") } as ServerConfig;
}

// Unique per test: a sibling suite may set LEGALWORK_RUNTIME_DB (which overrides
// the per-config path), so unique workspace ids keep tests isolated regardless.
const wsId = () => `ws-${crypto.randomUUID()}`;

describe("eigenwelt-hub-installs-store", () => {
  test("records and reads installs per workspace", async () => {
    const config = await makeConfig();
    const a = wsId();
    const b = wsId();
    expect(await readHubInstalls(config, a)).toEqual({});

    await recordHubInstall(config, a, "item-a", {
      version: 2,
      kind: "workflow",
      name: "nda-review",
      installedAt: 1000,
    });
    await recordHubInstall(config, a, "item-b", {
      version: 1,
      kind: "integration",
      name: "highq",
      installedAt: 2000,
    });

    const installs = await readHubInstalls(config, a);
    expect(installs["item-a"]).toEqual({ version: 2, kind: "workflow", name: "nda-review", installedAt: 1000 });
    expect(installs["item-b"]?.version).toBe(1);
    // A different workspace is isolated.
    expect(await readHubInstalls(config, b)).toEqual({});
  });

  test("re-recording an id upgrades the tracked version", async () => {
    const config = await makeConfig();
    const a = wsId();
    await recordHubInstall(config, a, "item-a", { version: 1, kind: "preset", name: "p", installedAt: 1 });
    await recordHubInstall(config, a, "item-a", { version: 5, kind: "preset", name: "p", installedAt: 2 });
    expect((await readHubInstalls(config, a))["item-a"]?.version).toBe(5);
  });

  test("forgetting an install removes it", async () => {
    const config = await makeConfig();
    const a = wsId();
    await recordHubInstall(config, a, "item-a", { version: 1, kind: "workflow", name: "x", installedAt: 1 });
    await forgetHubInstall(config, a, "item-a");
    expect(await readHubInstalls(config, a)).toEqual({});
  });
});
