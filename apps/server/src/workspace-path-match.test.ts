import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearProjectPathCache, directoryWithinProject, findProjectForDirectory, pathKeyWithin, projectPathKey, sameProjectDirectory,
} from "./workspace-path-match.js";

// A project registered under a mapped drive (P:\Matters\Example) and a chat
// stored under its UNC target (\\fileserver\share\Matters\Example) name the
// same folder. A lexical relative() check rejected such chats, so every
// project-scoped tool failed with "No LegalWork workspace matches …".
// A directory symlink models the alias on every platform.

let root = "";
let real = "";
let alias = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-path-match-")));
  real = join(root, "share", "Matters", "Example Matter");
  await mkdir(join(real, "Drafts"), { recursive: true });
  alias = join(root, "mapped-drive");
  await symlink(join(root, "share"), alias, "dir");
  clearProjectPathCache();
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("project path matching", () => {
  test("a chat stored under the canonical target matches a project registered under the alias", async () => {
    const project = join(alias, "Matters", "Example Matter");
    expect(await sameProjectDirectory(project, real)).toBe(true);
    expect(await directoryWithinProject(project, join(real, "Drafts"))).toBe(true);
    const match = await findProjectForDirectory([{ id: "ws_example", path: project }, { id: "ws_other", path: join(root, "other") }], real);
    expect(match?.id).toBe("ws_example");
  });

  test("the nearest nested project wins, also across aliases", async () => {
    const outer = join(alias, "Matters");
    const inner = join(alias, "Matters", "Example Matter");
    const match = await findProjectForDirectory([{ id: "outer", path: outer }, { id: "inner", path: inner }], join(real, "Drafts"));
    expect(match?.id).toBe("inner");
  });

  test("sibling folders and prefixes of a folder name never match", async () => {
    await mkdir(join(root, "share", "Matters", "Example Matter 2"), { recursive: true });
    expect(await directoryWithinProject(real, join(root, "share", "Matters", "Example Matter 2"))).toBe(false);
    expect(await findProjectForDirectory([{ id: "example", path: real }], join(root, "share", "Matters"))).toBeUndefined();
  });

  test("Windows keys ignore case, separators and extended-length prefixes", () => {
    const key = (path: string) => projectPathKey(path, { platform: "win32" });
    expect(key("\\\\?\\UNC\\FileServer\\Share\\Matters")).toBe(key("\\\\fileserver\\share\\Matters\\"));
    expect(key("//FileServer/Share/Matters")).toBe(key("\\\\FileServer\\Share\\Matters"));
    expect(key("\\\\?\\P:\\Matters\\Example")).toBe(key("p:/matters/example"));
    expect(pathKeyWithin(key("//FileServer/Share/Matters"), key("\\\\FileServer\\Share\\Matters\\Example"))).toBe(true);
    expect(pathKeyWithin(key("//FileServer/Share/Matters"), key("//FileServer/Share/Matters2"))).toBe(false);
    // A drive letter and its UNC target differ only by the drive mapping;
    // realpath (not lexical rules) must bridge them.
    expect(key("P:\\Matters\\Example")).not.toBe(key("\\\\FileServer\\Share\\Matters\\Example"));
  });

  test("POSIX keys stay case-sensitive", () => {
    expect(projectPathKey("/Volumes/Matters/Example", { platform: "posix" })).not.toBe(projectPathKey("/volumes/matters/example", { platform: "posix" }));
  });

  test("unresolvable paths fall back to lexical comparison instead of throwing", async () => {
    expect(await sameProjectDirectory(join(root, "missing", "a"), join(root, "missing", "a/"))).toBe(true);
    expect(await sameProjectDirectory(join(root, "missing", "a"), join(root, "missing", "b"))).toBe(false);
  });
});
