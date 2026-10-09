import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { startModelCatalogRelay } from "./model-catalog.js";
import type { ServerConfig } from "./types.js";

const engineBin = process.env.LEGALWORK_TEST_OPENCODE_BIN;

test.skipIf(!engineBin)("a cold engine sees Eigenwelt models on its first provider read", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-catalog-engine-"));
  const previousUrl = process.env.OPENCODE_MODELS_URL;
  const modelId = "legalwork-catalog-startup-probe";
  const registry = { anthropic: {
    id: "anthropic", name: "Anthropic", env: [], npm: "@ai-sdk/anthropic",
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
    await writeFile(configPath, "{}");
    engine = await createManagedOpencodeServer({
      bin: engineBin, cwd: root,
      env: {
        HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
        OPENCODE_CONFIG: configPath, OPENCODE_DB: join(root, "engine.db"),
        OPENCODE_MODELS_URL: relay.url, OPENCODE_MODELS_PATH: relay.catalogPath,
      },
    });
    const response = await fetch(`${engine.url}/provider`, {
      headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBe(200);
    const providers = z.object({ all: z.array(z.object({ id: z.string(), models: z.record(z.string(), z.unknown()) })) }).parse(await response.json());
    expect(providers.all.find(provider => provider.id === "anthropic")?.models[modelId]).toBeDefined();
  } finally {
    await engine?.close();
    await relay?.stop();
    mirror.stop(true);
    if (previousUrl === undefined) delete process.env.OPENCODE_MODELS_URL;
    else process.env.OPENCODE_MODELS_URL = previousUrl;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
