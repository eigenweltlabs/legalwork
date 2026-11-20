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
import { beginDocumentCapture, captureProfile } from "./routes.js";

test.skipIf(!nativeMcpBinary)("opening, explicitly retrying, and correcting a workday keeps private drafts and deduplicates successful calls", async () => {
  const narrative = "Drafting Example";
  const prompts: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let invalidResponse = true;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ model: z.literal("fixture"), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(await request.json());
    const prompt = body.messages.find(item => item.role === "user")?.content;
    if (!prompt) throw Error("Missing private generation request");
    prompts.push(prompt);
    if (hold) { entered.resolve(); await release.promise; }
    const input = z.discriminatedUnion("stage", [
      z.object({ stage: z.literal("grouping"), evidence: z.array(z.object({ id: z.string(), documentId: z.string(), projectId: z.string() })) }),
      z.object({ stage: z.literal("wording"), entries: z.array(z.object({ index: z.number() })) }),
    ]).parse(JSON.parse(prompt.trim().split("\n").at(-1) ?? ""));
    const content = invalidResponse ? "Invalid structured output" : input.stage === "grouping"
      ? JSON.stringify({ proposals: input.evidence.map(item => ({
          evidenceIds: [item.id], activity: "DFT", documentId: item.documentId,
          projectId: item.projectId, matterId: null, startAt: null, endAt: null, workedMinutes: null,
        })) })
      : JSON.stringify({ wording: input.entries.map(({ index }) => ({ index, narrative })) });
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
    await mkdir(join(engine.directory, "Folder"));
    const file = join(engine.directory, "Folder", "Example.docx");
    await writeFile(file, "Synthetic document");
    await capture?.(null, await stat(file));
    const refresh: CaptureAction = { type: "refresh", model: { workspaceId: "example", providerID: "example", modelID: "fixture" } };
    const initial = await request(refresh);
    expect(initial.proposals).toHaveLength(1);
    expect(initial.wording).toBeUndefined();
    expect(prompts).toHaveLength(0);
    await request({ type: "settings", settings: { ...initial.settings, aiSuggestions: true } });
    expect((await request(refresh)).status?.type).toBe("failed");
    expect(prompts).toHaveLength(1);
    invalidResponse = false;
    expect((await request(refresh)).status?.type).toBe("failed");
    expect(prompts).toHaveLength(1);
    const result = await request({ ...refresh, type: "suggest" });
    expect(result.status?.type).toBe("ready");
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("Example.docx");
    expect(prompts[0]).not.toContain("Folder/");
    expect(proposal.narrative).toBe(narrative);
    expect(proposal.suggested).toBe(true);
    const [reopened, secondWindow] = await Promise.all([request(refresh), request({ ...refresh, type: "suggest" })]);
    expect(reopened.proposals[0]).toEqual(proposal);
    expect(secondWindow.proposals[0]).toEqual(proposal);
    expect(prompts).toHaveLength(3);
    expect(await readFile(profile.path, "utf8")).toContain(narrative);

    const correction: CaptureAction = { type: "chat", id: randomUUID(), text: "Example → Rekurs",
      model: refresh.model, instruction: { scope: "document", documentId: proposal.documentId! } };
    const changed = await request(correction);
    expect(changed.proposals[0].narrative).toBe("Drafting Rekurs");
    expect(changed.proposals[0].key).toBe(proposal.key);
    expect(changed.proposals[0].digest).not.toBe(proposal.digest);
    expect(changed.chat.map(turn => turn.role)).toEqual(["user", "assistant"]);
    expect(changed.instructions[0]).toMatchObject({ text: correction.text, documentId: proposal.documentId });
    expect((await request(correction)).chat).toEqual(changed.chat);
    expect(prompts).toHaveLength(5);
    expect((await engine.client().session.list({ directory: engine.directory })).data).toHaveLength(0);
    for (const file of ["engine.db", "engine.db-wal"]) {
      const bytes = file === "engine.db" ? await readFile(join(engine.root, file))
        : await readFile(join(engine.root, file)).catch(() => Buffer.alloc(0));
      expect(bytes.includes("Example.docx")).toBe(false);
      expect(bytes.includes(narrative)).toBe(false);
      expect(bytes.includes(correction.text)).toBe(false);
    }
    hold = true;
    const interrupted = request({ type: "chat", id: randomUUID(), text: "Shorten the description", model: refresh.model });
    await entered.promise;
    try {
      await request({ type: "settings", settings: { ...initial.settings, aiSuggestions: false } });
    } finally {
      release.resolve();
    }
    const cancelled = await interrupted;
    expect(cancelled.proposals.some(item => item.suggested)).toBe(false);
    expect(cancelled.settings.aiSuggestions).toBe(false);
    const priorCalls = prompts.length;
    const permanent = { type: "chat", id: randomUUID(), text: "Use active voice", instruction: { scope: "personal" } } satisfies CaptureAction;
    const stored = await request(permanent);
    expect(stored.instructions.some(rule => rule.id === permanent.id && rule.text === permanent.text)).toBe(true);
    expect(stored.chat.at(-1)).toMatchObject({ role: "assistant", replyTo: permanent.id });
    expect((await request(permanent)).chat).toEqual(stored.chat);
    expect(prompts).toHaveLength(priorCalls);
  } finally {
    release.resolve();
    await server.stop();
    await engine.close();
    provider.stop(true);
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}, 60_000);
