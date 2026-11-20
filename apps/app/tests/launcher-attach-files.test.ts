import { expect, test } from "bun:test";
import type { AssistantContextItem } from "@legalwork/types/launcher";
import { attachFilesToDraft } from "../src/react-app/launcher/attach-files";
import { DraftCoordinator, EMPTY_DRAFT_FILE } from "../src/react-app/launcher/draft-coordinator";

function setup() {
  let file = structuredClone(EMPTY_DRAFT_FILE);
  const storage = { read: async () => structuredClone(file), write: async (next: typeof file, version: number) => { if (version !== file.version) return false; file = structuredClone(next); return true; } };
  return { panel: new DraftCoordinator(storage), home: new DraftCoordinator(storage) };
}
const item = (file: File): AssistantContextItem => ({ type: "file", id: file.name, name: file.name, path: file.name, workspaceId: "assistant", revision: null, sourceLabel: null });

test("a failed file does not discard other uploads; attachments stay in their original conversation", async () => {
  const { panel } = setup(); await panel.claim("original", "panel"); await panel.claim("other", "panel");
  const outcome = await attachFilesToDraft({ files: [new File(["ok"], "one"), new File(["bad"], "bad"), new File(["ok"], "two")], drafts: panel, conversationId: "original", owner: "panel", stage: async file => { if (file.name === "bad") throw new Error("upload failed"); return item(file); } });
  expect(outcome.added).toBe(2); expect(outcome.failures).toEqual([{ name: "bad", error: "upload failed" }]);
  expect(panel.get("original").context.map(item => item.id)).toEqual(["one", "two"]);
  expect(panel.get("other").context).toEqual([]);
});
test("a handoff waits for the upload to become durable and the context limit is enforced", async () => {
  const { panel, home } = setup(); await panel.claim("one", "panel");
  const pending = Promise.withResolvers<void>(); const began = Promise.withResolvers<void>();
  const uploading = attachFilesToDraft({ files: [new File(["file"], "one")], drafts: panel, conversationId: "one", owner: "panel", stage: async file => { began.resolve(); await pending.promise; return item(file); } });
  await began.promise; const handoff = home.claim("one", "home"); pending.resolve(); await uploading; await handoff;
  expect(home.get("one").context[0]?.id).toBe("one");
  await home.update("one", "home", { context: Array.from({ length: 50 }, (_, id) => item(new File([], String(id)))) });
  const result = await attachFilesToDraft({ files: [new File([], "extra")], drafts: home, conversationId: "one", owner: "home", stage: async () => { throw new Error("must not upload"); } });
  expect(result.failures[0]?.error).toContain("50"); expect(home.get("one").context.length).toBe(50);
});
