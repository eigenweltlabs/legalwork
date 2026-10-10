import { expect, test } from "bun:test";
import { createOpencodeClient, type Event, type Part } from "@opencode-ai/sdk/v2/client";
import { channelEventWakes, watchChannelEvents } from "./channel-event-wait.js";

const part = (value: Part): Event => ({ id: "hint", type: "message.part.updated", properties: { sessionID: value.sessionID, part: value, time: 1 } });
const text = (closed: boolean): Part => ({ id: "prose", type: "text", sessionID: "owned-session", messageID: "reply", text: "public prose", time: { start: 1, ...(closed ? { end: 2 } : {}) } });

test("engine wake hints exclude tokens, reasoning, hidden prose and unrelated sessions", () => {
  const delta: Event = { id: "delta", type: "message.part.delta", properties: { sessionID: "owned-session", messageID: "reply", partID: "prose", field: "text", delta: "private delta" } };
  const hidden = text(true); if (hidden.type !== "text") throw new Error("Invalid fixture"); hidden.synthetic = true;
  expect(channelEventWakes(delta, "owned-session", "human")).toBe(false);
  expect(channelEventWakes(part(text(false)), "owned-session", "human")).toBe(false);
  expect(channelEventWakes(part(hidden), "owned-session", "human")).toBe(false);
  expect(channelEventWakes(part(text(true)), "another-session", "human")).toBe(false);
  expect(channelEventWakes(part(text(true)), "owned-session", "human")).toBe(true);
  expect(channelEventWakes({ id: "idle", type: "session.idle", properties: { sessionID: "owned-session" } }, "owned-session", "human")).toBe(true);
  expect(channelEventWakes({ id: "question", type: "question.asked", properties: { id: "question", sessionID: "owned-session", questions: [] } }, "owned-session", "human")).toBe(true);
});

test("the actual OpenCode SDK SSE reader wakes completed tools immediately and closes on request abort", async () => {
  let write: ((event: Event) => void) | undefined, cancelled = false, requests = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { write = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
    cancel() { cancelled = true; },
  });
  const client = createOpencodeClient({ baseUrl: "http://engine.test", fetch: Object.assign(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    expect(new URL(request.url).pathname).toBe("/event"); requests++;
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: () => {} }) });
  const stop = new AbortController(); let hints = 0;
  const watching = watchChannelEvents(client, "owned-session", "human", () => { hints++; }, stop.signal);
  await new Promise(resolve => setTimeout(resolve, 5));
  write?.(part(text(false))); write?.({ id: "idle", type: "session.idle", properties: { sessionID: "foreign-session" } });
  write?.(part({ id: "reaction", type: "tool", sessionID: "owned-session", messageID: "reply", tool: "legalwork_assistant_react", callID: "call",
    state: { status: "completed", input: {}, output: "private tool data", title: "", metadata: {}, time: { start: 1, end: 2 } } }));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(hints).toBe(1); stop.abort(); await watching;
  expect(cancelled).toBe(true); expect(requests).toBe(1);
});

test("a broken OpenCode SSE endpoint performs one connection attempt and leaves receipt polling in control", async () => {
  let requests = 0, hints = 0;
  const client = createOpencodeClient({ baseUrl: "http://engine.test", fetch: Object.assign(async () => {
    requests++; return new Response("unavailable", { status: 503 });
  }, { preconnect: () => {} }) });
  await watchChannelEvents(client, "owned-session", "human", () => { hints++; }, new AbortController().signal);
  expect(requests).toBe(1); expect(hints).toBe(0);
});
