import { z } from "zod";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureAction } from "@legalwork/types/time-capture";
import { captureProposalSchema, captureStateSchema } from "@legalwork/types/time-capture";
import { registerFileRoutes } from "../routes/files.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { backOfficeAccess } from "../back-office/access.js";
import { ApprovalService } from "../approvals.js";
import { ReloadEventStore } from "../events.js";
import { TokenService } from "../tokens.js";
import { ApiError } from "../errors.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { runtimeDbPath, writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import {
  acceptPrivateProposal,
  beginDocumentCapture,
  captureProfile,
  registerWorkdayRoutes,
} from "./routes.js";
import { documentEvidence } from "./document-workday.js";

test("document evidence keeps one stable key per path, project and day; timestamps are not a duration", () => {
  const at = new Date(2026, 9, 5, 17, 45);
  const created = documentEvidence("a", "Reports/Reply.docx", true, at);
  const amended = documentEvidence("a", "Reports/Reply.docx", false, at);
  expect(created?.eventKey).toBe(amended?.eventKey);
  expect(created?.proposal).toMatchObject({
    date: "2026-10-05",
    source: "documents",
    activity: "DFT",
    projectId: "a",
    narrative: "Reply.docx",
    workedMinutes: null,
    startAt: null,
    endAt: null,
  });
  expect(documentEvidence("b", "Reports/Reply.docx", true, at)?.eventKey).not.toBe(created?.eventKey);
  for (const path of [
    "/outside/report.docx",
    "C:\\private\\report.docx",
    "Notes/../secret.md",
    ".legalwork/workflows/secrets.md",
    "a/~$reply.docx",
    "main.ts",
  ]) {
    expect(documentEvidence("a", path, true, at)).toBeUndefined();
  }
});

test("only successful opted-in local editor saves yield a private workday suggestion", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-document-capture-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const config = backOfficeTestConfig(root, {
    workspaces: [
      {
        id: "matter-project",
        name: "Synthetic",
        workspaceType: "local",
        path: workspace,
        preset: "starter",
      },
    ],
    authorizedRoots: [workspace],
  });
  // The fixture keeps runtime/private files isolated from a normal account.
  expect(runtimeDbPath(config)).toBe(join(root, "runtime.sqlite"));
  const routes: Route[] = [];
  const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });
  const readJsonBody = (r: Request) => r.json();
  registerFileRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable: () => {},
    requireApproval: async () => {},
    requireClientScope: () => {},
    resolveWorkspace: async () => config.workspaces[0],
    resolveInboxEnabled: () => false,
    resolveOutboxEnabled: () => false,
    resolveInboxMaxBytes: () => 0,
    scopeRank: () => 3,
  });
  registerWorkdayRoutes({
    resolveWorkspace: async () => config.workspaces[0],
    routes,
    config,
    jsonResponse,
    readJsonBodyLimited: readJsonBody,
    ensureWritable: () => {},
  });
  const approvals = new ApprovalService(config.approval),
    reloadEvents = new ReloadEventStore(),
    tokens = new TokenService(config);
  async function dispatch(request: Request) {
    const url = new URL(request.url);
    const matched = matchRoute(routes, request.method, url.pathname);
    if (!matched) throw Error("Missing fixture route");
    const actor = request.headers.has("X-LegalWork-Host-Token")
      ? { type: "host" as const }
      : { type: "remote" as const };
    try {
      return await matched.handler({
        config,
        url,
        params: matched.params,
        request,
        actor,
        approvals,
        reloadEvents,
        tokens,
      });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ message: e.message }, { status: e.status });
      throw e;
    }
  }
  try {
    const base = "http://127.0.0.1",
      date = new Date();
    const day = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    const getProfileId = async () =>
      (await captureProfile(config, await backOfficeAccess(config))).profileId;
    let profileId = await getProfileId();
    const endpoint =
      base +
      "/private-timesheet/workday?" +
      new URLSearchParams({ date: day, user: "local", scope: "local", principal: "" });
    const host = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
    const customer = { Authorization: "Bearer " + config.token, "Content-Type": "application/json" };
    const workday = async (action: CaptureAction) => {
      const response = await dispatch(
        new Request(endpoint + "&profileId=" + profileId, {
          method: "POST",
          headers: host,
          body: JSON.stringify(action),
        }),
      );
      const raw = await response.json();
      expect(response.status).toBe(200);
      return captureStateSchema.parse(raw);
    };
    const settings = (documents: boolean) =>
      workday({
        type: "settings",
        settings: { calendar: false, tasks: false, documents, intervalMinutes: 0 },
      });
    const write = async (path: string, content: string, ui = true, raw = false, createOnly = false) => {
      const payload = raw
        ? { path, dataBase64: Buffer.from(content).toString("base64"), createOnly }
        : { path, content, createOnly };
      const r = await dispatch(
        new Request(base + "/workspace/matter-project/files/" + (raw ? "raw" : "content"), {
          method: "POST",
          headers: ui ? host : customer,
          body: JSON.stringify(payload),
        }),
      );
      await r.arrayBuffer();
      return r.status;
    };
    await settings(false);
    expect(await write("Before.md", "OFF")).toBe(200);
    await settings(true);
    expect(await write("Existing.md", "private sample")).toBe(200);
    expect(await write("Existing.md", "edited private sample")).toBe(200);
    expect(await write("Synthetic.docx", "binary sample", true, true)).toBe(200);
    expect(await write("Existing.md", "conflict", true, false, true)).toBe(409);
    expect(await write("Other.md", "remote actor", false)).toBe(200);
    const initial = await workday({ type: "calendar" });
    expect(initial.proposals.map((p) => p.narrative).sort()).toEqual(["Existing.md", "Synthetic.docx"]);
    expect(
      initial.proposals.every((p) => p.workedMinutes === null && p.endAt === null && p.startAt === null),
    ).toBe(true);
    const next = await workday({ type: "calendar" });
    expect(next.proposals.map((p) => p.key)).toEqual(initial.proposals.map((p) => p.key));
    expect(
      await beginDocumentCapture(
        config,
        { actor: { type: "host" }, agentAccess: {} },
        "matter-project",
        "Agent.md",
      ),
    ).toBeUndefined();
    const interrupted = await beginDocumentCapture(
      config,
      { actor: { type: "host" } },
      "matter-project",
      "Interrupted.md",
    );
    const disabled = await settings(false);
    expect(disabled.proposals).toEqual([]);
    expect(await write("After.md", "OFF")).toBe(200);
    await settings(true);
    const interruptedFile = join(workspace, "Interrupted.md");
    await writeFile(interruptedFile, "Synthetic interrupted save");
    await interrupted?.(null, await stat(interruptedFile));
    const resumed = await workday({ type: "calendar" });
    expect(resumed.proposals).toHaveLength(2);
    const folder = join(root, "private-timesheets"),
      files = (await readdir(folder)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
    expect(files).toHaveLength(1);
    const profile = await readFile(join(folder, files[0]), "utf8");
    for (const excluded of [
      "OFF",
      "private sample",
      "binary sample",
      "remote actor",
      "Interrupted.md",
      "Other.md",
      "Before.md",
      "After.md",
    ])
      expect(profile).not.toContain(excluded);
    const accepted = resumed.proposals[0];
    await acceptPrivateProposal(
      config,
      { user: "local", scope: "local", principal: "", profileId },
      accepted.key,
      accepted.digest,
      async () => true,
    );
    const identity = { user: "local", scope: "local", principal: "" };
    const original = (id: string, hash: string) => dispatch(new Request(
      base + "/private-timesheet/original/" + hash + "?" + new URLSearchParams({ ...identity, profileId: id }),
      { headers: host },
    ));
    const shown = await original(profileId, accepted.digest);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ activity: accepted.activity, narrative: accepted.narrative, workedMinutes: accepted.workedMinutes });
    expect((await original("wrong", accepted.digest)).status).toBe(409);
    expect((await original(profileId, "f".repeat(64))).status).toBe(404);
    await workday({
      type: "settings",
      settings: { calendar: false, tasks: true, documents: false, intervalMinutes: 0 },
    });
    expect((await workday({ type: "calendar" })).proposals).toHaveLength(0);
    await settings(true);
    const restored = await workday({ type: "calendar" });
    expect(restored.proposals.find((p) => p.key === accepted.key)).toBeUndefined();
    const crossAccount = await beginDocumentCapture(
      config,
      { actor: { type: "host" } },
      "matter-project",
      "Switched.md",
    );
    await writeEigenweltConnection(config, {
      platformURL: eigenweltPlatformUrl(),
      account: {
        userId: "second-person",
        orgId: "fixture",
        orgName: "Fixture",
        orgRole: "org:member",
        userName: "Second",
        userEmail: "second@example.test",
      },
    });
    const switchedFile = join(workspace, "Switched.md");
    await writeFile(switchedFile, "Synthetic new account");
    await crossAccount?.(null, await stat(switchedFile));
    const stale = await dispatch(
      new Request(endpoint + "&profileId=" + profileId, {
        method: "POST",
        headers: host,
        body: JSON.stringify({ type: "settings", settings: initial.settings }),
      }),
    );
    expect(stale.status).toBe(409);
    profileId = await getProfileId();
    const newProfile = await workday({ type: "calendar" });
    expect(newProfile.settings.documents).toBe(true);
    expect(newProfile.proposals).toEqual([]);
    await writeEigenweltConnection(config, { account: null, platformURL: null });
    profileId = await getProfileId();
    const previous = await workday({ type: "calendar" });
    expect(previous.proposals.map((p) => p.narrative)).toEqual(
      ["Existing.md", "Synthetic.docx"].filter(narrative => narrative !== accepted.narrative),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("a moved document survives an atomic edit without lending its private identity to the old name", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-document-identity-"));
  try {
    const first = join(root, "one"), second = join(root, "two");
    await Promise.all([mkdir(first), mkdir(second)]);
    const config = backOfficeTestConfig(root, {
      workspaces: [
        { id: "one", name: "One", path: first, workspaceType: "local", preset: "starter" },
        { id: "two", name: "Two", path: second, workspaceType: "local", preset: "starter" },
      ],
      authorizedRoots: [first, second],
    });
    const actor = { actor: { type: "host" } };
    const created = await beginDocumentCapture(config, actor, "one", "Revision.md");
    const originalPath = join(first, "Revision.md"), movedPath = join(first, "Moved.md");
    await writeFile(originalPath, "Synthetic");
    await created?.(null, await stat(originalPath));
    await rename(originalPath, movedPath);
    const moved = await beginDocumentCapture(config, actor, "one", "Moved.md");
    const movedBefore = await stat(movedPath);
    const next = join(first, "Replacement.md");
    await writeFile(next, "More synthetic content");
    await rename(next, movedPath);
    await moved?.(movedBefore, await stat(movedPath));
    await writeFile(originalPath, "Unrelated file made outside LegalWork");
    const reused = await beginDocumentCapture(config, actor, "one", "Revision.md");
    const reusedBefore = await stat(originalPath);
    await writeFile(next, "First LegalWork edit of the unrelated file");
    await rename(next, originalPath);
    await reused?.(reusedBefore, await stat(originalPath));
    const another = await beginDocumentCapture(config, actor, "two", "Revision.md");
    await writeFile(join(second, "Revision.md"), "Unrelated synthetic content");
    await another?.(null, await stat(join(second, "Revision.md")));
    const profile = await captureProfile(config, await backOfficeAccess(config));
    const storage = z.object({ documentSaves: z.record(z.iso.date(), z.record(z.string(), captureProposalSchema)) })
      .parse(JSON.parse(await readFile(profile.path, "utf8")));
    const entries = Object.values(storage.documentSaves).flatMap(day => Object.values(day));
    expect(entries).toHaveLength(4);
    const original = entries.find(item => item.projectId === "one" && item.activity === "DFT");
    const amendment = entries.find(item => item.projectId === "one" && item.narrative === "Moved.md");
    const reusedName = entries.find(item => item.projectId === "one" && item.narrative === "Revision.md" && item.activity === "MOD");
    expect(original?.documentId).toBeTruthy();
    expect(amendment?.documentId).toBe(original?.documentId);
    expect(reusedName?.documentId).toBeTruthy();
    expect(reusedName?.documentId).not.toBe(original?.documentId);
    expect(entries.find(item => item.projectId === "two")?.documentId).not.toBe(original?.documentId);
    expect(entries.every(item => item.workedMinutes === null && !item.changeSummary)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
