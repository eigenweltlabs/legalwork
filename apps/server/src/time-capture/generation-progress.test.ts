import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureStateSchema, workdayGenerationProgressSchema, type CaptureAction } from "@legalwork/types/time-capture";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { nativeMcpBinary, nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { startServer } from "../server.js";
import { activeCaptureProfile } from "./profile.js";
import { digest } from "./private-workday.js";

function stage(fail = false) {
  return { fail, grouping: Promise.withResolvers<void>(), releaseGrouping: Promise.withResolvers<void>(),
    second: Promise.withResolvers<void>(), releaseSecond: Promise.withResolvers<void>() };
}
test.skipIf(!nativeMcpBinary)("live suggestions expose validated rows for exactly this run and commit once after final validation", async () => {
  let step = stage();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { messages } = await request.json() as { messages: { role: string; content: string }[] };
    const input = JSON.parse(messages.find(message => message.role === "user")!.content.trim().split("\n").at(-1)!);
    const current = step;
    let result;
    if (input.stage === "grouping") {
      current.grouping.resolve();
      await current.releaseGrouping.promise;
      result = { proposals: input.evidence.map((row: { id: string }) => ({ evidenceIds: [row.id], activity: null,
        documentId: null, projectId: null, matterId: null, startAt: null, endAt: null, workedMinutes: null })) };
    } else {
      if (input.entries[0].index > 0) { current.second.resolve(); await current.releaseSecond.promise; }
      result = { wording: input.entries.map(({ index }: { index: number }) => ({
        index: current.fail && index > 0 ? 999 : index, narrative: "Reviewed suggestion " + index })) };
    }
    const chunk = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({
      id: "c", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n";
    return new Response(chunk({ role: "assistant", content: JSON.stringify(result) }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  const engine = await nativeMcpEngine({ providers: { example: { package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: provider.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: {} } } } });
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(engine.root, "config");
  const connection = engine.connection();
  const config = backOfficeTestConfig(engine.root, {
    opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
    workspaces: [{ id: "example", name: "Example", preset: "starter", workspaceType: "local", path: engine.directory }], authorizedRoots: [engine.directory],
  });
  const server = await startServer(config);
  try {
    const { profileId, path, scope, user, principal } = await activeCaptureProfile(config);
    const date = "2025-01-12";
    const document = (index: number) => ({ source: "documents", key: randomUUID(), digest: digest(index), date,
      activity: "", projectId: null, narrative: "Synthetic file " + index, dismissed: false, startAt: null, endAt: null, workedMinutes: null });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ days: {}, lastRun: 0, settings: { calendar: false, tasks: false, documents: true, workspaceActivity: false,
      model: { workspaceId: "example", providerID: "example", modelID: "fixture" } }, documentSaves: { [date]: { a: document(1), b: document(2) } } }));
    const query = new URLSearchParams({ profileId, date, scope, user, principal });
    const url = "http://127.0.0.1:" + server.port + "/private-timesheet/workday?";
    const headers = { authorization: "Bearer fixture", "x-legalwork-host-token": "host", "content-type": "application/json" };
    const http = (q: URLSearchParams, body?: CaptureAction, signal?: AbortSignal) => fetch(url + q, {
      method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body), signal,
    });
    const state = async (body?: CaptureAction, signal?: AbortSignal) => {
      const response = await http(query, body, signal);
      const json = await response.json();
      expect(response.status, JSON.stringify(json)).toBe(200);
      return captureStateSchema.parse(json);
    };
    const progress = async (runId: string, scopedDate = date) => {
      const q = new URLSearchParams(query); q.set("progress", runId); q.set("date", scopedDate);
      const response = await http(q);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return workdayGenerationProgressSchema.nullable().parse(await response.json());
    };
    const stored = async () => JSON.parse(await readFile(path, "utf8"));
    const start = async (fail = false) => {
      step = stage(fail);
      const controller = new AbortController(), runId = randomUUID();
      const result = state({ type: "suggest", runId }, controller.signal);
      void result.catch(() => {});
      const prematurelyFinished = result.then(() => { throw Error("The run ended before the expected model stage"); });
      await Promise.race([step.grouping.promise, prematurelyFinished]);
      expect(await progress(runId)).toMatchObject({ runId, date, phase: "grouping", total: null, completed: 0, proposals: [] });
      step.releaseGrouping.resolve();
      await Promise.race([step.second.promise, prematurelyFinished]);
      const partial = await progress(runId);
      expect(partial).toMatchObject({ phase: "wording", completed: 1, proposals: [{ suggested: true, narrative: "Reviewed suggestion 0" }] });
      expect(await progress(randomUUID())).toBeNull();
      expect(await progress(runId, "2025-01-11")).toBeNull();
      const wrong = new URLSearchParams(query); wrong.set("progress", runId); wrong.set("profileId", "other");
      expect((await http(wrong)).status).toBe(409);
      return { controller, runId, result, partial: partial! };
    };
    const cancelled = await start();
    expect((await stored()).days[date]).toBeUndefined();
    expect(cancelled.partial.total).toBe(2);
    const transient = cancelled.partial.proposals[0];
    expect((await http(query, { type: "draft", key: transient.key, proposalDigest: transient.digest, values: { narrative: "Cannot edit preview" } })).status).toBe(409);
    cancelled.controller.abort();
    await expect(cancelled.result).rejects.toThrow();
    step.releaseSecond.resolve();
    expect(await progress(cancelled.runId)).toBeNull();

    const failed = await start(true);
    step.releaseSecond.resolve();
    expect((await failed.result).status?.reason).toBe("invalid_output");
    expect((await stored()).days[date]).toBeUndefined();
    expect((await stored()).checkedThrough[date]).toBeUndefined();
    expect(await progress(failed.runId)).toBeNull();

    const stale = await start();
    await state({ type: "settings-patch", change: { field: "documents", value: false } });
    step.releaseSecond.resolve();
    await stale.result;
    expect(await progress(stale.runId)).toBeNull();
    expect((await stored()).days[date]).toBeUndefined();
    await state({ type: "settings-patch", change: { field: "documents", value: true } });

    const valid = await start();
    const preview = valid.partial.proposals[0];
    expect((await state()).proposals).toHaveLength(0);
    step.releaseSecond.resolve();
    const final = await valid.result;
    expect(final.status?.type).toBe("ready");
    expect(final.proposals).toHaveLength(2);
    expect(final.proposals.find(row => row.key === preview.key)?.digest).toBe(preview.digest);
    expect(await progress(valid.runId)).toBeNull();
    expect(Object.keys((await stored()).accepted)).toHaveLength(0);

    const prior = await stored(); prior.documentSaves[date].c = document(3);
    await writeFile(path, JSON.stringify(prior));
    const editing = await start();
    await state({ type: "draft", key: preview.key, proposalDigest: preview.digest, values: { narrative: "Worker edit" } });
    expect((await progress(editing.runId))?.proposals).toEqual([]);
    step.releaseSecond.resolve();
    const preserved = await editing.result;
    expect(preserved.drafts[preview.key].values.narrative).toBe("Worker edit");
    expect(preserved.proposals).toHaveLength(3);
    expect(new Set(preserved.proposals.map(row => row.key)).size).toBe(3);
  } finally {
    step.releaseGrouping.resolve(); step.releaseSecond.resolve();
    await server.stop(); provider.stop(true); await engine.close();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
  }
}, 40_000);
