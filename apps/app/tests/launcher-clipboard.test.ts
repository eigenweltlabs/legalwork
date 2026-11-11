import { expect, test } from "bun:test";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { canCopyLauncherResult, copyLauncherText, isDesktopLauncherServer, launcherClipboardText, launcherLocalPaths } from "../src/react-app/launcher/launcher-clipboard";

const item = (kind: LauncherSearchResult["kind"]): LauncherSearchResult => ({ id: "one", kind, workspaceId: "w", sourceId: "w", title: "Title", updatedAt: 0, match: "recent", score: 1, actions: ["open"] });
const unused = async () => { throw new Error("Unexpected call"); };

test("copy is offered for local files and transcripts but never tasks or chats", () => {
  expect(canCopyLauncherResult(item("files"), true)).toBe(true);
  expect(canCopyLauncherResult(item("files"), false)).toBe(false);
  expect(canCopyLauncherResult(item("tasks"), false)).toBe(false);
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
  expect(await launcherClipboardText(item("recordings"), { recordingTranscript })).toBe("first\nsecond");
  expect(offsets).toEqual([0, 6]);
});

test("unavailable or stalled transcripts fail instead of copying a partial excerpt", async () => {
  for (const page of [{ content: "", nextOffset: null }, { content: "partial", nextOffset: 0 }]) {
    await expect(launcherClipboardText(item("recordings"), { recordingTranscript: async id => ({ recording: { id, title: "Title" }, totalCharacters: 10, ...page }) })).rejects.toThrow();
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


test("panel text copying uses the desktop bridge even when browser clipboard permission is denied", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes: string[] = [];
  let browserCalls = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __LEGALWORK_ELECTRON__: {
    invokeDesktop: async (command: string, text: string) => { expect(command).toBe("launcherClipboardWrite"); writes.push(text); },
  } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
    writeText: async () => { browserCalls++; throw new Error("Document is not focused"); },
  } } });
  try {
    await copyLauncherText("Complete reply\nWith another paragraph");
    expect(writes).toEqual(["Complete reply\nWith another paragraph"]);
    expect(browserCalls).toBe(0);
    Reflect.deleteProperty(globalThis, "window");
    await expect(copyLauncherText("Web reply")).rejects.toThrow("Document is not focused");
    expect(browserCalls).toBe(1);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { writes.push(text); } } } });
    await copyLauncherText("Web reply");
    expect(writes.at(-1)).toBe("Web reply");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});


test("native paths belong only to the exact running desktop server, not another loopback service", () => {
  const runtime = { running: true, baseUrl: "http://127.0.0.1:4123" };
  expect(isDesktopLauncherServer("http://127.0.0.1:4123/", runtime)).toBe(true);
  for (const url of ["http://127.0.0.1:4999", "http://localhost:4123", "http://127.0.0.1:4123/remote", "https://remote.example", "invalid"]) expect(isDesktopLauncherServer(url, runtime)).toBe(false);
  expect(isDesktopLauncherServer(runtime.baseUrl, { ...runtime, running: false })).toBe(false);
  expect(isDesktopLauncherServer(runtime.baseUrl, undefined)).toBe(false);
});
