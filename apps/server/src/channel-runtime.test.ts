import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChannelRuntime, type ChannelEngine, type ChannelLiveEvent } from "./channel-runtime.js";
import type { z } from "zod";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-channel-runtime-"));
  let sends = 0, hasMessage = false, busy = false, complete = false, available = true, uncertain = false;
  let now = Date.now();
  let events: z.infer<typeof ChannelLiveEvent>[] = [];
  const engine: ChannelEngine = {
    current: async () => ({ workspaceId: "owned-assistant", sessionId: "daily-session" }), validate: async () => {},
    hasMessage: async () => hasMessage, busy: async () => busy,
    send: async () => { sends++; hasMessage = true; busy = true; if (uncertain) throw new Error("lost response"); },
    result: async () => complete ? { state: "completed", text: "Real final reply", events } : { state: "running", events },
  };
  let runtime = await ChannelRuntime.open(join(root, "runtime.sqlite"), engine, () => available, () => now);
  const input = { id: randomUUID(), userId: "user-a", orgId: "org-a", conversationId: randomUUID(), channel: "ios", text: "Please help", attachments: [] };
  return { input, get runtime() { return runtime; }, get sends() { return sends; },
    finish: () => { complete = true; busy = false; }, revoke: () => { available = false; }, uncertain: () => { uncertain = true; },
    missing: () => { hasMessage = false; }, persisted: () => { hasMessage = true; }, expireAcceptance: () => { now += 30001; },
    progress: (text="Acknowledged before work completes") => { events=[{key:"a".repeat(64),event:{type:"message.created",text}}]; }, compact: () => { events=[]; },
    reopen: async () => { runtime.close(); runtime = await ChannelRuntime.open(join(root, "runtime.sqlite"), engine, () => available, () => now); },
    close: async () => { runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}
test("a lost dispatch response and process restart recover the same engine message without a second prompt", async () => {
  const f = await fixture(); try {
    f.uncertain(); expect((await f.runtime.accept(f.input)).state).toBe("running");
    await f.reopen(); expect((await f.runtime.accept(f.input)).state).toBe("running"); expect(f.sends).toBe(1);
    f.finish(); const result = await f.runtime.inspect(f.input.id); expect(result.textResult).toBe("Real final reply");
    await f.reopen(); expect((await f.runtime.accept(f.input)).textResult).toBe(result.textResult); expect(f.sends).toBe(1);
  } finally { await f.close(); }
});
test("live completed bubbles survive receipt replay, engine compaction and process restart exactly once", async () => {
  const f=await fixture();try {
    await f.runtime.accept(f.input);f.progress();const early=await f.runtime.inspect(f.input.id);
    expect(early.state).toBe("running");expect(early.events).toHaveLength(1);
    await f.reopen();expect((await f.runtime.accept(f.input)).events).toEqual(early.events);expect(f.sends).toBe(1);
    f.compact();f.finish();expect((await f.runtime.inspect(f.input.id)).events).toEqual(early.events);
    await f.reopen();expect((await f.runtime.inspect(f.input.id)).events).toEqual(early.events);
  }finally { await f.close(); }
});
test("a completed bubble cannot change under the same replay identity", async () => {
  const f=await fixture();try {
    await f.runtime.accept(f.input);f.progress();await f.runtime.inspect(f.input.id);f.progress("Changed body");
    await expect(f.runtime.inspect(f.input.id)).rejects.toThrow("completed channel event changed");
  }finally { await f.close(); }
});
test("unknown outcome without an engine message fails rather than replaying a consequential prompt", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); f.missing(); await f.reopen();
    expect((await f.runtime.inspect(f.input.id)).state).toBe("running"); f.expireAcceptance();
    const result = await f.runtime.accept(f.input); expect(result.state).toBe("failed"); expect(result.code).toBe("dispatch_uncertain"); expect(f.sends).toBe(1);
  } finally { await f.close(); }
});
test("an asynchronous acknowledgement can precede persistence across restart without a second prompt", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); f.missing(); await f.reopen();
    expect((await f.runtime.accept(f.input)).state).toBe("running"); expect(f.sends).toBe(1);
    f.persisted(); f.finish(); expect((await f.runtime.inspect(f.input.id)).textResult).toBe("Real final reply");
    expect(f.sends).toBe(1);
  } finally { await f.close(); }
});
test("owner binding survives restart and rejects other organizations and changed replay content", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); await f.reopen();
    await expect(f.runtime.accept({ ...f.input, orgId: "another-org" })).rejects.toThrow("another account");
    await expect(f.runtime.accept({ ...f.input, text: "Different request" })).rejects.toThrow("different content"); expect(f.sends).toBe(1);
  } finally { await f.close(); }
});
test("parallel retries dispatch once and another turn waits behind active work", async () => {
  const f = await fixture(); try {
    const receipts = await Promise.all([f.runtime.accept(f.input), f.runtime.accept(f.input)]);
    expect(receipts[0].messageId).toBe(receipts[1].messageId); expect(f.sends).toBe(1);
    await expect(f.runtime.accept({ ...f.input, id: randomUUID() })).rejects.toThrow("still active");
    f.finish(); await f.runtime.inspect(f.input.id);
    await f.runtime.accept({ ...f.input, id: randomUUID() }); expect(f.sends).toBe(2);
  } finally { await f.close(); }
});
test("lost executor ownership fences reads, new turns and command execution", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); f.revoke();
    await expect(f.runtime.inspect(f.input.id)).rejects.toThrow("does not own");
    let calls = 0;
    await expect(f.runtime.command({ id: randomUUID(), userId: "user-a", orgId: "org-a", command: { kind: "assistant.stop", revision: 1 } }, async () => { calls++; return {}; })).rejects.toThrow("does not own");
    expect(calls).toBe(0);
  } finally { await f.close(); }
});
test("control commands can resolve while a message runs and repeat only their durable result", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); let calls = 0;
    const command = { id: randomUUID(), userId: "user-a", orgId: "org-a", command: { kind: "assistant.stop", revision: 1 } };
    const result = await f.runtime.command(command, async () => { calls++; return { stopped: true }; });
    await f.reopen(); expect(await f.runtime.command(command, async () => { calls++; return {}; })).toEqual(result); expect(calls).toBe(1);
    expect(f.runtime.approvalRevision("approval", "exact-content-hash")).toBe(1);
    expect(f.runtime.approvalRevision("approval", "exact-content-hash")).toBe(1);
    expect(f.runtime.approvalRevision("approval", "different-hash")).toBe(2);
  } finally { await f.close(); }
});
test("lease cancellation is durable and cannot stop a newer turn after completion", async () => {
  const f = await fixture(); try {
    await f.runtime.accept(f.input); let stops = 0;
    expect(await f.runtime.cancel(f.input.id, async () => { stops++; })).toEqual({ stopped: true });
    await f.reopen(); expect(await f.runtime.cancel(f.input.id, async () => { stops++; })).toEqual({ stopped: false });
    expect((await f.runtime.inspect(f.input.id)).code).toBe("cancelled"); expect(stops).toBe(1);
  } finally { await f.close(); }
  const g = await fixture(); try {
    await g.runtime.accept(g.input); g.finish(); await g.runtime.inspect(g.input.id);
    await g.runtime.accept({ ...g.input, id: randomUUID() }); let stops = 0;
    expect(await g.runtime.cancel(g.input.id, async () => { stops++; })).toEqual({ stopped: false }); expect(stops).toBe(0);
  } finally { await g.close(); }
});
test("model reload waits for active work and an unchanged model remains inert across restart", async () => {
  const f = await fixture(); try {
    let reloads = 0;
    await f.runtime.configure("first-model", async () => { reloads++; });
    await f.runtime.accept(f.input);
    await f.runtime.configure("first-model", async () => { reloads++; });
    await expect(f.runtime.configure("rotated-key", async () => { reloads++; })).rejects.toThrow("active turn");
    f.finish(); await f.runtime.configure("rotated-key", async () => { reloads++; });
    await f.reopen(); await f.runtime.configure("rotated-key", async () => { reloads++; });
    expect(reloads).toBe(2); expect(f.sends).toBe(1);
  } finally { await f.close(); }
});
