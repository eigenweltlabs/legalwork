import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./legalwork-costs.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";
import { gatewayWireTokens, readGatewayCostRequests } from "../gateway-cost-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const id = "ff55966a-a509-42b0-88b6-43f251d5f512";
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-cost-capture-")); directories.push(directory);
  const settingsPath = join(directory, "settings.json"), store = join(directory, "costs");
  await writeFile(settingsPath, JSON.stringify({ sharedConfiguration: { providers: { eigenwelt: { settings: { baseURL: "https://gateway.example/v1" } } } } }));
  const runtime = nativePluginTestRuntime(directory, { directory: store, settingsPath });
  await runtime.start(plugin);
  return { directory: store, runtime };
}
function event(providerID = "eigenwelt", url = "https://gateway.example/v1/chat/completions") {
  return { sessionID: "ses_sample", agent: "legalwork", model: { providerID, id: "Sample gateway model" }, kind: "primary",
    request: new Request(url, { method: "POST", headers: { authorization: "Bearer private-secret" }, body: '{"messages":[{"content":"private-prompt"}]}' }) };
}

test("captures gateway identifiers and numeric usage while preserving streamed bytes and excluding content", async () => {
  const { runtime, directory } = await setup();
  try {
    const input = event(); await runtime.hook("session", "http.request", input);
    const chunks = ['data: {"id":"gen-sample","choices":[{"delta":{"content":"private-output"}}]}\n\n',
      'data: {"id":"gen-sample","usage":{"prompt_tokens":100,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":90},"completion_tokens_details":{"reasoning_tokens":3},"cost":0.000008}}\n\n', 'data: [DONE]\n\n'];
    const output = { ...input, response: new Response(new ReadableStream<Uint8Array>({ start(controller) {
      // Deliberately split UTF-8/SSE frames across network chunks.
      const bytes = new TextEncoder().encode(chunks.join(""));
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream", "x-litellm-call-id": id } }) };
    await runtime.hook("session", "http.response", output);
    expect(await output.response.text()).toBe(chunks.join(""));
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readGatewayCostRequests(directory, "ses_sample"))[0]?.completedAt) break;
      await Bun.sleep(10);
    }
    expect(await readGatewayCostRequests(directory, "ses_sample")).toMatchObject([{ requestId: id, responseId: "gen-sample", costEur: 0.000008,
      tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 90, write: 0 } } }]);
    const files = await readdir(directory);
    const persisted = (await Promise.all(files.map(file => readFile(join(directory, file), "utf8")))).join("");
    for (const secret of ["private-secret", "private-prompt", "private-output", "choices", "authorization"]) expect(persisted).not.toContain(secret);
  } finally { await runtime.close(); }
});

test("ignores other providers, wrong origins, and absent gateway request IDs", async () => {
  const { runtime, directory } = await setup();
  try {
    for (const input of [event("other"), event("eigenwelt", "https://other.example/v1/chat/completions"), event()]) {
      await runtime.hook("session", "http.request", input);
      const output = { ...input, response: Response.json({ id: "gen-nope", usage: { cost: 99 } }) };
      await runtime.hook("session", "http.response", output);
      expect(await output.response.json()).toMatchObject({ id: "gen-nope" });
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readGatewayCostRequests(directory, "ses_sample"))[0]?.completedAt) break;
      await Bun.sleep(10);
    }
    expect(await readGatewayCostRequests(directory, "ses_sample")).toEqual([]);
  } finally { await runtime.close(); }
});

test("normalizes cache writes and rejects impossible token buckets", () => {
  expect(gatewayWireTokens({ prompt_tokens: 37086, completion_tokens: 18, prompt_tokens_details: { cache_creation_tokens: 37083 } }))
    .toEqual({ input: 3, output: 18, reasoning: 0, cache: { read: 0, write: 37083 } });
  expect(gatewayWireTokens({ prompt_tokens: 3, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } })).toBeUndefined();
  expect(gatewayWireTokens({ prompt_tokens: 3, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } })).toBeUndefined();
});

test("captures the usage-only tail even when the native provider stops at finish_reason", async () => {
  const { runtime, directory } = await setup();
  try {
    const input = event(); await runtime.hook("session", "http.request", input);
    const output = { ...input, response: new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"gen-tail","choices":[{"finish_reason":"stop"}]}\n\n'));
      await Bun.sleep(20);
      controller.enqueue(new TextEncoder().encode('data: {"id":"gen-tail","usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.000008}}\n\n'));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream", "x-litellm-call-id": id } }) };
    await runtime.hook("session", "http.response", output);
    const reader = output.response.body?.getReader();
    if (!reader) throw new Error("Missing model response");
    await reader.read(); await reader.cancel();
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readGatewayCostRequests(directory, "ses_sample"))[0]?.completedAt) break;
      await Bun.sleep(10);
    }
    expect((await readGatewayCostRequests(directory, "ses_sample"))[0]).toMatchObject({ costEur: 0.000008, completedAt: expect.any(Number) });
  } finally { await runtime.close(); }
});
