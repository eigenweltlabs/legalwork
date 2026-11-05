import { expect, test } from "bun:test";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { canCopyLauncherResult, launcherClipboardText, launcherLocalPaths } from "../src/react-app/launcher/launcher-clipboard";

const item = (kind: LauncherSearchResult["kind"]): LauncherSearchResult => ({ id: "one", kind, workspaceId: "w", sourceId: "w", title: "Title", updatedAt: 0, match: "recent", score: 1, actions: ["open"] });
const unused = async () => { throw new Error("Unexpected call"); };

test("copy is offered for local files, tasks and transcripts, including recent results", () => {
  expect(canCopyLauncherResult(item("files"), true)).toBe(true);
  expect(canCopyLauncherResult(item("files"), false)).toBe(false);
  expect(canCopyLauncherResult(item("tasks"), false)).toBe(true);
  expect(canCopyLauncherResult(item("recordings"), false)).toBe(true);
  expect(canCopyLauncherResult(item("chats"), true)).toBe(false);
  expect(canCopyLauncherResult(item("projects"), true)).toBe(false);
});

test("recordings copy the complete transcript across pages", async () => {
  const offsets: number[] = [];
  const recordingTranscript: LegalworkServerClient["recordingTranscript"] = async (id, options) => {
    expect(id).toBe("one"); offsets.push(options?.offset ?? 0);
    return { recording: { id, title: "Title" }, content: options?.offset ? "second" : "first\n", nextOffset: options?.offset ? null : 6, totalCharacters: 12 };
  };
  expect(await launcherClipboardText(item("recordings"), { getTask: unused, recordingTranscript })).toBe("first\nsecond");
  expect(offsets).toEqual([0, 6]);
});

test("unavailable or stalled transcripts fail instead of copying a partial excerpt", async () => {
  for (const page of [{ content: "", nextOffset: null }, { content: "partial", nextOffset: 0 }]) {
    await expect(launcherClipboardText(item("recordings"), { getTask: unused, recordingTranscript: async id => ({ recording: { id, title: "Title" }, totalCharacters: 10, ...page }) })).rejects.toThrow();
  }
});


test("local file paths include Wiki sources and are checked before any OS clipboard operation", async () => {
  const file: LauncherSearchResult = { ...item("files"), path: "Notes.md", sourceKind: "wiki" };
  let checked = false;
  const paths = await launcherLocalPaths([file], {
    visibleLauncherFiles: async items => { checked = true; return { items }; },
    listWorkspaces: async () => { expect(checked).toBe(true); return { items: [{ id: "w", name: "Research", path: "/external/wiki", preset: "wiki", workspaceType: "local" }] }; },
    launcherFolders: unused, launcherFolderFile: unused,
  });
  expect(paths).toEqual(["/external/wiki/Notes.md"]);
  await expect(launcherLocalPaths([file], { visibleLauncherFiles: async () => ({ items: [] }), listWorkspaces: unused, launcherFolders: unused, launcherFolderFile: unused })).rejects.toThrow();
});

test("added-folder paths are resolved from current configuration and stale selections fail together", async () => {
  const file: LauncherSearchResult = { ...item("files"), workspaceId: null, folderId: "library", path: "Notes.md" };
  const folder: LauncherSearchResult = { ...file, id: "folder", path: "nested", fileType: "folder" };
  expect(await launcherLocalPaths([file, folder], {
    visibleLauncherFiles: async items => ({ items }), listWorkspaces: unused,
    launcherFolderFile: async () => ({ path: "/real/library/Notes.md" }),
    launcherFolders: async () => ({ folders: [{ id: "library", name: "Library", path: "/real/library", createdAt: 0 }] }),
  })).toEqual(["/real/library/Notes.md", "/real/library/nested"]);
  await expect(launcherLocalPaths([file, folder], { visibleLauncherFiles: async () => ({ items: [file] }), listWorkspaces: unused, launcherFolders: unused, launcherFolderFile: unused })).rejects.toThrow();
});
