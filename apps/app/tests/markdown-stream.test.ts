import { afterEach, expect, test } from "bun:test";
import { applyMarkdownStreamEvent, markdownStreamPath, useMarkdownStreams, writeMarkdownChunk } from "../src/react-app/domains/session/artifacts/markdown-stream";
const item = () => Object.values(useMarkdownStreams.getState().items)[0];
const input = { workspaceId: "project-a", sessionId: "task-a", path: "Draft.md", content: "# Review\n", append: false, complete: false, exists: async () => false, save: async (_content: string) => {} };
afterEach(() => { useMarkdownStreams.setState({ items: {} }); });

test("document chunks appear before saving and only completion commits the exact content", async () => {
  const saved: string[] = [];
  const draft = { ...input, save: async (content: string) => { saved.push(content); } };
  await writeMarkdownChunk(draft);
  expect(item()).toMatchObject({ content: "# Review\n", status: "writing" });
  expect(saved).toEqual([]);
  await writeMarkdownChunk({ ...draft, append: true, content: "\nFirst section.\n" });
  expect(item().content).toBe("# Review\n\nFirst section.\n");
  expect(saved).toEqual([]);
  await writeMarkdownChunk({ ...draft, append: true, complete: true, content: "\nLast section.\n" });
  expect(saved).toEqual(["# Review\n\nFirst section.\n\nLast section.\n"]);
  expect(item().status).toBe("complete");
});

test("projects stay isolated; cancellation retains an unsaved preview and rejects later appends", async () => {
  await writeMarkdownChunk(input);
  await writeMarkdownChunk({ ...input, workspaceId: "project-b", sessionId: "task-b", content: "B" });
  applyMarkdownStreamEvent("project-a", { type: "session.idle", data: { sessionID: "task-a" } });
  expect(item().status).toBe("failed");
  expect(Object.values(useMarkdownStreams.getState().items)[1].status).toBe("writing");
  await expect(writeMarkdownChunk({ ...input, append: true, complete: true })).rejects.toThrow("No active draft");
});

test("a failed final save never claims completion or retries a partial file automatically", async () => {
  await writeMarkdownChunk(input);
  await expect(writeMarkdownChunk({ ...input, append: true, complete: true, save: async () => { throw new Error("Conflict"); } })).rejects.toThrow("Conflict");
  expect(item().status).toBe("failed");
});

test("existing files, competing drafts, and paths outside the project are refused", async () => {
  for (const path of ["../Draft.md", "/Draft.md", "a/../Draft.md", "a\\Draft.md", "Draft.docx", ""]) expect(markdownStreamPath(path)).toBeNull();
  expect(markdownStreamPath("Notes/Review.md")).toBe("Notes/Review.md");
  await expect(writeMarkdownChunk({ ...input, exists: async () => true })).rejects.toThrow("already exists");
  expect(item()).toBeUndefined();
  await writeMarkdownChunk(input);
  await expect(writeMarkdownChunk({ ...input, sessionId: "other-task" })).rejects.toThrow("active draft");
  expect(Object.values(useMarkdownStreams.getState().items)).toHaveLength(1);
});
