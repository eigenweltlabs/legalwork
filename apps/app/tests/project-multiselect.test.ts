import { expect, test } from "bun:test";
import { changeListSelection } from "../src/react-app/domains/workspace/list-selection";
import { fileTransferItems, transferFileBatch } from "../src/react-app/domains/workspace/project-file-batch";
import { PROJECT_FILES_DRAG_TYPE, readProjectFileDrag, readProjectFilesDrag, writeProjectFileDrag, writeProjectFilesDrag } from "../src/app/lib/project-file-drag";
import { acceptsSessionDrag, acceptsSessionsDrag, readSessionsDrag, startSessionDrag, startSessionsDrag } from "../src/react-app/domains/session/sidebar/session-drag";
import { viewerFileTabs } from "../src/react-app/domains/session/panel/viewer-file-drop";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

function transferData() {
  const values = new Map<string, string>();
  const data: Pick<DataTransfer, "types" | "setData" | "getData" | "clearData" | "effectAllowed"> = {
    get types() { return [...values.keys()]; }, effectAllowed: "copy",
    setData: (key, value) => { values.set(key, value); }, getData: key => values.get(key) ?? "",
    clearData: () => values.clear(),
  };
  return data;
}
const source = { projectId: "source", workspaceId: "server-source", path: "a.md", name: "a.md" };

test("selection ranges follow current sort order and never act on filtered-out items", () => {
  expect(changeListSelection(["hidden", "a"], ["c", "b", "a"], "a", "c", true)).toEqual({ ids: ["a", "c", "b"], anchor: "a" });
  expect(changeListSelection(["a"], ["a", "b"], "a", "a")).toEqual({ ids: [], anchor: "a" });
  expect(changeListSelection(["hidden"], ["a", "b"], "hidden", "b", true)).toEqual({ ids: ["b"], anchor: "b" });
  expect(changeListSelection(["a"], ["a"], "a", "missing")).toEqual({ ids: ["a"], anchor: "a" });
});

test("batch copy retains successes, reports collisions and retries only remaining files", async () => {
  const items = fileTransferItems([source, { ...source, path: "b.md", name: "b.md" }]);
  const writes: string[] = [];
  const first = await transferFileBatch(items, async item => {
    writes.push(item.name);
    if (item.name === "b.md") throw new Error("File already exists");
  }, () => {});
  expect(first[0].done).toBe(true);
  expect(first[1]).toMatchObject({ done: false, error: "File already exists" });
  first[1].name = "b-copy.md";
  const retry = await transferFileBatch(first, async item => { writes.push(item.name); }, () => {});
  expect(writes).toEqual(["a.md", "b.md", "b-copy.md"]);
  expect(retry.every(item => item.done && !item.error)).toBe(true);
  expect(items.every(item => !item.done)).toBe(true);
});

test("aliases of one original transfer once, but equal paths in different projects stay distinct", () => {
  expect(fileTransferItems([source, { ...source, name: "Alias" }, { ...source, projectId: "other" }])).toHaveLength(2);
});

test("multi-file drags replace legacy single payloads and validate every source", () => {
  const data = transferData();
  writeProjectFileDrag(data, source);
  writeProjectFilesDrag(data, [source, { ...source, path: "b.md" }, source]);
  expect(readProjectFileDrag(data)).toBeNull();
  expect(readProjectFilesDrag(data)).toHaveLength(2);
  data.setData(PROJECT_FILES_DRAG_TYPE, JSON.stringify([source, { ...source, path: "../outside" }]));
  expect(readProjectFilesDrag(data)).toEqual([]);
  data.setData(PROJECT_FILES_DRAG_TYPE, JSON.stringify([{ ...source, token: "not-carried" }]));
  expect(readProjectFilesDrag(data)).toEqual([source]);
});

test("multiple file sources open as distinct originals without copying them", async () => {
  const client = createLegalworkServerClient({ baseUrl: "http://unused.invalid" });
  const tabs = [];
  for await (const tab of viewerFileTabs(client, "target", { projects: [source, { ...source, projectId: "other" }], workspace: null, storage: null, memory: null, files: [] })) tabs.push(tab);
  expect(tabs).toHaveLength(2);
  expect(tabs[0].id).not.toBe(tabs[1].id);
  expect(tabs.map(tab => tab.sourceProject?.projectId)).toEqual(["source", "other"]);
});

test("multi-chat drags stay project-scoped and single-only targets cannot consume just the first chat", () => {
  const data = transferData();
  startSessionDrag(data, "a", "old");
  startSessionsDrag(data, "a", ["one", "two", "one"]);
  expect(acceptsSessionDrag(data, "a")).toBe(false);
  expect(acceptsSessionsDrag(data, "a")).toBe(true);
  expect(readSessionsDrag(data, "a")).toEqual(["one", "two"]);
  expect(readSessionsDrag(data, "b")).toEqual([]);
});
