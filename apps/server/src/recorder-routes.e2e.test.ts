import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { RecorderLiveTranscriptStatus, ServerConfig } from "./types.js";
import { authenticateWikiAgentRequest, ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession } from "./wiki/agent-access.js";
import { Plugin } from "@opencode/plugin";
import { recordingTools } from "./opencode-plugins/recording-tools.js";
import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
import { PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT } from "./scheduled-tasks/access.js";
import type { AudioRecordingMeta } from "@legalwork/types/audio";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { grantWikiProjectAccess, wikiProjectAccessRevision } from "./wiki/project-access.js";

const TOKEN = "recorder_routes_client_token";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function startTestServer(withRecorder: boolean) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-recorder-routes-"));
  roots.push(root);
  let status: RecorderLiveTranscriptStatus = {
    available: true,
    recordingActive: true,
    liveTranscriptActive: false,
    fileName: null,
    error: null,
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    configPath: join(root, "server.json"),
    hostToken: "recorder_routes_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
    recorder: withRecorder ? {
      listRecordings: async () => [],
      readRecording: async () => null,
      status: () => status,
      setLiveTranscript: (enabled, workspacePath) => {
        expect(workspacePath).toBe(root);
        status = {
          ...status,
          liveTranscriptActive: enabled,
          fileName: enabled ? "live-call-transcript.md" : null,
        };
        return status;
      },
    } : null,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  return { base, root, config, url: `${base}/workspace/ws_1/recorder/live-transcript` };
}

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("recorder live transcript routes", () => {
  test("reads and toggles the desktop recorder for an authenticated workspace", async () => {
    const { url } = await startTestServer(true);
    const initial = await fetch(url, { headers });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ recordingActive: true, liveTranscriptActive: false });

    const enabled = await fetch(url, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      liveTranscriptActive: true,
      fileName: "live-call-transcript.md",
    });

    const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({ enabled: "yes" }) });
    expect(invalid.status).toBe(400);
  });

  test("reports unavailable when LegalWork is not embedded in the desktop app", async () => {
    const { url } = await startTestServer(false);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, recordingActive: false });
  });
});

describe("recording library access", () => {
  test("only the owner can read the library, with an explicit unavailable response for headless servers", async () => {
    const { base } = await startTestServer(true);
    const owner = { "x-legalwork-host-token": "recorder_routes_host_token" };
    for (const path of ["/recorder/recordings", "/recorder/recordings/example"]) {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { headers })).status).toBe(403);
    }
    const list = await fetch(`${base}/recorder/recordings`, { headers: owner });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ scope: "library", recordings: [], totalMatches: 0, nextCursor: null });
    expect((await fetch(`${base}/recorder/recordings/missing`, { headers: owner })).status).toBe(404);
    expect((await fetch(`${base}/recorder/recordings?limit=1000`, { headers: owner })).status).toBe(400);
    const headless = await startTestServer(false);
    expect((await fetch(`${headless.base}/recorder/recordings`, { headers: owner })).status).toBe(503);
  });

  test("tools inherit the real chat's owner access and immediately lose it on downgrade or revocation", async () => {
    const { base, root, config } = await startTestServer(true);
    const before = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN, agent: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
    process.env.LEGALWORK_SERVER_URL = base;
    process.env.LEGALWORK_SERVER_TOKEN = TOKEN;
    process.env.LEGALWORK_WIKI_AGENT_TOKEN = await ensureWikiAgentToken(config);
    const context = { directory: root, sessionID: "recording-chat" };
    const {tool: RECORDING_TOOLS} = await nativePluginTools(Plugin.define({id:"recording-fixture",async setup(ctx){await ctx.tool.transform(editor=>{for(const tool of recordingTools(ctx))editor.add(tool);});}}));
    const list = async () => JSON.parse(await RECORDING_TOOLS.legalwork_recordings_list.execute({ period: "yesterday", timeZone: "Europe/Berlin" }, context));
    try {
      expect((await list()).ok).toBe(false);
      await grantWikiAgentSession(config, { sessionId: context.sessionID, directory: root, scope: "owner" });
      const allowed = await list();
      expect(allowed.ok).toBe(true);
      expect(allowed.referenceData.scope).toBe("library");
      expect(allowed.referenceData.filters.timeZone).toBe("Europe/Berlin");
      expect(allowed.referenceData.filters.from).toBe(allowed.referenceData.filters.to);
      const missing = JSON.parse(await RECORDING_TOOLS.legalwork_recording_read.execute({ id: "missing" }, context));
      expect(missing.ok).toBe(false);
      expect(JSON.stringify(missing)).toContain("recording_not_found");
      for (const scope of ["collaborator", "viewer"] satisfies Array<"collaborator" | "viewer">) {
        await grantWikiAgentSession(config, { sessionId: context.sessionID, directory: root, scope });
        expect((await list()).ok).toBe(false);
      }
      await grantWikiAgentSession(config, { sessionId: context.sessionID, directory: root, scope: "owner" });
      for (const agent of [PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT]) {
        await grantWikiAgentSession(config, { sessionId: context.sessionID, directory: root, scope: "owner", scheduledProjects: agent === ALL_PROJECTS_TASK_AGENT ? "all" : ["ws_1"] });
        const scheduled = JSON.parse(await RECORDING_TOOLS.legalwork_recordings_list.execute({}, { ...context, agent }));
        expect(scheduled.ok).toBe(true);
      }
      revokeWikiAgentSession(config, context.sessionID);
      expect((await list()).ok).toBe(false);
    } finally {
      for (const [key, value] of Object.entries({ LEGALWORK_SERVER_URL: before.url, LEGALWORK_SERVER_TOKEN: before.token, LEGALWORK_WIKI_AGENT_TOKEN: before.agent })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

async function libraryFixture() {
  const f = await startTestServer(true);
  const otherRoot = await mkdtemp(join(tmpdir(), "legalwork-recording-other-")); roots.push(otherRoot);
  const other = await realpath(otherRoot);
  f.config.workspaces.push({ id: "other", name: "Other project", path: other, preset: "starter", workspaceType: "local" });
  const items: AudioRecordingMeta[] = ["global", "current", "other"].map(id => ({
    id, title: `${id} recording`, createdAt: Date.now() - 1000, durationMs: 10000, language: "auto", modelId: null,
    sources: ["microphone"], folderPath: "/private/recordings", audioPath: null, transcriptPath: null,
    sizeBytes: 100, segmentCount: 1, status: "complete", error: null,
    speakerNames: { "0": "Private speaker" }, projectIds: id === "global" ? [] : [id === "current" ? "ws_1" : "other"],
  }));
  const reads: string[] = [];
  if (!f.config.recorder) throw new Error("Recorder fixture missing");
  f.config.recorder.listRecordings = async () => items;
  f.config.recorder.readRecording = async id => {
    reads.push(id); const meta = items.find(item => item.id === id);
    return meta ? { meta, segments: [{ id: "segment", startMs: 0, endMs: 10000, text: `Private ${id} transcript`, speaker: 0, final: true }] } : null;
  };
  const grant = (scheduledProjects?: "all" | string[]) => grantWikiAgentSession(f.config, { sessionId: "chat", directory: f.root, scope: "owner", scheduledProjects });
  await grant();
  const headers = { "x-legalwork-wiki-agent-token": await ensureWikiAgentToken(f.config), "x-legalwork-wiki-agent-session": "chat", "x-legalwork-wiki-agent-directory": encodeURIComponent(f.root) };
  const owner = { "x-legalwork-host-token": "recorder_routes_host_token", "Content-Type": "application/json" };
  const call = (path = "") => fetch(`${f.base}/recorder/recordings${path}`, { headers });
  const pending = async () => (await (await fetch(`${f.base}/approvals`, { headers: owner })).json()).items;
  const decide = async (reply: "allow" | "deny") => {
    for (let i = 0; i < 100; i++) {
      const item = (await pending())[0];
      if (item) {
        expect(item.action).toBe("recordings.project.read");
        expect(reads).not.toContain("other");
        expect((await fetch(`${f.base}/approvals/${item.id}`, { method: "POST", headers: owner,
          body: JSON.stringify({ reply, sessionID: "chat", workspaceId: "ws_1" }) })).status).toBe(200);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Recording approval did not appear");
  };
  return { ...f, other, items, reads, grant, headers, call, pending, decide };
}

test("interactive discovery exposes names and times, while another project's content waits for approval", async () => {
  const f = await libraryFixture();
  const list = await (await f.call()).json();
  expect(list.totalMatches).toBe(3);
  expect(JSON.stringify(list)).not.toContain("Private speaker");
  expect(f.reads).toEqual([]);
  for (const id of ["global", "current"]) expect((await f.call(`/${id}`)).status).toBe(200);
  const denied = f.call("/other");
  await f.decide("deny");
  expect((await denied).status).toBe(403);
  expect(f.reads).not.toContain("other");
  // A later user-authorized retry grants this chat's read-only recording access.
  const approved = f.call("/other"); await f.decide("allow");
  expect((await approved).status).toBe(200);
  expect((await f.call("/other")).status).toBe(200);
  expect(await f.pending()).toEqual([]);
  await grantWikiAgentSession(f.config, { sessionId: "chat", directory: f.root, scope: "collaborator" });
  expect((await f.call("/other")).status).toBe(403);
});

test("existing project grants and authorized folders permit transcripts without asking again", async () => {
  const f = await libraryFixture();
  const origin = await authenticateWikiAgentRequest(f.config, new Request(`${f.base}/recorder/recordings`, { headers: f.headers }));
  if (!origin) throw new Error("Missing origin");
  grantWikiProjectAccess(f.config, "chat", { wikiId: "wiki", projectId: "other", root: f.other, scope: "owner", origin: origin.generation }, wikiProjectAccessRevision(f.config, "chat"));
  expect((await f.call("/other")).status).toBe(200);
  // A new generation drops the old grant; an existing folder authorization still applies.
  await f.grant(["ws_1"]); await f.grant();
  await writeRuntimeOpencodeConfig(f.config, "ws_1", () => ({ permission: { external_directory: { [`${f.other}/*`]: "allow" } } }));
  expect((await f.call("/other")).status).toBe(200);
  await writeRuntimeOpencodeConfig(f.config, "ws_1", () => ({ permission: { external_directory: { [`${f.other}/*`]: "deny" } } }));
  expect((await f.call("/other")).status).toBe(403);
  expect(await f.pending()).toEqual([]);
});

test("scheduled recording access follows server-recorded project scope plus globals, never caller claims or old approvals", async () => {
  const f = await libraryFixture();
  const interactive = await (await f.call("?limit=1")).json();
  await f.grant(["ws_1"]);
  const limited = await (await f.call()).json();
  expect(limited.recordings.map((item: { id: string }) => item.id).sort()).toEqual(["current", "global"]);
  expect(limited.access.projects).toEqual(["ws_1"]);
  const paged = await (await f.call(`?cursor=${encodeURIComponent(interactive.nextCursor)}`)).json();
  expect(paged.recordings.every((item: { id: string }) => item.id !== "other")).toBe(true);
  for (const id of ["current", "global"]) expect((await f.call(`/${id}`)).status).toBe(200);
  expect((await f.call("/other?agent=legalwork-scheduled-all")).status).toBe(403);
  expect(f.reads).not.toContain("other");
  expect(await f.pending()).toEqual([]);
  await f.grant("all");
  expect((await (await f.call()).json()).totalMatches).toBe(3);
  expect((await f.call("/other")).status).toBe(200);
  // A reused chat must not retain the previous all-project scheduled authority.
  await f.grant(["ws_1"]);
  expect((await f.call("/other")).status).toBe(403);
  await f.grant(); f.reads.length = 0;
  const regular = f.call("/other"); await f.decide("deny");
  expect((await regular).status).toBe(403);
});

test("a permission downgrade while approval is pending cannot disclose a transcript", async () => {
  const f = await libraryFixture();
  const response = f.call("/other");
  for (let i = 0; i < 100 && !(await f.pending()).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await grantWikiAgentSession(f.config, { sessionId: "chat", directory: f.root, scope: "collaborator" });
  await f.decide("allow");
  expect((await response).status).toBe(403);
  expect(f.reads).toEqual([]);
});

test("permission changes revoke recording approval and in-flight library reads", async () => {
  const f = await libraryFixture();
  const response = f.call("/other"); await f.decide("allow");
  expect((await response).status).toBe(200);
  await writeRuntimeOpencodeConfig(f.config, "ws_1", () => ({ permission: { external_directory: { [`${f.other}/*`]: "deny" } } }));
  expect((await f.call("/other")).status).toBe(403);
  if (!f.config.recorder) throw new Error("Recorder fixture missing");
  f.config.recorder.listRecordings = async () => {
    await f.grant(["ws_1"]);
    return f.items;
  };
  expect((await f.call()).status).toBe(403);
  expect(await f.pending()).toEqual([]);
});

test("a recording moved to another project during a read requires approval before returning content", async () => {
  const f = await libraryFixture();
  if (!f.config.recorder) throw new Error("Recorder fixture missing");
  f.config.recorder.readRecording = async () => ({
    meta: { ...f.items[0], projectIds: ["other"] },
    segments: [{ id: "s", startMs: 0, endMs: 100, text: "Moved private content", speaker: null, final: true }],
  });
  const response = f.call("/global"); await f.decide("deny");
  expect((await response).status).toBe(403);
});
