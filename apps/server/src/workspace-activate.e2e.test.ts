import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

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
  const root = await mkdtemp(join(tmpdir(), "legalwork-activate-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

function hostAuth(token: string) {
  return { "X-LegalWork-Host-Token": token };
}

function workspaceIdsFromConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("workspaces" in value) || !Array.isArray(value.workspaces)) return [];
  return value.workspaces.flatMap((workspace) =>
    workspace && typeof workspace === "object" && !Array.isArray(workspace) && "id" in workspace && typeof workspace.id === "string"
      ? [workspace.id]
      : [],
  );
}

function workspacesFromConfig(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("workspaces" in value) || !Array.isArray(value.workspaces)) return [];
  return value.workspaces.filter(
    (workspace): workspace is Record<string, unknown> =>
      Boolean(workspace) && typeof workspace === "object" && !Array.isArray(workspace),
  );
}

function authorizedRootsFromConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!("authorizedRoots" in value) || !Array.isArray(value.authorizedRoots)) return [];
  return value.authorizedRoots.filter((root): root is string => typeof root === "string");
}

async function readPersistedWorkspaceIds(configPath: string) {
  return workspaceIdsFromConfig(JSON.parse(await readFile(configPath, "utf8")));
}

async function readPersistedConfig(configPath: string): Promise<unknown> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function startMockOpencode() {
  const requests: Array<{ pathname: string; search: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ pathname: url.pathname, search: url.search });

      if (url.pathname === "/instance/dispose") {
        return Response.json({ disposed: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

function startMockRemoteLegalwork() {
  const requests: Array<{ pathname: string; authorization: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ pathname: url.pathname, authorization: request.headers.get("authorization") });

      if (url.pathname === "/workspaces") {
        return Response.json({
          activeId: "ws_remote",
          items: [
            { id: "ws_remote", name: "Remote Project", path: "/remote/project" },
            { id: "ws_other", name: "Other", path: "/remote/other" },
          ],
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startLegalworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.opencodeBaseUrl,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, hostToken: config.hostToken };
}

async function startLegalworkServerWithWorkspaces(input: {
  configPath: string;
  workspaces: ServerConfig["workspaces"];
  authorizedRoots: string[];
  projectsDirectory?: string;
  opencodeBaseUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: input.configPath,
    projectsDirectory: input.projectsDirectory,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: input.workspaces,
    authorizedRoots: input.authorizedRoots,
    opencodeBaseUrl: input.opencodeBaseUrl,
    opencodeUsername: input.opencodeUsername,
    opencodePassword: input.opencodePassword,
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, hostToken: config.hostToken };
}

describe("workspace activation", () => {
  test("activates a workspace without disposing its running engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const response = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: hostAuth(legalwork.hostToken),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeId).toBe("ws_1");

    expect(mock.requests).toEqual([]);
  });

  test("retries an explicit reload while the engine listener is starting", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    await probe.stop(true);
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${port}`,
    });
    const mockReady = new Promise<void>((resolve) => {
      setTimeout(() => {
        const engine = Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: () => Response.json({ disposed: true }),
        });
        stops.push(() => engine.stop(true));
        resolve();
      }, 250);
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/engine/reload`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token" },
    });
    await mockReady;
    expect(response.status).toBe(200);
  });

  test("allows navigation with an unreachable engine but reports an explicit reload as unavailable", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    await probe.stop(true);
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${port}`,
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const activated = await fetch(`${base}/workspaces/ws_1/activate`, { method: "POST", headers: hostAuth(legalwork.hostToken) });
    expect(activated.status).toBe(200);
    const response = await fetch(`${base}/workspace/ws_1/engine/reload`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token" },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "opencode_unavailable" });
  });

  test("does not repeat a reload after the engine accepts and drops the connection", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let attempts = 0;
    const engine = createServer((request) => {
      attempts += 1;
      request.socket.destroy();
    });
    await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
    stops.push(() => new Promise<void>((resolve, reject) => {
      engine.close((error) => error ? reject(error) : resolve());
    }));
    const address = engine.address();
    if (!address || typeof address === "string") throw new Error("Missing engine port");
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${address.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/engine/reload`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token" },
    });
    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
  });

  test("persists activation order only when requested", async () => {
    const firstRoot = await createWorkspaceRoot();
    const secondRoot = await createWorkspaceRoot();
    const configPath = join(firstRoot, "server.json");
    const workspaces: ServerConfig["workspaces"] = [
      {
        id: "ws_1",
        name: "One",
        path: firstRoot,
        preset: "starter",
        workspaceType: "local",
      },
      {
        id: "ws_2",
        name: "Two",
        path: secondRoot,
        preset: "starter",
        workspaceType: "local",
      },
    ];
    await writeFile(
      configPath,
      `${JSON.stringify({ workspaces, authorizedRoots: [firstRoot, secondRoot] }, null, 2)}\n`,
      "utf8",
    );
    const legalwork = await startLegalworkServerWithWorkspaces({
      configPath,
      workspaces,
      authorizedRoots: [firstRoot, secondRoot],
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const persistedResponse = await fetch(`${base}/workspaces/ws_2/activate?persist=true`, {
      method: "POST",
      headers: hostAuth(legalwork.hostToken),
    });
    expect(persistedResponse.status).toBe(200);
    const persistedBody = await persistedResponse.json();
    expect(persistedBody.activeId).toBe("ws_2");
    expect(persistedBody.persisted).toBe(true);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_2", "ws_1"]);

    const volatileResponse = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: hostAuth(legalwork.hostToken),
    });
    expect(volatileResponse.status).toBe(200);
    const volatileBody = await volatileResponse.json();
    expect(volatileBody.activeId).toBe("ws_1");
    expect(volatileBody.persisted).toBe(false);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_2", "ws_1"]);

    const bodyPersistedResponse = await fetch(`${base}/workspaces/ws_1/activate`, {
      method: "POST",
      headers: { ...hostAuth(legalwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ persist: true }),
    });
    expect(bodyPersistedResponse.status).toBe(200);
    const bodyPersistedBody = await bodyPersistedResponse.json();
    expect(bodyPersistedBody.activeId).toBe("ws_1");
    expect(bodyPersistedBody.persisted).toBe(true);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["ws_1", "ws_2"]);
  });
});

// Hold a real engine's model response open while the UI's activation and
// snapshot requests run. No live model, user project or account is used.
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("opening a background chat preserves its running turn through completion", async () => {
  const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
  if (!binary) return;
  const root = await realpath(await createWorkspaceRoot());
  let release = () => {};
  let requested = false;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const provider = Bun.serve({ port: 0, async fetch(request) {
    await request.json(); requested = true;
    await responseGate;
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "navigation-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "Navigation check completed." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const configPath = join(root, "engine.json");
  await writeFile(configPath, JSON.stringify({
    enabled_providers: ["fixture"], model: "fixture/fixture", small_model: "fixture/fixture", share: "disabled", autoupdate: false,
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: provider.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 } } } } },
  }));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG: configPath, OPENCODE_DB: join(root, "engine.db"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
  }, stdout: "ignore", stderr: "pipe" });
  const logs = new Response(engine.stderr).text();
  const baseUrl = `http://127.0.0.1:${port}`;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(50); }
    throw new Error("Timed out waiting for engine fixture");
  };
  try {
    await until(async () => {
      if (engine.exitCode !== null) throw new Error("Engine failed to start: " + await logs);
      try { return (await fetch(baseUrl + "/global/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    });
    const legalwork = await startLegalworkServer({ workspaceRoot: root, opencodeBaseUrl: baseUrl });
    const client = createOpencodeClient({ baseUrl, directory: root });
    const { data: session } = await client.session.create({ title: "Background work" }, { throwOnError: true });
    await client.session.promptAsync({ sessionID: session.id, agent: "build", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Run the navigation fixture." }] }, { throwOnError: true });
    await until(async () => requested);
    expect((await client.session.status({}, { throwOnError: true })).data[session.id]?.type).toBe("busy");
    const serverUrl = `http://127.0.0.1:${legalwork.server.port}`;
    for (let i = 0; i < 2; i++) {
      const activate = await fetch(`${serverUrl}/workspaces/ws_1/activate`, { method: "POST", headers: hostAuth(legalwork.hostToken) });
      expect(activate.status).toBe(200);
      const snapshot = await fetch(`${serverUrl}/workspace/ws_1/sessions/${session.id}/snapshot`, { headers: { Authorization: "Bearer owt_test_token" } });
      expect(snapshot.status).toBe(200);
      expect((await client.session.status({}, { throwOnError: true })).data[session.id]?.type).toBe("busy");
    }
    release();
    await until(async () => (await client.session.status({}, { throwOnError: true })).data[session.id]?.type !== "busy");
    const { data: messages } = await client.session.messages({ sessionID: session.id }, { throwOnError: true });
    expect(messages.some(message => message.info.role === "assistant" && message.info.error)).toBe(false);
    expect(messages.flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")).toContain("Navigation check completed.");
  } finally { release(); engine.kill("SIGKILL"); await engine.exited; await logs; provider.stop(true); }
}, 30000);

describe("workspace lifecycle registry", () => {
  test("creates server config file when adding a local workspace", async () => {
    const configRoot = await createWorkspaceRoot();
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(configRoot, "server.json");
    const legalwork = await startLegalworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const response = await fetch(`${base}/workspaces/local`, {
      method: "POST",
      headers: { ...hostAuth(legalwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: workspaceRoot, name: "Persisted Local", preset: "starter" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.persisted).toBe(true);

    const persisted = await readPersistedConfig(configPath);
    const workspaces = workspacesFromConfig(persisted);
    expect(workspaces[0]?.path).toBe(workspaceRoot);
    expect(workspaces[0]?.name).toBe("Persisted Local");
    expect(authorizedRootsFromConfig(persisted)).toEqual([workspaceRoot]);
  });

  test("does not persist transient local OpenCode runtime fields", async () => {
    const configRoot = await createWorkspaceRoot();
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(configRoot, "server.json");
    const legalwork = await startLegalworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
      opencodeBaseUrl: "http://127.0.0.1:49999",
      opencodeUsername: "runtime-user",
      opencodePassword: "runtime-pass",
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const response = await fetch(`${base}/workspaces/local`, {
      method: "POST",
      headers: { ...hostAuth(legalwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: workspaceRoot, name: "Runtime Local", preset: "starter" }),
    });
    expect(response.status).toBe(201);

    const persisted = await readPersistedConfig(configPath);
    const workspace = workspacesFromConfig(persisted)[0];
    expect(workspace?.path).toBe(workspaceRoot);
    expect(workspace?.baseUrl).toBeUndefined();
    expect(workspace?.directory).toBeUndefined();
    expect(workspace?.opencodeUsername).toBeUndefined();
    expect(workspace?.opencodePassword).toBeUndefined();
  });

  test("creates and persists remote LegalWork workspace records", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(workspaceRoot, "server.json");
    await writeFile(configPath, `${JSON.stringify({ workspaces: [], authorizedRoots: [] }, null, 2)}\n`, "utf8");
    const remote = startMockRemoteLegalwork();
    const legalwork = await startLegalworkServerWithWorkspaces({
      configPath,
      workspaces: [],
      authorizedRoots: [],
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;
    const response = await fetch(`${base}/workspaces/remote`, {
      method: "POST",
      headers: { ...hostAuth(legalwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${remote.server.port}`,
        legalworkHostUrl: `http://127.0.0.1:${remote.server.port}`,
        legalworkToken: "remote_token",
        directory: "/remote/project",
        remoteType: "legalwork",
        sandboxRunId: "run_1",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.activeId).toBe("rem_ws_remote");
    expect(body.workspaces[0].legalworkWorkspaceId).toBe("ws_remote");
    expect(body.workspaces[0].legalworkWorkspaceName).toBe("Remote Project");
    expect(remote.requests[0]).toEqual({ pathname: "/workspaces", authorization: "Bearer remote_token" });

    const persisted = await readPersistedConfig(configPath);
    const workspaces = workspacesFromConfig(persisted);
    expect(workspaces[0]?.id).toBe("rem_ws_remote");
    expect(workspaces[0]?.workspaceType).toBe("remote");
    expect(workspaces[0]?.remoteType).toBe("legalwork");
    expect(workspaces[0]?.sandboxRunId).toBe("run_1");
    expect(authorizedRootsFromConfig(persisted)).toEqual([]);
  });

  test("renames activates and deletes remote records without authorized roots", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const configPath = join(workspaceRoot, "server.json");
    const workspaces: ServerConfig["workspaces"] = [
      {
        id: "rem_ws_one",
        name: "One",
        path: "/remote/one",
        preset: "remote",
        workspaceType: "remote",
        remoteType: "legalwork",
        baseUrl: "http://127.0.0.1:9",
        legalworkWorkspaceId: "ws_one",
      },
      {
        id: "rem_ws_two",
        name: "Two",
        path: "/remote/two",
        preset: "remote",
        workspaceType: "remote",
        remoteType: "legalwork",
        baseUrl: "http://127.0.0.1:9",
        legalworkWorkspaceId: "ws_two",
      },
    ];
    await writeFile(configPath, `${JSON.stringify({ workspaces, authorizedRoots: [] }, null, 2)}\n`, "utf8");
    const legalwork = await startLegalworkServerWithWorkspaces({
      configPath,
      workspaces,
      authorizedRoots: [],
    });
    const base = `http://127.0.0.1:${legalwork.server.port}`;

    const renameResponse = await fetch(`${base}/workspaces/rem_ws_one/display-name`, {
      method: "PATCH",
      headers: { ...hostAuth(legalwork.hostToken), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed One" }),
    });
    expect(renameResponse.status).toBe(200);
    let persisted = await readPersistedConfig(configPath);
    expect(workspacesFromConfig(persisted)[0]?.displayName).toBe("Renamed One");

    const activateResponse = await fetch(`${base}/workspaces/rem_ws_two/activate?persist=true`, {
      method: "POST",
      headers: hostAuth(legalwork.hostToken),
    });
    expect(activateResponse.status).toBe(200);
    expect(await readPersistedWorkspaceIds(configPath)).toEqual(["rem_ws_two", "rem_ws_one"]);

    const deleteResponse = await fetch(`${base}/workspaces/rem_ws_one`, {
      method: "DELETE",
      headers: hostAuth(legalwork.hostToken),
    });
    expect(deleteResponse.status).toBe(200);
    persisted = await readPersistedConfig(configPath);
    expect(workspaceIdsFromConfig(persisted)).toEqual(["rem_ws_two"]);
    expect(authorizedRootsFromConfig(persisted)).toEqual([]);
  });
});

test("selected-folder project preserves files, persists metadata and rejects stale writes", async () => {
  const root = await createWorkspaceRoot();
  const selected = join(root, "client-selected");
  await mkdir(selected);
  await writeFile(join(selected, "contract.txt"), "Original terms");
  const legalwork = await startLegalworkServerWithWorkspaces({ configPath: join(root, "server.json"), workspaces: [], authorizedRoots: [] });
  const base = `http://127.0.0.1:${legalwork.server.port}`;
  const headers = { ...hostAuth(legalwork.hostToken), Authorization: "Bearer owt_test_token", "Content-Type": "application/json" };
  const created = await fetch(`${base}/workspaces/local`, { method: "POST", headers, body: JSON.stringify({ folderPath: selected, folderMode: "selected", name: "Matter Alpha" }) });
  expect(created.status).toBe(201);
  const list = await created.json();
  const id = list.activeId;
  expect(list.workspaces[0].path).toBe(selected);
  const endpoint = `${base}/workspace/${id}/project`;
  expect(await (await fetch(endpoint, { headers })).json()).toEqual({ version: 1, revision: 0, fields: [] });
  const payload = { revision: 0, fields: [{ id: "client", label: "Client", type: "text", value: "Acme" }] };
  const saved = await fetch(endpoint, { method: "PATCH", headers: { Authorization: "Bearer owt_test_token", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  expect(saved.status).toBe(200);
  expect((await (await fetch(endpoint, { headers })).json()).fields[0].value).toBe("Acme");
  const stale = await fetch(endpoint, { method: "PATCH", headers, body: JSON.stringify(payload) });
  expect(stale.status).toBe(409);
  expect(await readFile(join(selected, "contract.txt"), "utf8")).toBe("Original terms");
  expect(await readPersistedWorkspaceIds(join(root, "server.json"))).toEqual([id]);
});


test("local folder setup discovers custom defaults, saves values and finishes setup without a remote link", async () => {
  const root = await createWorkspaceRoot();
  const selected = join(root, "existing-matter");
  await mkdir(selected);
  await writeFile(join(selected, "brief.txt"), "Budget: 3500");
  const legalwork = await startLegalworkServerWithWorkspaces({ configPath: join(root, "server.json"), workspaces: [], authorizedRoots: [] });
  const base = `http://127.0.0.1:${legalwork.server.port}`;
  const headers = { ...hostAuth(legalwork.hostToken), Authorization: "Bearer owt_test_token", "Content-Type": "application/json" };
  const created = await fetch(`${base}/workspaces/local`, { method: "POST", headers, body: JSON.stringify({
    name: "Existing matter", folderPath: selected, folderMode: "selected", initializeFromFolders: true,
    projectFields: [{ id: "budget", label: "Our budget", labelSource: "custom", type: "number", value: null }],
  }) });
  expect(created.status).toBe(201);
  const { activeId } = await created.json();
  const endpoint = `${base}/workspace/${activeId}/project`;
  const context = await (await fetch(`${endpoint}/setup`, { headers })).json();
  expect(context).not.toHaveProperty("context");
  expect((await fetch(`${endpoint}/context`, { headers })).status).toBe(404);
  expect(context).toMatchObject({ localFolder: selected, initialization: "pending", remote: { folders: [] }, fields: [{ id: "budget", label: "Our budget", value: null }] });
  const metadata = await fetch(`${endpoint}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ revision: context.revision, values: { budget: 3500 } }) });
  expect(metadata.status).toBe(200);
  const updated = await metadata.json();
  expect(updated.fields[0]).toMatchObject({ id: "budget", label: "Our budget", type: "number", value: 3500 });
  const completed = await fetch(`${endpoint}/setup`, { method: "PATCH", headers, body: JSON.stringify({ revision: updated.revision, name: "Reviewed matter" }) });
  expect(completed.status).toBe(200);
  expect((await completed.json()).remote).toMatchObject({ folders: [], initialization: "ready" });
  expect(await readFile(join(selected, "brief.txt"), "utf8")).toBe("Budget: 3500");
  const noSource = await fetch(`${base}/workspaces/local`, { method: "POST", headers, body: JSON.stringify({ name: "Empty", folderMode: "default", initializeFromFolders: true }) });
  expect(noSource.status).toBe(400);
});

test("new default projects use the native host root without relocating existing projects", async () => {
  const root = await createWorkspaceRoot();
  const projectsDirectory = join(root, "Redirected Documents", "LegalWork", "Projects");
  const legalwork = await startLegalworkServerWithWorkspaces({ configPath: join(root, "server.json"), workspaces: [], authorizedRoots: [], projectsDirectory });
  const base = `http://127.0.0.1:${legalwork.server.port}`;
  const headers = { ...hostAuth(legalwork.hostToken), Authorization: "Bearer owt_test_token", "Content-Type": "application/json" };
  expect(await (await fetch(`${base}/workspaces/project-defaults`, { headers })).json()).toEqual({ folderPath: projectsDirectory });
  for (const expected of ["Matter", "Matter (2)"]) {
    const response = await fetch(`${base}/workspaces/local`, { method: "POST", headers, body: JSON.stringify({ folderMode: "default", name: "Matter", projectFields: [{ id: "client", label: "Mandant", type: "text", value: null }] }) });
    expect(response.status).toBe(201);
    const list = await response.json();
    expect(list.workspaces[0].path).toBe(join(projectsDirectory, expected));
    const details = await (await fetch(`${base}/workspace/${list.workspaces[0].id}/project`, { headers })).json();
    expect(details.fields).toEqual([{ id: "client", label: "Mandant", type: "text", value: null }]);
  }
  const persisted = await readPersistedConfig(join(root, "server.json"));
  expect(workspacesFromConfig(persisted).map((workspace) => workspace.path)).toEqual([join(projectsDirectory, "Matter (2)"), join(projectsDirectory, "Matter")]);
});


test("missing project folders are never recreated and recover with the same identity and values", async () => {
  const root = await createWorkspaceRoot();
  const selected = join(root, "Selected");
  const moved = join(root, "Disconnected");
  await mkdir(selected);
  const legalwork = await startLegalworkServerWithWorkspaces({ configPath: join(root, "server.json"), workspaces: [], authorizedRoots: [] });
  const base = `http://127.0.0.1:${legalwork.server.port}`;
  const headers = { ...hostAuth(legalwork.hostToken), Authorization: "Bearer owt_test_token", "Content-Type": "application/json" };
  const created = await fetch(`${base}/workspaces/local`, { method: "POST", headers, body: JSON.stringify({ folderPath: selected, name: "Matter", projectFields: [{ id: "client", label: "Client", type: "text", value: null }] }) });
  const { activeId } = await created.json();
  const endpoint = `${base}/workspace/${activeId}/project`;
  await rename(selected, moved);
  const activation = await fetch(`${base}/workspaces/${activeId}/activate`, { method: "POST", headers });
  expect(activation.status).toBe(404);
  expect((await activation.json()).code).toBe("project_folder_unavailable");
  const unavailable = await fetch(endpoint, { headers });
  expect(unavailable.status).toBe(404);
  expect((await unavailable.json()).code).toBe("project_folder_unavailable");
  expect(await stat(selected).catch(() => null)).toBeNull();
  await rename(moved, selected);
  const restored = await fetch(endpoint, { headers });
  expect(restored.status).toBe(200);
  expect((await restored.json()).fields[0].id).toBe("client");
  expect(await readPersistedWorkspaceIds(join(root, "server.json"))).toEqual([activeId]);
});
