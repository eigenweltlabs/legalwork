import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedImageAffinity } from "./managed-image-affinity.js";
import type { WorkspaceInfo } from "./types.js";

const connection = { url: "http://127.0.0.1:54321", username: "owned-user", password: "owned-secret" };
function workspace(): WorkspaceInfo {
  return { id: "workspace", name: "Workspace", path: "/fixture/project", preset: "starter", workspaceType: "local" };
}
function defaults() {
  return { opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password };
}
async function fixture(run: (database: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-managed-image-affinity-"));
  try { const database = join(root, "history.sqlite"); await writeFile(database, "fixture history; never opened as SQLite"); await run(database, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("saved connection values alone cannot establish affinity; repeated current resolution is the same capability", async () => {
  await fixture(async database => {
    const affinity = await createManagedImageAffinity(defaults(), database), project = workspace();
    expect(affinity.resolve(project)).toBeUndefined();
    await affinity.connect(connection);
    const first = affinity.resolve(project);
    expect(first?.storageNamespace).toBe(affinity.storageNamespace);
    expect(affinity.resolve(project)).toBe(first);
    expect(Object.keys(first ?? {})).toEqual(["storageNamespace", "connectionGeneration"]);
    expect(Object.isFrozen(first)).toBe(true);
    affinity.disconnect();
    expect(affinity.resolve(project)).toBeUndefined();
  });
});

test("manual endpoint or credentials never inherit the managed history capability", async () => {
  await fixture(async database => {
    const config = defaults(), affinity = await createManagedImageAffinity(config, database), project = workspace();
    await affinity.connect(connection);
    const first = affinity.resolve(project);
    expect(first).toBeDefined();
    project.baseUrl = "http://127.0.0.1:54322";
    expect(affinity.resolve(project)).toBeUndefined();
    project.baseUrl = connection.url;
    project.opencodePassword = "different-secret";
    expect(affinity.resolve(project)).toBeUndefined();
    project.opencodePassword = connection.password;
    project.opencodeUsername = "different-user";
    expect(affinity.resolve(project)).toBeUndefined();
    project.opencodeUsername = connection.username;
    expect(affinity.resolve(project)).toBe(first);
    delete project.baseUrl; delete project.opencodeUsername; delete project.opencodePassword;
    config.opencodePassword = "changed-server-credential";
    expect(affinity.resolve(project)).toBeUndefined();
  });
});

test("native reconnect keeps history namespace but invalidates all old I/O snapshots even with identical endpoint", async () => {
  await fixture(async database => {
    const config = defaults(), affinity = await createManagedImageAffinity(config, database), project = workspace();
    await affinity.connect(connection);
    const before = affinity.resolve(project);
    affinity.disconnect();
    await affinity.connect(connection);
    const after = affinity.resolve(project);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(after?.connectionGeneration).not.toBe(before?.connectionGeneration);
    expect(after?.storageNamespace).toBe(before?.storageNamespace);
    const replacement = { url: "http://127.0.0.1:54323", username: "new-user", password: "new-secret" };
    affinity.disconnect(); await affinity.connect(replacement);
    expect(affinity.resolve(project)).toBeUndefined();
    config.opencodeBaseUrl = replacement.url; config.opencodeUsername = replacement.username; config.opencodePassword = replacement.password;
    expect(affinity.resolve(project)?.storageNamespace).toBe(before?.storageNamespace);
    expect(affinity.resolve(project)).not.toBe(after);
  });
});

test("canonical history aliases share a namespace; separate databases with identical bytes and connections do not", async () => {
  await fixture(async (database, root) => {
    const other = join(root, "other.sqlite"); await writeFile(other, "fixture history; never opened as SQLite");
    const first = await createManagedImageAffinity(defaults(), database), second = await createManagedImageAffinity(defaults(), other);
    await first.connect(connection); await second.connect(connection);
    expect(first.storageNamespace).not.toBe(second.storageNamespace);
    const repeated = await createManagedImageAffinity(defaults(), join(root, "subdirectory", "..", "history.sqlite"));
    expect(repeated.storageNamespace).toBe(first.storageNamespace);
    if (process.platform !== "win32") {
      const alias = join(root, "alias.sqlite"); await symlink(database, alias);
      expect((await createManagedImageAffinity(defaults(), alias)).storageNamespace).toBe(first.storageNamespace);
    }
  });
});

test("first launch binds only after its database exists; missing/non-file history and credentials fail closed", async () => {
  await fixture(async (database, root) => {
    const missing = join(root, "missing.sqlite"), fresh = await createManagedImageAffinity(defaults(), missing);
    await expect(fresh.connect(connection)).rejects.toThrow();
    expect(fresh.resolve(workspace())).toBeUndefined();
    await writeFile(missing, "new history");
    await fresh.connect(connection);
    expect(fresh.resolve(workspace())?.storageNamespace).toBe(fresh.storageNamespace);
    const directory = join(root, "directory"); await mkdir(directory);
    await expect((await createManagedImageAffinity(defaults(), directory)).connect(connection)).rejects.toThrow("regular file");
    const affinity = await createManagedImageAffinity(defaults(), database);
    await expect(affinity.connect({ ...connection, password: "" })).rejects.toThrow("authenticated owned connection");
    expect(affinity.resolve(workspace())).toBeUndefined();
  });
});

test("disconnect during asynchronous binding cannot resurrect an old connection", async () => {
  await fixture(async database => {
    const affinity = await createManagedImageAffinity(defaults(), database);
    const pending = affinity.connect(connection);
    affinity.disconnect();
    await expect(pending).rejects.toThrow("changed during history binding");
    expect(affinity.resolve(workspace())).toBeUndefined();
  });
});

test.skipIf(process.platform === "win32")("a missing history path later redirected to another database never gains affinity", async () => {
  await fixture(async (database, root) => {
    const chosen = join(root, "future.sqlite"), affinity = await createManagedImageAffinity(defaults(), chosen);
    await symlink(database, chosen);
    await expect(affinity.connect(connection)).rejects.toThrow("path changed");
    expect(affinity.resolve(workspace())).toBeUndefined();
  });
});
