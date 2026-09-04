import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const HOST_TOKEN = "owt_env_host_token";
const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];
const priorEnvStore = process.env.LEGALWORK_ENV_STORE;
const priorTokenStore = process.env.LEGALWORK_TOKEN_STORE;
const priorOpenAiApiKey = process.env.OPENAI_API_KEY;
const priorXdgDataHome = process.env.XDG_DATA_HOME;
const priorLegalWorkApiKey = process.env.LEGALWORK_API_KEY;
const priorLegalWorkInferenceBaseUrl = process.env.LEGALWORK_INFERENCE_BASE_URL;
const nativeFetch = globalThis.fetch;

function baseConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_env_client_token",
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
}

async function boot() {
  const server = await startServer(baseConfig()) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

function hostAuth() {
  return { "x-legalwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "legalwork-env-routes-"));
  dirs.push(dir);
  // Redirect the shared env.json path into a throwaway dir so the test never
  // touches the developer's real ~/.config/legalwork/env.json.
  process.env.LEGALWORK_ENV_STORE = join(dir, "env.json");
  process.env.LEGALWORK_TOKEN_STORE = join(dir, "tokens.json");
  process.env.XDG_DATA_HOME = join(dir, "xdg-data");
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
  if (priorEnvStore === undefined) {
    delete process.env.LEGALWORK_ENV_STORE;
  } else {
    process.env.LEGALWORK_ENV_STORE = priorEnvStore;
  }
  if (priorTokenStore === undefined) {
    delete process.env.LEGALWORK_TOKEN_STORE;
  } else {
    process.env.LEGALWORK_TOKEN_STORE = priorTokenStore;
  }
  if (priorOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = priorOpenAiApiKey;
  }
  if (priorXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = priorXdgDataHome;
  }
  if (priorLegalWorkApiKey === undefined) {
    delete process.env.LEGALWORK_API_KEY;
  } else {
    process.env.LEGALWORK_API_KEY = priorLegalWorkApiKey;
  }
  if (priorLegalWorkInferenceBaseUrl === undefined) {
    delete process.env.LEGALWORK_INFERENCE_BASE_URL;
  } else {
    process.env.LEGALWORK_INFERENCE_BASE_URL = priorLegalWorkInferenceBaseUrl;
  }
  globalThis.fetch = nativeFetch;
});

describe("env routes", () => {
  test("rejects unauthenticated requests", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/env`);
    expect(response.status).toBe(401);
  });

  test("rejects owner bearer tokens", async () => {
    const { base } = await boot();
    const issued = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ scope: "owner", label: "test owner" }),
    });
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as { token: string };

    const response = await fetch(`${base}/env`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(response.status).toBe(401);
  });

  test("CORS preflight allows PUT", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/env`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  test("PUT + GET round-trips a single entry and returns raw values", async () => {
    const { base } = await boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, count: 1 });

    const list = await fetch(`${base}/env`, { headers: hostAuth() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ key: string; value: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" });
  });

  test("GET /env can return metadata without raw values", async () => {
    const { base } = await boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ entries: [{ key: "WITH_VALUE", value: "secret" }, { key: "EMPTY_VALUE", value: "" }] }),
    });

    const list = await fetch(`${base}/env?includeValues=false`, { headers: hostAuth() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ key: string; hasValue: boolean; value?: string }> };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ key: "EMPTY_VALUE", hasValue: false });
    expect(body.items[1]).toMatchObject({ key: "WITH_VALUE", hasValue: true });
    expect(Object.prototype.hasOwnProperty.call(body.items[0], "value")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body.items[1], "value")).toBe(false);
  });

  test("GET /env/:key reveals one raw value", async () => {
    const { base } = await boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" }),
    });

    const reveal = await fetch(`${base}/env/ANTHROPIC_API_KEY`, { headers: hostAuth() });
    expect(reveal.status).toBe(200);
    expect(await reveal.json()).toMatchObject({
      item: { key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" },
    });

    const missing = await fetch(`${base}/env/MISSING`, { headers: hostAuth() });
    expect(missing.status).toBe(404);
  });

  test("GET and PUT /env/status track pending changes per runtime", async () => {
    const { base } = await boot();

    const initial = await fetch(`${base}/env/status?runtimeKey=runtime-a`, { headers: hostAuth() });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ runtimeKey: "runtime-a", pendingChanges: false });

    const setPending = await fetch(`${base}/env/status`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ runtimeKey: "runtime-a", pendingChanges: true }),
    });
    expect(setPending.status).toBe(200);
    expect(await setPending.json()).toEqual({ runtimeKey: "runtime-a", pendingChanges: true });

    const otherRuntime = await fetch(`${base}/env/status?runtimeKey=runtime-b`, { headers: hostAuth() });
    expect(await otherRuntime.json()).toEqual({ runtimeKey: "runtime-b", pendingChanges: false });

    const updated = await fetch(`${base}/env/status?runtimeKey=runtime-a`, { headers: hostAuth() });
    expect(await updated.json()).toEqual({ runtimeKey: "runtime-a", pendingChanges: true });

    const cleared = await fetch(`${base}/env/status`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ runtimeKey: "runtime-a", pendingChanges: false }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ runtimeKey: "runtime-a", pendingChanges: false });
  });

  test("GET /env/keys returns names without values", async () => {
    const { base } = await boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({
        entries: [
          { key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" },
          { key: "NBA_LIVE_KEY", value: "secret-value" },
        ],
      }),
    });

    const list = await fetch(`${base}/env/keys`, { headers: hostAuth() });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ keys: ["ANTHROPIC_API_KEY", "NBA_LIVE_KEY"] });
  });

  test("invalid env store returns 409 instead of overwriting on PUT", async () => {
    writeFileSync(process.env.LEGALWORK_ENV_STORE!, "{ this is not json");
    const { base } = await boot();

    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "SAFE", value: "new" }),
    });

    expect(put.status).toBe(409);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_env_store");
  });

  test("PUT accepts a batch via entries[]", async () => {
    const { base } = await boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({
        entries: [
          { key: "A", value: "1" },
          { key: "B", value: "2" },
        ],
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, count: 2 });

    const body = (await (await fetch(`${base}/env`, { headers: hostAuth() })).json()) as {
      items: Array<{ key: string }>;
    };
    expect(body.items.map((i) => i.key)).toEqual(["A", "B"]);
  });

  test("PUT rejects invalid keys with 400", async () => {
    const { base } = await boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "bad-key", value: "x" }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_env_key");
    expect(body.message).toBe("Invalid environment variable name");
    expect(body.message).not.toContain("bad-key");
  });

  test("PUT rejects reserved keys with 400", async () => {
    const { base } = await boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "LEGALWORK_TOKEN", value: "x" }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("reserved_env_key");
    expect(body.message).toBe("Environment variable name is reserved for LegalWork internals");
    expect(body.message).not.toContain("LEGALWORK_TOKEN");
  });

  test("PUT with no entries returns 400", async () => {
    const { base } = await boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ entries: [] }),
    });
    expect(put.status).toBe(400);
  });

  test("DELETE removes an existing entry", async () => {
    const { base } = await boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "FOO", value: "bar" }),
    });

    const del = await fetch(`${base}/env/FOO`, { method: "DELETE", headers: hostAuth() });
    expect(del.status).toBe(200);

    const list = (await (await fetch(`${base}/env`, { headers: hostAuth() })).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(0);
  });

  test("DELETE on missing key returns 404", async () => {
    const { base } = await boot();
    const del = await fetch(`${base}/env/MISSING`, { method: "DELETE", headers: hostAuth() });
    expect(del.status).toBe(404);
  });

  test("voice realtime capability is unavailable without standard OpenAI credentials", async () => {
    delete process.env.OPENAI_API_KEY;
    const { base } = await boot();
    const response = await fetch(`${base}/voice/realtime/capability`, { headers: hostAuth() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported: false,
      providerId: null,
      model: null,
      reason: "openai_credentials_unavailable",
    });
  });

  test("voice realtime capability reads the standard OpenCode OpenAI API credential", async () => {
    delete process.env.OPENAI_API_KEY;
    const authDir = join(process.env.XDG_DATA_HOME!, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "sk-provider-test" },
    }));

    const { base } = await boot();
    const response = await fetch(`${base}/voice/realtime/capability`, { headers: hostAuth() });
    expect(await response.json()).toMatchObject({
      supported: true,
      providerId: "openai",
      model: "gpt-realtime-2.1",
    });
  });

  test("voice realtime prefers a locally saved OpenAI key over the inherited environment key", async () => {
    process.env.OPENAI_API_KEY = "sk-env-test";
    const authDir = join(process.env.XDG_DATA_HOME!, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "sk-saved-test" },
    }));

    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.openai.com/v1/realtime/calls") {
        expect(request.headers.get("authorization")).toBe("Bearer sk-saved-test");
        return Promise.resolve(new Response("v=0\r\no=answer", {
          status: 200,
          headers: { "content-type": "application/sdp" },
        }));
      }
      return nativeFetch(input, init);
    }) as typeof fetch;

    const { base } = await boot();
    const response = await fetch(`${base}/voice/realtime/call`, {
      method: "POST",
      headers: { ...hostAuth(), "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\no=offer\r\n" }),
    });

    expect(response.status).toBe(200);
  });

  test("voice realtime call uses the unified WebRTC endpoint and exact semantic VAD contract", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let realtimeInstructions = "";
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.openai.com/v1/realtime/calls") {
        expect(request.headers.get("authorization")).toBe("Bearer sk-test");
        const form = await request.formData();
        const sdpPart = form.get("sdp");
        expect(sdpPart).toBeInstanceOf(Blob);
        expect(await (sdpPart as Blob).text()).toBe("v=0\\r\\no=offer\\r\\n");
        const rawSession = form.get("session");
        expect(rawSession).toBeInstanceOf(Blob);
        const session = JSON.parse(await (rawSession as Blob).text()) as {
          model: string;
          instructions: string;
          audio: { input: { transcription?: unknown; turn_detection: Record<string, unknown> } };
          tool_choice: string;
          tools: Array<{ name: string; parameters: { required?: string[] } }>;
        };
        expect(session.model).toBe("gpt-realtime-2.1");
        realtimeInstructions = session.instructions;
        expect(session.audio.input.transcription).toBeUndefined();
        expect(session.audio.input.turn_detection).toEqual({
          type: "semantic_vad",
          eagerness: "auto",
          create_response: true,
          interrupt_response: true,
        });
        expect(session.tool_choice).toBe("required");
        expect(session.tools.map((tool) => tool.name)).toEqual(["continue_work", "answer_in_voice"]);
        expect(session.tools.find((tool) => tool.name === "answer_in_voice")?.parameters.required).toEqual(["intent"]);
        return Promise.resolve(new Response("v=0\\r\\no=answer", {
          status: 200,
          headers: { "content-type": "application/sdp" },
        }));
      }
      return nativeFetch(input, init);
    }) as typeof fetch;

    const { base } = await boot();
    const issued = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ scope: "owner", label: "voice owner" }),
    });
    const tokenBody = (await issued.json()) as { token: string };

    const capability = await fetch(`${base}/voice/realtime/capability`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    expect(await capability.json()).toMatchObject({
      supported: true,
      providerId: "openai",
      model: "gpt-realtime-2.1",
    });

    const response = await fetch(`${base}/voice/realtime/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\\r\\no=offer\\r\\n", sessionContext: "Recent canonical chat." }),
    });

    const failureText = response.status === 200 ? "" : await response.clone().text();
    expect({ status: response.status, failureText }).toEqual({ status: 200, failureText: "" });
    expect(realtimeInstructions).toContain("You are LegalWork. You have one continuous identity across text and voice.");
    expect(realtimeInstructions).toContain("Before speaking after any user turn, choose exactly one route");
    expect(realtimeInstructions).toContain("ask one concise clarification before starting work");
    expect(realtimeInstructions).toContain("Never answer an actionable new substantive request from general knowledge in voice");
    expect(realtimeInstructions).toContain("Do not expand it into a plan");
    expect(realtimeInstructions).toContain("Live progress, blockers, and completed results");
    expect(realtimeInstructions).toContain("never evidence of a finding or result");
    expect(realtimeInstructions).toContain("two-to-four-sentence spoken summary");
    expect(realtimeInstructions).toContain("Recent canonical chat.");
    expect(realtimeInstructions).not.toContain("OpenCode");
    expect(await response.json()).toEqual({
      ok: true,
      sdp: "v=0\\r\\no=answer",
      model: "gpt-realtime-2.1",
      providerId: "openai",
      tools: ["continue_work", "answer_in_voice"],
    });
  });

  test("voice realtime call does not expose a credential when OpenAI rejects the model", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = ((input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.openai.com/v1/realtime/calls") {
        expect(request.headers.get("authorization")).toBe("Bearer sk-test");
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: "Model is not available for this project." },
        }), { status: 403, headers: { "content-type": "application/json" } }));
      }
      return nativeFetch(input, init);
    }) as typeof fetch;

    const { base } = await boot();
    const response = await fetch(`${base}/voice/realtime/call`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ sdp: "v=0\\r\\no=offer" }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("openai_realtime_failed");
    expect(body.message).toContain("Model is not available");
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });
  test("values persist across server restart", async () => {
    const first = await boot();
    await fetch(`${first.base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "PERSISTED", value: "yes" }),
    });
    await first.server.stop(true);
    stops.pop();

    const second = await boot();
    const body = (await (await fetch(`${second.base}/env`, { headers: hostAuth() })).json()) as {
      items: Array<{ key: string; value: string }>;
    };
    expect(body.items).toEqual([expect.objectContaining({ key: "PERSISTED", value: "yes" })]);
  });
});
