import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { proxyOpencodeRequest } from "./server.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";
import { listMcpDisplay } from "./mcp.js";
import { nativeDefaultVariant } from "@legalwork/types/native-model-display";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;

// Markers are synthetic. The fixture has no account credentials or inference
// endpoint and only exercises the real released native read APIs through LW.
test.skipIf(!binary)("released native configuration and catalogs keep credentials inside the trusted engine for viewers and collaborators", async () => {
  if (!binary) throw new Error("A verified OpenCode binary is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-secret-boundary-")));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  for (const name of ["home", "config", "data", "state", "cache", "project"]) await mkdir(join(root, name));
  const directory = join(root, "project");
  const secrets = {
    providerKey: "synthetic-provider-key-boundary",
    providerHeader: "synthetic-provider-header-boundary",
    providerBody: "synthetic-provider-body-boundary",
    modelKey: "synthetic-model-key-boundary",
    modelHeader: "synthetic-model-header-boundary",
    variantHeader: "synthetic-variant-header-boundary",
    agentHeader: "synthetic-agent-header-boundary",
    agentBody: "synthetic-agent-body-boundary",
    mcpHeader: "synthetic-mcp-header-boundary",
    mcpOAuthSecret: "synthetic-mcp-oauth-secret-boundary",
    mcpEnvironment: "synthetic-mcp-environment-boundary",
    credentialKey: "synthetic-credential-key-boundary",
  };
  let networkRequests = 0;
  const provider = Bun.serve({ port: 0, fetch() { networkRequests++; return new Response("External or inference requests are forbidden in this fixture", { status: 403 }); } });
  const configuration = {
    update: "disable", warming: false, model: "fixture/fixture",
    providers: { fixture: {
      name: "Secret boundary fixture", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "{env:LEGALWORK_SYNTHETIC_BOUNDARY_KEY}", timeout: 15000 },
      headers: { "x-custom-auth": secrets.providerHeader, "x-nonsecret-transport": "fixture-routing" },
      body: { custom_auth_token: secrets.providerBody, reasoning_effort: "high" },
      models: { fixture: {
        name: "Boundary model", settings: { apiKey: secrets.modelKey, reasoningEffort: "high" }, headers: { "x-model-auth": secrets.modelHeader },
        variants: [{ id: "thorough", settings: { reasoningEffort: "high" }, headers: { "x-variant-auth": secrets.variantHeader } }],
        capabilities: { tools: true }, limit: { context: 32000, output: 4096 },
      }, headerOnly: { headers: { "x-mode-auth": secrets.modelHeader }, variants: [{ id: "HeaderOnly", headers: { "X-Mode-Auth": secrets.modelHeader } }] },
      custom: { settings: { customBudget: { amount: 41 } }, body: { private_mode: secrets.providerBody }, variants: [{ id: "CustomCase", settings: { customBudget: { amount: 41 } }, body: { private_mode: secrets.providerBody } }] },
      },
    } },
    agents: { fixture: {
      description: "Visible agent description", system: "Use only project evidence.", mode: "primary",
      request: { headers: { "x-agent-auth": secrets.agentHeader }, body: { auth_token: secrets.agentBody, temperature: 0.2 } },
    } },
    mcp: { servers: {
      remote: { type: "remote", url: `${provider.url.origin}/mcp`, disabled: true, headers: { "x-mcp-auth": secrets.mcpHeader }, oauth: { client_id: "visible-client-id", client_secret: secrets.mcpOAuthSecret } },
      local: { type: "local", command: ["never-execute-this-fixture"], disabled: true, environment: { CUSTOM_AUTH: secrets.mcpEnvironment } },
    } },
  };
  const configPath = join(root, "config", "engine.json");
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const eventsAbort = new AbortController();
  try {
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_DB: join(root, "engine.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", LEGALWORK_SYNTHETIC_BOUNDARY_KEY: secrets.providerKey,
    } });
    const privateClient = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const config: ServerConfig = {
      configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host",
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
      opencodeBaseUrl: engine.url, opencodeUsername: engine.username, opencodePassword: engine.password,
    };
    const workspace = config.workspaces[0]!;
    proxy = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      try { return await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: url.pathname.replace(/^\/opencode/, ""), actor: { type: "remote", scope: request.headers.get("x-fixture-scope") === "viewer" ? "viewer" : "collaborator" } }); }
      catch (error) { return Response.json({ code: error instanceof ApiError ? error.code : "fixture_error" }, { status: error instanceof ApiError ? error.status : 500 }); }
    } });
    const location = { directory };
    expect((await privateClient.server.info()).version).toBe(await expectedOpencodeVersion(binary));
    expect(JSON.stringify(await privateClient.config.get({ location }))).toContain(secrets.providerKey);
    await privateClient.model.list({ location });
    expect(JSON.stringify(await privateClient.model.default({ location }))).toContain(secrets.modelKey);
    const leaks: string[] = [];
    for (const scope of ["viewer", "collaborator"]) {
      const client = OpenCode.make({ baseUrl: `${proxy.url.origin}/opencode`, headers: { "x-fixture-scope": scope } });
      const snapshots: Record<string, unknown> = {
        config: await client.config.get({ location }),
        providers: await client.provider.list({ location }),
        provider: await client.provider.get({ location, providerID: "fixture" }),
        models: await client.model.list({ location }),
        modelDefault: await client.model.default({ location }),
        agents: await client.agent.list({ location }),
        agent: await client.agent.get({ location, agentID: "fixture" }),
        connectors: await client.mcp.list({ location }),
        integrations: await client.integration.list({ location }),
      };
      const models = (await client.model.list({ location })).data;
      expect((await client.model.default({ location })).data?.id).toBe("fixture");
      expect(nativeDefaultVariant(models.find(model => model.id === "headerOnly")!)).toBe("HeaderOnly");
      expect(nativeDefaultVariant(models.find(model => model.id === "custom")!)).toBe("CustomCase");
      // A private mismatching header must still prevent a false default after
      // the safe reasoning controls are projected without authentication bags.
      expect(nativeDefaultVariant(models.find(model => model.id === "fixture")!)).toBeUndefined();
      expect(models.find(model => model.id === "fixture")?.settings?.reasoningEffort).toBe("high");
      expect(JSON.stringify(snapshots.providers)).toContain("Secret boundary fixture");
      expect(JSON.stringify(snapshots.models)).toContain("thorough");
      expect(JSON.stringify(snapshots.agents)).toContain("Visible agent description");
      for (const [endpoint, value] of Object.entries(snapshots)) {
        const text = JSON.stringify(value);
        for (const [name, marker] of Object.entries(secrets)) if (text.includes(marker)) leaks.push(`${scope}:${endpoint}:${name}`);
      }
      await expect(client.credential.list()).rejects.toThrow();
    }
    const connectors = await listMcpDisplay(config, workspace);
    expect(connectors.find(item => item.name === "remote")).toMatchObject({ editable: false, config: { type: "remote", enabled: false }, configured: { url: true, headers: ["x-mcp-auth"], oauth: true } });
    expect(connectors.find(item => item.name === "local")).toMatchObject({ editable: false, configured: { command: true, environment: ["CUSTOM_AUTH"] } });
    expect(JSON.stringify(connectors)).not.toContain(provider.url.origin);
    for (const marker of Object.values(secrets)) expect(JSON.stringify(connectors)).not.toContain(marker);
    // Credential invalidations must still reach clients, without vault values.
    const publicClient = OpenCode.make({ baseUrl: `${proxy.url.origin}/opencode`, headers: { "x-fixture-scope": "viewer" } });
    const iterator = publicClient.event.subscribe({ signal: eventsAbort.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const pendingEvent = iterator.next();
    await privateClient.credential.create({ integrationID: "fixture", value: { type: "key", key: secrets.credentialKey }, label: "Synthetic credential", activate: true });
    const watchdog = setTimeout(() => eventsAbort.abort(), 10000);
    try {
      let next = await pendingEvent;
      while (!next.done && next.value.type !== "credential.updated") next = await iterator.next();
      if (next.done || next.value.type !== "credential.updated") throw new Error("Credential invalidation was not delivered.");
      expect(next.value.data).toEqual({});
      for (const marker of Object.values(secrets)) expect(JSON.stringify(next.value)).not.toContain(marker);
    } finally { clearTimeout(watchdog); eventsAbort.abort(); await iterator.return?.(); }
    expect(networkRequests).toBe(0);
    expect(leaks).toEqual([]);
  } finally {
    eventsAbort.abort(); await proxy?.stop(true); await engine?.close(); provider.stop(true); await rm(root, { recursive: true, force: true });
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}, 60000);
