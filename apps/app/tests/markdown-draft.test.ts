import { describe, expect, test } from "bun:test";
import { loadMarkdownDraft, savedMarkdownDraft, replaceMarkdownText } from "../src/react-app/domains/session/artifacts/markdown-draft";

describe("Markdown draft preservation", () => {
  test("opening retains exact whitespace and markup", () => {
    const source = "---\ntitle: Matter\n---\n\n# Brief\n\n* item\n\n\n";
    expect(loadMarkdownDraft(null, source, 1).content).toBe(source);
  });
  test("incoming disk changes cannot overwrite a draft or advance its save version", () => {
    const current = { content: "my edits", baseline: "original", updatedAt: 1 };
    expect(loadMarkdownDraft(current, "external edits", 2)).toBe(current);
    expect(loadMarkdownDraft({ ...current, content: "original" }, "external edits", 2).content).toBe("external edits");
  });
  test("edits made during a save survive and remain dirty", () => {
    const result = savedMarkdownDraft({ content: "newer edits", baseline: "original", updatedAt: 1 }, "submitted edits", 2);
    expect(result).toEqual({ content: "newer edits", baseline: "submitted edits", updatedAt: 2 });
    expect(loadMarkdownDraft(result, "submitted edits", 2)).toBe(result);
  });
  test("agent replacements reject stale/ambiguous matches and preserve literal dollar signs", () => {
    expect(() => replaceMarkdownText("a a", "a", "b")).toThrow("more than once");
    expect(() => replaceMarkdownText("a", "b", "c")).toThrow("not found");
    expect(replaceMarkdownText("# Brief\nFee: 20", "20", "$100")).toBe("# Brief\nFee: $100");
  });
});
