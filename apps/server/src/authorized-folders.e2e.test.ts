import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const CLIENT_TOKEN = "owt_authorized_folders_client";
const HOST_TOKEN = "owt_authorized_folders_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorDataDir = process.env.LEGALWORK_DATA_DIR;
const priorTokenStore = process.env.LEGALWORK_TOKEN_STORE;

type AuthorizedFoldersBody = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot?: string;
  updatedAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function clientAuth(token = CLIENT_TOKEN) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function hostAuth() {
  return { "x-legalwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

async function createTempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createWorkspaceRoot() {
  return createTempRoot("legalwork-authorized-folders-");
}

async function startLegalworkServer(workspaceRoot: string, options?: { readOnly?: boolean; permissions?: NonNullable<Awaited<ReturnType<typeof readRuntimeOpencodeConfig>>["permissions"]> }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: options?.readOnly === true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  if (options?.permissions) await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ permissions: options.permissions }));
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, config };
}

function readExternalDirectory(raw: string): Record<string, unknown> {
  const config = asRecord(JSON.parse(raw));
  const permission = asRecord(config.permission);
  return asRecord(permission.external_directory);
}

beforeEach(async () => {
  const envRoot = await createTempRoot("legalwork-authorized-folders-env-");
  process.env.LEGALWORK_DATA_DIR = join(envRoot, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(envRoot, "tokens.json");
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  if (priorDataDir === undefined) {
    delete process.env.LEGALWORK_DATA_DIR;
  } else {
    process.env.LEGALWORK_DATA_DIR = priorDataDir;
  }
  if (priorTokenStore === undefined) {
    delete process.env.LEGALWORK_TOKEN_STORE;
  } else {
    process.env.LEGALWORK_TOKEN_STORE = priorTokenStore;
  }
});

describe("authorized folders routes", () => {
  test("lists visible folders and counts preserved hidden entries", async () => {
    const root = resolve(await createWorkspaceRoot());
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
      permission: {
        external_directory: {
          [`${root}/*`]: "allow",
          "/shared/*": "allow",
          "/hidden": "allow",
          "/denied/*": "deny",
        },
      },
    }, null, 2) + "\n", "utf8");
    const { base, config } = await startLegalworkServer(root, { permissions: [
      { action: "external_directory", resource: `${root}/*`, effect: "allow" }, { action: "external_directory", resource: "/shared/*", effect: "allow" },
      { action: "external_directory", resource: "/hidden", effect: "allow" }, { action: "external_directory", resource: "/denied/*", effect: "deny" },
    ] });

    const response = await fetch(`${base}/workspace/ws_1/authorized-folders`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const body = await response.json() as AuthorizedFoldersBody;

    expect(body).toMatchObject({
      folders: ["/shared"],
      hiddenCount: 2,
      workspaceRoot: root,
    });
  });

  test("dedupes, filters workspace root, and preserves hidden entries on write", async () => {
    const root = resolve(await createWorkspaceRoot());
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, JSON.stringify({
      permission: {
        external_directory: {
          [`${root}/*`]: "allow",
          "/existing/*": "allow",
          "/hidden": "allow",
          "/denied/*": "deny",
        },
      },
    }, null, 2) + "\n", "utf8");
    const { base, config } = await startLegalworkServer(root, { permissions: [
      { action: "external_directory", resource: `${root}/*`, effect: "allow" }, { action: "external_directory", resource: "/existing/*", effect: "allow" },
      { action: "external_directory", resource: "/hidden", effect: "allow" }, { action: "external_directory", resource: "/denied/*", effect: "deny" },
    ] });

    const response = await fetch(`${base}/workspace/ws_1/authorized-folders`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ folders: ["/shared", "/shared/", root, `${root}/*`, "/existing/*"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as AuthorizedFoldersBody;
    expect(body.folders).toEqual(["/shared", "/existing"]);
    expect(body.hiddenCount).toBe(2);
    expect(typeof body.updatedAt).toBe("number");

    expect(readExternalDirectory(await readFile(configPath, "utf8"))["/shared/*"]).toBeUndefined();
    const runtimeConfig = await readRuntimeOpencodeConfig(config, "ws_1");
    const externalDirectory = Object.fromEntries((runtimeConfig.permissions ?? []).filter(rule => rule.action === "external_directory").map(rule => [rule.resource, rule.effect]));
    expect(externalDirectory["/hidden"]).toBe("allow");
    expect(externalDirectory["/denied/*"]).toBe("deny");
    expect(externalDirectory["/shared/*"]).toBe("allow");
    expect(externalDirectory["/existing/*"]).toBe("allow");
    expect(externalDirectory[`${root}/*`]).toBe("allow");
    expect(Object.keys(externalDirectory).sort()).toEqual(["/denied/*", "/existing/*", "/hidden", "/shared/*", `${root}/*`].sort());
  });

  test("requires client auth, collaborator scope, and writable server", async () => {
    const root = await createWorkspaceRoot();
    const { base } = await startLegalworkServer(root);

    const unauthenticated = await fetch(`${base}/workspace/ws_1/authorized-folders`);
    expect(unauthenticated.status).toBe(401);

    const viewerWrite = await fetch(`${base}/workspace/ws_1/authorized-folders`, {
      method: "PUT",
      headers: clientAuth("owt_retired_viewer"),
      body: JSON.stringify({ folders: ["/shared"] }),
    });
    expect(viewerWrite.status).toBe(401);

    const readOnlyRoot = await createWorkspaceRoot();
    const readOnly = await startLegalworkServer(readOnlyRoot, { readOnly: true });
    const readOnlyWrite = await fetch(`${readOnly.base}/workspace/ws_1/authorized-folders`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ folders: ["/shared"] }),
    });
    expect(readOnlyWrite.status).toBe(403);
  });
});
