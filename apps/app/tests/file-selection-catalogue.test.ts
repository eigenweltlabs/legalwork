import { expect, test } from "bun:test";
import { fileSelectionCatalogue, fileSelectionRange } from "../src/react-app/domains/workspace/file-selection-catalogue";

test("virtualized files remain selectable after scrolling and Select all covers the logical list", () => {
  const files = Array.from({ length: 200 }, (_, index) => ({ key: `memory-${index}`, name: `File ${index}` }));
  const before = fileSelectionCatalogue([files], files.slice(0, 20));
  const after = fileSelectionCatalogue([files], files.slice(150, 170));
  expect([...before.keys()]).toEqual([...after.keys()]);
  expect(after.size).toBe(200);
  expect(after.get("memory-3")).toBe(files[3]);
  expect(fileSelectionRange([files], files.slice(150, 170).map(file => file.key), "memory-3", "memory-152")).toEqual(files.slice(3, 153).map(file => file.key));
  const filtered = fileSelectionCatalogue([files.slice(150, 170)], files.slice(150, 160));
  expect(filtered.has("memory-3")).toBe(false);
});

test("ranges cannot accidentally include another file list", () => {
  const memory = ["M1", "M2", "M3"].map(key => ({ key }));
  const mounted = ["A", "B", "C", "M1"];
  expect(fileSelectionRange([memory], mounted, "B", "M1")).toBeNull();
  expect(fileSelectionRange([memory], mounted, "M1", "B")).toBeNull();
  expect(fileSelectionRange([memory], mounted, "B", "C")).toEqual(["B", "C"]);
  expect(fileSelectionRange([memory], mounted, "M1", "M3")).toEqual(["M1", "M2", "M3"]);
});
