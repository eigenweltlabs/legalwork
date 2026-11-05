import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

test("archives legacy remote registrations without exposing credentials or losing them on local edits", async (t) => {
  const { userData, store } = await isolatedStore(t);
  const remote = { id: "rem_old", name: "Old worker", workspaceType: "remote", baseUrl: "https://retired.example", legalworkToken: "preserve-secret" };
  const local = { id: "ws_local", name: "Local", path: userData, workspaceType: "local" };
  const registry = path.join(userData, "legalwork-workspaces.json");
  await writeFile(registry, JSON.stringify({ recoveryCompleted: true, selectedId: remote.id, activeId: remote.id, workspaces: [remote, local] }));
  const state = await store.readWorkspaceState();
  assert.deepEqual(state.workspaces, [local]);
  assert.equal(state.selectedId, local.id);
  assert.match(state.warnings[0], /no longer supported/);
  assert.ok(!JSON.stringify(state).includes("preserve-secret"));
  await store.updateWorkspaceDisplayName({ workspaceId: local.id, displayName: "Renamed" });
  const saved = JSON.parse(await readFile(registry, "utf8"));
  assert.deepEqual(saved.workspaces.find(entry => entry.id === remote.id), remote);
  assert.equal(saved.workspaces.find(entry => entry.id === local.id).displayName, "Renamed");
  assert.deepEqual((await store.readWorkspaceState()).workspaces.map(entry => entry.id), [local.id]);
});

test("a registry containing only retired workers stays recoverable and has no active project", async t => {
  const { userData, store } = await isolatedStore(t);
  const registry = path.join(userData, "legalwork-workspaces.json");
  const remote = { id: "rem_only", workspaceType: "remote", legalworkToken: "archived-secret" };
  await writeFile(registry, JSON.stringify({ recoveryCompleted: true, selectedId: remote.id, watchedId: remote.id, activeId: remote.id, workspaces: [remote] }));
  const state = await store.readWorkspaceState();
  assert.deepEqual(state.workspaces, []);
  assert.equal(state.selectedId, "");
  assert.equal(state.activeId, null);
  assert.equal(state.watchedId, null);
  assert.ok(state.warnings[0].includes(registry));
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")).workspaces, [remote]);
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

async function isolatedStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-registry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "userData");
  await mkdir(userData);
  const options = { app: { getPath: name => name === "userData" ? userData : root }, defaultDenBaseUrl: "https://example.test", defaultRequireSignin: false, forceRequireSignin: false };
  const store = createWorkspaceStore(options);
  await store.writeWorkspaceState({ selectedId: "", workspaces: [] });
  return { root, userData, options, store };
}

test("removing the last project survives reads and restart without token-store recovery", async t => {
  const { root, userData, store, options } = await isolatedStore(t);
  const folderPath = path.join(root, "project");
  const created = await store.createWorkspace({ folderPath });
  await writeFile(path.join(userData, "legalwork-server-tokens.json"), JSON.stringify({ version: 1, workspaces: { [folderPath]: { updatedAt: 1 } } }));
  await store.forgetWorkspace(created.selectedId);
  assert.deepEqual((await store.readWorkspaceState()).workspaces, []);
  assert.deepEqual((await createWorkspaceStore(options).readWorkspaceState()).workspaces, []);
  // Reopening the folder explicitly remains possible.
  assert.equal((await store.createWorkspace({ folderPath })).workspaces.length, 1);
});

test("concurrent window mutations cannot resurrect a forgotten project or lose a rename", async t => {
  const { root, store } = await isolatedStore(t);
  const first = await store.createWorkspace({ folderPath: path.join(root, "one") });
  const second = await store.createWorkspace({ folderPath: path.join(root, "two") });
  await Promise.all([
    store.setSelectedWorkspace(second.selectedId),
    store.forgetWorkspace(first.selectedId),
    store.updateWorkspaceDisplayName({ workspaceId: second.selectedId, displayName: "Renamed" }),
    store.readWorkspaceState(),
  ]);
  const final = await store.readWorkspaceState();
  assert.deepEqual(final.workspaces.map(item => item.id), [second.selectedId]);
  assert.equal(final.workspaces[0].displayName, "Renamed");
});
