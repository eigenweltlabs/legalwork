import { expect, test } from "bun:test";
import { parseProjectContents } from "../src/components/chat/project/project-tool";

test("project tool output parsing handles persisted JSON and rejects malformed or incomplete results", () => {
  const result = { version: 1, project: { id: "current", name: "Matter", fields: [] }, sections: [
    { kind: "notes", path: "", items: [{ id: "Notes/Test.md", kind: "notes", title: "<script>content</script>", preview: "Note preview" }], nextCursor: null },
  ] };
  expect(parseProjectContents(JSON.stringify(result))).toEqual(result);
  expect(parseProjectContents(result)).toEqual(result);
  for (const value of ["{", null, { error: "Unavailable" }, { ...result, project: { id: 22 } }, { ...result, sections: [{ kind: "email" }] }]) {
    expect(parseProjectContents(value)).toBeNull();
  }
});
