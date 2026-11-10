import { expect, test } from "bun:test";
import { join } from "node:path";
import { inspectSkillPackage, readSkillPackageFile } from "./skill-package.js";
import { skillPackageFixture } from "./skill-package.test-support.js";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import { SandboxFilesystem } from "./agent-sandbox/filesystem.js";

test("resources cannot escape to another package, hidden files, absolute paths or links", async () => {
  const f = await skillPackageFixture();
  await writeFile(join(f.root, "secret.md"), "unrelated");
  for (const path of ["../secret.md", "resources/../../secret.md", "/etc/passwd", "resources\\..\\secret.md", ".env", "resources/./felder.md", "resources/file:stream"]) {
    await expect(readSkillPackageFile(f.skill, f.directory, path)).rejects.toThrow();
  }
  await expect(readSkillPackageFile(f.skill, f.root, "resources/felder.md")).rejects.toThrow("Load it again");
  // Junctions are available without Windows Developer Mode; file links are
  // tested on macOS/Linux, where they do not require elevated privileges.
  await symlink(f.root, join(f.directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(readSkillPackageFile(f.skill, f.directory, "linked/secret.md")).rejects.toThrow();
  await expect(inspectSkillPackage(f.skill)).rejects.toThrow("symbolic links");
  if (process.platform !== "win32") {
    await symlink(join(f.root, "secret.md"), join(f.directory, "resources/link.md"));
    await expect(readSkillPackageFile(f.skill, f.directory, "resources/link.md")).rejects.toThrow("not links");
  }
});

test("sandbox exposes the full selected package read-only, without its sibling library", async () => {
  const f = await skillPackageFixture(), workspace = join(f.root, "matter"); await mkdir(workspace);
  const fs = await SandboxFilesystem.create([
    { source: workspace, target: "/workspace", writable: true },
    { source: f.directory, target: "/skills/0", writable: false },
  ], new AbortController().signal);
  try {
    for (const path of ["resources/felder.md", "resources/template.docx", "scripts/helper.py"]) {
      const opened = await fs.request({ op: "open", path: `/skills/0/${path}`, write: false, create: false, exclusive: false, truncate: false });
      const handle = z.number().parse(opened);
      const result = await fs.request({ op: "read", handle, offset: 0, size: 128 * 1024 });
      expect(result).toEqual(await readFile(join(f.directory, path)));
      await fs.request({ op: "close", handle });
    }
    await expect(fs.request({ op: "open", path: "/skills/0/resources/felder.md", write: true, create: false, exclusive: false, truncate: false })).rejects.toThrow();
    await expect(fs.request({ op: "stat", path: "/skills/1/SKILL.md" })).rejects.toThrow();
    await expect(fs.request({ op: "stat", path: "/skills/0/../secret.md" })).rejects.toThrow();
  } finally { await fs.dispose(); }
});
