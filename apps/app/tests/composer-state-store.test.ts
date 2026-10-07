import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft, ComposerAttachment } from "../src/app/types";
import {
  carryAssistantDraft,
  getComposerQueuedDrafts,
  isComposerQueuePaused,
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
