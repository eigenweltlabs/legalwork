import { expect, test } from "bun:test";
import { McpRecovery } from "./mcp-recovery.js";

function input(directory = "/project") {
  const statuses: Record<string, { status: string }> = { notes: { status: "failed" } };
  const connects: string[] = [];
  return {
    engine: "http://127.0.0.1:4000", directory, statuses, connects,
    connectors: async () => [{ name: "notes", config: { type: "remote", disabled: false } }],
    readStatuses: async () => statuses,
    connect: async (name: string) => { connects.push(name); },
  };
}

test("only failed, enabled remote transports are reconnected", async () => {
  const current = input();
  const statuses = {
    notes: { status: "failed" }, healthy: { status: "connected" }, manual: { status: "disabled" },
    auth: { status: "needs_auth" }, registration: { status: "needs_client_registration" },
    local: { status: "failed" }, paused: { status: "failed" }, denied: { status: "failed" }, removed: { status: "failed" },
  };
  await new McpRecovery().recover({ ...current, statuses, readStatuses: async () => statuses,
    connectors: async () => Object.keys(statuses).filter(name => name !== "removed").map(name => ({
      name, config: { type: name === "local" ? "local" : "remote", disabled: name === "paused" }, disabledByTools: name === "denied",
    })),
  });
  expect(current.connects).toEqual(["notes"]);
});

test("concurrent refreshes share an attempt and failed retries have a cooldown", async () => {
  let now = 0;
  const recovery = new McpRecovery(() => now, 100);
  const current = input();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const connect = async (name: string) => { current.connects.push(name); started.resolve(); await release.promise; throw new Error("Network still offline"); };
  const first = recovery.recover({ ...current, connect });
  await started.promise;
  const second = recovery.recover({ ...current, connect });
  release.resolve();
  await Promise.all([first, second]);
  expect(current.connects).toEqual(["notes"]);
  await recovery.recover(current);
  expect(current.connects).toHaveLength(1);
  now = 100;
  await recovery.recover(current);
  expect(current.connects).toEqual(["notes", "notes"]);
});

test("a recovered connection can recover a later interruption without a stale cooldown", async () => {
  const recovery = new McpRecovery(() => 0);
  const current = input();
  await recovery.recover(current);
  current.statuses.notes.status = "connected";
  await recovery.recover(current);
  current.statuses.notes.status = "failed";
  await recovery.recover(current);
  expect(current.connects).toEqual(["notes", "notes"]);
});

test("workspaces serialize one connector's reconnect while unrelated connectors recover independently", async () => {
  const recovery = new McpRecovery();
  const a = input("/a"), b = input("/b"), c = input("/c");
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = recovery.recover({ ...a, connect: async () => { order.push("a"); started.resolve(); await release.promise; } });
  await started.promise;
  const second = recovery.recover({ ...b, connect: async () => { order.push("b"); } });
  const independent = { tasks: { status: "failed" } };
  await recovery.recover({ ...c, statuses: independent, readStatuses: async () => independent,
    connectors: async () => [{ name: "tasks", config: { type: "remote" } }], connect: async () => { order.push("c"); },
  });
  expect(order).toEqual(["a", "c"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["a", "c", "b"]);
});

test("a queued reconnect respects a subsequent manual disconnect or sign-in", async () => {
  for (const status of ["disabled", "needs_auth", "connected"]) {
    const recovery = new McpRecovery();
    const a = input("/a"), b = input("/b");
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const first = recovery.recover({ ...a, connect: async () => { started.resolve(); await release.promise; } });
    await started.promise;
    const second = recovery.recover(b);
    b.statuses.notes.status = status;
    release.resolve();
    await Promise.all([first, second]);
    expect(b.connects).toEqual([]);
  }
});

test("disabling a connector while queued prevents reconnect", async () => {
  const recovery = new McpRecovery();
  const a = input("/a"), b = input("/b");
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const first = recovery.recover({ ...a, connect: async () => { started.resolve(); await release.promise; } });
  await started.promise;
  let enabled = true;
  const second = recovery.recover({ ...b, connectors: async () => [{ name: "notes", config: { type: "remote", disabled: !enabled } }] });
  enabled = false;
  release.resolve();
  await Promise.all([first, second]);
  expect(b.connects).toEqual([]);
});

test("manual changes wait for an in-flight recovery and prevent queued recovery", async () => {
  const recovery = new McpRecovery();
  const a = input("/a"), b = input("/b");
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = recovery.recover({ ...a, connect: async () => { order.push("recover"); started.resolve(); await release.promise; } });
  await started.promise;
  const queued = recovery.recover(b);
  const changed = recovery.mutate("notes", async () => { order.push("disabled"); });
  await recovery.recover(b);
  expect(order).toEqual(["recover"]);
  release.resolve();
  await Promise.all([first, queued, changed]);
  expect(order).toEqual(["recover", "disabled"]);
  expect(b.connects).toEqual([]);
});

test("a failed manual operation releases its queue and recovery pause", async () => {
  const recovery = new McpRecovery();
  await expect(recovery.mutate("notes", async () => { throw new Error("Synthetic failure"); })).rejects.toThrow("Synthetic failure");
  const current = input();
  await recovery.recover(current);
  expect(current.connects).toEqual(["notes"]);
});

test("pending OAuth pauses every instance sharing credentials, then ends or expires", async () => {
  let now = 0;
  const recovery = new McpRecovery(() => now);
  const a = input("/a"), b = { ...input("/b"), engine: "http://another-engine" };
  recovery.beginAuth("notes");
  await recovery.recover(a);
  await recovery.recover(b);
  expect(a.connects).toEqual([]);
  expect(b.connects).toEqual([]);
  recovery.endAuth("notes");
  await recovery.recover(a);
  expect(a.connects).toEqual(["notes"]);
  recovery.beginAuth("notes");
  now = 5 * 60_000 - 1;
  await recovery.recover(b);
  expect(b.connects).toEqual([]);
  now++;
  await recovery.recover(b);
  expect(b.connects).toEqual(["notes"]);
});

test("native OAuth pauses recovery for the engine's full attempt lifetime", async () => {
  let now = 0;
  const recovery = new McpRecovery(() => now, 0);
  recovery.beginAuth("notes", 20 * 60_000);
  let connects = 0;
  const input = { engine: "native", directory: "/project", statuses: { notes: { status: "failed" } }, connectors: async () => [{ name: "notes", config: { type: "remote", disabled: false } }], readStatuses: async () => ({ notes: { status: "failed" } }), connect: async () => { connects += 1; } };
  now = 6 * 60_000; await recovery.recover(input); expect(connects).toBe(0);
  now = 21 * 60_000; await recovery.recover(input); expect(connects).toBe(1);
});
