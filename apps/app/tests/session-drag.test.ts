import { describe, expect, test } from "bun:test";
import { acceptsSessionDrag, moveSessionInOrder } from "../src/react-app/domains/session/sidebar/session-drag";

describe("project session drag and drop", () => {
  test("reorders roots without removing sessions hidden by a filter", () => {
    const ids = ["a", "hidden", "b", "c"];
    expect(moveSessionInOrder(ids, "c", "a", "before")).toEqual(["c", "a", "hidden", "b"]);
    expect(moveSessionInOrder(ids, "a", "b", "after")).toEqual(["hidden", "b", "a", "c"]);
    expect(ids).toEqual(["a", "hidden", "b", "c"]);
  });

  test("ignores self drops, descendants and missing sessions", () => {
    const ids = ["a", "b"];
    expect(moveSessionInOrder(ids, "a", "a", "after")).toBe(ids);
    expect(moveSessionInOrder(ids, "child", "b", "before")).toBe(ids);
    expect(moveSessionInOrder(ids, "a", "missing", "after")).toBe(ids);
  });

  test("only accepts session drags from the same project", () => {
    const data = { types: ["application/x-legalwork-session-id", "application/x-legalwork-workspace-project-a"] };
    expect(acceptsSessionDrag(data, "project-a")).toBe(true);
    expect(acceptsSessionDrag(data, "project-b")).toBe(false);
    expect(acceptsSessionDrag({ types: ["Files"] }, "project-a")).toBe(false);
  });
});
