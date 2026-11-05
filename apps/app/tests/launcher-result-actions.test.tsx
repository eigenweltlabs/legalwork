import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { resultActionMenu } from "../src/react-app/launcher/action-catalog";
import { LauncherActionMenu, LauncherResultList } from "../src/react-app/launcher/launcher-results";
import { resultKey } from "../src/react-app/launcher/launcher-search-session";

const file: LauncherSearchResult = { id: "contract.pdf", kind: "files", workspaceId: "project", sourceId: "local:project", title: "Contract", path: "contract.pdf", fileType: "pdf", updatedAt: 0, score: 1, match: "recent", actions: ["open", "attach", "compare", "pin"] };
const noop = () => {};

test("legacy providers cannot reintroduce pin controls into launcher actions", () => {
  expect(resultActionMenu(file, 1)).toEqual(["attach"]);
  expect(resultActionMenu(file, 2)).toEqual(["attach", "compare"]);
  const html = renderToStaticMarkup(<LauncherActionMenu result={file} multiSelected={0} pinned extra={["open-in-app", "hide"]} projects={[]} onRun={noop} onExtra={noop} onTransfer={noop} onClose={noop} />);
  expect(html).not.toContain("lucide-pin");
  expect(html.match(/role="menuitem"/g)).toHaveLength(3);
});

test("previously pinned files render as ordinary launcher results", () => {
  const html = renderToStaticMarkup(<LauncherResultList items={[file]} sources={[]} query="" selectedKey={null} multiSelect={new Set()} pins={new Set([resultKey(file)])} pending={false} onSelect={noop} onRun={noop} onToggleMulti={noop} onOpenActions={noop} />);
  expect(html).toContain("Contract");
  expect(html).not.toContain("lucide-pin");
});

test("file subtitles distinguish wiki, project and additional-folder origins without replacing the document icon", () => {
  for (const [sourceKind, label, icon] of [["wiki", "Wiki", "lucide-book-open"], ["project", "Project", "lw-folder-icon"], ["folder", "Folder", "lw-folder-icon"]] as const) {
    const html = renderToStaticMarkup(<LauncherResultList items={[{ ...file, sourceKind, subtitle: "Legal Research" }]} sources={[]} query="" selectedKey={null} multiSelect={new Set()} pins={new Set()} pending={false} onSelect={noop} onRun={noop} onToggleMulti={noop} onOpenActions={noop} />);
    expect(html).toContain(`${label} · Legal Research`);
    expect(html).toContain(icon);
    expect(html).toContain("lucide-file-text");
    expect(html).toContain(`data-source-kind="${sourceKind}"`);
  }
});
