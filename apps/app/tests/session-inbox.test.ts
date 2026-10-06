import { beforeEach, expect, test } from "bun:test";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
const { useSessionInboxStore: inbox, unreadSession } = await import("../src/react-app/domains/session/sidebar/session-inbox-store");
const { useSessionManagementStore: pins } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { inboxNeedsRefresh } = await import("../src/react-app/shell/use-session-inbox");
const entry = (assistantAt = 10): SessionInboxEntry => ({ workspaceId: "project", sessionId: "chat", updatedAt: assistantAt, assistantAt });
beforeEach(() => {
  inbox.setState({ entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null });
  pins.setState({ pinnedIds: [] });
  storage.clear();
});

test("only assistant activity is unread; opening clears it until the next unseen reply", () => {
  inbox.getState().receive([entry(0)]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  expect(inbox.getState().receive([entry()])).toEqual(["project"]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
  inbox.getState().open("chat");
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  inbox.getState().receive([entry(20)]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  inbox.getState().open(null);
  inbox.getState().receive([entry(30)]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
  expect(inbox.getState().receive([entry(30)])).toEqual([]);
});

test("opening one chat does not clear another chat in the same project", () => {
  inbox.getState().receive([entry(), { ...entry(), sessionId: "other" }]);
  inbox.getState().open("chat");
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  expect(unreadSession(inbox.getState(), "other")).toBe(true);
});

test("automation pins the destination once per run and respects manual unpin until the next run", () => {
  const automated = { ...entry(), automation: { runId: "run1", at: 10, pinRunId: "run1" } };
  inbox.getState().receive([automated]);
  expect(pins.getState().pinnedIds).toEqual(["chat"]);
  pins.getState().togglePin("chat");
  inbox.getState().receive([automated]);
  expect(pins.getState().pinnedIds).toEqual([]);
  inbox.getState().receive([{ ...automated, automation: { runId: "disabled-run", at: 20, pinRunId: "run1" } }]);
  expect(pins.getState().pinnedIds).toEqual([]);
  expect(inbox.getState().entries.chat.automation?.runId).toBe("disabled-run");
  inbox.getState().receive([{ ...automated, automation: { runId: "run3", at: 30, pinRunId: "run3" } }]);
  expect(pins.getState().pinnedIds).toEqual(["chat"]);
});

test("newest run goes to the top regardless of API order; disabled pin still keeps the clock metadata", () => {
  inbox.getState().receive([
    { ...entry(), sessionId: "latest", automation: { runId: "r3", at: 30, pinRunId: "r3" } },
    { ...entry(), sessionId: "older", automation: { runId: "r1", at: 10, pinRunId: "r1" } },
    { ...entry(), sessionId: "disabled", automation: { runId: "r2", at: 20, pinRunId: null } },
  ]);
  expect(pins.getState().pinnedIds).toEqual(["latest", "older"]);
  expect(inbox.getState().entries.disabled.automation).toBeDefined();
});

test("read and processed pin markers survive a reload without keeping a chat open", async () => {
  const automated = { ...entry(), automation: { runId: "run1", at: 10, pinRunId: "run1" } };
  inbox.getState().receive([automated]); inbox.getState().open("chat");
  pins.getState().togglePin("chat");
  const saved = storage.get("legalwork.react.sessionInbox")!;
  expect(JSON.parse(saved).state.openSessionId).toBeUndefined();
  inbox.setState({ entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null });
  storage.set("legalwork.react.sessionInbox", saved);
  await inbox.persist.rehydrate();
  inbox.getState().receive([automated]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  expect(pins.getState().pinnedIds).toEqual([]);
  inbox.getState().receive([{ ...automated, assistantAt: 20 }]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
});

test("missing new chats keep requesting sidebar reconciliation after a skipped or failed fetch", () => {
  const listed = [{ id: "older", time: { updated: 5 } }];
  expect(inboxNeedsRefresh([entry()], listed)).toBe(true);
  // Receiving metadata does not acknowledge a list refresh that never completed.
  inbox.getState().receive([entry()]);
  expect(inboxNeedsRefresh([entry()], listed)).toBe(true);
  expect(inboxNeedsRefresh([entry()], [...listed, { id: "chat", time: { updated: 10 } }])).toBe(false);
  const page = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, time: { updated: 100 + i } }));
  expect(inboxNeedsRefresh([entry()], page)).toBe(false);
  expect(inboxNeedsRefresh([entry(500)], page)).toBe(true);
});
