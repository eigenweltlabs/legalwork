import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { captureStateSchema, type CaptureAction } from "../back-office/timesheet-schema.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { backOfficeAccess } from "../back-office/access.js";
import { nativeMcpBinary, nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { startServer } from "../server.js";
import { beginDocumentCapture, captureProfile } from "./routes.js";

test.skipIf(!nativeMcpBinary)("opening a workday uses AI only after opt-in and keeps generated wording out of chat and storage", async () => {
  const narrative = "Reviewed the synthetic agreement";
  const prompts: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ model: z.literal("fixture"), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(await request.json());
    prompts.push(...body.messages.filter(item => item.role === "user").map(item => item.content));
    const content = JSON.stringify([{ index: 0, activity: "MOD", narrative }]);
    function chunk(delta: object, finish_reason: string | null) {
      return "data: " + JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    }
    return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const engine = await nativeMcpEngine({ providers: { example: { package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic" }, models: { fixture: {} } } } });
  process.env.XDG_CONFIG_HOME = join(engine.root, "config");
  const connection = engine.connection();
  const config = backOfficeTestConfig(engine.root, {
    opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
    workspaces: [{ id: "example", name: "Synthetic", preset: "starter", workspaceType: "local", path: engine.directory }],
    authorizedRoots: [engine.directory],
  });
  const server = await startServer(config);
  try {
    const profile = await captureProfile(config, await backOfficeAccess(config));
    const date = new Intl.DateTimeFormat("sv-SE").format(new Date());
    const query = new URLSearchParams({ date, profileId: profile.profileId, scope: profile.scope, principal: profile.principal, user: profile.user });
    const url = `http://127.0.0.1:${server.port}/private-timesheet/workday?` + query;
    const request = async (action?: CaptureAction) => {
      const response = await fetch(url, { method: action ? "POST" : "GET", headers: {
        authorization: "Bearer fixture", "x-legalwork-host-token": "host", "content-type": "application/json",
      }, body: JSON.stringify(action) });
      const data: unknown = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(200);
      return captureStateSchema.parse(data);
    };
    await request({ type: "settings", settings: { documents: true, calendar: false, tasks: false, intervalMinutes: 0 } });
    const capture = await beginDocumentCapture(config, { actor: { type: "host" } }, "example", "Folder/Example.docx");
    await capture?.(true);
    const refresh: CaptureAction = { type: "refresh", model: { workspaceId: "example", providerID: "example", modelID: "fixture" } };
    const initial = await request(refresh);
    expect(initial.proposals).toHaveLength(1);
    expect(initial.wording).toBeUndefined();
    expect(prompts).toHaveLength(0);
    await request({ type: "settings", settings: { ...initial.settings, aiSuggestions: true } });
    const result = await request(refresh);
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Example.docx");
    expect(prompts[0]).not.toContain("Folder/");
    expect(result.wording?.[proposal.digest]).toEqual({ narrative, activity: "MOD" });
    expect(proposal.narrative).toBe("Example.docx");
    expect((await request()).wording).toBeUndefined();
    expect(await readFile(profile.path, "utf8")).not.toContain(narrative);
    expect((await engine.client().session.list({ directory: engine.directory })).data).toHaveLength(0);
    for (const file of ["engine.db", "engine.db-wal"]) {
      const bytes = file === "engine.db" ? await readFile(join(engine.root, file))
        : await readFile(join(engine.root, file)).catch(() => Buffer.alloc(0));
      expect(bytes.includes("Example.docx")).toBe(false);
      expect(bytes.includes(narrative)).toBe(false);
    }
  } finally {
    await server.stop();
    await engine.close();
    provider.stop(true);
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}, 60_000);
