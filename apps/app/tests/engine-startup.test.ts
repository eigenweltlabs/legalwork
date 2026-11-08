import { expect, test } from "bun:test";
import { waitForEngineReady, pauseStartupPoll } from "../src/react-app/shell/engine-startup";
import type { MigrationProgress } from "@legalwork/types/migration-progress";

test("a long migration keeps project loading blocked until the engine is ready", async () => {
  let polls = 0, updates = 0, elapsedMs = 0;
  await waitForEngineReady({
    signal: new AbortController().signal,
    health: async () => ({ engine: { status: ++polls <= 400 ? "migrating" : "ready" } }),
    onUpdating: () => { updates++; },
    pause: async () => { elapsedMs += 500; },
  });
  expect(polls).toBe(401);
  expect(updates).toBe(400);
  expect(elapsedMs).toBe(200_000);
});

test("ordinary startup and servers without a managed engine can open", async () => {
  let polls = 0, updates = 0;
  const signal = new AbortController().signal;
  await waitForEngineReady({ signal,
    health: async () => ({ engine: { status: ++polls === 1 ? "starting" : "ready" } }),
    onUpdating: () => { updates++; }, pause: async () => {},
  });
  await waitForEngineReady({ signal, health: async () => ({}), onUpdating: () => { updates++; } });
  expect(updates).toBe(0);
  expect(polls).toBe(2);
});

test("measured folder work keeps routes blocked even between native engine restarts", async () => {
  let polls = 0;
  const seen: number[] = [];
  await waitForEngineReady({ signal: new AbortController().signal,
    health: async () => ({ engine: { status: "ready" } }),
    migration: async () => ({ migration: { status: ++polls < 4 ? "running" : "complete", phase: "copying", work: { completed: polls, total: 4, unit: "files" }, deferredProjects: 0 } }),
    onUpdating: progress => { if (progress?.work) seen.push(progress.work.completed); }, pause: async () => {},
  });
  expect(seen).toEqual([1, 2, 3]);
  expect(polls).toBe(4);
});

test("older servers without progress keep bounded health polling and do not repeat unsupported reads", async () => {
  let polls = 0, progressReads = 0;
  await waitForEngineReady({ signal: new AbortController().signal,
    health: async () => ({ engine: { status: ++polls < 3 ? "migrating" : "ready" } }),
    migration: async () => { progressReads++; throw Object.assign(new Error("Not found"), { status: 404 }); },
    onUpdating: () => {}, pause: async () => {},
  });
  expect(polls).toBe(3);
  expect(progressReads).toBe(1);
});

test("migration failure cannot be mistaken for ready history", async () => {
  const migration: MigrationProgress = { status: "error", phase: "verifying", deferredProjects: 0 };
  await expect(waitForEngineReady({ signal: new AbortController().signal,
    health: async () => ({ engine: { status: "ready" } }), migration: async () => ({ migration }), onUpdating: () => {},
  })).rejects.toThrow("Migration failed");
});

test("a migration failure stays blocked instead of loading projects", async () => {
  await expect(waitForEngineReady({ signal: new AbortController().signal,
    health: async () => ({ engine: { status: "error" } }), onUpdating: () => {},
  })).rejects.toThrow("Engine startup failed");
});

test("a stopped server fails after bounded transport retries", async () => {
  let polls = 0;
  await expect(waitForEngineReady({ signal: new AbortController().signal,
    health: async () => { polls++; throw new Error("disconnected"); },
    onUpdating: () => {}, pause: async () => {},
  })).rejects.toThrow("disconnected");
  expect(polls).toBe(3);
});

test("successful migration polling resets transport retries", async () => {
  let polls = 0;
  await waitForEngineReady({ signal: new AbortController().signal,
    health: async () => {
      polls++;
      if ([1, 2, 4, 5].includes(polls)) throw new Error("temporary disconnect");
      return { engine: { status: polls === 6 ? "ready" : "migrating" } };
    }, onUpdating: () => {}, pause: async () => {},
  });
  expect(polls).toBe(6);
});

test("unmount cancels polling without opening the app", async () => {
  const controller = new AbortController();
  await expect(waitForEngineReady({ signal: controller.signal,
    health: async () => ({ engine: { status: "migrating" } }),
    onUpdating: () => { controller.abort(new Error("unmounted")); },
  })).rejects.toThrow("unmounted");
  await expect(pauseStartupPoll(controller.signal)).rejects.toThrow("unmounted");
});
