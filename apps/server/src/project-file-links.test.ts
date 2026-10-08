import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importProjectFile, readProjectFileLinks, updateProjectFileLinks } from "./project-file-links.js";

const roots: string[] = [];
const root = async () => { const path = await mkdtemp(join(tmpdir(), "project-links-")); roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const source = { projectId: "source", workspaceId: "source", path: "contract.md", name: "Contract" };

test("links persist, concurrent additions don't overwrite each other and removal leaves originals intact", async () => {
  const from = await root(); const to = await root();
  await writeFile(join(from, source.path), "original");
  expect(await readProjectFileLinks(to)).toEqual([]);
  expect(await readdir(to)).toEqual([]);
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  await Promise.all(ids.map(id => updateProjectFileLinks(to, links => [...links, { id, name: id, folder: "", source, createdAt: 1 }])));
  expect(await readProjectFileLinks(to)).toHaveLength(8);
  await updateProjectFileLinks(to, links => links.filter(link => link.id !== ids[0]));
  expect(await readProjectFileLinks(to)).toHaveLength(7);
  expect(await readFile(join(from, source.path), "utf8")).toBe("original");
});

test("copy is independent, exclusive and does not leave partial files on collisions", async () => {
  const to = await root(); await mkdir(join(to, "Contracts"));
  const results = await Promise.allSettled(["one", "two"].map(value => importProjectFile(to, "Contracts/A.md", new TextEncoder().encode(value))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(["one", "two"]).toContain(await readFile(join(to, "Contracts/A.md"), "utf8"));
  expect(await readdir(join(to, "Contracts"))).toEqual(["A.md"]);
});

test("imports and link metadata cannot escape through paths or symbolic links", async () => {
  const to = await root(); const outside = await root();
  await symlink(outside, join(to, "escape"));
  await expect(importProjectFile(to, "../escape.md", new Uint8Array())).rejects.toMatchObject({ status: 400 });
  await expect(importProjectFile(to, "escape/leak.md", new Uint8Array())).rejects.toMatchObject({ status: 403 });
  await writeFile(join(outside, "kept.md"), "keep");
  await symlink(join(outside, "kept.md"), join(to, "existing.md"));
  await expect(importProjectFile(to, "existing.md", new Uint8Array())).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(outside, "kept.md"), "utf8")).toBe("keep");
  await symlink(outside, join(to, ".legalwork"));
  await expect(readProjectFileLinks(to)).rejects.toMatchObject({ status: 403 });
  await expect(updateProjectFileLinks(to, () => [])).rejects.toMatchObject({ status: 403 });
});

test("malformed metadata is retained rather than silently erased", async () => {
  const to = await root(); await mkdir(join(to, ".legalwork"));
  await writeFile(join(to, ".legalwork/project-file-links.json"), "invalid");
  await expect(updateProjectFileLinks(to, () => [])).rejects.toMatchObject({ status: 409, code: "invalid_project_file_links" });
  expect(await readFile(join(to, ".legalwork/project-file-links.json"), "utf8")).toBe("invalid");
});

test("a missing destination is actionable and unsupported hard links fall back without overwriting", async () => {
  const to = await root();
  await expect(importProjectFile(to, "missing/A.md", new Uint8Array())).rejects.toMatchObject({ status: 404, code: "folder_not_found" });
  const unsupported = spyOn(fs, "link").mockImplementation(async () => { throw Object.assign(new Error("No hard links on this volume"), { code: "ENOTSUP" }); });
  try {
    await importProjectFile(to, "A.md", new TextEncoder().encode("original"));
    await expect(importProjectFile(to, "A.md", new TextEncoder().encode("replacement"))).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(to, "A.md"), "utf8")).toBe("original");
    expect(await readdir(to)).toEqual(["A.md"]);
    expect(unsupported).toHaveBeenCalledTimes(2);
  } finally { unsupported.mockRestore(); }
});
