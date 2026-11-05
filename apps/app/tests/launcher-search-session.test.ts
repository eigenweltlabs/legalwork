import { expect, test } from "bun:test";
import type { LauncherSearchResponse, LauncherSearchResult } from "@legalwork/types/launcher";
import { LauncherSearchSession } from "../src/react-app/launcher/launcher-search-session";

const item = (id: string, score: number): LauncherSearchResult => ({ id, kind: "files", workspaceId: "w", sourceId: "local:w", title: id, updatedAt: 0, match: "prefix", score, actions: ["open"] });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("choosing a category browses without words and removes rows from the previous query immediately", async () => {
  const calls: string[] = [];
  const session = new LauncherSearchSession(async input => {
    calls.push(`${input.kinds[0]}:${input.query}`);
    return { items: [item(input.query || "recent.txt", 1)], sources: [], unavailable: [] };
  }, { debounceMs: 0, contentPass: false });
  session.search({ query: "old", kinds: ["files"], projectId: null });
  await wait(10);
  session.search({ query: "", kinds: ["files"], projectId: null });
  expect(session.current().items).toEqual([]);
  await wait(10);
  expect(calls).toEqual(["files:old", "files:"]);
  expect(session.current().items[0]?.id).toBe("recent.txt");
  session.cancel();
});
test("stale queries are cancelled, the fast pass renders first, and the content pass appends without reordering", async () => {
  const calls: string[] = [];
  const session = new LauncherSearchSession(async (input, signal) => {
    calls.push(`${input.query}:${input.content ? "content" : "fast"}`);
    const response: LauncherSearchResponse = { items: input.content ? [item("b", 900), item("a", 500), item("c", 300)] : [item("a", 500), item("b", 400)], sources: [{ id: "files:w", kind: "files", workspaceId: "w", label: "W", coverage: input.content ? "complete" : "filename-only", count: 2 }], unavailable: [] };
    if (input.query === "slow") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return response;
  }, { debounceMs: 5 });
  const seen: string[] = [];
  session.subscribe(snapshot => seen.push(`${snapshot.query}|${snapshot.items.map(item => item.id).join(",")}|${snapshot.pending ? "pending" : "settled"}`));
  session.search({ query: "slow", kinds: ["files"], projectId: null });
  await wait(10);
  session.search({ query: "mietvertrag", kinds: ["files"], projectId: null });
  await wait(40);
  expect(calls).toEqual(["slow:fast", "mietvertrag:fast", "mietvertrag:content"]);
  expect(seen.at(-2)).toBe("mietvertrag|a,b|pending");
  expect(seen.at(-1)).toBe("mietvertrag|a,b,c|settled");
  expect(session.current().sources[0]?.coverage).toBe("complete");
  session.search({ query: "", kinds: ["files"], projectId: null });
  expect(session.current().items).toEqual([]);
});

test("a new query renders the server's order; only the content pass for the same words keeps rows in place", async () => {
  const responses: Record<string, LauncherSearchResult[]> = { a: [item("alpha.txt", 500), item("abc.txt", 400)], ab: [item("ab.txt", 1000), item("abc.txt", 800), item("alpha.txt", 100)] };
  const session = new LauncherSearchSession(async (input): Promise<LauncherSearchResponse> => ({ items: responses[input.query] ?? [], sources: [], unavailable: [] }), { debounceMs: 0, contentPass: false });
  const seen: string[][] = [];
  session.subscribe(snapshot => { if (!snapshot.pending) seen.push(snapshot.items.map(entry => entry.id)); });
  session.search({ query: "a", kinds: ["files"], projectId: null });
  await wait(20);
  session.search({ query: "ab", kinds: ["files"], projectId: null });
  await wait(20);
  expect(seen.at(-1)).toEqual(["ab.txt", "abc.txt", "alpha.txt"]);
});

test("slow chat and task providers do not delay local filename results", async () => {
  let finish = () => {};
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const session = new LauncherSearchSession(async input => {
    if (input.kinds[0] !== "files") await slow;
    return { items: input.kinds[0] === "files" ? [item("ready.txt", 100)] : [], sources: [], unavailable: [] };
  }, { debounceMs: 0, contentPass: false });
  session.search({ query: "ready", kinds: ["chats", "tasks", "files"], projectId: null });
  await wait(10);
  expect(session.current().items.map(entry => entry.id)).toEqual(["ready.txt"]);
  expect(session.current().pending).toBe(true);
  finish(); await wait(10);
  expect(session.current().pending).toBe(false);
});

test("new search folders refresh while indexing, then stop when complete or hidden", async () => {
  let calls = 0;
  const session = new LauncherSearchSession(async (): Promise<LauncherSearchResponse> => {
    calls++;
    return { items: calls >= 3 ? [item("new-folder.txt", 500)] : [], sources: [{ id: "folder:one", kind: "files", workspaceId: null, label: "New folder", coverage: calls >= 3 ? "filename-only" : "indexing", count: calls >= 3 ? 1 : 0 }], unavailable: [] };
  }, { debounceMs: 0, contentPass: false, indexingPollMs: 2 });
  session.search({ query: "new", kinds: ["files"], projectId: null });
  await wait(30);
  expect(calls).toBe(3); expect(session.current().items[0]?.id).toBe("new-folder.txt"); expect(session.current().pending).toBe(false);
  calls = 0;
  session.search({ query: "other", kinds: ["files"], projectId: null });
  await wait(2); session.cancel(); const stoppedAt = calls;
  await wait(20); expect(calls).toBe(stoppedAt);
});

test("changing the file source clears old rows and passes the qualifier to both search phases", async () => {
  const calls: string[] = [];
  const session = new LauncherSearchSession(async input => {
    calls.push(`${input.sourceKind}:${input.content}`);
    return { items: [item(`${input.sourceKind}.pdf`, 1)], sources: [], unavailable: [] };
  }, { debounceMs: 0 });
  try {
    session.search({ query: "contract", kinds: ["files"], projectId: null, sourceKind: "project" });
    await wait(20);
    expect(session.current().items[0]?.id).toBe("project.pdf");
    session.search({ query: "contract", kinds: ["files"], projectId: null, sourceKind: "wiki" });
    expect(session.current().items).toEqual([]);
    await wait(20);
    expect(session.current().items.map(item => item.id)).toEqual(["wiki.pdf"]);
    expect(calls).toEqual(["project:false", "project:true", "wiki:false", "wiki:true"]);
  } finally { session.cancel(); }
});
