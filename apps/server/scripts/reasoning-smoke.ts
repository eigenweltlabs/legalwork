// Run from the repository root:
// OPENCODE_BIN=/path/to/pinned/opencode bun apps/server/scripts/reasoning-smoke.ts [manifest.json]
// Optional live verification: MODEL_API_TEST_BASE_URL + MODEL_API_TEST_KEY.
// To exercise an Electron-managed engine through its LegalWork server, set
// MODEL_REASONING_ENGINE_URL, MODEL_REASONING_ENGINE_KEY,
// MODEL_REASONING_WORKSPACE and MODEL_REASONING_CAPTURE_REPORT. See docs/qa/model-reasoning.md.
// The proxy binds only loopback; credentials stay in memory and are not logged.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { buildEigenweltModelsMap } from "../src/eigenwelt-auth";
import { parseManifestModels } from "../src/eigenwelt-paid-manifest";
import { getModelBehaviorSummary } from "../../app/src/app/lib/model-behavior";

const manifestPath = process.argv[2] ?? new URL("./fixtures/model-reasoning-manifest.json", import.meta.url);
const binary = process.env.OPENCODE_BIN;
const existingEngine = process.env.MODEL_REASONING_ENGINE_URL;
const captureReport = process.env.MODEL_REASONING_CAPTURE_REPORT;
const workspace = process.env.MODEL_REASONING_WORKSPACE;
if (!existingEngine && !binary) throw new Error("Set OPENCODE_BIN to LegalWork's pinned engine.");
if (existingEngine && (!captureReport || !workspace || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(existingEngine).hostname))) {
  throw new Error("Existing-engine verification needs a loopback engine, disposable workspace and local request report.");
}
const models = parseManifestModels(await Bun.file(manifestPath).json());
if (!models.length || models.some((model) => !model.variants)) throw new Error("Every model needs explicit OpenCode variants.");
const liveBase = process.env.MODEL_API_TEST_BASE_URL;
const liveKey = process.env.MODEL_API_TEST_KEY;
if (Boolean(liveBase) !== Boolean(liveKey)) throw new Error("Live verification requires both MODEL_API_TEST_BASE_URL and MODEL_API_TEST_KEY.");
const captured: Array<{ model: string; effort: unknown; stream: boolean; nonce: string; status: number }> = [];
const checks: Array<{ model: string; selection: string; effort: string | null; passed: boolean }> = [];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
  if (!request.url.endsWith("/chat/completions")) return Response.json({ error: "Unknown local test route" }, { status: 404 });
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) return Response.json({ error: "Invalid test request" }, { status: 400 });
  const title = body.messages.some((message: unknown) => isRecord(message) &&
    message.role === "system" && typeof message.content === "string" && message.content.startsWith("You are a title generator"));
  const prompt = body.messages.flatMap((message: unknown) => {
    if (!isRecord(message) || message.role !== "user") return [];
    const texts = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
      ? message.content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []) : [];
    return texts.filter((text) => typeof text === "string" && (text.startsWith("MODEL_REASONING_CHECK_") || text.startsWith("MODEL_REASONING_TOOL_")));
  }).at(-1);
  const nonce = !title && typeof prompt === "string" ? prompt.split(" ")[0] : undefined;
  let response: Response;
  if (liveBase && liveKey && nonce) {
    response = await fetch(`${liveBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${liveKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: "error",
    });
  } else {
    const tool = nonce?.startsWith("MODEL_REASONING_TOOL_") && !body.messages.some((message) => isRecord(message) && message.role === "tool");
    const chunk = { id: "local-reasoning-check", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: tool ? { role: "assistant", reasoning_content: "Read the requested test value.",
        tool_calls: [{ index: 0, id: "local-read", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: inputFile }) } }] }
        : { role: "assistant", content: "4" }, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    response = body.stream
      ? new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json({ ...chunk, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }] });
  }
  if (nonce) captured.push({ model: body.model, effort: body.reasoning_effort, stream: body.stream === true, nonce, status: response.status });
  return response;
} });
const root = existingEngine && workspace ? await realpath(workspace) : await realpath(await mkdtemp(join(tmpdir(), "legalwork-reasoning-smoke-")));
const inputFile = join(root, `reasoning-check-${crypto.randomUUID()}.txt`);
await writeFile(inputFile, "4\n");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("port reservation") });
const port = probe.port;
probe.stop(true);
const config = { enabled_providers: ["eigenwelt"], permission: { "*": "deny", read: "allow", external_directory: "deny" }, provider: { eigenwelt: {
  npm: "@ai-sdk/openai-compatible", name: "Eigenwelt",
  options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: "local-test-only" },
  models: buildEigenweltModelsMap(models),
} } };
const configPath = join(root, "opencode.json");
if (!existingEngine) await writeFile(configPath, JSON.stringify(config));
const engineEnv: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") };
delete engineEnv.MODEL_API_TEST_KEY;
delete engineEnv.MODEL_REASONING_ENGINE_KEY;
const engine = !existingEngine && binary ? Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: engineEnv,
  stdout: "ignore", stderr: "ignore",
}) : undefined;
const client = createOpencodeClient({ baseUrl: existingEngine ?? `http://127.0.0.1:${port}`, throwOnError: true,
  ...(process.env.MODEL_REASONING_ENGINE_KEY ? { headers: { Authorization: `Bearer ${process.env.MODEL_REASONING_ENGINE_KEY}` } } : {}),
});
const requestSchema = z.array(z.object({ model: z.string(), effort: z.unknown(), stream: z.boolean(), nonce: z.string().optional(), status: z.number() }));
async function sentFor(nonce: string) {
  const requests = existingEngine && captureReport ? requestSchema.parse(await Bun.file(captureReport).json())
    .map((request) => ({ ...request, effort: request.effort === null ? undefined : request.effort })) : captured;
  return requests.filter((request) => request.nonce === nonce);
}
try {
  for (let attempt = 0; ; attempt++) {
    try { await client.global.health(); break; }
    catch { if (attempt === 60) throw new Error("Local engine did not become healthy"); await Bun.sleep(500); }
  }
  const catalog = (await client.provider.list()).data?.all.find((provider) => provider.id === "eigenwelt");
  if (!catalog || models.some((model) => !catalog.models[model.id]) ||
      (!existingEngine && Object.keys(catalog.models).length !== models.length)) throw new Error("Engine lost catalog models");
  if (process.env.MODEL_REASONING_CATALOG_REPORT) await writeFile(process.env.MODEL_REASONING_CATALOG_REPORT, JSON.stringify(catalog.models, null, 2));
  for (const entry of models) {
    const model = catalog.models[entry.id];
    if (!model || !entry.variants) throw new Error("Missing model controls");
    const keys = Object.entries(entry.variants).filter(([, value]) => !value.disabled).map(([key]) => key);
    const actual = Object.keys(model.variants ?? {}).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new Error(`${entry.id}: inferred unsupported efforts survived`);
    const initial = getModelBehaviorSummary("eigenwelt", model, null);
    if (initial.options.some((option) => option.value === null) || initial.value !== null) {
      throw new Error(`${entry.id}: the UI added a default item or selected an implicit variant`);
    }
    if (typeof entry.options?.reasoningEffort === "string" && initial.label !== entry.options.reasoningEffort) {
      throw new Error(`${entry.id}: the UI did not display the configured native default`);
    }
    if (typeof entry.options?.reasoningEffort === "string" &&
        initial.options.filter((option) => option.isDefault).map((option) => option.value).join() !== entry.options.reasoningEffort) {
      throw new Error(`${entry.id}: the native default was not selected in the dropdown`);
    }
    const selections: Array<string | null> = [null, "engine-default", ...keys];
    // Unsupported saved choices must return to provider default on every model.
    for (const old of ["low", "medium"]) if (!keys.includes(old)) selections.push(old);
    for (const selection of selections) {
      const summary = getModelBehaviorSummary("eigenwelt", model, selection);
      const variant = selection === "engine-default" ? null : summary.value;
      const nonce = `MODEL_REASONING_CHECK_${crypto.randomUUID()}`;
      const session = (await client.session.create()).data;
      if (!session) throw new Error("Session not created");
      const result = (await client.session.prompt({ sessionID: session.id, model: { providerID: "eigenwelt", modelID: model.id },
        ...(variant ? { variant } : {}),
        parts: [{ type: "text", text: `${nonce} Reply with only the numeral 4. Do not use tools or read files.` }],
      })).data;
      if (result?.info.error) throw new Error(`${entry.id}: engine ${result.info.error.name}`);
      const expected = variant ? entry.variants[variant]?.reasoningEffort : entry.options?.reasoningEffort;
      const sent = await sentFor(nonce);
      if (!sent.length || sent.some((request) => request.effort !== expected || !request.stream || request.status !== 200)) {
        throw new Error(`${entry.id}: ${selection ?? "default"} sent wrong effort or upstream failed: ${JSON.stringify(sent)}`);
      }
      const answer = result?.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (result?.info.error || answer?.trim() !== "4") throw new Error(`${entry.id}: ${selection ?? "default"} did not return the expected answer`);
      const check = { model: entry.id, selection: selection ?? "default", effort: typeof expected === "string" ? expected : null, passed: true };
      checks.push(check); console.log(JSON.stringify(check));
    }
    // Exercise an actual engine tool round trip, including reasoning replay,
    // rather than only accepting a completion request with a tools schema.
    const variant = keys.includes("high") ? "high" : undefined;
    const toolNonce = `MODEL_REASONING_TOOL_${crypto.randomUUID()}`;
    const session = (await client.session.create()).data;
    if (!session) throw new Error("Tool-check session not created");
    const result = (await client.session.prompt({ sessionID: session.id,
      model: { providerID: "eigenwelt", modelID: model.id }, ...(variant ? { variant } : {}),
      parts: [{ type: "text", text: `${toolNonce} Use the read tool to read ${inputFile}. You must call the read tool before answering. Reply with only the file's numeral. Do not use other tools.` }],
    })).data;
    const read = result?.parts.some((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed");
    // prompt() returns the final message; completed tool parts are on earlier
    // assistant messages in the same session, so inspect the session history.
    const history = (await client.session.messages({ sessionID: session.id })).data;
    const completed = read || history?.some((message) => message.parts.some((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed"));
    const answer = result?.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    const sent = await sentFor(toolNonce);
    const expected = variant ? entry.variants[variant]?.reasoningEffort : entry.options?.reasoningEffort;
    if (!completed || result?.info.error || answer?.trim() !== "4" || sent.length < 2 ||
        sent.some((request) => request.effort !== expected || !request.stream || request.status !== 200)) {
      const tools = history?.flatMap((message) => message.parts.flatMap((part) => part.type === "tool"
        ? [{ tool: part.tool, status: part.state.status, ...(part.state.status === "error" ? { error: part.state.error.slice(0, 180) } : {}) }] : []));
      throw new Error(`${entry.id}: read tool round trip failed: ${JSON.stringify({ tools, error: result?.info.error?.name, answer })}`);
    }
    const check = { model: entry.id, selection: "tool-read", effort: variant ?? null, passed: true };
    checks.push(check); console.log(JSON.stringify(check));
  }
  // An external recorder may front a live or synthetic upstream; do not infer
  // live-provider coverage merely from using an existing Electron engine.
  const upstream = existingEngine ? "external-recorder" : liveBase ? "live" : "synthetic";
  if (process.env.MODEL_REASONING_REPORT) await writeFile(process.env.MODEL_REASONING_REPORT, JSON.stringify({ upstream, existingEngine: Boolean(existingEngine), models: models.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, upstream, existingEngine: Boolean(existingEngine), models: models.length, checks: checks.length }));
} finally {
  proxy.stop(true);
  // The isolated engine can retain background title tasks after the assertions.
  // Terminate it deterministically so a passing matrix does not leave workers.
  if (engine) { engine.kill("SIGKILL"); await engine.exited; }
  if (existingEngine) await rm(inputFile, { force: true });
  else await rm(root, { recursive: true, force: true });
}
