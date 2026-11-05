import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { resultActionMenu } from "../src/react-app/launcher/action-catalog";
import { LauncherActionMenu, LauncherResultList } from "../src/react-app/launcher/launcher-results";
import { resultKey } from "../src/react-app/launcher/launcher-search-session";

const file: LauncherSearchResult = { id: "contract.pdf", kind: "files", workspaceId: "project", sourceId: "local:project", title: "Contract", path: "contract.pdf", fileType: "pdf", updatedAt: 0, score: 1, match: "recent", actions: ["open", "attach", "compare", "pin", "copy-path"] };
const noop = () => {};

test("legacy providers use distinct chat actions and cannot reintroduce pin or copy-path controls", () => {
  expect(resultActionMenu(file, 1)).toEqual(["chat-with-assistant", "ask"]);
  expect(resultActionMenu(file, 2)).toEqual(["chat-with-assistant", "ask", "compare"]);
  const html = renderToStaticMarkup(<LauncherActionMenu result={file} multiSelected={0} pinned extra={["open-in-app", "hide"]} projects={[]} onRun={noop} onExtra={noop} onTransfer={noop} onClose={noop} />);
  expect(html).not.toContain("lucide-pin");
  expect(html).not.toContain("Copy path");
  expect(html).not.toContain("Attach to draft");
  expect(html.match(/role="menuitem"/g)).toHaveLength(4);
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
