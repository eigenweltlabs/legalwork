import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft, ComposerAttachment } from "../src/app/types";
import { createProjectAttachmentMention } from "../src/react-app/domains/session/surface/composer/workspace-attachment";
import { encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";
import {
  carryAssistantDraft,
  getComposerQueuedDrafts,
  isComposerQueuePaused,
  QueuedEditRecoveredError,
  submitComposerDraft,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";

function reset() {
  useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, pausedQueues: {}, stashedDrafts: {}, history: {} });
}

function draft(text: string): ComposerDraft {
  return {
    mode: "prompt",
    parts: [{ type: "text", text }],
    attachments: [],
    text,
    resolvedText: text,
    command: undefined,
  };
}

function editorFixture() {
  const store = useComposerStateStore.getState();
  const file = new File(["original document bytes"], "Agreement.pdf", { type: "application/pdf" });
  const reference = createProjectAttachmentMention({ projectId: "project", workspaceId: "project", connectionId: "drive", path: "~lw~c291cmNl~Cloud.pdf", name: "Cloud.pdf" }, "Project");
  store.setDraft("a", `Review @${encodeComposerMentionValue(reference)} [pasted text Notes]`);
  store.setAttachments("a", [{ id: "document", name: file.name, kind: "file", mimeType: file.type, size: file.size, file }]);
  store.setMentions("a", { [reference]: "upload" });
  store.setPasteParts("a", [{ id: "notes", label: "Notes", text: "Original pasted notes", lines: 1 }]);
  return useComposerStateStore.getState().sessions.a;
}

test("sending clears the composer before preparation and leaves new typing intact on success", async () => {
  reset();
  const editor = editorFixture();
  const preparing = Promise.withResolvers<void>();
  let notifications = 0;
  const send = submitComposerDraft("a", editor, async () => {
    expect(useComposerStateStore.getState().sessions.a).toBeUndefined();
    await preparing.promise;
    expect(await editor.attachments[0].file.text()).toBe("original document bytes");
  }, () => { notifications++; });
  expect(useComposerStateStore.getState().sessions.a).toBeUndefined();
  useComposerStateStore.getState().setDraft("a", "My next question");
  const next = useComposerStateStore.getState().sessions.a;
  preparing.resolve();
  await send;
  expect(useComposerStateStore.getState().sessions.a).toBe(next);
  expect(notifications).toBe(1);
});

test("failed document preparation restores the entire editor and original file bytes", async () => {
  reset();
  const editor = editorFixture();
  await expect(submitComposerDraft("a", editor, async () => {
    expect(useComposerStateStore.getState().sessions.a).toBeUndefined();
    throw new Error("Cloud download failed");
  }, () => {})).rejects.toThrow("Cloud download failed");
  expect(useComposerStateStore.getState().sessions.a).toEqual(editor);
  expect(await useComposerStateStore.getState().sessions.a.attachments[0].file.text()).toBe("original document bytes");
  expect(useComposerStateStore.getState().stashedDrafts.a).toEqual([]);
});

test("a failed submission restores the sent message, preserves new input separately, and can be retried", async () => {
  reset();
  const editor = editorFixture();
  const admitted = Promise.withResolvers<void>();
  const send = submitComposerDraft("a", editor, () => admitted.promise, () => {});
  useComposerStateStore.getState().setDraft("a", "New input while sending");
  useComposerStateStore.getState().setPasteParts("a", [{ id: "new", label: "New", text: "New notes", lines: 1 }]);
  const next = useComposerStateStore.getState().sessions.a;
  admitted.reject(new Error("Submission failed"));
  await expect(send).rejects.toThrow("Submission failed");
  expect(useComposerStateStore.getState().sessions.a).toEqual(editor);
  expect(useComposerStateStore.getState().stashedDrafts.a).toEqual([next]);
  // Repeated failures must not duplicate or lose the next draft.
  await expect(submitComposerDraft("a", editor, async () => { throw new Error("Still offline"); }, () => {})).rejects.toThrow("Still offline");
  expect(useComposerStateStore.getState().stashedDrafts.a).toEqual([next]);
  await submitComposerDraft("a", editor, async () => {}, () => {});
  expect(useComposerStateStore.getState().sessions.a).toBe(next);
  expect(useComposerStateStore.getState().stashedDrafts.a).toEqual([]);
});

test("a late send failure restores only its original session", async () => {
  reset();
  const editor = editorFixture();
  const admitted = Promise.withResolvers<void>();
  const send = submitComposerDraft("a", editor, () => admitted.promise, () => {});
  useComposerStateStore.getState().setDraft("b", "Another chat's input");
  admitted.reject(new Error("Failed after navigating away"));
  await expect(send).rejects.toThrow("Failed after navigating away");
  expect(useComposerStateStore.getState().sessions.a).toEqual(editor);
  expect(useComposerStateStore.getState().sessions.b.draft).toBe("Another chat's input");
});

test("failed queued edits retain their lease unless admission reports that it expired", async () => {
  for (const recovered of [false, true]) {
    reset();
    const editor = { ...editorFixture(), queuedDraftId: "reserved-slot" };
    useComposerStateStore.setState(state => ({ sessions: { ...state.sessions, a: editor } }));
    const error = recovered ? new QueuedEditRecoveredError("Lease expired") : new Error("Offline");
    await expect(submitComposerDraft("a", editor, async () => { throw error; }, () => {})).rejects.toThrow(error.message);
    expect(useComposerStateStore.getState().sessions.a.queuedDraftId).toBe(recovered ? undefined : "reserved-slot");
    expect(useComposerStateStore.getState().sessions.a.attachments).toEqual(editor.attachments);
  }
});

test("reopening a queued edit retains text, attachments and the stashed composer as an independent draft", () => {
  reset();
  const store = useComposerStateStore.getState();
  const file = new File(["original bytes"], "source.txt");
  const attachment: ComposerAttachment = { id: "source", name: file.name, kind: "file", mimeType: file.type, size: file.size, file };
  store.appendQueuedDraft("a", { ...draft("queued original"), attachments: [attachment] });
  store.setDraft("a", "previous unsent composer");
  const id = useComposerStateStore.getState().queuedDrafts.a[0].id;
  store.editQueuedDraft("a", id);
  store.setDraft("a", "edited after acquiring lease");
  store.setMentions("a", { "source.txt": "file" });
  store.setPasteParts("a", [{ id: "paste", label: "1", text: "retained paste", lines: 1 }]);
  expect(store.recoverQueuedEdit("a")).toBe(true);
  expect(store.recoverQueuedEdit("a")).toBe(false);
  const recovered = useComposerStateStore.getState().sessions.a;
  expect(recovered.queuedDraftId).toBeUndefined();
  expect(recovered.draft).toBe("edited after acquiring lease");
  expect(recovered.attachments).toEqual([attachment]);
  expect(recovered.mentions).toEqual({ "source.txt": "file" });
  expect(recovered.pasteParts[0].text).toBe("retained paste");
  expect(useComposerStateStore.getState().queuedDrafts.a[0].text).toBe("queued original");
  store.clearSession("a");
  expect(useComposerStateStore.getState().sessions.a.draft).toBe("previous unsent composer");
});

describe("composer state store", () => {
  beforeEach(reset);

  test("midnight carries unsent assistant input once without copying prior chat history", () => {
    const store = useComposerStateStore.getState();
    store.setDraft("yesterday", "Review this tomorrow");
    store.setPasteParts("yesterday", [{ id: "paste", label: "Notes", text: "Private notes", lines: 1 }]);
    store.appendHistory("yesterday", "Earlier sent message");
    const editor = useComposerStateStore.getState().sessions.yesterday;
    carryAssistantDraft("yesterday", "today");
    carryAssistantDraft("yesterday", "today");
    expect(useComposerStateStore.getState().sessions.today).toEqual(editor);
    expect(useComposerStateStore.getState().sessions.yesterday).toBeUndefined();
    expect(useComposerStateStore.getState().history.today).toBeUndefined();
  });

  test("midnight preserves an existing target draft and never detaches a queued edit", () => {
    const store = useComposerStateStore.getState();
    store.setDraft("yesterday", "Older unsent input");
    store.setDraft("today", "Current input");
    carryAssistantDraft("yesterday", "today");
    expect(useComposerStateStore.getState().sessions.today.draft).toBe("Current input");
    expect(useComposerStateStore.getState().sessions.yesterday.draft).toBe("Older unsent input");
    store.appendQueuedDraft("yesterday", draft("Queued task"));
    store.editQueuedDraft("yesterday", getComposerQueuedDrafts(useComposerStateStore.getState(), "yesterday")[0].id);
    carryAssistantDraft("yesterday", "tomorrow");
    expect(useComposerStateStore.getState().sessions.tomorrow).toBeUndefined();
    expect(useComposerStateStore.getState().sessions.yesterday.queuedDraftId).toBeDefined();
  });

  test("scopes queued drafts by session", () => {
    const { appendQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("queued in A"));
    appendQueuedDraft("session-b", draft("queued in B"));

    const state = useComposerStateStore.getState();
    expect(getComposerQueuedDrafts(state, "session-a").map((item) => item.text)).toEqual(["queued in A"]);
    expect(getComposerQueuedDrafts(state, "session-b").map((item) => item.text)).toEqual(["queued in B"]);
  });

  test("clearing composer input does not clear queued drafts", () => {
    const { appendQueuedDraft, clearSession, setDraft } = useComposerStateStore.getState();
    setDraft("session-a", "in-progress draft");
    appendQueuedDraft("session-a", draft("queued follow-up"));

    clearSession("session-a");

    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.text)).toEqual([
      "queued follow-up",
    ]);
  });

  test("remove and clear only affect the target session", () => {
    const { appendQueuedDraft, clearQueuedDrafts, removeQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("first A"));
    appendQueuedDraft("session-a", draft("second A"));
    appendQueuedDraft("session-b", draft("only B"));

    removeQueuedDraft("session-a", getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[0]!.id);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.text)).toEqual([
      "second A",
    ]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.text)).toEqual([
      "only B",
    ]);

    clearQueuedDrafts("session-a");
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")).toEqual([]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.text)).toEqual([
      "only B",
    ]);
  });
});

test("editing restores mentions, pasted text and attachments, preserving an existing draft", () => {
  reset();
  const store = useComposerStateStore.getState();
  const file = new File(["contract"], "contract.txt", { type: "text/plain" });
  const attachment: ComposerAttachment = { id: "file", name: file.name, kind: "file", mimeType: file.type, size: file.size, file };
  const paste = { id: "paste", label: "1", text: "Full source text", lines: 1 };
  store.setMentions("a", { "contract.txt": "file" });
  store.setPasteParts("a", [paste]);
  store.appendQueuedDraft("a", { ...draft("@contract.txt [pasted text 1]"), attachments: [attachment] });
  const queued = getComposerQueuedDrafts(useComposerStateStore.getState(), "a")[0]!;
  store.clearSession("a");
  store.setDraft("a", "Still typing");
  store.editQueuedDraft("a", queued.id);
  const next = useComposerStateStore.getState();
  expect(next.sessions.a?.draft).toBe("@contract.txt [pasted text 1]");
  expect(next.sessions.a?.mentions).toEqual({ "contract.txt": "file" });
  expect(next.sessions.a?.pasteParts).toEqual([paste]);
  expect(next.sessions.a?.attachments[0]?.file).toBe(file);
  expect(getComposerQueuedDrafts(next, "a")).toEqual([queued]);
  expect(next.sessions.a?.queuedDraftId).toBe(queued.id);
  expect(isComposerQueuePaused(next, "a")).toBe(true);
  store.clearSession("a");
  expect(useComposerStateStore.getState().sessions.a?.draft).toBe("Still typing");
  expect(isComposerQueuePaused(useComposerStateStore.getState(), "a")).toBe(false);
});

test("editing reserves the original slot and saving updates it in place", () => {
  reset();
  const store = useComposerStateStore.getState();
  store.appendQueuedDraft("a", draft("first"));
  store.appendQueuedDraft("a", draft("second"));
  store.appendQueuedDraft("a", draft("third"));
  const first = getComposerQueuedDrafts(useComposerStateStore.getState(), "a")[0]!;
  store.editQueuedDraft("a", first.id);
  expect(useComposerStateStore.getState().sessions.a?.draft).toBe("first");
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "a").map((item) => item.text)).toEqual(["first", "second", "third"]);
  store.setDraft("a", "edited first");
  store.appendQueuedDraft("a", draft("edited first"));
  store.clearSession("a");
  const result = getComposerQueuedDrafts(useComposerStateStore.getState(), "a");
  expect(result.map((item) => item.text)).toEqual(["edited first", "second", "third"]);
  expect(result[0]?.id).toBe(first.id);
  expect(result[0]?.editor.queuedDraftId).toBeUndefined();
  expect(isComposerQueuePaused(useComposerStateStore.getState(), "a")).toBe(false);
});

test("earlier messages can drain, but cannot skip the reserved edit slot", () => {
  reset();
  const store = useComposerStateStore.getState();
  ["first", "second", "third"].forEach((text) => store.appendQueuedDraft("a", draft(text)));
  const [first, second] = getComposerQueuedDrafts(useComposerStateStore.getState(), "a");
  store.editQueuedDraft("a", second!.id);
  expect(isComposerQueuePaused(useComposerStateStore.getState(), "a")).toBe(false);
  store.removeQueuedDraft("a", first!.id);
  expect(isComposerQueuePaused(useComposerStateStore.getState(), "a")).toBe(true);
  store.appendQueuedDraft("a", draft("edited second"));
  store.clearSession("a");
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "a").map((item) => item.text)).toEqual(["edited second", "third"]);
});

test("reordering keeps edits in their moved slot and leaves other sessions alone", () => {
  reset();
  const store = useComposerStateStore.getState();
  ["first", "second", "third"].forEach((text) => store.appendQueuedDraft("a", draft(text)));
  store.appendQueuedDraft("b", draft("other session"));
  const [first, second, third] = getComposerQueuedDrafts(useComposerStateStore.getState(), "a");
  store.editQueuedDraft("a", second!.id);
  store.reorderQueuedDrafts("a", [third!.id, second!.id, first!.id]);
  store.appendQueuedDraft("a", draft("edited second"));
  store.clearSession("a");
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "a").map((item) => item.text)).toEqual(["third", "edited second", "first"]);
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "b").map((item) => item.text)).toEqual(["other session"]);
});

test("stale reorder events cannot revive removed messages or lose newly queued ones", () => {
  reset();
  const store = useComposerStateStore.getState();
  ["first", "second"].forEach((text) => store.appendQueuedDraft("a", draft(text)));
  const [first, second] = getComposerQueuedDrafts(useComposerStateStore.getState(), "a");
  store.removeQueuedDraft("a", first!.id);
  store.appendQueuedDraft("a", draft("new"));
  store.reorderQueuedDrafts("a", [second!.id, first!.id, second!.id]);
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "a").map((item) => item.text)).toEqual(["second", "new"]);
});

test("deleting an edited message restores the unsent draft and releases the queue", () => {
  reset();
  const store = useComposerStateStore.getState();
  store.appendQueuedDraft("a", draft("first"));
  store.appendQueuedDraft("a", draft("second"));
  store.setDraft("a", "unsent draft");
  const first = getComposerQueuedDrafts(useComposerStateStore.getState(), "a")[0]!;
  store.editQueuedDraft("a", first.id);
  store.removeQueuedDraft("a", first.id);
  expect(useComposerStateStore.getState().sessions.a?.draft).toBe("unsent draft");
  expect(useComposerStateStore.getState().sessions.a?.queuedDraftId).toBeUndefined();
  expect(isComposerQueuePaused(useComposerStateStore.getState(), "a")).toBe(false);
  store.appendQueuedDraft("a", draft("unsent draft"));
  expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "a").map((item) => item.text)).toEqual(["second", "unsent draft"]);
});
