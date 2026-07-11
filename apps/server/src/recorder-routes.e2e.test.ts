import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { RecorderLiveTranscriptStatus, ServerConfig } from "./types.js";

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
  return `http://127.0.0.1:${server.port}/workspace/ws_1/recorder/live-transcript`;
}

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("recorder live transcript routes", () => {
  test("reads and toggles the desktop recorder for an authenticated workspace", async () => {
    const url = await startTestServer(true);
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
    const url = await startTestServer(false);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, recordingActive: false });
  });
});
