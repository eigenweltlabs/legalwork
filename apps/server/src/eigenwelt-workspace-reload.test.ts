import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * The engine keeps one instance per workspace folder, built from the engine
 * config file as it was then. A sign-in from one workspace rewrote the file,
 * but only that workspace's instance was rebuilt (by the app), so every other
 * workspace kept serving its old provider list: no Eigenwelt models there
 * until it was reopened. The server now reloads the other idle workspaces
 * whenever the Eigenwelt models in the file change.
 */

const priorEnv = { ...process.env };
let temporary: string;
let config: ServerConfig;
let app: Awaited<ReturnType<typeof startServer>>;
let engine: ReturnType<typeof Bun.serve>;
const reloaded: string[] = [];
const statusAsked: string[] = [];

const dir = (id: string) => join(temporary, id);

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-reload-"));
  for (const key of [
    "LEGALWORK_TOKEN_STORE",
    "LEGALWORK_RUNTIME_DB",
    "LEGALWORK_ENV_STORE",
    "LEGALWORK_DATA_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ])
    process.env[key] = join(temporary, key);
  // Unreachable platform: the entitlements poll's model sync just fails quietly.
  process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:9";
  // A stand-in engine: records instance reloads, and ws_busy has a task running.
  engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const directory = url.searchParams.get("directory") ?? "";
      if (url.pathname === "/instance/dispose") reloaded.push(directory);
      if (url.pathname === "/session/status") {
        statusAsked.push(directory);
        return Response.json({ ses_1: { type: directory === dir("ws_busy") ? "busy" : "idle" } });
      }
      return Response.json({});
    },
  });
  const workspaces = ["ws_a", "ws_b", "ws_busy"];
  for (const id of workspaces) await mkdir(dir(id), { recursive: true });
  config = {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "owner-token",
    configPath: join(temporary, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: workspaces.map((id) => ({ id, name: id, path: dir(id), preset: "default", workspaceType: "local" })),
    authorizedRoots: [temporary],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    opencodeBaseUrl: `http://127.0.0.1:${engine.port}`,
  };
  app = await startServer(config);
});

afterAll(async () => {
  await app?.stop();
  engine?.stop(true);
  await rm(temporary, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "x-legalwork-host-token": config.hostToken,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// The reloads run in the background, one workspace after another; the busy
// workspace is checked last, so its status request marks the pass as done.
async function reloadPassDone() {
  for (let attempt = 0; attempt < 100 && !statusAsked.includes(dir("ws_busy")); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function reset() {
  reloaded.length = 0;
  statusAsked.length = 0;
}

test("a sign-in from one workspace reloads the other idle workspaces' engines", async () => {
  reset();
  const signIn = await call("PUT", "/workspace/ws_a/eigenwelt/connection", {
    entitlements: { plan: "plus", subscriptionStatus: "active", features: ["premium_models"] },
    platformToken: "access",
    baseURL: "https://paid.gateway.test/v1",
    apiKey: "sk-firm-key",
    models: [{ id: "Eigenwelt Europe" }],
  });
  expect(signIn.status).toBe(200);
  await reloadPassDone();
  // ws_a is the app's own (it reloads it); ws_busy has a task that a reload would abort.
  expect(reloaded).toEqual([dir("ws_b")]);
});

test("a rebuild that leaves the Eigenwelt models as they were reloads nothing", async () => {
  reset();
  // The first entitlements poll after a start always rebuilds the config file.
  expect((await call("GET", "/workspace/ws_a/eigenwelt/entitlements")).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(reloaded).toEqual([]);
});

test("a sign-out reloads them too, so the models leave every workspace", async () => {
  reset();
  expect((await call("PUT", "/workspace/ws_b/eigenwelt/connection", { disconnect: true })).status).toBe(200);
  await reloadPassDone();
  expect(reloaded).toEqual([dir("ws_a")]);
});
