import { test, expect } from "bun:test";
import { channelEventWakes, channelEventWait } from "./channel-event-wait.js";

test("native completed output and lifecycle events wake only the originating session", () => {
  for (const type of ["session.text.ended", "session.tool.success", "session.tool.failed", "session.execution.succeeded", "session.execution.failed", "form.created"]) {
    expect(channelEventWakes({ type, data: { sessionID: "own" } }, "own", "input")).toBe(true);
    expect(channelEventWakes({ type, data: { sessionID: "other" } }, "own", "input")).toBe(false);
  }
  expect(channelEventWakes({ type: "session.text.delta", data: { sessionID: "own" } }, "own", "input")).toBe(false);
  expect(channelEventWakes({ type: "session.text.ended", data: {} }, "own", "input")).toBe(false);
});
test("a native event hint and cancellation release the bounded receipt wait", async () => {
  const controller = new AbortController();
  const first = channelEventWait(3000, controller.signal); first.notify(); await first.done; first.close();
  const second = channelEventWait(3000, controller.signal); controller.abort(); await second.done; second.close();
  expect(controller.signal.aborted).toBe(true);
});
