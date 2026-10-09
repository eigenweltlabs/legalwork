import { expect, test } from "bun:test";
import { hasWorkspaceFileMove, readWorkspaceFileMove, workspaceFileMoves, writeWorkspaceFileMove, WORKSPACE_MOVE_TYPE } from "../src/app/lib/workspace-file-move";
import { fileExplorerSplitDropEdge } from "../src/react-app/domains/session/panel/document-split-drop";

function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "copyMove" satisfies DataTransfer["effectAllowed"], get types() { return [...data.keys()]; }, setData: (key: string, value: string) => { data.set(key, value); }, getData: (key: string) => data.get(key) ?? "" };
}
test("moves stay within the original server and workspace, including protected drag payloads", () => {
  const data = transfer();
  writeWorkspaceFileMove(data, { baseUrl: "http://local", workspaceId: "a", paths: ["notes.md", "a.pdf", "notes.md"] });
  expect(hasWorkspaceFileMove({ types: data.types }, "http://local", "a")).toBe(true);
  expect(hasWorkspaceFileMove(data, "http://remote", "a")).toBe(false);
  expect(hasWorkspaceFileMove(data, "http://local", "b")).toBe(false);
  expect(readWorkspaceFileMove(data, "http://local", "a")).toEqual(["notes.md", "a.pdf"]);
  expect(readWorkspaceFileMove(data, "http://remote", "a")).toEqual([]);
  data.setData(WORKSPACE_MOVE_TYPE, JSON.stringify({ baseUrl: "http://local", workspaceId: "a", paths: ["../escape.md"] }));
  expect(readWorkspaceFileMove(data, "http://local", "a")).toEqual([]);
});
test("batch moves preserve extensions, refuse overwrite and skip files already in the folder", () => {
  expect(workspaceFileMoves(["notes.md", "other/a.pdf", "Folder/b.md"], "Folder")).toEqual([
    { type: "rename", from: "notes.md", to: "Folder/notes.md", overwrite: false },
    { type: "rename", from: "other/a.pdf", to: "Folder/a.pdf", overwrite: false },
  ]);
  expect(workspaceFileMoves(["Folder/notes.md"], "")[0].to).toBe("notes.md");
  expect(() => workspaceFileMoves(["notes.md"], "../outside")).toThrow();
});
test("file browser content keeps folder drops while the narrow outer edges still split", () => {
  for (const [x, y] of [[41, 300], [959, 300], [500, 41], [500, 559]]) expect(fileExplorerSplitDropEdge(x, y, 1000, 600)).toBeNull();
  expect(fileExplorerSplitDropEdge(4, 300, 1000, 600)).toBe("left");
  expect(fileExplorerSplitDropEdge(20, 300, 1000, 600)).toBe("left");
  expect(fileExplorerSplitDropEdge(40, 300, 1000, 600)).toBe("left");
  expect(fileExplorerSplitDropEdge(960, 300, 1000, 600)).toBe("right");
  expect(fileExplorerSplitDropEdge(500, 40, 1000, 600)).toBe("top");
  expect(fileExplorerSplitDropEdge(500, 560, 1000, 600)).toBe("bottom");
  expect(fileExplorerSplitDropEdge(996, 300, 1000, 600)).toBe("right");
  expect(fileExplorerSplitDropEdge(500, 4, 1000, 600)).toBe("top");
  expect(fileExplorerSplitDropEdge(500, 596, 1000, 600)).toBe("bottom");
});
