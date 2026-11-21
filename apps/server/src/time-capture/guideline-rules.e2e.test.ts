import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { captureStateSchema, guidelineRuleSuggestionsSchema, type WorkdayGuideline } from "../back-office/timesheet-schema.js";
import { nativeMcpBinary, nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { startServer } from "../server.js";
import { captureProfile } from "./routes.js";

test.skipIf(!nativeMcpBinary)("private guideline preview extracts selected text without saving and discards results after a model change", async () => {
  const text = "The minimum recorded time is 12 minutes. Charge in 6-minute increments.";
  const suggestion = guidelineRuleSuggestionsSchema.parse({
    rules: { minimumMinutes: 12, incrementMinutes: 6 },
    evidence: { minimumMinutes: "The minimum recorded time is 12 minutes.", incrementMinutes: "Charge in 6-minute increments." },
    notes: [],
  });
  const prompts: string[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let hold = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ model: z.literal("fixture"), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(await request.json());
    const prompt = body.messages.find(({ role }) => role === "user")?.content;
    if (!prompt) throw new Error("Expected the selected guideline text.");
    prompts.push(prompt);
    if (hold) { entered.resolve(); await release.promise; }
    const chunk = (delta: object, finish_reason: string | null) =>
      "data: " + JSON.stringify({
        id: "synthetic", object: "chat.completion.chunk", model: body.model, created: 1,
        choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n";
    return new Response(chunk({ role: "assistant", content: JSON.stringify(suggestion) }, null) +
      chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    engine = await nativeMcpEngine({ providers: { example: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic" }, models: { fixture: {} } } } });
    process.env.XDG_CONFIG_HOME = join(engine.root, "config");
    const connection = engine.connection();
    const config = backOfficeTestConfig(engine.root, {
      opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
      workspaces: [{ id: "example", name: "Synthetic", preset: "starter", workspaceType: "local", path: engine.directory }],
      authorizedRoots: [engine.directory],
    });
    server = await startServer(config);
    const { path, profileId, scope, principal, user } = await captureProfile(config, await backOfficeAccess(config));
    const date = "2026-11-17";
    const endpoint = "http://127.0.0.1:" + server.port + "/private-timesheet/workday?";
    const context = { date, profileId, scope, principal, user };
    const headers = { authorization: "Bearer fixture", "x-legalwork-host-token": "host", "content-type": "application/json" };
    const model = { workspaceId: "example", providerID: "example", modelID: "fixture" };
    const request = (body?: object, query = new URLSearchParams(context)) => fetch(endpoint + query, {
      method: body ? "POST" : "GET", headers, body: JSON.stringify(body),
    });
    const preview = (id = profileId) => request({ text, model }, new URLSearchParams({ ...context, profileId: id, preview: "guideline-rules" }));
    const state = async (body?: object) => {
      const response = await request(body);
      const data: unknown = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(200);
      return captureStateSchema.parse(data);
    };
    const unrelated = "Unrelated private instruction for a synthetic case.";
    await state({ type: "chat", id: randomUUID(), text: unrelated, instruction: { scope: "personal" } });
    const before = await readFile(path, "utf8");
    const warning = await preview(randomUUID());
    expect(warning.status).toBe(409);
    expect(prompts).toHaveLength(0);

    const reviewed = await preview();
    const data: unknown = await reviewed.json();
    expect(reviewed.status, JSON.stringify(data)).toBe(200);
    expect(reviewed.headers.get("cache-control")).toBe("no-store");
    expect(guidelineRuleSuggestionsSchema.parse(data)).toEqual(suggestion);
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0].split("\n\n").at(-1) ?? "")).toEqual({ stage: "guideline-rules", text });
    expect(prompts[0]).not.toContain(unrelated);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await state()).guidelines).toEqual([]);

    const guideline: WorkdayGuideline = { id: randomUUID(), revision: 0, scope: "firm", targetId: "firm",
      name: "Fixture terms", effectiveFrom: date, rules: suggestion.rules };
    const saved = await state({ type: "guideline", guideline });
    expect(saved.guidelines).toEqual([{ ...guideline, revision: 1 }]);
    expect((await state()).guidelines).toEqual(saved.guidelines);
    expect(await readFile(path, "utf8")).not.toContain(text);

    hold = true;
    const interrupted = preview();
    await Promise.race([entered.promise, interrupted.then(response => {
      throw new Error("Expected generation to reach the provider, got HTTP " + response.status);
    })]);
    try {
      await state({ type: "settings-patch", change: { field: "model", value: { ...model, modelID: "different" } } });
    } finally {
      release.resolve();
    }
    expect((await interrupted).status).toBe(409);
    expect((await state()).guidelines).toEqual(saved.guidelines);
    expect(prompts).toHaveLength(2);
    expect((await engine.client().session.list({ directory: engine.directory })).data).toHaveLength(0);
  } finally {
    release.resolve();
    try { await server?.stop(); }
    finally {
      try { await engine?.close(); }
      finally {
        provider.stop(true);
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
    }
  }
}, 60_000);
