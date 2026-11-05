import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeProxyDirectory, assertNativeProxyRoute, nativeProxyFilePath, nativeProxyPath, nativeProxySessionID } from "./native-proxy-policy.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const actor = { type: "remote", scope: "collaborator" } satisfies import("./types.js").Actor;
test("native routes cannot bypass credential/admin/settings/terminal boundaries through API prefixes or escaping", () => {
  for (const path of ["/api/credential", "/opencode/api/credential/id", "/api/%63redential", "/api/pty", "/api/experimental/persistent-pty/id", "/api/experimental/session/id/terminal", "/api/debug/heap-dump", "/api/rpc/foreign/run"]) expect(() => assertNativeProxyRoute(actor, "GET", path)).toThrow();
  for (const path of ["/api/experimental/config", "/api/experimental/mcp/notes", "/api/plugin/update", "/api/project/id", "/api/experimental/session/import"]) expect(() => assertNativeProxyRoute(actor, "POST", path)).toThrow();
  expect(() => assertNativeProxyRoute(actor, "POST", "/api/integration/openai/connect/key")).not.toThrow();
  expect(() => assertNativeProxyRoute(actor, "POST", "/api/experimental/mcp/notes/connect")).not.toThrow();
  expect(() => assertNativeProxyRoute({ type: "remote", scope: "viewer" }, "POST", "/api/session/s/permission/r/reply")).toThrow();
  expect(() => nativeProxyPath("/api/%252e%252e/debug")).toThrow();
});
test("coding worktree routes are excluded while legal file/history operations remain available", () => {
  for (const method of ["GET", "POST", "DELETE"]) for (const path of ["/api/worktree", "/opencode/api/worktree/refresh", "/api/%77orktree"]) {
    expect(() => assertNativeProxyRoute(actor, method, path)).toThrow("outside LegalWork's legal workflows");
  }
  for (const path of ["/api/session/chat/revert/stage", "/api/session/chat/diff", "/api/fs/read/document.txt"]) {
    expect(() => assertNativeProxyRoute(actor, "GET", path)).not.toThrow();
  }
});
test("native session selectors and absolute file paths retain their meaning", () => {
  expect(nativeProxySessionID("/api/experimental/session/s_1/export")).toBe("s_1");
  expect(nativeProxySessionID("/api/session/active")).toBeUndefined();
  const path = "/opencode/api/fs/read//tmp/hello%20world.txt";
  expect(nativeProxyFilePath(path, new URL("http://proxy.invalid"), "/workspace")).toBe("/tmp/hello world.txt");
});
test("symlinked directories and nonexistent write destinations cannot escape an authorized project", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-proxy-path-"))); roots.push(root);
  const project = join(root, "project"), outside = join(root, "outside");
  await mkdir(project); await mkdir(outside); await symlink(outside, join(project, "alias"));
  await expect(assertNativeProxyDirectory(project, join(project, "alias", "new.txt"))).rejects.toThrow();
  await expect(assertNativeProxyDirectory(project, join(project, "new", "file.txt"))).resolves.toBe(join(project, "new", "file.txt"));
});
