import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { captureStateSchema, type CaptureAction } from "../back-office/timesheet-schema.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { backOfficeAccess } from "../back-office/access.js";
import { nativeMcpBinary, nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { startServer } from "../server.js";
import { recordCompletedTask } from "./activity-workday.js";
import { beginDocumentCapture, captureProfile, checkScheduledWorkday, prepareWorkday, workdayModelFailure } from "./routes.js";
import { ApiError } from "../errors.js";
import { connectedWorkdayModel, generateConnectedTimeText } from "./connected-model.js";

test("private workday failures expose only stable recovery reasons", () => {
  const privateText = "Synthetic private prompt or upstream response";
  const failed = new ApiError(502, "opencode_request_failed", privateText, { status: 503, detail: privateText });
  const timeout = new ApiError(502, "opencode_request_failed", privateText, { status: 504, detail: privateText });
  for (const [error, expired, reason] of [
    [failed, false, "provider_failed"],
    [new ApiError(503, "timesheet_model_failed", privateText), false, "provider_failed"],
    [new Error(privateText), false, undefined],
    [new Error(privateText, { cause: timeout }), false, "timeout"],
    [new DOMException(privateText, "TimeoutError"), false, "timeout"],
    [failed, true, "timeout"],
    [new ApiError(502, "timesheet_model_format", privateText), false, "invalid_output"],
    [new ApiError(409, "timesheet_model_unavailable", privateText), false, "model_unavailable"],
  ] as const) {
    const status = workdayModelFailure(error, expired);
    expect(status.reason).toBe(reason);
    expect(JSON.stringify(status)).not.toContain(privateText);
  }
});

test.skipIf(!nativeMcpBinary)("retired providers advertised by the native engine cannot receive a private workday prompt", async () => {
  const definition = { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture" }, models: { fixture: {} } };
  const retired = ["eigenwelt-free", "opencode"];
  const engine = await nativeMcpEngine({ providers: { "eigenwelt-free": definition, opencode: definition, firm: definition } });
  try {
    const connection = engine.connection();
    const config = backOfficeTestConfig(engine.root, {
      opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
      workspaces: [{ id: "private", preset: "starter", workspaceType: "local", path: engine.directory, name: "Fixture" }],
    });
    const signal = AbortSignal.timeout(10_000);
    const advertised = (await engine.client().model.list({ location: engine.location })).data;
    const choice = (providerID: string) => ({ workspaceId: "private", providerID, modelID: "fixture" });
    for (const id of retired) {
      expect(advertised.some(model => model.providerID === id && model.id === "fixture")).toBe(true);
      expect(await connectedWorkdayModel(config, config.workspaces, [choice(id)], signal, false, id)).toBeUndefined();
      await expect(generateConnectedTimeText(config, config.workspaces[0], choice(id), "Synthetic private activity", async () => {}, signal))
        .rejects.toMatchObject({ code: "timesheet_model_unavailable" });
    }
    expect(await connectedWorkdayModel(config, config.workspaces, [choice("firm")], signal, false, "firm")).toEqual(choice("firm"));
    const automatic = await connectedWorkdayModel(config, config.workspaces, [], signal, false);
    expect(automatic).toBeDefined();
    expect(retired).not.toContain(automatic?.providerID);
  } finally { await engine.close(); }
}, 30_000);

test.skipIf(!nativeMcpBinary)("inline suggestion generation groups sources and respects the selected model", async () => {
  const narrative = "Drafting Example";
  const prompts: string[] = [];
  let invalidResponse = true;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ model: z.literal("fixture"), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(await request.json());
    const prompt = body.messages.find(item => item.role === "user")?.content;
    if (!prompt) throw Error("Missing private generation request");
    prompts.push(prompt);
    const input = z.discriminatedUnion("stage", [
      z.object({ stage: z.literal("grouping"), evidence: z.array(z.object({ id: z.string(), documentId: z.string().nullable(), projectId: z.string().nullable(), source: z.string(), startAt: z.string().nullable(), endAt: z.string().nullable() })) }),
      z.object({ stage: z.literal("wording"), entries: z.array(z.object({ index: z.number() })) }),
    ]).parse(JSON.parse(prompt.trim().split("\n").at(-1) ?? ""));
    let content = "Invalid structured output";
    if (!invalidResponse) {
      if (input.stage === "grouping") {
        const desktop = input.evidence.find(item => item.source === "desktop");
        const document = input.evidence.find(item => item.documentId);
        if (desktop && desktop.startAt && desktop.endAt)
          content = JSON.stringify({ proposals: [{ evidenceIds: [desktop.id], activity: "RES", documentId: null, projectId: null, matterId: null,
            startAt: desktop.startAt, endAt: desktop.endAt, workedMinutes: Math.round((Date.parse(desktop.endAt) - Date.parse(desktop.startAt)) / 60_000) }] });
        else {
        if (!document || input.evidence.length !== 2) throw Error("Expected one whole-day batch with both sources");
        content = JSON.stringify({ proposals: [{
          evidenceIds: input.evidence.map(item => item.id), activity: "DFT", documentId: document.documentId,
          projectId: document.projectId, matterId: null, startAt: null, endAt: null, workedMinutes: null,
        }] });
        }
      } else content = JSON.stringify({ wording: input.entries.map(({ index }) => ({ index, narrative })) });
    }
    function chunk(delta: object, finish_reason: string | null) {
      return "data: " + JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    }
    return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousLocalCli = process.env.LEGALWORK_TIMESHEET_LLAMA_CLI;
  const previousLocalModel = process.env.LEGALWORK_TIMESHEET_GGUF;
  delete process.env.LEGALWORK_TIMESHEET_LLAMA_CLI;
  delete process.env.LEGALWORK_TIMESHEET_GGUF;
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
      // The desktop's POST starts a chat. Exercise the inline reconstruction
      // used without a chat launcher, then read its result from the desktop API.
      if (action?.type === "suggest") {
        await prepareWorkday(config, profile, date, action);
        action = undefined;
      }
      const response = await fetch(url, { method: action ? "POST" : "GET", headers: {
        authorization: "Bearer fixture", "x-legalwork-host-token": "host", "content-type": "application/json",
      }, body: JSON.stringify(action) });
      const data: unknown = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(200);
      return captureStateSchema.parse(data);
    };
    const settings: CaptureAction = { type: "settings", settings: {
      documents: true, calendar: false, tasks: true, schedule: { frequency: "hourly" },
    } };
    await request(settings);
    // Older empty-day checks wrote this placeholder even without a local model installed.
    const old = JSON.parse(await readFile(profile.path, "utf8"));
    await writeFile(profile.path, JSON.stringify({ ...old, lastModel: { workspaceId: "local", providerID: "local", modelID: "llama.cpp" } }));
    const capture = await beginDocumentCapture(config, { actor: { type: "host" } }, "example", "Folder/Example.docx");
    await mkdir(join(engine.directory, "Folder"));
    const file = join(engine.directory, "Folder", "Example.docx");
    await writeFile(file, "Synthetic document");
    await capture?.(null, await stat(file));
    await recordCompletedTask(config, profile, {
      id: "synthetic-task", title: "File the draft", projectId: "example", updatedAt: new Date().toISOString(),
    });
    const suggest: CaptureAction = { type: "suggest", model: { workspaceId: "example", providerID: "example", modelID: "fixture" } };
    expect((await request({ type: "calendar" })).proposals).toHaveLength(2);
    const beforeGeneration = await request();
    expect(beforeGeneration.proposals).toEqual([]);
    expect(beforeGeneration.modelReady).toBe(true);
    expect(prompts).toHaveLength(0);
    expect((await request(suggest)).status).toMatchObject({ type: "failed", reason: "invalid_output" });
    expect(prompts).toHaveLength(2);
    const journal = JSON.parse(await readFile(join(profile.path + ".day-log", date + ".json"), "utf8"));
    expect(journal.observations.map((row: { proposal: { source: string } }) => row.proposal.source).sort()).toEqual(["documents", "tasks"]);
    expect(JSON.stringify(journal)).not.toContain("Folder/");
    invalidResponse = false;
    expect((await request()).status?.type).toBe("failed");
    expect(prompts).toHaveLength(2);
    // Another workspace can map the same provider ID to different credentials
    // or an endpoint. A stale app hint must not reauthorize that boundary.
    for (const unsafe of [{ ...suggest.model!, workspaceId: "removed-workspace" }, { ...suggest.model!, providerID: "self-hosted" }]) {
      expect((await request({ type: "settings-patch", change: { field: "model", value: unsafe } })).modelReady).toBe(false);
      expect((await request(suggest)).status).toMatchObject({ type: "unavailable", reason: "model_unavailable" });
      expect(prompts).toHaveLength(2);
    }
    // A model retirement within the selected provider on the same workspace
    // recovers for the plain Add suggestions action and for scheduled runs.
    const retired = { ...suggest.model!, modelID: "retired" };
    expect((await request({ type: "settings-patch", change: { field: "model", value: retired } })).modelReady).toBe(true);
    const result = await request({ type: "suggest" });
    expect(result.status?.type).toBe("ready");
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("Example.docx");
    expect(prompts[0]).toContain("File the draft");
    expect(prompts[0]).not.toContain("Folder/");
    expect(proposal.narrative).toBe(narrative);
    expect(proposal.suggested).toBe(true);
    const [reopened, secondWindow] = await Promise.all([request(suggest), request(suggest)]);
    expect(reopened.proposals[0]).toEqual(proposal);
    expect(secondWindow.proposals[0]).toEqual(proposal);
    expect((await request()).proposals[0]).toEqual(proposal);
    expect(prompts).toHaveLength(4);
    expect(await readFile(profile.path, "utf8")).toContain(narrative);

    expect((await engine.client().session.list({ directory: engine.directory })).data).toHaveLength(0);
    for (const file of ["engine.db", "engine.db-wal"]) {
      const bytes = file === "engine.db" ? await readFile(join(engine.root, file))
        : await readFile(join(engine.root, file)).catch(() => Buffer.alloc(0));
      expect(bytes.includes("Example.docx")).toBe(false);
      expect(bytes.includes(narrative)).toBe(false);
    }
    const desktopUrl = "http://127.0.0.1:" + server.port + "/private-timesheet/desktop-activity?" + query;
    const started = Date.now() - 66_000;
    const observe = (time: number, host: boolean, endpoint = desktopUrl) => fetch(endpoint, { method: "POST",
      headers: { authorization: "Bearer fixture", ...(host && { "x-legalwork-host-token": "host" }), "content-type": "application/json" },
      body: JSON.stringify({ state: "active", platform: "darwin", permission: "granted", observedAt: time, idleSeconds: 1,
        application: "Synthetic Editor", documentName: "Billing-review.pdf" }) });
    expect((await observe(started, true)).status).toBe(409);
    await request({ type: "settings-patch", change: { field: "desktopActivity", value: true } });
    expect((await observe(started, false)).status).toBe(401);
    const wrongProfile = new URL(desktopUrl);
    wrongProfile.searchParams.set("profileId", "other");
    expect((await observe(started, true, wrongProfile.toString())).status).toBe(409);
    for (const seconds of [0, 15, 30, 45, 60]) expect((await observe(started + 1000 * seconds, true)).status).toBe(200);
    await checkScheduledWorkday(config, {});
    const desktop = await request();
    expect(desktop.status?.type).toBe("ready");
    expect(desktop.proposals.find(row => row.source === "desktop")).toMatchObject({ narrative, workedMinutes: 1 });
    expect(prompts.some(prompt => prompt.includes("Billing-review.pdf") && prompt.includes("Synthetic Editor"))).toBe(true);
    const readDay = async () => JSON.parse(await readFile(join(profile.path + ".day-log", date + ".json"), "utf8"));
    expect((await readDay()).observations.some((row: { proposal: { source: string } }) => row.proposal.source === "desktop")).toBe(true);
    await request({ type: "settings-patch", change: { field: "desktopActivity", value: false } });
    expect((await request(suggest)).proposals.some(row => row.source === "desktop")).toBe(false);
    expect((await readDay()).observations.some((row: { proposal: { source: string } }) => row.proposal.source === "desktop")).toBe(false);
    const priorCalls = prompts.length;
    // A request from a stale second window must respect the newer saved provider.
    const selected = { workspaceId: "local", providerID: "local", modelID: "llama.cpp" };
    await request({ type: "settings-patch", change: { field: "model", value: selected } });
    const staleRequest = await request(suggest);
    expect(staleRequest.settings.model).toEqual(selected);
    expect(staleRequest.status?.type).toBe("unavailable");
    expect(staleRequest.modelReady).toBe(false);
    expect(prompts).toHaveLength(priorCalls);
  } finally {
    await server.stop();
    await engine.close();
    provider.stop(true);
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousLocalCli === undefined) delete process.env.LEGALWORK_TIMESHEET_LLAMA_CLI;
    else process.env.LEGALWORK_TIMESHEET_LLAMA_CLI = previousLocalCli;
    if (previousLocalModel === undefined) delete process.env.LEGALWORK_TIMESHEET_GGUF;
    else process.env.LEGALWORK_TIMESHEET_GGUF = previousLocalModel;
  }
}, 60_000);
