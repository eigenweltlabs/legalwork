import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { deleteProjectNote } from "../src/react-app/domains/workspace/delete-project-note";

function noteCache() {
  const cache = new QueryClient();
  cache.setQueryData(["markdown-editor", "project-a", "Notes/note.md"], { content: "Note" });
  cache.setQueryData(["markdown-editor", "project-b", "Notes/note.md"], { content: "Other note" });
  for (const key of ["project-notes", "project-files", "workspace-files"]) {
    cache.setQueryData([key, "project-a"], { entries: ["Notes/note.md"] });
    cache.setQueryData([key, "project-b"], { entries: ["Notes/note.md"] });
  }
  return cache;
}

test("deleting a note refreshes its project listings and clears only its preview", async () => {
  const cache = noteCache();
  await deleteProjectNote({ deleteWorkspaceFiles: async (workspace, files) => {
    expect(workspace).toBe("project-a");
    expect(files).toEqual([{ path: "Notes/note.md" }]);
    return [{ ok: true, path: "Notes/note.md" }];
  } }, cache, "project-a", "Notes/note.md");
  expect(cache.getQueryData(["markdown-editor", "project-a", "Notes/note.md"])).toBeUndefined();
  expect(cache.getQueryData(["markdown-editor", "project-b", "Notes/note.md"])).toEqual({ content: "Other note" });
  for (const key of ["project-notes", "project-files", "workspace-files"]) {
    expect(cache.getQueryState([key, "project-a"])?.isInvalidated).toBe(true);
    expect(cache.getQueryState([key, "project-b"])?.isInvalidated).toBe(false);
  }
});

test("an individual file-operation failure keeps the note in cache and reports failure", async () => {
  const cache = noteCache();
  await expect(deleteProjectNote({ deleteWorkspaceFiles: async () => [{ ok: false, path: "Notes/note.md", code: "permission_denied" }] }, cache, "project-a", "Notes/note.md")).rejects.toThrow("permission_denied");
  expect(cache.getQueryData(["markdown-editor", "project-a", "Notes/note.md"])).toEqual({ content: "Note" });
  expect(cache.getQueryState(["project-notes", "project-a"])?.isInvalidated).toBe(false);
});

test("missing results and request failures do not masquerade as successful deletion", async () => {
  const cache = noteCache();
  await expect(deleteProjectNote({ deleteWorkspaceFiles: async () => [] }, cache, "project-a", "Notes/note.md")).rejects.toThrow("delete_failed");
  await expect(deleteProjectNote({ deleteWorkspaceFiles: async () => { throw new Error("offline"); } }, cache, "project-a", "Notes/note.md")).rejects.toThrow("offline");
  expect(cache.getQueryData(["markdown-editor", "project-a", "Notes/note.md"])).toEqual({ content: "Note" });
});
