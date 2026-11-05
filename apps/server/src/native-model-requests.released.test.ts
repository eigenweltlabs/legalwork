import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import { Model } from "@opencode/schema/model";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { closeRuntimeOpencodeConfig, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import { engineProjectStatus } from "./engine-project.js";
import type { ServerConfig } from "./types.js";
import { registerLocalProject } from "./routes/workspaces.js";
import { workspaceIdForPath } from "./workspaces.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const requestBody = z.object({ model: z.string(), messages: z.array(z.unknown()) }).passthrough();
type CapturedRequest = { project: string; primary: boolean; sessionID: string | null; body: z.infer<typeof requestBody> };
const privateMarker = (project: string) => ` \n\t"private-request-${project}"\n tail \t `;

function completedResponse(model: string) {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "lw287-synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "Synthetic request completed." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** Real engine + production configuration writer. Only model responses are
 * synthetic; every captured request has passed native request construction. */
async function fixture(run: (context: {
  client: () => OpenCodeClient;
  config: ServerConfig;
  captures: CapturedRequest[];
  restart: () => Promise<void>;
}) => Promise<void>) {
  if (!binary) throw new Error("The released engine fixture requires LEGALWORK_TEST_OPENCODE_BIN.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-model-requests-")));
  const previous = { ...process.env };
  const captures: CapturedRequest[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = requestBody.parse(await request.json());
    const project = new URL(request.url).pathname.split("/")[1] ?? "";
    // Native title/generate requests have no tool definitions. The actual
    // production primary request advertises its native tools and session ID.
    const primary = Array.isArray(body.tools) && body.tools.length > 0;
    captures.push({ project, primary, sessionID: request.headers.get("x-opencode-session-id"), body });
    if (body.model === "temperature-unsupported" && Object.hasOwn(body, "temperature")) {
      return Response.json({ error: { message: "Unsupported parameter: temperature", type: "invalid_request_error", param: "temperature" } }, { status: 400 });
    }
    return completedResponse(body.model);
  } });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private", "server.json"), token: "lw287-fixture", hostToken: "lw287-fixture-host",
    workspaces: ["first", "second"].map(id => ({ id, name: id, path: join(root, id), preset: "starter", workspaceType: "local" })), authorizedRoots: [join(root, "first"), join(root, "second")],
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, engineProjectTrustRequired: true, engineConfigurationMode: "native-project", startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let client: OpenCodeClient | undefined;
  const restart = async () => {
    await engine?.close();
    engine = await createManagedOpencodeServer({ bin: binary, cwd: root, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "engine-config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config),
      OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      LEGALWORK_SERVER_URL: `http://127.0.0.1:${server?.port}`, LEGALWORK_SERVER_TOKEN: config.token,
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
  };
  try {
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json"); process.env.XDG_CONFIG_HOME = join(root, "library");
    await Promise.all(config.workspaces.map(workspace => workspace.path).map(path => mkdir(path, { recursive: true })));
    for (const id of ["first", "second"]) {
      await writeRuntimeOpencodeConfig(config, id, () => ({ providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "lw287-synthetic-key", baseURL: `${provider.url.origin}/${id}/v1` }, models: {
          "temperature-unsupported": { limit: { context: 128_000, output: 4096 }, capabilities: { tools: true, temperature: false } },
          "temperature-supported": { limit: { context: 128_000, output: 4096 }, capabilities: { tools: true, temperature: true }, body: { temperature: 0.35, top_p: 0.75 } },
          "reasoning-shared": { limit: { context: 128_000, output: 4096 }, capabilities: { tools: true, reasoning: { supported: true, effort: id === "first" ? ["low", "high"] : ["low", "medium", "high"] } },
            body: { legalwork_fixture_marker: privateMarker(id) },
            variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }] },
        },
      } } }));
    }
    await writeLegalworkRuntimeConfigFile(config, "first");
    for (const workspace of config.workspaces) expect(await readFile(join(workspace.path, ".opencode", "opencode.json"), "utf8")).not.toContain(`private-request-${workspace.id}`);
    for (const workspace of config.workspaces) expect((await engineProjectStatus(config, workspace)).state).toBe("ready");
    server = await startServer(config);
    await restart();
    await run({ client: () => { if (!client) throw new Error("Released model fixture has not started."); return client; }, config, captures, restart });
  } finally {
    await engine?.close(); await server?.stop(); await closeRuntimeOpencodeConfig(config); provider.stop(true);
    const capture = process.env.LEGALWORK_MODEL_REQUEST_CAPTURE;
    if (capture) await appendFile(capture, JSON.stringify({ testProfile: root, captures }) + "\n", { mode: 0o600 });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); await rm(root, { recursive: true, force: true });
  }
}

async function prompt(client: OpenCodeClient, directory: string, modelID: string, variant?: string) {
  const location = { directory };
  const models = (await client.model.list({ location })).data;
  expect(models.some(model => model.providerID === "fixture" && model.id === modelID)).toBe(true);
  const session = await client.session.create({ location, title: "LW287 synthetic model request", agent: "legalwork", model: { providerID: "fixture", id: modelID, ...(variant ? { variant } : {}) } });
  await client.session.prompt({ sessionID: session.id, text: `LW287 fixture: ${modelID}` });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
  const completed = await client.session.get({ sessionID: session.id });
  const diagnostic = completed.outcome === "failed" ? JSON.stringify(await client.message.list({ sessionID: session.id })) : undefined;
  expect(completed.outcome, diagnostic).toBe("succeeded");
}

test.skipIf(!binary)("a project registered after native engine startup admits its first new chat", async () => {
  await fixture(async ({ client, config, captures }) => {
    const existing = config.workspaces[0];
    await prompt(client(), existing.path, "temperature-unsupported");
    const directory = join(existing.path, "..", "created-after-startup");
    const settings = await readRuntimeOpencodeConfig(config, existing.id);
    await writeRuntimeOpencodeConfig(config, workspaceIdForPath(directory), () => settings);
    const { workspace } = await registerLocalProject(config, { folderPath: directory, name: "New project", preset: "starter" });
    const before = captures.filter(capture => capture.primary).length;
    await prompt(client(), workspace.path, "temperature-unsupported");
    expect(captures.filter(capture => capture.primary).length).toBeGreaterThan(before);
  });
}, 60_000);

test.skipIf(!binary)("released native defaults omit temperature and explicit model body settings reach the provider unchanged", async () => {
  const captures: Array<z.infer<typeof requestBody>> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = requestBody.parse(await request.json()); captures.push(body);
    return completedResponse(body.model);
  } });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine({ default_agent: "legalwork", agents: { legalwork: { mode: "primary", system: "Run the synthetic request fixture." } }, providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "lw287-synthetic-key", baseURL: `${provider.url.origin}/v1` }, models: {
        "temperature-unsupported": { limit: { context: 128_000, output: 4096 }, capabilities: { tools: true, temperature: false } },
        "temperature-supported": { limit: { context: 128_000, output: 4096 }, capabilities: { tools: true, temperature: true }, body: { temperature: 0.35, top_p: 0.75 } },
      },
    } } });
    await prompt(engine.client(), engine.directory, "temperature-unsupported");
    await prompt(engine.client(), engine.directory, "temperature-supported");
    const unsupported = captures.filter(body => body.model === "temperature-unsupported");
    const supported = captures.filter(body => body.model === "temperature-supported");
    expect(unsupported.length).toBeGreaterThan(0); expect(supported.length).toBeGreaterThan(0);
    for (const body of unsupported) expect(Object.hasOwn(body, "temperature")).toBe(false);
    for (const body of supported) expect(body).toMatchObject({ temperature: 0.35, top_p: 0.75 });
  } finally {
    await engine?.close(); provider.stop(true);
    if (process.env.LEGALWORK_MODEL_REQUEST_CAPTURE) await appendFile(process.env.LEGALWORK_MODEL_REQUEST_CAPTURE, JSON.stringify({ mode: "native-default", captures }) + "\n", { mode: 0o600 });
  }
}, 45_000);

test.skipIf(!binary)("production native requests omit unsupported default generation parameters and retain explicit supported model settings", async () => {
  await fixture(async ({ client, config, captures }) => {
    await prompt(client(), config.workspaces[0]!.path, "temperature-unsupported");
    const unsupported = captures.filter(request => request.primary && request.body.model === "temperature-unsupported");
    expect(unsupported.length).toBeGreaterThan(0);
    for (const request of unsupported) {
      expect(Object.hasOwn(request.body, "temperature")).toBe(false);
      expect(Object.hasOwn(request.body, "top_p")).toBe(false);
    }
    await prompt(client(), config.workspaces[0]!.path, "temperature-supported");
    const supported = captures.filter(request => request.primary && request.body.model === "temperature-supported");
    expect(supported.length).toBeGreaterThan(0);
    for (const request of supported) expect(request.body).toMatchObject({ temperature: 0.35, top_p: 0.75 });
  });
}, 60_000);

test.skipIf(!binary)("different native project reasoning declarations keep the same model runnable through project switching and restart", async () => {
  await fixture(async ({ client, config, captures, restart }) => {
    for (const cycle of ["initial", "restarted"]) {
      if (cycle === "restarted") await restart();
      for (const workspace of config.workspaces) await prompt(client(), workspace.path, "reasoning-shared", "high");
    }
    const requests = captures.filter(request => request.primary && request.body.model === "reasoning-shared");
    expect(requests.filter(request => request.project === "first").length).toBeGreaterThanOrEqual(2);
    expect(requests.filter(request => request.project === "second").length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.body.reasoning_effort).toBe("high");
      expect(request.body.legalwork_fixture_marker).toBe(privateMarker(request.project));
    }
  });
}, 90_000);
