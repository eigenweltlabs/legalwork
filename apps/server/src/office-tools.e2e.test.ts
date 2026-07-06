import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-office-tools-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

function baseConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_client_token",
    hostToken: "host_test_token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_word_test",
        name: "word-test",
        path: root,
        workspaceType: "local",
      } as ServerConfig["workspaces"][number],
    ],
    authorizedRoots: [root],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
  };
}

const AUTH = { Authorization: "Bearer owt_test_client_token" };
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" };

async function startTestServer() {
  const root = await createWorkspaceRoot();
  const server = await startServer(baseConfig(root));
  stops.push(() => server.stop());
  return { baseUrl: `http://127.0.0.1:${server.port}/workspace/ws_word_test/office-tools` };
}

describe("office tool relay", () => {
  test("execute fails fast when no pane is connected", async () => {
    const { baseUrl } = await startTestServer();

    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tool: "word_read_document" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No matching Office pane");
  });

  test("round trip: pane polls, executes, posts result", async () => {
    const { baseUrl } = await startTestServer();

    // Pane connects with a long poll.
    const pollPromise = fetch(`${baseUrl}/poll?wait=10`, { headers: AUTH });
    // Give the poll a moment to register as a waiter.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const executePromise = fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tool: "word_read_selection", args: { probe: 1 } }),
    });

    const pollResponse = await pollPromise;
    const pollBody = (await pollResponse.json()) as {
      requests: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
    };
    expect(pollBody.requests.length).toBe(1);
    const request = pollBody.requests[0]!;
    expect(request.tool).toBe("word_read_selection");
    expect(request.args).toEqual({ probe: 1 });

    const resultResponse = await fetch(`${baseUrl}/requests/${request.id}/result`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: true, result: { text: "selected words" } }),
    });
    expect(((await resultResponse.json()) as { accepted: boolean }).accepted).toBe(true);

    const executeBody = (await (await executePromise).json()) as {
      ok: boolean;
      result?: { text: string };
    };
    expect(executeBody.ok).toBe(true);
    expect(executeBody.result?.text).toBe("selected words");
  });

  test("queued request is delivered to the next poll", async () => {
    const { baseUrl } = await startTestServer();

    // Mark the pane as recently alive with a zero-wait poll.
    await fetch(`${baseUrl}/poll?wait=0`, { headers: AUTH });

    const executePromise = fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tool: "word_search", args: { query: "liability" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pollBody = (await (await fetch(`${baseUrl}/poll?wait=5`, { headers: AUTH })).json()) as {
      requests: Array<{ id: string; tool: string }>;
    };
    expect(pollBody.requests.length).toBe(1);

    await fetch(`${baseUrl}/requests/${pollBody.requests[0]!.id}/result`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, error: "anchor not found" }),
    });

    const executeBody = (await (await executePromise).json()) as { ok: boolean; error?: string };
    expect(executeBody.ok).toBe(false);
    expect(executeBody.error).toBe("anchor not found");
  });

  test("execute times out when the pane never answers", async () => {
    const { baseUrl } = await startTestServer();
    await fetch(`${baseUrl}/poll?wait=0`, { headers: AUTH });

    const executeBody = (await (
      await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tool: "word_read_document", timeoutMs: 1200 }),
      })
    ).json()) as { ok: boolean; error?: string };
    expect(executeBody.ok).toBe(false);
    expect(executeBody.error).toContain("did not answer");

    // A late result for the timed-out request is rejected.
    const late = (await (
      await fetch(`${baseUrl}/requests/does-not-exist/result`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: true, result: {} }),
      })
    ).json()) as { accepted: boolean };
    expect(late.accepted).toBe(false);
  });

  test("routes tools to the matching host when Word and Excel panes coexist", async () => {
    const { baseUrl } = await startTestServer();

    // Both panes long-poll the same workspace, each reporting its host.
    const wordPoll = fetch(`${baseUrl}/poll?wait=3&host=Word&document=%2Fdocs%2Fcontract.docx`, { headers: AUTH });
    const excelPoll = fetch(`${baseUrl}/poll?wait=3&host=Excel&document=%2Fdocs%2Fmodel.xlsx`, { headers: AUTH });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Status reports BOTH panes.
    const status = (await (await fetch(`${baseUrl}/status`, { headers: AUTH })).json()) as {
      connected: boolean;
      hosts: Array<{ host: string; documentUrl: string | null }>;
    };
    expect(status.connected).toBe(true);
    expect(status.hosts.map((entry) => entry.host).sort()).toEqual(["excel", "word"]);

    // A word_* tool must reach the WORD pane even though Excel polled too.
    const executePromise = fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tool: "word_read_document" }),
    });

    const wordRequests = ((await (await wordPoll).json()) as { requests: Array<{ id: string; tool: string }> }).requests;
    expect(wordRequests.length).toBe(1);
    expect(wordRequests[0]!.tool).toBe("word_read_document");

    await fetch(`${baseUrl}/requests/${wordRequests[0]!.id}/result`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: true, result: { text: "from word pane" } }),
    });
    const executeBody = (await (await executePromise).json()) as { ok: boolean; result?: { text: string } };
    expect(executeBody.ok).toBe(true);
    expect(executeBody.result?.text).toBe("from word pane");

    // The Excel pane's poll must NOT have received the word request.
    const excelRequests = ((await (await excelPoll).json()) as { requests: unknown[] }).requests;
    expect(excelRequests.length).toBe(0);
  });

  type StatusBody = {
    connected: boolean;
    hosts: Array<{ host: string; documentUrl: string | null }>;
  };
  const readStatus = async (baseUrl: string) =>
    (await (await fetch(`${baseUrl}/status`, { headers: AUTH })).json()) as StatusBody;

  test("status reflects pane liveness and the reported document", async () => {
    const { baseUrl } = await startTestServer();

    let status = await readStatus(baseUrl);
    expect(status.connected).toBe(false);
    expect(status.hosts).toEqual([]);

    const documentUrl = "/Users/test/Matters/Model.xlsx";
    await fetch(
      `${baseUrl}/poll?wait=0&document=${encodeURIComponent(documentUrl)}&host=Excel`,
      { headers: AUTH },
    );
    status = await readStatus(baseUrl);
    expect(status.connected).toBe(true);
    expect(status.hosts).toEqual([{ host: "excel", documentUrl }]);

    // Same pane (host) reporting an untitled document clears its identity.
    await fetch(`${baseUrl}/poll?wait=0&document=&host=Excel`, { headers: AUTH });
    status = await readStatus(baseUrl);
    expect(status.hosts).toEqual([{ host: "excel", documentUrl: null }]);
  });
});
