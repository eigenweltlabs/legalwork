import { expect, test } from "bun:test";
import { ApiError } from "./errors.js";
import { startToolImageOriginalLifecycle, type ToolImageOriginalLifecycleSource } from "./tool-image-original-lifecycle.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(ids: string[] = []) {
  const indexed = new Set(ids), deleted = new Set<string>(), removed: string[][] = [], reads: string[] = [], errors: unknown[] = [];
  const messages: Array<{ type: string; data: unknown }> = [];
  let wake = () => {}, streams = 0, closedStreams = 0;
  const state = { current: true, read: async (_id: string, _signal: AbortSignal) => {}, remove: async (_ids: readonly string[]) => {} };
  const source: ToolImageOriginalLifecycleSource = {
    assertCurrent() { if (!state.current) throw new Error("Managed engine identity changed."); },
    async session(id, signal) { reads.push(id); await state.read(id, signal); },
    async *events(signal) {
      streams++;
      const abort = () => wake();
      signal.addEventListener("abort", abort);
      try {
        yield { type: "server.connected", data: {} };
        while (!signal.aborted) {
          if (!messages.length) await new Promise<void>(done => { wake = done; if (signal.aborted) done(); });
          signal.throwIfAborted();
          const event = messages.shift();
          if (event) yield event;
        }
      } finally { signal.removeEventListener("abort", abort); closedStreams++; }
    },
  };
  const service = startToolImageOriginalLifecycle({
    source: () => source,
    store: {
      indexedSessionIDs: async () => [...indexed],
      deletedSessionIDs: async () => [...deleted],
      retryReferenceDeletions: async () => {},
      async removeSessions(values) {
        await state.remove(values);
        removed.push([...values]);
        for (const id of values) { indexed.delete(id); deleted.add(id); }
      },
    },
    report: error => errors.push(error),
  });
  return { state, service, indexed, deleted, removed, reads, errors,
    push(event: { type: string; data: unknown }) { messages.push(event); wake(); },
    counts: () => ({ streams, closedStreams }),
  };
}
async function until(predicate: () => boolean) {
  while (!predicate()) await new Promise<void>(done => setImmediate(done));
}

test("reconciles only indexed404s, preserves live chats and handles exact native deletion IDs", async () => {
  const value = fixture(["live", "missing"]);
  value.state.read = async id => { if (id === "missing") throw new ApiError(404, "missing", "Native chat is absent."); };
  try {
    await until(() => value.removed.length === 1);
    expect(value.reads).toEqual(["live", "missing"]);
    expect(value.removed).toEqual([["missing"]]);
    value.push({ type: "session.updated", data: { sessionID: "live" } });
    value.push({ type: "session.deleted", data: { sessionID: "live" } });
    await until(() => value.removed.length === 2);
    expect(value.removed).toEqual([["missing"], ["live"]]);
    expect(value.errors).toEqual([]);
  } finally { await value.service.close(); }
  expect(value.counts()).toEqual({ streams: 1, closedStreams: 1 });
});

test("network/auth/ambiguous errors preserve originals and reconnect before retrying", async () => {
  const value = fixture(["keep"]);
  value.state.read = async () => { throw new ApiError(502, "engine_auth", "Authentication failed."); };
  try {
    await until(() => value.errors.length === 1);
    expect(value.removed).toEqual([]);
    expect(value.indexed.has("keep")).toBe(true);
    value.state.read = async () => { throw new Error("Connection closed"); };
    await until(() => value.errors.length === 2);
    expect(value.removed).toEqual([]);
    value.state.read = async () => { throw new Error("Client wrapped native absence", { cause: new ApiError(404, "missing", "Absent") }); };
    await until(() => value.removed.length === 1);
    expect(value.removed).toEqual([["keep"]]);
  } finally { await value.service.close(); }
  expect(value.counts().closedStreams).toBe(value.counts().streams);
});

test("retries durable deletion intent and never treats malformed events as a session ID", async () => {
  const value = fixture();
  value.deleted.add("retry");
  let attempts = 0;
  value.state.remove = async () => { if (++attempts === 1) throw new Error("Temporary private-file failure"); };
  try {
    await until(() => value.removed.length === 1);
    expect(attempts).toBe(2);
    expect(value.removed).toEqual([["retry"]]);
    value.push({ type: "session.deleted", data: { sessionID: 12 } });
    await until(() => value.errors.length === 2);
    expect(value.removed).toEqual([["retry"]]);
  } finally { await value.service.close(); }
});

test("subscribes before checking so a deletion during reconciliation is retained", async () => {
  const value = fixture(["racing"]), entered = deferred(), finish = deferred();
  value.state.read = async () => { entered.resolve(); await finish.promise; };
  try {
    await entered.promise;
    value.push({ type: "session.deleted", data: { sessionID: "racing" } });
    finish.resolve();
    await until(() => value.removed.length === 1);
    expect(value.removed).toEqual([["racing"]]);
    expect(value.errors).toEqual([]);
  } finally { finish.resolve(); await value.service.close(); }
});

test("a connection change after404 prevents deletion; close aborts and reaps the stream", async () => {
  const value = fixture(["keep"]);
  value.state.read = async () => { value.state.current = false; throw new ApiError(404, "missing", "Another engine cannot prove deletion."); };
  try {
    await until(() => value.errors.length === 1);
    expect(value.removed).toEqual([]);
    expect(value.indexed.has("keep")).toBe(true);
  } finally { await value.service.close(); }
  expect(value.counts().closedStreams).toBe(value.counts().streams);

  const blocked = fixture(["pending"]), entered = deferred();
  blocked.state.read = async (_id, signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  await entered.promise;
  await blocked.service.close();
  expect(blocked.removed).toEqual([]);
  expect(blocked.errors).toEqual([]);
  expect(blocked.counts()).toEqual({ streams: 1, closedStreams: 1 });
});
