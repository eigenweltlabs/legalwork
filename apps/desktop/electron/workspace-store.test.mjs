import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWorkspaceStore } from "./workspace-store.mjs";

test("recovers empty desktop workspace state from token store paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "old-workspace");
  await mkdir(oldWorkspace, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "legalwork-workspaces.json"),
    JSON.stringify({ selectedId: "ws_missing", activeId: "ws_missing", watchedId: null, workspaces: [] }),
    "utf8",
  );
  await writeFile(
    path.join(userData, "legalwork-server-tokens.json"),
    JSON.stringify({
      version: 1,
      workspaces: {
        "": { updatedAt: 3 },
        [oldWorkspace]: { updatedAt: 2 },
        [path.join(root, "missing")]: { updatedAt: 4 },
      },
    }),
    "utf8",
  );

  const previous = process.env.LEGALWORK_SERVER_CONFIG;
  process.env.LEGALWORK_SERVER_CONFIG = path.join(root, "missing-server.json");
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].path, oldWorkspaceReal);
    assert.equal(state.selectedId, state.workspaces[0].id);
    assert.equal(state.watchedId, state.workspaces[0].id);

    const persisted = JSON.parse(await readFile(path.join(userData, "legalwork-workspaces.json"), "utf8"));
    assert.equal(persisted.workspaces.length, 1);
    assert.equal(persisted.selectedWorkspaceId, state.workspaces[0].id);
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_SERVER_CONFIG;
    else process.env.LEGALWORK_SERVER_CONFIG = previous;
  }
});

test("prefers server config workspaces when desktop state is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "server-workspace");
  const serverConfig = path.join(root, "server.json");
  await mkdir(oldWorkspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);

  await writeFile(
    path.join(userData, "legalwork-workspaces.json"),
    JSON.stringify({ selectedId: "", activeId: null, watchedId: null, workspaces: [] }),
    "utf8",
  );
  await writeFile(
    serverConfig,
    JSON.stringify({ workspaces: [{ path: oldWorkspace, name: "From Server" }] }),
    "utf8",
  );
  await writeFile(
    path.join(userData, "legalwork-server-tokens.json"),
    JSON.stringify({ version: 1, workspaces: { [path.join(root, "other")]: { updatedAt: 9 } } }),
    "utf8",
  );

  const previous = process.env.LEGALWORK_SERVER_CONFIG;
  process.env.LEGALWORK_SERVER_CONFIG = serverConfig;
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].path, oldWorkspaceReal);
    assert.equal(state.workspaces[0].name, "From Server");
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_SERVER_CONFIG;
    else process.env.LEGALWORK_SERVER_CONFIG = previous;
  }
});

test("normalizes recovered remote LegalWork entries before persisting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const serverConfig = path.join(root, "server.json");
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "legalwork-workspaces.json"),
    JSON.stringify({ selectedId: "", activeId: null, watchedId: null, workspaces: [] }),
    "utf8",
  );
  await writeFile(
    serverConfig,
    JSON.stringify({
      workspaces: [
        {
          id: "legacy_one",
          path: "/workspace",
          workspaceType: "remote",
          remoteType: "legalwork",
          baseUrl: "https://worker.example.com/workspace/ws_remote",
        },
        {
          id: "legacy_two",
          path: "/workspace",
          workspaceType: "remote",
          remoteType: "legalwork",
          baseUrl: "https://worker.example.com/w/ws_remote",
        },
      ],
    }),
    "utf8",
  );

  const previous = process.env.LEGALWORK_SERVER_CONFIG;
  process.env.LEGALWORK_SERVER_CONFIG = serverConfig;
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].id, "rem_ws_remote");
    assert.equal(state.workspaces[0].baseUrl, "https://worker.example.com");
    assert.equal(state.workspaces[0].legalworkWorkspaceId, "ws_remote");
    assert.equal(state.selectedId, "rem_ws_remote");
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_SERVER_CONFIG;
    else process.env.LEGALWORK_SERVER_CONFIG = previous;
  }
});

test("selecting a server-created project persists it across desktop restart without replacing project metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-project-register-"));
  const userData = path.join(root, "userData"), serverConfig = path.join(root, "server.json");
  const project = path.join(root, "New project"), metadata = path.join(project, ".opencode/legalwork.json");
  await mkdir(path.dirname(metadata), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(metadata, JSON.stringify({ project: { fields: [{ name: "Matter", value: "42" }] } }));
  await writeFile(serverConfig, JSON.stringify({ workspaces: [{ id: "ws_new", path: project, name: "New project", projectOrder: 0 }] }));
  await writeFile(path.join(userData, "legalwork-workspaces.json"), JSON.stringify({ workspaces: [{ id: "ws_old", path: root, name: "Existing", workspaceType: "local" }], selectedId: "ws_old" }));
  const previous = process.env.LEGALWORK_SERVER_CONFIG;
  process.env.LEGALWORK_SERVER_CONFIG = serverConfig;
  try {
    const options = { app: { getPath: (name) => name === "userData" ? userData : root }, defaultDenBaseUrl: "https://example.test", defaultRequireSignin: false, forceRequireSignin: false };
    await createWorkspaceStore(options).setSelectedWorkspace("ws_new");
    const reloaded = await createWorkspaceStore(options).readWorkspaceState();
    assert.equal(reloaded.selectedId, "ws_new");
    assert.deepEqual(reloaded.workspaces.map(item => item.id), ["ws_new", "ws_old"]);
    assert.equal(JSON.parse(await readFile(metadata, "utf8")).project.fields[0].value, "42");
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_SERVER_CONFIG;
    else process.env.LEGALWORK_SERVER_CONFIG = previous;
  }
});
