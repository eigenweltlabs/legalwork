import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { primaryResultAction, launcherActionSelection, resultActionMenu } from "../src/react-app/launcher/action-catalog";
import { LauncherActionMenu, LauncherResultList, launcherExtraActions } from "../src/react-app/launcher/launcher-results";
import { assistantAvatarImages } from "../src/react-app/domains/session/sidebar/assistant-avatar-assets";
import { resultKey } from "../src/react-app/launcher/launcher-search-session";

const file: LauncherSearchResult = { id: "contract.pdf", kind: "files", workspaceId: "project", sourceId: "local:project", title: "Contract", path: "contract.pdf", fileType: "pdf", updatedAt: 0, score: 1, match: "recent", actions: ["open", "attach", "compare", "pin", "copy-path"] };
const noop = () => {};

test("file actions match across search, directory browsing and legacy recent metadata", () => {
  const expected = ["chat-with-assistant", "ask", "summarize", "copy-to-project", "move-to-project"];
  const layers: LauncherSearchResult[] = [file, { ...file, actions: ["open"] }, { ...file, actions: ["open", "ask", "summarize", "reveal"] }];
  for (const item of layers) {
    expect(resultActionMenu(item)).toEqual(expected);
    expect(primaryResultAction(item)).toBe("open");
    expect(launcherExtraActions(item, true)).toEqual(["copy-to-clipboard", "hide"]);
  }
  const html = renderToStaticMarkup(<LauncherActionMenu result={file} selection={[file]} assistantIcon="fox" extra={launcherExtraActions(file, true)} projects={[]} onRun={noop} onExtra={noop} onTransfer={noop} onClose={noop} />);
  expect(html).toContain(assistantAvatarImages.fox);
  expect(html).not.toContain(assistantAvatarImages.cat);
  expect(html).not.toContain("lucide-pin");
  expect(html).not.toContain("Copy path");
  expect(html).not.toContain("Attach to draft");
  expect(html).not.toContain("Open in app");
  expect(html.match(/role="menuitem"/g)).toHaveLength(5);
});

test("chats and containers never inherit file/Assistant actions from cached metadata", () => {
  for (const item of [{ ...file, kind: "chats" }, { ...file, kind: "projects" }, { ...file, fileType: "folder" }] satisfies LauncherSearchResult[]) {
    expect(resultActionMenu(item)).toEqual([]);
    expect(launcherExtraActions(item, false)).toEqual(["open-in-app", "hide"]);
  }
  const externalFolder = { ...file, workspaceId: null, folderId: "library", fileType: "folder" };
  expect(resultActionMenu(externalFolder, [externalFolder], true)).toEqual(["open-external", "reveal"]);
  expect(resultActionMenu(externalFolder, [externalFolder], false)).toEqual([]);
  expect(launcherExtraActions(externalFolder, false)).toEqual(["hide"]);
});

test("tasks and recordings expose only actions that their handlers support", () => {
  expect(resultActionMenu({ ...file, kind: "tasks", completed: false })).toEqual(["complete", "chat-with-assistant", "ask"]);
  expect(resultActionMenu({ ...file, kind: "tasks", completed: true })).toEqual(["reopen", "chat-with-assistant", "ask"]);
  expect(resultActionMenu({ ...file, kind: "tasks", workspaceId: null })).toEqual(["chat-with-assistant", "ask"]);
  expect(resultActionMenu({ ...file, kind: "recordings" })).toEqual(["chat-with-assistant", "ask"]);
});

test("multi-file actions use the focused selection and the intersection of supported source operations", () => {
  const added = { ...file, id: "other", folderId: "library", workspaceId: null };
  const selected = new Set([resultKey(file), resultKey(added)]);
  expect(launcherActionSelection(file, [file, added], selected)).toEqual([file, added]);
  expect(launcherActionSelection(file, [added], selected)).toEqual([file]);
  const unrelated = { ...file, id: "unrelated" };
  expect(launcherActionSelection(unrelated, [file, added], selected)).toEqual([unrelated]);
  expect(resultActionMenu(file, [file, added])).toEqual(["chat-with-assistant", "ask", "summarize", "compare"]);
  const wiki: LauncherSearchResult = { ...file, id: "wiki", sourceKind: "wiki" };
  expect(resultActionMenu(wiki)).toEqual(["chat-with-assistant", "ask", "summarize", "copy-to-project"]);
  expect(resultActionMenu(file, [file, wiki])).not.toContain("move-to-project");
});

test("previously pinned files render as ordinary launcher results", () => {
  const html = renderToStaticMarkup(<LauncherResultList items={[file]} sources={[]} query="" selectedKey={null} multiSelect={new Set()} pins={new Set([resultKey(file)])} pending={false} onSelect={noop} onRun={noop} onToggleMulti={noop} onOpenActions={noop} />);
  expect(html).toContain("Contract");
  expect(html).not.toContain("lucide-pin");
});

test("result subtitles use only the origin icon and name consistently across result kinds", () => {
  for (const kind of ["files", "chats", "tasks", "recordings"] satisfies LauncherSearchResult["kind"][]) {
  for (const [sourceKind, label, icon] of [["wiki", "Wiki", "lucide-book-open"], ["project", "Project", "lw-folder-icon"], ["folder", "Folder", "lw-folder-icon"]] as const) {
    const html = renderToStaticMarkup(<LauncherResultList items={[{ ...file, kind, sourceKind, subtitle: "Legal Research" }]} sources={[]} query="" selectedKey={null} multiSelect={new Set()} pins={new Set()} pending={false} onSelect={noop} onRun={noop} onToggleMulti={noop} onOpenActions={noop} />);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain(`${label} · Legal Research`);
    expect(html).toContain('>Legal Research</span>');
    expect(html).toContain(icon);
    if (kind === "files") expect(html).toContain("lucide-file-text");
    if (kind === "chats") expect(html).toContain("lucide-message-square");
    expect(html).toContain(`data-source-kind="${sourceKind}"`);
  }
  }
});
