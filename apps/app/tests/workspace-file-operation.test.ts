import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { operateWorkspaceFile } from "../src/react-app/domains/workspace/workspace-file-operation";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  mock.restore();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});
function setup(owned: boolean) {
  const client = createLegalworkServerClient({ baseUrl: "http://test.invalid" });
  const file = { client, workspaceId: "project", path: "note.md", isRemoteWorkspace: false };
  spyOn(client, "statWorkspaceFile").mockResolvedValue({ ok: true, path: file.path, exists: true, kind: "file", fileId: "/project/note.md", size: 1, updatedAt: 1 });
  const apply = spyOn(client, "applyWorkspaceFileOperations").mockResolvedValue([{ ok: true }]);
  const request = mock(async (name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => callback(owned ? null : { name, mode: "exclusive" }));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request } } });
  const queries = new QueryClient();
  const cacheKey = ["markdown-editor", "project", "note.md"];
  queries.setQueryData(cacheKey, "old content");
  return { file, apply, request, queries, cacheKey };
}
test("move and delete reject an editor-owned file before any filesystem mutation", async () => {
  const { file, apply, queries, cacheKey } = setup(true);
  await expect(operateWorkspaceFile(file, { type: "delete", path: file.path }, queries)).rejects.toThrow();
  await expect(operateWorkspaceFile(file, { type: "rename", from: file.path, to: "Folder/note.md", overwrite: false }, queries)).rejects.toThrow();
  expect(apply).not.toHaveBeenCalled();
  expect(queries.getQueryData(cacheKey)).toBe("old content");
});
test("successful file mutations hold the identity lock and evict only stale document content", async () => {
  const { file, apply, request, queries, cacheKey } = setup(false);
  queries.setQueryData(["markdown-editor", "other-project", "note.md"], "other content");
  await operateWorkspaceFile(file, { type: "delete", path: file.path }, queries);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toContain("legalwork:document:");
  expect(request.mock.calls[0][1]).toEqual({ ifAvailable: true });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(queries.getQueryData(cacheKey)).toBeUndefined();
  expect(queries.getQueryData(["markdown-editor", "other-project", "note.md"])).toBe("other content");
});
test("a failed filesystem operation keeps cached content and reports its error", async () => {
  const { file, apply, queries, cacheKey } = setup(false);
  apply.mockResolvedValue([{ ok: false, message: "Permission denied" }]);
  await expect(operateWorkspaceFile(file, { type: "delete", path: file.path }, queries)).rejects.toThrow("Permission denied");
  expect(queries.getQueryData(cacheKey)).toBe("old content");
});
