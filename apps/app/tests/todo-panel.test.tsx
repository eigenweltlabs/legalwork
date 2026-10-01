import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import type { TodoItem } from "../src/app/types";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { hasUnfinishedTodos, TodoPanel } from "../src/react-app/domains/session/surface/todo-panel";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  seedSessionState,
  seedTodoState,
  snapshotKey,
  todoKey,
  trackWorkspaceSessionSync,
} from "../src/react-app/domains/session/sync/session-sync";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";

const todos: TodoItem[] = [
  { id: "screen", content: "Identify agreements", status: "completed", priority: "high" },
  { id: "review", content: "Review agreements", status: "in_progress", priority: "high" },
  { id: "report", content: "Write report", status: "pending", priority: "high" },
];
const snapshot: LegalworkSessionSnapshot = {
  session: { id: "plan-chat", title: "Diligence", time: { created: 1, updated: 2 }, version: "0" },
  messages: [], todos: [], status: { type: "idle" },
};

afterEach(() => getReactQueryClient().clear());

test("unfinished plans remain collapsible; completed and cancelled plans leave the composer", () => {
  const html = renderToStaticMarkup(<TodoPanel todos={todos} />);
  expect(html).toContain("Progress · 1/3");
  expect(html).toContain('aria-expanded="false"');
  expect(hasUnfinishedTodos(todos)).toBe(true);
  const done = todos.map(todo => ({ ...todo, status: "completed" }));
  expect(renderToStaticMarkup(<TodoPanel todos={done} />)).toBe("");
  done[1].status = "cancelled";
  expect(hasUnfinishedTodos(done)).toBe(false);
  expect(hasUnfinishedTodos([{ ...todos[1], content: " " }])).toBe(false);
});

test("a plan observed through the external cache subscription survives query garbage collection", async () => {
  const cache = getReactQueryClient();
  const key = todoKey("plan-project", "long-running-chat");
  cache.setQueryData(key, todos);
  const query = cache.getQueryCache().find({ queryKey: key });
  expect(query?.getObserversCount()).toBe(0);
  expect(query?.gcTime).toBe(Infinity);
  // Wait beyond the old 15-second GC deadline with no query observers.
  await Bun.sleep(15_050);
  expect(cache.getQueryData(key)).toEqual(todos);
  const done = todos.map(todo => ({ ...todo, status: "completed" }));
  seedTodoState("plan-project", "long-running-chat", done, Date.now() + 1);
  expect(hasUnfinishedTodos(cache.getQueryData<TodoItem[]>(key) ?? [])).toBe(false);
}, 20_000);

test("a hot update cancels the old plan GC timer while preserving the shared client", async () => {
  const previous = getReactQueryClient();
  const existing = new QueryClient({ defaultOptions: { queries: { gcTime: 30 } } });
  const target = globalThis as typeof globalThis & { __owReactQueryClient?: QueryClient };
  const key = todoKey("plan-project", "existing-plan");
  existing.setQueryData(key, todos);
  target.__owReactQueryClient = existing;
  try {
    expect(getReactQueryClient()).toBe(existing);
    await Bun.sleep(60);
    expect(existing.getQueryData(key)).toEqual(todos);
  } finally { existing.clear(); target.__owReactQueryClient = previous; }
});

test("session metadata and idle transitions cannot replace a live plan with an old empty snapshot", () => {
  const input = { workspaceId: "plan-project", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, snapshot.session.id);
  const cache = getReactQueryClient();
  cache.setQueryData(snapshotKey(input.workspaceId, snapshot.session.id), snapshot);
  seedSessionState(input.workspaceId, snapshot);
  try {
    __applySessionSyncEventForTest(input, { type: "todo.updated", properties: { sessionID: snapshot.session.id, todos } });
    __applySessionSyncEventForTest(input, { type: "session.updated", properties: { info: { id: snapshot.session.id, title: "Updated diligence" } } });
    const replayed = cache.getQueryData<LegalworkSessionSnapshot>(snapshotKey(input.workspaceId, snapshot.session.id));
    if (!replayed) throw new Error("Missing cached session");
    seedSessionState(input.workspaceId, replayed);
    __applySessionSyncEventForTest(input, { type: "session.idle", properties: { sessionID: snapshot.session.id } });
    expect(cache.getQueryData(todoKey(input.workspaceId, snapshot.session.id))).toEqual(todos);
    expect(cache.getQueryData(todoKey("another-project", snapshot.session.id))).toBeUndefined();
  } finally { release(); cleanup(); }
});

test("an in-flight snapshot cannot erase a newer plan; a subsequent fresh read can complete it", () => {
  const cache = getReactQueryClient();
  const key = todoKey("plan-project", snapshot.session.id);
  cache.setQueryData(key, todos, { updatedAt: 200 });
  seedTodoState("plan-project", snapshot.session.id, [], 100);
  expect(cache.getQueryData(key)).toEqual(todos);
  const done = todos.map(todo => ({ ...todo, status: "completed" }));
  seedTodoState("plan-project", snapshot.session.id, done, 300);
  expect(cache.getQueryData(key)).toEqual(done);
  seedSessionState("plan-project", snapshot);
  expect(cache.getQueryData(key)).toEqual(done);
  seedTodoState("plan-project", "another-chat", todos, 100);
  expect(cache.getQueryData(todoKey("plan-project", "another-chat"))).toEqual(todos);
});
