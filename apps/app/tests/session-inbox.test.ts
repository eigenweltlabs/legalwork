import { beforeEach, expect, test } from "bun:test";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
const { useSessionInboxStore: inbox, unreadSession, unreadWorkspace } = await import("../src/react-app/domains/session/sidebar/session-inbox-store");
const { useSessionManagementStore: pins } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { inboxNeedsRefresh, reconcileInboxActivity } = await import("../src/react-app/shell/use-session-inbox");
const entry = (assistantAt = 10): SessionInboxEntry => ({ workspaceId: "project", sessionId: "chat", updatedAt: assistantAt, assistantAt });
beforeEach(() => {
  inbox.setState({ entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null, openWorkspaceId: null, trackingStartedAt: 0 });
  pins.setState({ pinnedIds: [] });
  storage.clear();
});

test("enabling unread tracking starts existing chats read, including history loaded later", () => {
  inbox.setState({ trackingStartedAt: null });
  inbox.getState().receive([entry(10)], 100);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  inbox.getState().receive([{ ...entry(90), sessionId: "loaded-later" }], 110);
  expect(unreadSession(inbox.getState(), "loaded-later")).toBe(false);
  inbox.getState().receive([entry(101), { ...entry(105), sessionId: "new-chat" }], 120);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
  expect(unreadSession(inbox.getState(), "new-chat")).toBe(true);
  expect(inbox.getState().trackingStartedAt).toBe(100);
});

test("an empty first sync persists the cutoff and replies received while closed stay unread", async () => {
  inbox.setState({ trackingStartedAt: null });
  inbox.getState().receive([], 100);
  const saved = storage.get("legalwork.react.sessionInbox")!;
  expect(JSON.parse(saved).state.trackingStartedAt).toBe(100);
  inbox.setState({ trackingStartedAt: null });
  storage.set("legalwork.react.sessionInbox", saved);
  await inbox.persist.rehydrate();
  inbox.getState().receive([entry(110)], 200);
  expect(inbox.getState().trackingStartedAt).toBe(100);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
});

test("upgrading the first release clears historical dots without replaying pins", async () => {
  const historical = { ...entry(10), automation: { runId: "run1", at: 5, pinRunId: "run1" } };
  const legacy = { entries: { chat: historical }, readAt: { chat: 3 }, pinnedRunIds: { chat: "run1" } };
  inbox.setState({ trackingStartedAt: null });
  storage.set("legalwork.react.sessionInbox", JSON.stringify({ state: legacy, version: 0 }));
  await inbox.persist.rehydrate();
  // No flash of unread dots from the cached data before the server responds.
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  inbox.getState().receive([historical], 100);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  expect(inbox.getState().readAt.chat).toBe(3);
  expect(pins.getState().pinnedIds).toEqual([]);
  expect(JSON.parse(storage.get("legalwork.react.sessionInbox")!).state.trackingStartedAt).toBe(100);
  inbox.getState().receive([{ ...historical, assistantAt: 101 }], 120);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
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

test("Assistant aggregates returned replies and scheduled deliveries across midnight and acknowledges them as one surface", async () => {
  const yesterday = { ...entry(10), workspaceId: "assistant", sessionId: "yesterday" };
  const today = { ...entry(0), workspaceId: "assistant", sessionId: "today", automation: { runId: "briefing", at: 20, pinRunId: null } };
  inbox.getState().receive([yesterday, today, entry(25)]);
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(true);
  expect(unreadSession(inbox.getState(), "today")).toBe(true);
  expect(pins.getState().pinnedIds).toEqual([]);
  inbox.getState().open("today", "assistant");
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(false);
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
  inbox.getState().receive([{ ...today, assistantAt: 30 }]);
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(false);
  inbox.getState().open(null);
  inbox.getState().receive([{ ...today, assistantAt: 40 }]);
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(true);
  const saved = storage.get("legalwork.react.sessionInbox")!;
  expect(JSON.parse(saved).state.openWorkspaceId).toBeUndefined();
  inbox.setState({ entries: {}, readAt: {} });
  storage.set("legalwork.react.sessionInbox", saved);
  await inbox.persist.rehydrate();
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(true);
  inbox.getState().open("today", "assistant");
  inbox.getState().open(null);
  inbox.getState().receive([{ ...today, assistantAt: 40, automation: { runId: "later", at: 50, pinRunId: null } }]);
  expect(unreadWorkspace(inbox.getState(), "assistant")).toBe(true);
});


test("project runs show activity before opening; only an idle terminal reply becomes unread", async () => {
  const { useSessionActivityStore: activity } = await import("../src/react-app/domains/session/status/session-activity-store");
  const running: SessionInboxEntry = { ...entry(0), status: "busy", automation: { runId: "run", at: 15, pinRunId: null } };
  inbox.getState().receive([running]);
  reconcileInboxActivity([running]);
  expect(activity.getState().getStatus("project", "chat")).toBe("thinking");
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  // A completed text/step must stay pending while more work runs.
  inbox.getState().receive([{ ...running, assistantAt: 20 }]);
  expect(unreadWorkspace(inbox.getState(), "project")).toBe(false);
  reconcileInboxActivity([{ ...running, status: "unknown" }]);
  expect(activity.getState().getStatus("project", "chat")).toBe("thinking");
  const finished: SessionInboxEntry = { ...entry(30), status: "idle" };
  inbox.getState().receive([finished]);
  reconcileInboxActivity([finished]);
  expect(activity.getState().getStatus("project", "chat")).toBe("idle");
  expect(unreadSession(inbox.getState(), "chat")).toBe(true);
  inbox.getState().open("chat");
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
});

test("an interrupted status read and tool-only scheduled delivery never count as a finished reply", () => {
  inbox.getState().receive([{ ...entry(50), status: "unknown" }]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
  inbox.setState({ entries: {} });
  inbox.getState().receive([{ ...entry(0), status: "idle", automation: { runId: "run", at: 80, pinRunId: null } }]);
  expect(unreadSession(inbox.getState(), "chat")).toBe(false);
});
