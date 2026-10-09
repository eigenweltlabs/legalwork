import { describe, expect, test } from "bun:test";
import { documentSplitDropEdge } from "../src/react-app/domains/session/panel/document-split-drop";

describe("document split drop edges", () => {
  test("right and bottom edges choose different orientations; the center opens normally", () => {
    expect(documentSplitDropEdge(900, 300, 1000, 600)).toBe("right");
    expect(documentSplitDropEdge(400, 540, 1000, 600)).toBe("bottom");
    expect(documentSplitDropEdge(500, 300, 1000, 600)).toBeNull();
  });
  test("the nearer relative edge wins in the corner for wide and tall panes", () => {
    expect(documentSplitDropEdge(1800, 760, 2000, 800)).toBe("bottom");
    expect(documentSplitDropEdge(760, 1800, 800, 2000)).toBe("right");
  });
  test("left and top edges are symmetric, including narrow panes", () => {
    expect(documentSplitDropEdge(10, 100, 100, 200)).toBe("left");
    expect(documentSplitDropEdge(50, 10, 100, 200)).toBe("top");
    expect(documentSplitDropEdge(10, 1, 100, 200)).toBe("top");
    expect(documentSplitDropEdge(1, 10, 100, 200)).toBe("left");
  });
  test("coordinates outside the pane cannot create a split", () => {
    for (const [x, y, width, height] of [[50, 50, 0, 0], [-1, 90, 100, 100], [101, 50, 100, 100], [90, 101, 100, 100]]) {
      expect(documentSplitDropEdge(x, y, width, height)).toBeNull();
    }
  });
});
