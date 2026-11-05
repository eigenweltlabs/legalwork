import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { startModelCatalogRelay } from "./model-catalog.js";
import type { ServerConfig } from "./types.js";

const engineBin = process.env.LEGALWORK_TEST_OPENCODE_BIN;

test.skipIf(!engineBin)("a cold engine sees Eigenwelt models on its first native model-catalog read", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-catalog-engine-"));
  const previousUrl = process.env.OPENCODE_MODELS_URL;
  const modelId = "legalwork-catalog-startup-probe";
  const registry = { anthropic: {
    id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic",
    models: { [modelId]: {
      id: modelId, name: "Catalog startup probe", release_date: "2026-10-09",
      attachment: false, reasoning: true, temperature: false, tool_call: true,
      limit: { context: 128000, output: 32000 },
    } },
  } };
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(200);
    return Response.json(registry);
  } });
  process.env.OPENCODE_MODELS_URL = `http://127.0.0.1:${mirror.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "probe", hostToken: "probe",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, configPath: join(root, "server.json"),
  };
  let relay: Awaited<ReturnType<typeof startModelCatalogRelay>> | undefined;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    relay = await startModelCatalogRelay(config);
    const configPath = join(root, "opencode.json");
    await writeFile(configPath, JSON.stringify({ update: "disable", warming: false }));
    engine = await createManagedOpencodeServer({
      bin: engineBin, cwd: root,
      env: {
        HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
        OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_DB: join(root, "engine.db"),
        OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_MODELS_URL: relay.url, OPENCODE_MODELS_PATH: relay.catalogPath,
        ANTHROPIC_API_KEY: "synthetic-zero-inference-catalog-fixture",
      },
    });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: root };
    // Assert the very first native model read. Priming the model catalog with
    // another list call first would hide a cold-start regression.
    expect((await client.model.list({ location })).data.find(model => model.providerID === "anthropic" && model.id === modelId)?.name).toBe("Catalog startup probe");
    expect((await client.provider.list({ location })).data.some(provider => provider.id === "anthropic")).toBe(true);
  } finally {
    await engine?.close();
    await relay?.stop();
    mirror.stop(true);
    if (previousUrl === undefined) delete process.env.OPENCODE_MODELS_URL;
    else process.env.OPENCODE_MODELS_URL = previousUrl;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
