import { describe, expect, test } from "bun:test";
import { isSessionListed, registerEmptySession, retainSessionInLists } from "../src/react-app/domains/session/sidebar/session-list-visibility";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { saveSessionDraft } from "../src/react-app/domains/session/sync/draft-store";

const fresh = () => { const id = crypto.randomUUID(); registerEmptySession(id); return id; };
describe("new chat list visibility", () => {
  test("unknown historical chats stay visible; several blank tabs stay hidden independently", () => {
    expect(isSessionListed(crypto.randomUUID())).toBe(true);
    const one = fresh(), two = fresh();
    useComposerStateStore.getState().setDraft(one, "  \n ");
    expect(isSessionListed(one)).toBe(false);
    expect(isSessionListed(two)).toBe(false);
    useComposerStateStore.getState().setDraft(two, "Prepare a review");
    expect(isSessionListed(two)).toBe(true);
    expect(isSessionListed(one)).toBe(false);
    expect(useComposerStateStore.getState().sessions[two]?.draft).toBe("Prepare a review");
  });
  test("clearing the composer after sending cannot hide a used chat or another window's draft", () => {
    const id = fresh();
    useComposerStateStore.getState().setDraft(id, "Draft");
    useComposerStateStore.getState().clearSession(id);
    registerEmptySession(id);
    expect(isSessionListed(id)).toBe(true);
  });
  test("retention that beats a create response wins", () => {
    const id = crypto.randomUUID();
    retainSessionInLists(id);
    registerEmptySession(id);
    expect(isSessionListed(id)).toBe(true);
  });
  test("an attachment-only draft is meaningful", () => {
    const id = fresh();
    useComposerStateStore.getState().setAttachments(id, [{ id: "file", name: "sample.txt", mimeType: "text/plain", size: 4, file: new File(["test"], "sample.txt") }]);
    expect(isSessionListed(id)).toBe(true);
  });
  test("restored prompt and queued message count, without changing another composer", () => {
    const restored = fresh(), queued = fresh(), untouched = fresh();
    saveSessionDraft("project", restored, { text: "Restore me", mode: "prompt" });
    useComposerStateStore.getState().appendQueuedDraft(queued, { text: "Review later", attachments: [], mode: "prompt" });
    expect(isSessionListed(restored)).toBe(true);
    expect(isSessionListed(queued)).toBe(true);
    expect(isSessionListed(untouched)).toBe(false);
  });
  test("activity from another window promotes the chat", () => {
    const id = fresh();
    useSessionActivityStore.getState().markMessageRole("project", id, "message", "user");
    expect(isSessionListed(id)).toBe(true);
  });
});

test("a failed storage write cannot hide a draft in this window", () => {
  const id = crypto.randomUUID();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stored = new Map<string, string>();
  let quotaFull = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { if (quotaFull) throw new Error("Quota exceeded"); stored.set(key, value); },
  } } });
  try {
    registerEmptySession(id);
    expect(isSessionListed(id)).toBe(false);
    quotaFull = true;
    useComposerStateStore.getState().setDraft(id, "Keep this draft visible");
    expect(isSessionListed(id)).toBe(true);
    registerEmptySession(id);
    expect(isSessionListed(id)).toBe(true);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
