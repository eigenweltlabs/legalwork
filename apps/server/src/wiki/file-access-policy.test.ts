import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxFilesystem } from "../agent-sandbox/filesystem.js";
import { buildWikiFilePolicy, wikiSafeSandboxMounts } from "./file-access-policy.js";

let root: string, project: string, own: string, external: string, runtime: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "wiki-file-policy-")));
  project = join(root, "project"); runtime = join(root, "runtime");
  own = join(runtime, "wikis", "personal"); external = join(root, "shared");
  await Promise.all([project, own, external].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(external, "Existing.md"), "original");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const policy = (directory = project) => buildWikiFilePolicy([{ root: own }, { root: external }], directory, [runtime]);

describe("Wiki filesystem boundaries", () => {
  test("a registered wiki below a replaced folder preserves the other wiki boundaries", async () => {
    const replaced = join(root, "replaced-folder");
    await writeFile(replaced, "This path is now a file.");
    const stale = join(replaced, "old-wiki");
    const rules = await buildWikiFilePolicy([{ root: stale }, { root: external }], project, [runtime]);
    expect(rules.protectedRoots).toContain(stale);
    expect(rules.protectedRoots).toContain(external);
    const mounts = await wikiSafeSandboxMounts(rules, [{ source: project, target: "/workspace", writable: true }]);
    expect(mounts[0].writable).toBe(true);
    await expect(wikiSafeSandboxMounts(rules, [{ source: external, target: "/external", writable: true }]))
      .resolves.toEqual([{ source: external, target: "/external", writable: false }]);
  });

  test("external wiki mounts become read-only and writable ancestor mounts fail closed", async () => {
    const rules = await policy();
    const alias = join(root, "alias"); await symlink(external, alias);
    const mounts = await wikiSafeSandboxMounts(rules, [{ source: project, target: "/workspace", writable: true }, { source: alias, target: "/authorized/0", writable: true }]);
    expect(mounts[0].writable).toBe(true);
    expect(mounts[1]).toEqual({ source: external, target: "/authorized/0", writable: false });
    await expect(wikiSafeSandboxMounts(rules, [{ source: root, target: "/workspace", writable: true }])).rejects.toMatchObject({ code: "wiki_sandbox_mount_denied" });
    const fs = await SandboxFilesystem.create(mounts, new AbortController().signal);
    try {
      await expect(fs.request({ op: "open", path: "/authorized/0/Existing.md", write: true, create: false, exclusive: false, truncate: true })).rejects.toMatchObject({ code: "EROFS" });
      await expect(fs.request({ op: "unlink", path: "/authorized/0/Existing.md" })).rejects.toMatchObject({ code: "EROFS" });
      await expect(fs.request({ op: "rename", path: "/authorized/0/Existing.md", destination: "/workspace/Move.md" })).rejects.toMatchObject({ code: "EROFS" });
      const handle = await fs.request({ op: "open", path: "/authorized/0/Existing.md", write: false, create: false, exclusive: false, truncate: false });
      expect(typeof handle).toBe("number");
    } finally { await fs.dispose(); }
  });
});
