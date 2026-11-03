import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWikiNativeFileAccess } from "./native-project-guard.js";

test("wiki native file tools stay inside wiki even with symlinks or multi-file edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-native-guard-"));
  try {
    const wiki = join(root, "wiki"), project = join(root, "project");
    await mkdir(wiki); await mkdir(project); await writeFile(join(project, "secret.txt"), "private");
    await symlink(project, join(wiki, "alias"));
    for (const tool of ["read", "write", "edit", "grep", "glob", "list", "legalwork_task_download_attachment"])
      for (const path of [join(project, "secret.txt"), "../project/secret.txt", "alias/secret.txt", "alias/new.txt"])
        await expect(assertWikiNativeFileAccess(wiki, tool, { path })).rejects.toMatchObject({ code: "wiki_native_project_access" });
    for (const pattern of ["../project/*", join(project, "*")]) await expect(assertWikiNativeFileAccess(wiki, "glob", { pattern })).rejects.toThrow();
    for (const tool of ["patch", "apply_patch", "multiedit"]) await expect(assertWikiNativeFileAccess(wiki, tool, {})).rejects.toThrow();
    await expect(assertWikiNativeFileAccess(wiki, "bash", { command: "cat ../project/secret.txt" })).rejects.toMatchObject({ code: "wiki_sandbox_required" });
    for (const [tool, key] of [["legalwork_task_attach", "paths"], ["benchmark_create_task", "documentPaths"], ["legalwork_skill_create", "resourcePaths"]]) {
      for (const path of [join(project, "secret.txt"), "../project/secret.txt", "alias/secret.txt"])
        await expect(assertWikiNativeFileAccess(wiki, tool, { [key]: ["note.md", path] })).rejects.toMatchObject({ code: "wiki_native_project_access" });
      await expect(assertWikiNativeFileAccess(wiki, tool, { [key]: ["note.md"] })).resolves.toBeUndefined();
      await expect(assertWikiNativeFileAccess(wiki, tool, { [key]: "../project/secret.txt" })).rejects.toThrow();
    }
    await expect(assertWikiNativeFileAccess(wiki, "benchmark_create_task", {})).resolves.toBeUndefined();
    await expect(assertWikiNativeFileAccess(wiki, "legalwork_skill_create", {})).resolves.toBeUndefined();
    for (const tool of ["write", "edit", "legalwork_task_download_attachment"]) for (const path of ["Dashboards/test.view.json", "test.VIEW.JSON", "test.view.conflict-123456789abc.json"])
      await expect(assertWikiNativeFileAccess(wiki, tool, { path })).rejects.toMatchObject({ code: "human_save_required" });
    await expect(assertWikiNativeFileAccess(wiki, "read", { filePath: "test.view.json" })).resolves.toBeUndefined();
    await expect(assertWikiNativeFileAccess(wiki, "write", { filePath: "new.md" })).resolves.toBeUndefined();
    await expect(assertWikiNativeFileAccess(wiki, "glob", {})).resolves.toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested wiki sessions resolve native paths from the session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-native-nested-"));
  try {
    const wiki = join(root, "wiki"), directory = join(wiki, "nested"), project = join(root, "project");
    await mkdir(directory, { recursive: true });
    await mkdir(project);
    await writeFile(join(wiki, "note.md"), "Wiki note");
    await writeFile(join(project, "secret.txt"), "Private project file");
    await symlink(project, join(directory, "alias"));
    for (const tool of ["read", "write", "edit", "grep", "glob", "list"]) {
      await expect(assertWikiNativeFileAccess(wiki, tool, { path: "alias/secret.txt" }, directory)).rejects.toMatchObject({ code: "wiki_native_project_access" });
      await expect(assertWikiNativeFileAccess(wiki, tool, { path: "../note.md" }, directory)).resolves.toBeUndefined();
    }
    for (const [tool, key] of [["legalwork_task_attach", "paths"], ["benchmark_create_task", "documentPaths"], ["legalwork_skill_create", "resourcePaths"]]) {
      await expect(assertWikiNativeFileAccess(wiki, tool, { [key]: ["alias/secret.txt"] }, directory)).rejects.toMatchObject({ code: "wiki_native_project_access" });
      await expect(assertWikiNativeFileAccess(wiki, tool, { [key]: ["../note.md"] }, directory)).resolves.toBeUndefined();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
