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

test("the chat reads scoped guidelines, publishes privately and edits the same suggestion without replacing its evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-chat-guidelines-"));
  try {
    const config = backOfficeTestConfig(root, { approval: { mode: "manual", timeoutMs: 100 } });
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
      effectiveFrom: date, rules: { instructions: "Name the lease provision reviewed.", minimumMinutes: 30 } };
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
        actor: { type: "remote", scope }, agentAccess: { actor: { type: "remote", scope }, directory: root, workspace,
          sessionId: "workday-chat", originSessionId: "workday-chat", generation: "test" } });
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
      .toEqual([expect.objectContaining({ editable: true, replaceable: false }), expect.objectContaining({ editable: true, replaceable: false })]);
    const timer = reviewedDay.suggestions.find((item: { narrative: string }) => item.narrative === "Reviewed agreement");
    const shortTimer = await call({ action: "update_suggestion", key: timer.key, digest: timer.digest, draftRevision: timer.draftRevision,
      changes: { startAt: date + "T10:00:00Z", endAt: date + "T10:00:15Z" } });
    const namedTimer = await call({ action: "update_suggestion", key: timer.key, digest: shortTimer.suggestion.digest, draftRevision: shortTimer.draftRevision,
      changes: { narrative: "Reviewed the short update." } });
    expect(namedTimer.suggestion).toMatchObject({ workedMinutes: null, startAt: date + "T10:00:00Z", endAt: date + "T10:00:15Z" });
    const suggestion = reviewedDay.suggestions.find((item: { narrative: string }) => item.narrative === "Reviewed the lease rent provision.");
    const firstEdit = await call({ action: "update_suggestion", key: suggestion.key, digest: suggestion.digest,
      draftRevision: suggestion.draftRevision, changes: { narrative: "Reviewed the rent adjustment provision." } });
    const protectedDay = await call({ action: "read" });
    expect(protectedDay.suggestions.find((item: { key: string }) => item.key === suggestion.key))
      .toMatchObject({ editable: true, replaceable: false, evidence: [] });
    const edited = JSON.parse(await readFile(owner.path, "utf8"));
    const evidenceBefore = edited.days[date].find((item: { proposal: { key: string } }) => item.proposal.key === suggestion.key).claims;
    expect(evidenceBefore.length).toBeGreaterThan(0);
    // Simulate a form edit in another window. Changing minutes must retain unrelated private fields.
    edited.drafts[suggestion.key] = { date, proposalDigest: firstEdit.suggestion.digest, revision: 3,
      values: { billingNarrative: "The worker's wording", client: "preserved recipient", recordedMinutes: 15 } };
    await writeFile(owner.path, JSON.stringify(edited));
    const update = { action: "update_suggestion", key: suggestion.key, digest: firstEdit.suggestion.digest,
      draftRevision: 3, changes: { recordedMinutes: 20 } };
    await expect(call({ ...update, draftRevision: 2 })).rejects.toMatchObject({ code: "private_workday_changed" });
    await expect(call({ ...update, changes: { matterId: randomUUID() } })).rejects.toMatchObject({ code: "private_workday_scope" });
    const result = await call(update);
    expect(result.suggestion).toMatchObject({ key: suggestion.key, workedMinutes: 20, chargeMinutes: 30, startAt: null, endAt: null });
    expect(result.draft).toEqual({ billingNarrative: "The worker's wording", client: "preserved recipient" });
    await expect(call(update)).rejects.toMatchObject({ code: "private_workday_changed" });
    const changed = JSON.parse(await readFile(owner.path, "utf8"));
    expect(changed.days[date]).toHaveLength(persisted.days[date].length);
    expect(changed.days[date].find((item: { proposal: { key: string } }) => item.proposal.key === suggestion.key).claims).toEqual(evidenceBefore);
    expect(changed.accepted).toEqual({});
    expect((await call({ action: "list_entries" })).entries).toHaveLength(day.existingEntries.length);
    // Resetting to the proposal's own text must also replace an intervening form override.
    const wording = await call({ ...update, digest: result.suggestion.digest, draftRevision: result.draftRevision,
      changes: { narrative: result.suggestion.narrative } });
    expect(wording.draft).toEqual({ client: "preserved recipient" });
    const guarded = JSON.parse(await readFile(owner.path, "utf8"));
    const next = { ...update, digest: wording.suggestion.digest, draftRevision: wording.draftRevision };
    guarded.pendingBookings[suggestion.key] = true;
    await writeFile(owner.path, JSON.stringify(guarded));
    await expect(call(next)).rejects.toMatchObject({ code: "private_booking_pending" });
    delete guarded.pendingBookings[suggestion.key];
    guarded.accepted[suggestion.key] = wording.suggestion.digest;
    await writeFile(owner.path, JSON.stringify(guarded));
    await expect(call(next)).rejects.toMatchObject({ code: "private_already_booked" });
    const manualKey = randomUUID();
    guarded.drafts[manualKey] = { date, values: { recordedMinutes: 10 }, revision: 1 };
    await writeFile(owner.path, JSON.stringify(guarded));
    await expect(call({ ...next, key: manualKey, draftRevision: 1 })).rejects.toMatchObject({ code: "private_workday_changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
