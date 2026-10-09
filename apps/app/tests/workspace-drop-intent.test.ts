import { expect, test } from "bun:test";
import { canTransferProjectFiles, readProjectFilesDrag, writeProjectFileDrag, writeProjectFilesDrag } from "../src/app/lib/project-file-drag";
import { acceptsProjectItemDrag, readProjectItemDrag, startProjectItemDrag } from "../src/react-app/domains/session/panel/project-item-drag";
import { isFileIntakeTarget } from "../src/react-app/domains/session/panel/file-drop-intent";

const source = { projectId: "project-a", workspaceId: "server-a", name: "A.txt", path: "A.txt" };
function transfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "copy" satisfies DataTransfer["effectAllowed"],
    get types() { return [...values.keys()]; },
    setData(type: string, value: string) { values.set(type, value); },
    getData(type: string) { return values.get(type) ?? ""; },
    clearData() { values.clear(); },
  };
}

test("own-project files never advertise transfer, even while payloads are protected", () => {
  const data = transfer(); writeProjectFileDrag(data, source);
  const hover = { types: data.types };
  expect(canTransferProjectFiles(hover, "project-a")).toBe(false);
  expect(canTransferProjectFiles(hover, "project-b")).toBe(true);
  expect(readProjectFilesDrag(data)).toEqual([source]);
});

test("a link dragged within its containing project is not offered for re-import", () => {
  const data = transfer(); writeProjectFileDrag(data, source, "linked-project");
  for (const target of ["project-a", "linked-project"]) expect(canTransferProjectFiles(data, target)).toBe(false);
  expect(canTransferProjectFiles(data, "third-project")).toBe(true);
});

test("batch markers replace the single payload and reject partial same-project transfers", () => {
  const data = transfer(); writeProjectFileDrag(data, source);
  const second = { ...source, projectId: "project-b", workspaceId: "server-b" };
  writeProjectFilesDrag(data, [source, second], "linked-project");
  expect(readProjectFilesDrag(data)).toEqual([source, second]);
  for (const target of ["project-a", "project-b", "linked-project"]) expect(canTransferProjectFiles(data, target)).toBe(false);
  expect(canTransferProjectFiles(data, "third-project")).toBe(true);
});

test("task and review drags retain the specific item and cannot be interpreted in another project", () => {
  for (const tab of [
    { type: "task", id: "task:t1", taskId: "t1", label: "Check terms" },
    { type: "review", id: "review:r1", reviewId: "r1", label: "Disclosure" },
  ] satisfies import("../src/react-app/domains/session/panel/project-item-drag").ProjectItemTab[]) {
    const data = transfer(); startProjectItemDrag(data, "project-a", tab);
    expect(acceptsProjectItemDrag({ types: data.types }, "project-a")).toBe(true);
    expect(readProjectItemDrag(data, "project-a")).toEqual(tab);
    expect(acceptsProjectItemDrag(data, "project-b")).toBe(false);
    expect(readProjectItemDrag(data, "project-b")).toBeNull();
    data.setData("application/x-legalwork-project-item", '{"type":"task","taskId":123,"label":"bad"}');
    expect(readProjectItemDrag(data, "project-a")).toBeNull();
  }
});

test("pane drops open files unless the pointer is over a compatible explicit intake", () => {
  const data = transfer(); writeProjectFileDrag(data, source);
  expect(isFileIntakeTarget(undefined, data)).toBe(false);
  expect(isFileIntakeTarget("composer", data)).toBe(true);
  expect(isFileIntakeTarget("", data)).toBe(false);
  expect(isFileIntakeTarget("review", { types: ["Files"] })).toBe(true);
  expect(isFileIntakeTarget("project:project-b", data, "project-b")).toBe(true);
  expect(isFileIntakeTarget("project:project-a", data, "project-a")).toBe(false);
  const cloud = { types: [...data.types, "application/x-legalwork-storage-entry", "application/x-legalwork-storage-entry-server-a"] };
  expect(isFileIntakeTarget("storage:server-a", cloud, "project-a")).toBe(true);
  expect(isFileIntakeTarget("storage:server-b", cloud, "project-b")).toBe(false);
});

 test("explicit review/task intake preserves compatible own-project single-file payloads", () => {
  const data = transfer(); writeProjectFileDrag(data, source);
  data.setData("application/x-legalwork-workspace-file", "fixture");
  expect(isFileIntakeTarget("review", data, "project-a")).toBe(true);
  expect(isFileIntakeTarget("review", data, "project-b")).toBe(false);
  expect(isFileIntakeTarget("task", data, "project-a")).toBe(false);
  data.setData("application/x-legalwork-storage-file", "fixture");
  expect(isFileIntakeTarget("task", data, "project-a")).toBe(true);
  expect(isFileIntakeTarget("task", data, "project-b")).toBe(false);
  writeProjectFilesDrag(data, [source, { ...source, path: "B.txt" }], "project-a");
  expect(isFileIntakeTarget("review", data, "project-a")).toBe(false);
 });
