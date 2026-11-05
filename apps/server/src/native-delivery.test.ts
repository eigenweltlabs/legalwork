import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "./errors.js";
import { nativeDeliveryRejection, nativeResponseError } from "./native-delivery.js";
import { SessionMessageQueue } from "./session-message-queue.js";

test("queued admission preserves rejection details without declaring transport/server errors rejected", () => {
  const reason = "This project has not been approved for OpenCode automation.";
  const error = nativeResponseError(400, { error: { message: reason } });
  expect(error.message).toBe(reason);
  expect(nativeDeliveryRejection(new Error("ClientError", { cause: error }))?.accepted).toBe(false);
  expect(nativeDeliveryRejection(nativeResponseError(500, { message: "unknown" }))).toBeUndefined();
  expect(nativeDeliveryRejection(new ApiError(503, "opencode_unavailable", "Lost response"))).toBeUndefined();
  expect(nativeDeliveryRejection(new DOMException("Timed out", "TimeoutError"))).toBeUndefined();
});

test("a refused queued prompt stays editable with its draft and never retries automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-rejected-queue-"));
  let sends = 0;
  const queue = new SessionMessageQueue(root, {
    idle: async () => true, confirmed: async () => false,
    send: async () => { sends++; throw nativeDeliveryRejection(nativeResponseError(400, { message: "Register this project first." })); },
  });
  try {
    const id = crypto.randomUUID();
    await queue.act("workspace", "chat", { type: "enqueue", id,
      draft: { mode: "prompt", text: "Review", parts: [{ type: "text", text: "Review" }], attachments: [], editor: { mentions: {}, pasteParts: [] } },
      execution: { kind: "prompt", text: "Review" },
    });
    let state = await queue.read("workspace", "chat");
    for (let i = 0; i < 100 && !state.paused; i++) { await new Promise(resolve => setTimeout(resolve, 5)); state = await queue.read("workspace", "chat"); }
    expect(state.entries[0]).toMatchObject({ id, status: "failed", error: "Register this project first.", draft: { text: "Review" } });
    await queue.tick(); await queue.tick();
    expect(sends).toBe(1);
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});
