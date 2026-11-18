import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureStateSchema, type CaptureAction, type CaptureProposal } from "@legalwork/types/time-capture";
import { ApprovalService } from "../approvals.js";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { backOfficeStore } from "../back-office/store.js";
import type { BackOfficeRecord } from "../back-office/schema.js";
import { ReloadEventStore } from "../events.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { TokenService } from "../tokens.js";
import { proposalCommitment } from "./original.js";
import { acceptPrivateProposal, captureProfile, registerWorkdayRoutes } from "./routes.js";

test("workday reconciliation requires the current accessible row, worker, service day and reviewed matter", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-reconcile-"));
  try {
    const config = backOfficeTestConfig(root);
    const access = await backOfficeAccess(config), store = await backOfficeStore(config);
    const { scope, actor } = access;
    const { profileId, principal, user, path } = await captureProfile(config, access);
    const date = "2026-11-17";
    const saveRecord = (objectId: string, values: BackOfficeRecord["values"]) => store.saveRecord(scope, actor, { revision: 0, objectId, values });
    const matter = saveRecord("matters", { name: "Reviewed matter" });
    const otherMatter = saveRecord("matters", { name: "Different matter" });
    const person = saveRecord("people", { name: "Other worker" });
    const record = (values: BackOfficeRecord["values"]) => saveRecord("timeEntries", {
      name: "Recorded work", startedAt: date, matter: matter.id, recordedMinutes: 20, ...values,
    });
    const right = record({ serviceDate: date, startedAt: "2026-11-18T03:00:00Z" });
    const differentDay = record({ serviceDate: "2026-11-18" });
    const differentMatter = record({ matter: otherMatter.id });
    const differentWorker = record({ timekeeper: person.id });
    const proposal: CaptureProposal = {
      key: randomUUID(), digest: "", date, source: "stopwatch", projectId: null, activity: "",
      narrative: "Stopwatch", startAt: null, endAt: null, workedMinutes: 20, dismissed: false,
    };
    proposal.digest = proposalCommitment(proposal);
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({
      settings: { calendar: false, tasks: false, intervalMinutes: 0 }, lastRun: 0,
      days: { [date]: [{ eventKey: "unassigned", proposal }] }, originals: { [proposal.digest]: proposal },
    }));
    const routes: Route[] = [];
    registerWorkdayRoutes({ routes, config, jsonResponse: Response.json, ensureWritable: () => {}, readJsonBodyLimited: (request) => request.json() });
    const url = new URL("/private-timesheet/workday?" + new URLSearchParams({ date, profileId, principal, scope, user }), "http://127.0.0.1");
    const approvals = new ApprovalService(config.approval), reloadEvents = new ReloadEventStore(), tokens = new TokenService(config);
    async function workday(action?: CaptureAction) {
      const method = action ? "POST" : "GET";
      const match = matchRoute(routes, method, url.pathname);
      if (!match) throw new Error("Missing workday route");
      const request = new Request(url, { method, body: action ? JSON.stringify(action) : undefined });
      const response = await match.handler({ config, url, request, params: match.params, actor: { type: "host" }, approvals, reloadEvents, tokens });
      return captureStateSchema.parse(await response.json());
    }
    const reconcile = (target: BackOfficeRecord, recordRevision = target.revision) => workday({
      type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: target.id, recordRevision,
    });
    await expect(reconcile(right)).rejects.toMatchObject({ code: "private_reconcile_matter" });
    await workday({ type: "draft", key: proposal.key, proposalDigest: proposal.digest, values: { matter: matter.id } });
    await expect(reconcile(differentDay)).rejects.toMatchObject({ code: "private_reconcile_mismatch" });
    await expect(reconcile(differentMatter)).rejects.toMatchObject({ code: "private_reconcile_mismatch" });
    await expect(reconcile(differentWorker)).rejects.toMatchObject({ code: "private_reconcile" });
    const changed = store.saveRecord(scope, actor, { id: right.id, objectId: right.objectId, revision: right.revision, values: { billingNarrative: "Reviewed change" } });
    await expect(reconcile(right)).rejects.toMatchObject({ code: "private_reconcile_changed" });
    expect((await workday()).proposals.map(({ key }) => key)).toEqual([proposal.key]);
    const linked = await reconcile(changed);
    expect(linked.proposals).toEqual([]);
    expect(linked.drafts).toEqual({});
    expect((await reconcile(changed)).proposals).toEqual([]);
    await expect(acceptPrivateProposal(config, { user, principal, scope, profileId }, proposal.key, proposal.digest, async () => true, "record")).rejects.toMatchObject({ code: "private_already_booked" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
