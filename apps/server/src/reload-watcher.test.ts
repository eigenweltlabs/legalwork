import { describe, expect, jest, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReloadEventStore } from "./events.js";
import { startReloadWatchers } from "./reload-watcher.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import * as fingerprints from "./reload-fingerprint.js";

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-reload-watcher-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildConfig(root: string): { config: ServerConfig; workspace: WorkspaceInfo } {
  const workspace: WorkspaceInfo = {
    id: "ws_reload_test",
    name: "Reload Test",
    path: root,
    preset: "starter",
    workspaceType: "local",
  };
  return {
    workspace,
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "token",
      hostToken: "host-token",
      approval: { mode: "auto", timeoutMs: 0 },
      corsOrigins: [],
      workspaces: [workspace],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "env",
      hostTokenSource: "env",
      logFormat: "pretty",
      logRequests: false,
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(store: ReloadEventStore, workspaceId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const items = store.list(workspaceId);
    if (items.length > 0) return items[0];
    await sleep(25);
  }
  return null;
}

describe("reload watcher fingerprints", () => {
  test("an explicit refresh waits for the initial baseline before accepting later changes", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const initialStarted = Promise.withResolvers<void>();
      const releaseInitial = Promise.withResolvers<void>();
      let first = true;
      const compute = spyOn(fingerprints, "computeReloadFingerprint").mockImplementation(async (_root, reason) => {
        if (first) { first = false; initialStarted.resolve(); await releaseInitial.promise; }
        return reason;
      });
      const watcher = startReloadWatchers({ config, reloadEvents: new ReloadEventStore(), debounceMs: 30 });
      let refreshed = false;
      const ready = watcher.refreshWorkspace(workspace.id).then(() => { refreshed = true; });
      try {
        await initialStarted.promise;
        await sleep(0); // Drain the unblocked explicit scan while the first scan is held.
        expect(refreshed).toBe(false);
        releaseInitial.resolve();
        await ready;
        expect(refreshed).toBe(true);
      } finally { releaseInitial.resolve(); await ready; watcher.close(); compute.mockRestore(); }
    });
  });

  test("does not emit when a watched file is rewritten with identical content", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const configPath = join(root, "opencode.jsonc");
      const content = '{ "plugin": ["demo"] }\n';
      await writeFile(configPath, content, "utf8");

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await writeFile(configPath, content, "utf8");
        await sleep(120);

        expect(events.list(workspace.id)).toEqual([]);
      } finally {
        watcher.close();
      }
    });
  });

  test("emits when project config content changes while running", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const configPath = join(root, "opencode.jsonc");
      await writeFile(configPath, '{ "plugin": ["demo"] }\n', "utf8");

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await writeFile(configPath, '{ "plugin": ["changed"] }\n', "utf8");

        const event = await waitForEvent(events, workspace.id);
        expect(event?.reason).toBe("config");
        expect(event?.trigger?.name).toBe("opencode.jsonc");
      } finally {
        watcher.close();
      }
    });
  });

  test("suppresses internal workspace bootstrap writes after refreshing the baseline", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const events = new ReloadEventStore();
      // Bootstrap can take longer than the debounce on a busy runner. Hold its
      // timers until the internal writes and their replacement baseline settle.
      jest.useFakeTimers();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 100 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        const ensured = await ensureWorkspaceFiles(root, "starter");
        await mkdir(join(root, ".opencode", "commands"), { recursive: true });
        await watcher.refreshWorkspace(workspace.id, ensured.reloadReasons);
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        await sleep(250);

        expect(ensured.reloadReasons).toEqual([]);
        expect(events.list(workspace.id)).toEqual([]);
        await writeFile(join(root, ".opencode", "commands", "sign.md"), "User command change\n", "utf8");
        expect((await waitForEvent(events, workspace.id))?.reason).toBe("commands");
      } finally {
        watcher.close();
        jest.useRealTimers();
      }
    });
  });

  test("watches hidden project opencode config files", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      await mkdir(join(root, ".opencode"), { recursive: true });

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await sleep(75);
        await writeFile(join(root, ".opencode", "opencode.jsonc"), '{ "mcp": {} }\n', "utf8");

        const event = await waitForEvent(events, workspace.id);
        expect(event?.reason).toBe("config");
        expect(event?.trigger?.name).toBe("opencode.jsonc");
      } finally {
        watcher.close();
      }
    });
  });
});
