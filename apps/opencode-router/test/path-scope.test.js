import assert from "node:assert/strict";
import test from "node:test";

import {
  isWithinWorkspaceRootPath,
  normalizeScopedDirectoryPath,
} from "../dist/path-scope.js";

test("normalizeScopedDirectoryPath strips Windows verbatim prefixes", () => {
  const workspaceRoot = String.raw`G:\project\legalwork_project`;
  const candidate = String.raw`\\?\G:\project\legalwork_project`;

  assert.equal(
    normalizeScopedDirectoryPath(workspaceRoot, "win32"),
    "g:/project/legalwork_project",
  );
  assert.equal(
    normalizeScopedDirectoryPath(candidate, "win32"),
    "g:/project/legalwork_project",
  );
});

test("isWithinWorkspaceRootPath accepts Windows verbatim aliases for workspace root", () => {
  const workspaceRoot = String.raw`G:\project\legalwork_project`;
  const candidate = String.raw`\\?\G:\project\legalwork_project`;

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
      platform: "win32",
    }),
    true,
  );
});

test("isWithinWorkspaceRootPath still rejects directories outside the workspace root", () => {
  const workspaceRoot = String.raw`G:\project\legalwork_project`;
  const candidate = String.raw`\\?\G:\project\outside`;

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
      platform: "win32",
    }),
    false,
  );
});

test("Windows scope checks preserve UNC aliases and path boundaries on every host", () => {
  assert.equal(
    normalizeScopedDirectoryPath(String.raw`\\?\UNC\server\share\project`, "win32"),
    "//server/share/project",
  );
  const workspaceRoot = String.raw`\\server\share\project`;
  for (const [candidate, expected] of [
    [String.raw`\\?\UNC\SERVER\SHARE\project\notes`, true],
    [String.raw`\\server\share\project\..notes`, true],
    [String.raw`\\server\share\project\notes\..\drafts`, true],
    [String.raw`\\server\share\project\..\outside`, false],
    [String.raw`\\server\share\project-copy`, false],
    [String.raw`\\server\other\project`, false],
  ]) {
    assert.equal(isWithinWorkspaceRootPath({ workspaceRoot, candidate, platform: "win32" }), expected, candidate);
  }
});

test("Windows scope checks reject sibling prefixes, parent traversal and other drives", () => {
  const workspaceRoot = String.raw`G:\project\legalwork_project`;
  for (const [candidate, expected] of [
    [String.raw`g:\PROJECT\legalwork_project\notes`, true],
    [String.raw`G:\project\legalwork_project\..notes`, true],
    [String.raw`G:\project\legalwork_project\..\outside`, false],
    [String.raw`G:\project\legalwork_project-copy`, false],
    [String.raw`H:\project\legalwork_project`, false],
  ]) {
    assert.equal(isWithinWorkspaceRootPath({ workspaceRoot, candidate, platform: "win32" }), expected, candidate);
  }
});

test("POSIX scope checks retain case sensitivity and directory boundaries", () => {
  for (const [candidate, expected] of [
    ["/project/work/notes/../drafts", true],
    ["/project/work/..notes", true],
    ["/project/work/../outside", false],
    ["/project/work-copy", false],
    ["/project/WORK", false],
  ]) {
    assert.equal(isWithinWorkspaceRootPath({ workspaceRoot: "/project/work/", candidate, platform: "linux" }), expected, candidate);
  }
});
