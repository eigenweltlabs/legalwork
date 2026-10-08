import { describe, expect, test } from "bun:test";
import { filePinKey, updatePinnedPaths, type FilePin } from "../src/react-app/domains/session/panel/file-pins";

const pin = (path: string, workspaceId = "project", source = "local"): FilePin => ({ workspaceId, source, path, name: path.split("/").at(-1)! });
describe("file pins", () => {
  test("identities distinguish projects, sources and separator characters", () => {
    const pins = [pin("a"), pin("a", "other"), pin("a", "project", "cloud"), pin("c", "a:b"), pin("b:c", "a")];
    expect(new Set(pins.map(filePinKey)).size).toBe(pins.length);
  });
  test("renaming a folder follows descendant pins, not similarly prefixed siblings", () => {
    const pins = [pin("brief/a.docx"), pin("brief/sub/b.pdf"), pin("briefs/c.pdf"), pin("brief/a.docx", "other"), pin("brief/a.docx", "project", "cloud")];
    const next = updatePinnedPaths(pins, "project", "local", "brief", "renamed");
    expect(next.map(item => item.path)).toEqual(["renamed/a.docx", "renamed/sub/b.pdf", "briefs/c.pdf", "brief/a.docx", "brief/a.docx"]);
    expect(pins[0]!.path).toBe("brief/a.docx");
  });
  test("a file rename updates its display name; deletion removes only matching pins", () => {
    const renamed = updatePinnedPaths([pin("a.docx"), pin("b.pdf"), pin("a.docx", "project", "cloud")], "project", "local", "a.docx", "new.docx");
    expect(renamed[0]!.name).toBe("new.docx");
    expect(updatePinnedPaths(renamed, "project", "local", "new.docx")).toEqual([pin("b.pdf"), pin("a.docx", "project", "cloud")]);
  });
});
