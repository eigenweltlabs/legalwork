import { expect, test } from "bun:test";
import { createBrowserExtensionChannel } from "./browser-extension-channel.js";
const binding = { actor: "desktop", workspaceID: "project", sessionID: "chat", tabID: "tab" };
test("cancelled undelivered mutations disappear and delivered mutations receive cancellation without replay", async () => {
  const channel = createBrowserExtensionChannel(), cap = channel.register(binding);
  const queued = new AbortController(); const first = channel.request(cap, "batch", { steps: ["click"] }, queued.signal); queued.abort(new Error("Stopped before delivery"));
  await expect(first).rejects.toThrow("Stopped before delivery");
  const delivered = new AbortController(), second = channel.request(cap, "upload", { full: "bytes" }, delivered.signal);
  const command = await channel.next(cap, new AbortController().signal);
  expect(command).toMatchObject({ route: "upload", body: { full: "bytes" } });
  if (!("requestID" in command)) throw new Error("Expected a mutation");
  delivered.abort(new Error("Stopped after delivery")); await expect(second).rejects.toThrow("Stopped after delivery");
  expect(await channel.next(cap, new AbortController().signal)).toEqual({ cancel: command.requestID });
  expect(() => channel.result(cap, command.requestID, { status: 200, payload: {} })).toThrow("no longer pending"); channel.close(cap);
});
test("a disconnected desktop rejects pending work and cannot resurrect an attachment or replay its result", async () => {
  const channel = createBrowserExtensionChannel(), cap = channel.register(binding), receiver = new AbortController();
  const next = channel.next(cap, receiver.signal), pending = channel.request(cap, "capture", {}, new AbortController().signal);
  const command = await next; expect(command).toMatchObject({ route: "capture" });
  const idle = channel.next(cap, receiver.signal);
  const failures = Promise.all([idle.catch(error => error), pending.catch(error => error)]);
  receiver.abort(); for (const error of await failures) expect(error.message).toContain("disconnected");
  expect(() => channel.binding(cap)).toThrow("disconnected");
});
