import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureAction } from "@legalwork/types/time-capture";
import { captureStateSchema } from "@legalwork/types/time-capture";
import { registerFileRoutes } from "../routes/files.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { ApprovalService } from "../approvals.js";
import { ReloadEventStore } from "../events.js";
import { TokenService } from "../tokens.js";
import { ApiError } from "../errors.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { runtimeDbPath, writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { beginDocumentCapture, registerWorkdayRoutes } from "./routes.js";
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
    const endpoint =
      base +
      "/private-timesheet/workday?" +
      new URLSearchParams({ date: day, user: "local", scope: "local", principal: "" });
    const host = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
    const customer = { Authorization: "Bearer " + config.token, "Content-Type": "application/json" };
    const workday = async (action: CaptureAction) => {
      const response = await dispatch(
        new Request(endpoint, { method: "POST", headers: host, body: JSON.stringify(action) }),
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
    await interrupted?.(false);
    const resumed = await workday({ type: "calendar" });
    expect(resumed.proposals).toHaveLength(2);
    const folder = join(root, "private-timesheets"),
      files = (await readdir(folder)).filter((n) => n.endsWith(".json"));
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
    await crossAccount?.(false);
    const newProfile = await workday({ type: "calendar" });
    expect(newProfile.settings.documents).not.toBe(true);
    expect(newProfile.proposals).toEqual([]);
    await writeEigenweltConnection(config, { account: null, platformURL: null });
    const previous = await workday({ type: "calendar" });
    expect(previous.proposals.map((p) => p.narrative).sort()).toEqual(["Existing.md", "Synthetic.docx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
