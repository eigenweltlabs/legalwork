import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApprovalService } from "../approvals.js";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { backOfficeStore } from "../back-office/store.js";
import { ReloadEventStore } from "../events.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { TokenService } from "../tokens.js";
import { timekeepingPreset } from "./profile.js";
import { captureProfile, registerWorkdayRoutes } from "./routes.js";
import { digest } from "./private-workday.js";
import { changeStopwatch, emptyStopwatch } from "./stopwatch.js";

test("the chat must read each matter's effective guidelines before publishing its draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-chat-guidelines-"));
  try {
    const config = backOfficeTestConfig(root);
    const access = await backOfficeAccess(config);
    const store = await backOfficeStore(config);
    const owner = await captureProfile(config, access);
    const date = "2026-11-17";
    const matters = ["Lease", "Acquisition"].map(name =>
      store.saveRecord(access.scope, access.actor, { revision: 0, objectId: "matters", values: { name } }));
    const workspace = { id: "timekeeping", workspaceType: "local" as const, path: root, preset: timekeepingPreset(owner.profileId), name: "Timekeeping" };
    config.workspaces.push(workspace);
    const saved: Parameters<typeof changeStopwatch>[0] = { days: {}, originals: {}, stopwatch: emptyStopwatch() };
    for (const matter of matters) {
      const id = randomUUID();
      changeStopwatch(saved, { type: "start", matterId: matter.id, id, note: "Reviewed agreement" }, new Date(date + "T10:00:00Z"), "UTC");
      changeStopwatch(saved, { type: "stop", id }, new Date(date + "T10:12:00Z"), "UTC");
    }
    const documentSaves = Object.fromEntries(matters.map(matter => [randomUUID(), {
      key: randomUUID(), digest: digest([date, matter.id]), date, source: "documents",
      projectId: null, matterId: matter.id, narrative: "Saved amendments to " + matter.values.name,
      activity: "", dismissed: false, workedMinutes: null, startAt: null, endAt: null,
      observedAt: date + "T11:00:00Z",
    }]));
    const guideline = { id: randomUUID(), name: "Lease wording", revision: 1, scope: "matter", targetId: matters[0].id,
      effectiveFrom: date, rules: { instructions: "Name the lease provision reviewed." } };
    await mkdir(dirname(owner.path), { recursive: true });
    await writeFile(owner.path, JSON.stringify({ ...saved, lastRun: 0, settings: { calendar: false, tasks: false, documents: true, stopwatchMode: "evidence" },
      documentSaves: { [date]: documentSaves },
      guidelines: { [guideline.id]: [guideline, { ...guideline, revision: 2, effectiveFrom: "2026-12-01", rules: { instructions: "Future instructions" } }] } }));
    const routes: Route[] = [];
    registerWorkdayRoutes({ config, routes, resolveWorkspace: async () => workspace, jsonResponse: Response.json,
      ensureWritable: () => {}, readJsonBodyLimited: req => req.json() });
    const url = new URL("http://localhost/workspace/timekeeping/timekeeping/workday");
    const match = matchRoute(routes, "POST", url.pathname)!;
    async function call(body: Record<string, unknown>, scope: "owner" | "collaborator" = "owner") {
      const request = new Request(url, { method: "POST", body: JSON.stringify({ date, ...body }) });
      const result = await match.handler({ config, params: match.params, url, request,
        approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config),
        actor: { type: "remote", scope }, agentAccess: { directory: root, workspace } });
      return result.json();
    }
    await expect(call({ action: "read" }, "collaborator")).rejects.toMatchObject({ status: 403 });
    const day = await call({ action: "read" });
    expect(day.observations.map((item: { source: string }) => item.source)).toEqual(["documents", "documents"]);
    const first = await call({ action: "guidelines", matterId: matters[0].id });
    const second = await call({ action: "guidelines", matterId: matters[1].id });
    expect(first.guidelines).toEqual([expect.objectContaining({ revision: 1, rules: guideline.rules })]);
    expect(second.guidelines).toEqual([]);
    const priorDay = await call({ action: "guidelines", date: "2026-11-16", matterId: matters[0].id });
    expect(priorDay.guidelines).toEqual([]);
    const suggestions = day.observations.map((obs: { id: string; matter: { id: string } }) => ({
      evidence: [obs.id], narrative: obs.matter.id === matters[0].id ? "Reviewed the lease rent provision." : "Reviewed the acquisition agreement.",
    }));
    const publish = { action: "publish", revision: day.revision, suggestions, complete: true };
    await expect(call(publish)).rejects.toMatchObject({ code: "workday_guidelines" });
    await expect(call({ ...publish, guidelineReceipts: [first.receipt] })).rejects.toMatchObject({ code: "workday_guidelines" });
    await expect(call({ ...publish, guidelineReceipts: [priorDay.receipt, second.receipt] })).rejects.toMatchObject({ code: "workday_guidelines" });
    expect(await call({ ...publish, guidelineReceipts: [first.receipt, second.receipt] })).toMatchObject({ published: 2, complete: true });
    await expect(call({ ...publish, guidelineReceipts: [first.receipt, second.receipt] })).rejects.toMatchObject({ code: "private_workday_changed" });
    const persisted = JSON.parse(await readFile(owner.path, "utf8"));
    expect(persisted.days[date].filter((entry: { generated?: boolean }) => entry.generated)).toHaveLength(2);
    expect(Object.keys(persisted.accepted)).toHaveLength(0);
    const reviewedDay = await call({ action: "read" });
    expect(reviewedDay.suggestions.filter((item: { narrative: string }) => item.narrative === "Reviewed agreement"))
      .toEqual([expect.objectContaining({ editable: false }), expect.objectContaining({ editable: false })]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
