import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import { captureProposalSchema, captureStateSchema } from "@legalwork/types/time-capture";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { backOfficeAccess } from "./back-office/access.js";
import { backOfficeStore, closeBackOfficeStoreForTests } from "./back-office/store.js";
import { BackOfficeChangeSchema, BackOfficeFileSchema, BackOfficeRecordSchema, defaultBackOfficeModel, type BackOfficeRecord } from "./back-office/schema.js";
import { syncBackOffice } from "./back-office/sync.js";
import { writeEigenweltConnection, closeEigenweltConnectionForTests } from "./eigenwelt-connection-store.js";
import { resetOrgPolicyRuntimeForTests, scheduleOrgPolicySync } from "./org-policy.js";
import { acceptPrivateProposal, captureProfile } from "./time-capture/routes.js";
import { proposalCommitment } from "./time-capture/original.js";

test("firm invoice draft documents preserve the requested revision through the proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-firm-invoice-revision-"));
  const config = backOfficeTestConfig(root);
  const draftId = crypto.randomUUID(), revision = "a".repeat(64), obsolete = "b".repeat(64);
  const requests: Array<{ format: string | null; revision: string | null }> = [];
  const documentPath = `/api/back-office/timesheet/drafts/${draftId}/document`;
  const platform = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/desktop/policy") return Response.json({ schemaVersion: 1, orgId: "firm", orgName: "Test firm", revision: 1, role: "admin", updatedAt: null,
      entries: { "backOffice.sync": { mode: "enforced", value: { enabled: true, modelEditors: ["reviewer"], directoryEditors: ["reviewer"], billingMembers: ["reviewer"] } } } });
    if (url.pathname === "/api/desktop/policy/secrets") return Response.json({ schemaVersion: 1, revision: 1, secrets: {} });
    if (url.pathname !== documentPath || request.method !== "GET") return new Response(null, { status: 404 });
    const format = url.searchParams.get("format"), requested = url.searchParams.get("revision");
    requests.push({ format, revision: requested });
    if (requested !== revision) return Response.json({ message: "Draft revision required or changed" }, { status: 409 });
    return Response.json({ format, contentBase64: Buffer.from(`Draft ${format} at ${requested}`).toString("base64") });
  } });
  const oldURL = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  await writeEigenweltConnection(config, { platformURL: platform.url.origin, platformToken: "test-platform", accessTokenExpiresAt: Date.now() + 3600000,
    account: { userId: "reviewer", orgId: "firm", orgName: "Test firm", orgRole: "org:admin", userName: "Reviewer", userEmail: null } });
  await scheduleOrgPolicySync(config, { force: true });
  const server = await startServer(config);
  const download = (format: string, requested?: string) => fetch(
    `http://127.0.0.1:${server.port}/back-office/timesheet/drafts/${draftId}/document?scope=team&format=${format}${requested ? "&revision=" + requested : ""}`,
    { headers: { authorization: "Bearer fixture", "x-legalwork-host-token": "host" } },
  );
  try {
    for (const format of ["pdf", "docx"]) {
      const file = await download(format, revision);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe(`Draft ${format} at ${revision}`);
    }
    expect((await download("pdf", obsolete)).status).toBe(409);
    expect((await download("pdf")).status).toBe(409);
    expect((await download("pdf", "invalid")).status).toBe(400);
    expect(requests).toEqual([
      { format: "pdf", revision }, { format: "docx", revision },
      { format: "pdf", revision: obsolete }, { format: "pdf", revision: null },
    ]);
  } finally {
    await server.stop();
    await resetOrgPolicyRuntimeForTests(config);
    await closeBackOfficeStoreForTests(config);
    await closeEigenweltConnectionForTests(config);
    platform.stop(true);
    if (oldURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = oldURL;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("a firm without a workflow service uses existing records; private evidence stays on device", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-directory-time-"));
  const config = backOfficeTestConfig(root);
  let serviceStatus = 404;
  const records = new Map<string, BackOfficeRecord>();
  const uploads: unknown[] = [];
  const files = new Map<string, Uint8Array>();
  let delegate = false;
  let offline = false;
  const platform = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (offline && (path === "/api/intake/members" || path === "/api/back-office"))
      return new Response("Synthetic connection unavailable", { status: 503 });
    if (path === "/api/intake/members") return Response.json([{ userId: "worker", name: "Worker", email: null, role: "org:member" }, { userId: "colleague", name: "Colleague", email: null, role: "org:member", canRecordTimeFor: delegate }]);
    if (path === "/api/desktop/policy") return Response.json({ schemaVersion: 1, orgId: "firm", orgName: "Test firm", revision: 1, role: "member", updatedAt: null,
      entries: { "backOffice.sync": { mode: "enforced", value: { enabled: true, modelEditors: ["worker"], directoryEditors: ["worker"], billingMembers: ["worker"] } } } });
    if (path === "/api/desktop/policy/secrets") return Response.json({ schemaVersion: 1, revision: 1, secrets: {} });
    if (path === "/api/back-office/timesheet") return new Response("<html>Unavailable</html>", { status: serviceStatus });
    if (path.startsWith("/upload/")) {
      const id = path.split("/").at(-1)!;
      if (request.method === "PUT") { files.set(id, new Uint8Array(await request.arrayBuffer())); return new Response(null, { status: 204 }); }
      const bytes = files.get(id);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    }
    if (path === "/api/back-office/files") {
      const body = z.object({ action: z.string(), id: z.string().optional(), file: BackOfficeFileSchema.optional() }).parse(await request.json());
      if (body.action === "prepare" && body.file) return Response.json({ uploaded: files.has(body.file.id), url: new URL("/upload/" + body.file.id, request.url).href });
      if (body.action === "commit") return Response.json({ ok: true });
      if (body.action === "download" && body.id) return Response.json({ url: new URL("/upload/" + body.id, request.url).href });
      return new Response(null, { status: 400 });
    }
    if (path === "/api/back-office") {
      const body = z.object({ changes: z.array(BackOfficeChangeSchema) }).parse(await request.json());
      for (const change of body.changes) {
        uploads.push(change);
        if (change.kind !== "record") throw new Error("Unexpected model mutation");
        const next = BackOfficeRecordSchema.parse(change.data), previous = records.get(next.id);
        records.set(next.id, { ...previous, ...next, values: { ...previous?.values, ...next.values } });
      }
      return Response.json({ protocol: 1, model: defaultBackOfficeModel(), records: [...records.values()], accepted: body.changes.map(change => change.id), conflicts: [], views: [], cursor: uploads.length + 1 });
    }
    return new Response(null, { status: 404 });
  } });
  const oldURL = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  await writeEigenweltConnection(config, { platformURL: platform.url.origin, platformToken: "test-platform", accessTokenExpiresAt: Date.now() + 3600000,
    account: { userId: "worker", orgId: "firm", orgName: "Test firm", orgRole: "org:admin", userName: "Worker", userEmail: null } });
  await scheduleOrgPolicySync(config, { force: true });
  const server = await startServer(config);
  const api = (path: string, body?: unknown, host = true) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer fixture", "content-type": "application/json", ...(host ? { "x-legalwork-host-token": "host" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const access = await backOfficeAccess(config, true), store = await backOfficeStore(config);
    const client = store.saveRecord("firm", access.actor, { objectId: "clients", revision: 0, values: { name: "Test client" } });
    const matter = store.saveRecord("firm", access.actor, { objectId: "matters", revision: 0, values: { name: "Test matter", clients: [client.id] } });
    await syncBackOffice(config);
    const path = "/back-office/timesheet?scope=team&expectedUserId=worker";
    const response = await api(path);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const state = TimesheetStateSchema.parse(body);
    expect(state.service).toBe("records");
    expect(state.canReview).toBe(false);
    expect(state.canManage).toBe(false);
    expect(state.matters.map(m => m.id)).toContain(matter.id);
    expect((await api(path + "&directoryId=wrong")).status).toBe(409);
    expect((await api(path, { type: "policy", policy: { scope: "firm", targetId: "firm", effectiveFrom: "2026-11-17", revision: 0 } })).status).toBe(501);
    expect(store.db.all("SELECT * FROM bo_timesheets")).toHaveLength(0);
    // Auth failures, outages and malformed success responses must never select another persistence mode.
    for (serviceStatus of [401, 403, 500, 503, 200]) expect((await api(path)).status).not.toBe(200);
    serviceStatus = 501;
    const missing = await api(path);
    const missingBody = await missing.json();
    expect(missing.status, JSON.stringify(missingBody)).toBe(200);
    expect(TimesheetStateSchema.parse(missingBody).service).toBe("records");
    serviceStatus = 404;
    const profile = await captureProfile(config, await backOfficeAccess(config, true));
    const proposal = captureProposalSchema.parse({ key: crypto.randomUUID(), digest: "0".repeat(64), date: "2026-11-17", source: "stopwatch", projectId: null, matterId: matter.id,
      activity: "RES", narrative: "PRIVATE source wording", startAt: "2026-11-17T09:00:00Z", endAt: "2026-11-17T09:13:00Z", workedMinutes: 13, dismissed: false });
    proposal.digest = proposalCommitment(proposal);
    await mkdir(dirname(profile.path), { recursive: true });
    await writeFile(profile.path, JSON.stringify({ settings: { calendar: false, tasks: false, intervalMinutes: 0 }, lastRun: 0,
      days: { [proposal.date]: [{ eventKey: "PRIVATE-event-id", proposal }] }, originals: { [proposal.digest]: proposal }, accepted: {} }));
    const context = new URLSearchParams({ date: proposal.date, profileId: profile.profileId, user: profile.user, scope: profile.scope, principal: profile.principal });
    expect(captureStateSchema.parse(await (await api("/private-timesheet/workday?" + context)).json()).proposals).toHaveLength(1);
    const roster = z.object({ members: z.array(z.object({ userId: z.string() })) }).parse(await (await api("/back-office/time-members")).json());
    expect(roster.members.map(member => member.userId)).toEqual(["worker"]);
    expect(store.records("firm", access.actor, "people")).toHaveLength(0);
    const draftAction = { type: "draft", key: proposal.key, proposalDigest: proposal.digest, values: { billingNarrative: "PRIVATE edited wording", recordedMinutes: 13 } };
    expect((await api("/private-timesheet/workday?" + context, draftAction, false)).status).toBe(401);
    expect((await api("/private-timesheet/workday?" + context, draftAction)).status).toBe(200);
    expect(store.records("firm", access.actor, "timeEntries")).toHaveLength(0);
    expect(captureStateSchema.parse(await (await api("/private-timesheet/workday?" + context)).json()).drafts[proposal.key].values.billingNarrative).toBe("PRIVATE edited wording");
    expect((await api("/private-timesheet/workday?" + context, { ...draftAction, proposalDigest: "f".repeat(64) })).status).toBe(409);
    const booking = { timekeeperUserId: "worker", id: proposal.key, create: true, revision: 0, objectId: "timeEntries", values: { name: "Confirmed research", billingNarrative: "Confirmed research", status: "Draft",
      matter: matter.id, client: client.id, serviceDate: proposal.date, startedAt: proposal.startAt, endedAt: proposal.endAt, recordedMinutes: 13, billableMinutes: 20 },
      privateProposal: { key: proposal.key, digest: proposal.digest, profileId: profile.profileId } };
    expect((await api("/back-office/records", booking, false)).status).toBe(403);
    expect((await api("/back-office/records", { ...booking, privateProposal: { ...booking.privateProposal, profileId: "another" } })).status).toBe(409);
    const other = { ...booking, id: crypto.randomUUID(), privateProposal: undefined, timekeeperUserId: "colleague" };
    expect((await api("/back-office/records", other)).status).toBe(403);
    expect((await api("/back-office/records", { ...booking, timekeeperUserId: "outside-contact" })).status).toBe(403);
    const workday = "/private-timesheet/workday?" + context;
    const { values } = booking;
    const draftPatch = { type: "draft-patch", key: proposal.key, proposalDigest: proposal.digest, date: proposal.date };
    const first = captureStateSchema.parse(await (await api(workday)).json()).drafts[proposal.key];
    const draftA = captureStateSchema.parse(await (await api(workday, {
      ...draftPatch, revision: first.revision, changes: values,
    })).json()).drafts[proposal.key];
    const staleBooking = { ...booking, privateProposal: { ...booking.privateProposal, draftRevision: draftA.revision } };
    const edited = { name: "Reviewed in the second window", billingNarrative: "Reviewed in the second window" };
    const draftB = captureStateSchema.parse(await (await api(workday, {
      ...draftPatch, revision: draftA.revision, changes: edited,
    })).json()).drafts[proposal.key];
    const stale = await api("/back-office/records", staleBooking);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "private_draft_conflict", details: { draft: draftB } });
    expect((await api("/back-office/records", booking)).status).toBe(409);
    expect(store.records("firm", access.actor, "timeEntries")).toHaveLength(0);
    expect(captureStateSchema.parse(await (await api(workday)).json()).drafts[proposal.key]).toEqual(draftB);
    const reviewedBooking = { ...booking, values: { ...values, ...edited }, privateProposal: {
      ...booking.privateProposal, draftRevision: draftB.revision,
    } };
    // Self is the bound account, even when no contact exists yet and the roster is offline.
    offline = true;
    const saved = await api("/back-office/records", reviewedBooking);
    expect(saved.status).toBe(200);
    expect((await api("/back-office/records", reviewedBooking)).status).toBe(200);
    expect(store.raw("firm", proposal.key)).not.toBeNull();
    expect(store.pending("firm", 0, access.actor).some(item => BackOfficeRecordSchema.parse(item.change.data).id === proposal.key)).toBe(true);
    offline = false;
    await expect(acceptPrivateProposal(config, { user: profile.user, scope: profile.scope, principal: profile.principal, profileId: profile.profileId }, proposal.key, proposal.digest,
      async () => "must not book twice", "workflow")).rejects.toMatchObject({ status: 409 });
    await syncBackOffice(config);
    const created = records.get(proposal.key);
    expect(created?.values.billingNarrative).toBe(edited.billingNarrative);
    const people = store.records("firm", access.actor, "people");
    expect(people).toHaveLength(1);
    expect(people[0].sourceId).toBe("eigenwelt-member:worker");
    expect(people[0].values.name).toBe("Worker");
    expect(created?.values.timekeeper).toBe(people[0].id);
    expect((await api("/private-timesheet/workday?" + context, draftAction)).status).toBe(409);
    expect((await api("/private-timesheet/workday?" + context, { type: "draft", key: proposal.key, values: null })).status).toBe(200);
    expect(captureStateSchema.parse(await (await api("/private-timesheet/workday?" + context)).json()).drafts[proposal.key]).toBeUndefined();
    const another = captureProposalSchema.parse({ ...proposal, key: crypto.randomUUID(), narrative: "PRIVATE second source" });
    another.digest = proposalCommitment(another);
    const privateState = JSON.parse(await readFile(profile.path, "utf8"));
    privateState.days[proposal.date].push({ eventKey: "PRIVATE-another-event", proposal: another });
    privateState.originals[another.digest] = another;
    await writeFile(profile.path, JSON.stringify(privateState));
    const reconcile = { type: "reconcile", key: another.key, digest: another.digest, recordId: proposal.key };
    const revision = store.raw("firm", proposal.key)?.revision;
    expect(revision).toBeGreaterThan(0);
    expect((await api("/private-timesheet/workday?" + context, reconcile)).status).toBe(400);
    const link = { ...reconcile, recordRevision: revision };
    expect((await api("/private-timesheet/workday?" + context, link)).status).toBe(200);
    expect((await api("/private-timesheet/workday?" + context, link)).status).toBe(200);
    expect(store.records("firm", access.actor, "timeEntries")).toHaveLength(1);
    expect(captureStateSchema.parse(await (await api("/private-timesheet/workday?" + context)).json()).proposals.some(item => item.key === another.key)).toBe(false);
    await expect(acceptPrivateProposal(config, profile, another.key, another.digest, async () => "duplicate", "record")).rejects.toMatchObject({ status: 409 });
    expect(created?.values.recordedMinutes).toBe(13);
    expect(created?.values.billableMinutes).toBe(20);
    expect(created?.access).toBe("org");
    const sent = JSON.stringify(uploads);
    expect(sent).not.toContain("PRIVATE");
    expect(sent).not.toContain(proposal.digest);
    expect(sent).not.toContain("privateProposal");
    expect(sent).not.toContain("draftRevision");
    expect(await readFile(profile.path, "utf8")).toContain("PRIVATE source wording");
    const invoiceResponse = await api("/back-office/records", { objectId: "invoices", revision: 0, values: { name: "Test invoice", matter: matter.id, client: client.id } });
    const invoice = z.object({ record: BackOfficeRecordSchema }).parse(await invoiceResponse.json()).record;
    const pdf = new TextEncoder().encode("%PDF-1.4 synthetic attachment test");
    const attached = await api(`/back-office/records/${invoice.id}/files/invoiceFile`, { objectId: "invoices", name: "Test.pdf", dataBase64: Buffer.from(pdf).toString("base64") });
    const file = z.object({ file: BackOfficeFileSchema }).parse(await attached.json()).file;
    expect((await api("/back-office/records", { id: invoice.id, objectId: "invoices", revision: invoice.revision, values: { invoiceFile: [file] } })).status).toBe(200);
    await syncBackOffice(config);
    expect(files.get(file.id)).toEqual(pdf);
    expect(records.get(invoice.id)?.values.invoiceFile).toEqual([file]);
    const downloaded = await api(`/back-office/records/${invoice.id}/files/invoiceFile/${file.id}`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(pdf);
    delegate = true;
    const delegatedBooking = await api("/back-office/records", other);
    expect(delegatedBooking.status).toBe(200);
    const assigned = BackOfficeRecordSchema.parse((await delegatedBooking.json()).record);
    delegate = false;
    expect((await api("/back-office/records", { objectId: "timeEntries", id: assigned.id, revision: 1, values: { recordedMinutes: 40 } })).status).toBe(403);
    expect((await api("/back-office/records", { objectId: "timeEntries", id: crypto.randomUUID(), revision: 0, create: true,
      values: { ...other.values, timekeeper: assigned.values.timekeeper } })).status).toBe(403);
    const dateOnlyId = crypto.randomUUID();
    offline = true;
    const dateOnly = await api("/back-office/records", { id: dateOnlyId, create: true, revision: 0, objectId: "timeEntries", timekeeperUserId: "worker",
      values: { ...booking.values, name: "Date-only service", billingNarrative: "Date-only service", serviceDate: "2026-11-18", startedAt: "2026-11-18", endedAt: null } });
    expect(dateOnly.status).toBe(200);
    expect(store.raw("firm", dateOnlyId)?.values.timekeeper).toBe(people[0].id);
    expect(store.pending("firm", 0, access.actor).some(item => BackOfficeRecordSchema.parse(item.change.data).id === dateOnlyId)).toBe(true);
    // Another worker still needs a current delegated grant; an outage cannot broaden access.
    const deniedId = crypto.randomUUID();
    expect((await api("/back-office/records", { ...other, id: deniedId })).status).toBe(502);
    expect(store.raw("firm", deniedId)).toBeNull();
    offline = false;
    await syncBackOffice(config);
    expect(records.get(dateOnlyId)?.values.startedAt).toBe("2026-11-18");
    expect(records.get(dateOnlyId)?.values.endedAt).toBeNull();
    expect(store.checkIntegrity().locallyVerified).toBe(true);
  } finally {
    await server.stop();
    await resetOrgPolicyRuntimeForTests(config);
    await closeBackOfficeStoreForTests(config);
    await closeEigenweltConnectionForTests(config);
    platform.stop(true);
    if (oldURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = oldURL;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
