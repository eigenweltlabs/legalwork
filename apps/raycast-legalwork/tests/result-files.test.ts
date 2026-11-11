import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalResultFile, resultReference } from "../src/result-files";

test("native result paths reject stale files, traversal, metadata, and escaping links", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "raycast-result-"));
  try {
    const root = join(temporary, "source"); await mkdir(root);
    await writeFile(join(root, "Agreement.docx"), "document");
    await writeFile(join(temporary, "private.txt"), "outside");
    await symlink(join(temporary, "private.txt"), join(root, "escape.txt"));
    await mkdir(join(root, "Subfolder"));
    expect(await canonicalResultFile(root, "Agreement.docx", false)).toBe(await realpath(join(root, "Agreement.docx")));
    expect(await canonicalResultFile(root, "Subfolder", true)).toBe(await realpath(join(root, "Subfolder")));
    for (const value of ["../private.txt", "escape.txt", "missing.txt", ".legalwork/settings.json", "Subfolder", join(temporary, "private.txt")]) {
      await expect(canonicalResultFile(root, value, false)).rejects.toThrow();
    }
    await rm(join(root, "Agreement.docx"));
    await expect(canonicalResultFile(root, "Agreement.docx", false)).rejects.toThrow();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("handoff carries exact identity and excludes indexed content", () => {
  expect(resultReference({ kind: "files", id: "contract.docx", workspaceId: "matter", sourceId: "local:matter", path: "contract.docx", title: "Contract", excerpt: "Private indexed text", score: 1, updatedAt: 1, match: "content", actions: ["open"] }))
    .toEqual({ kind: "files", id: "contract.docx", workspaceId: "matter", sourceId: "local:matter", path: "contract.docx" });
});
