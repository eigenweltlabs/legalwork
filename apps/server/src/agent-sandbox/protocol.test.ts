import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encodeFrame, FrameDecoder } from "./protocol.js";

test("fragmented and coalesced frames preserve binary files, Unicode and request identities", () => {
  const bytes = randomBytes(128 * 1024);
  const messages = [
    { protocol: 5 },
    { run: "a".repeat(32), payload: { event: "filesystem", id: "b".repeat(32), request: { op: "write", handle: 3, offset: 17, data: bytes } } },
    { op: "reply", run: "c".repeat(32), payload: { id: "d".repeat(32), response: { result: bytes } } },
    { op: "reply", run: "c".repeat(32), payload: { id: "d".repeat(32), response: { result: Buffer.alloc(0) } } },
    { run: "e".repeat(32), payload: { event: "request", request: { url: "https://example.com/Ä", bodyBase64: "AAEC" } } },
  ];
  const wire = Buffer.concat(messages.map(encodeFrame));
  const received: unknown[] = [], decoder = new FrameDecoder();
  for (let position = 0; position < wire.length;) {
    const size = position % 4093 + 1;
    decoder.push(wire.subarray(position, position + size), (message) => received.push(message));
    position += size;
  }
  expect(received).toEqual(messages);
  expect(wire.length).toBeLessThan(bytes.length * 2 + 2000);
  expect(messages[1]?.payload?.request?.data).toEqual(bytes);
});

test("oversized declared lengths are rejected before waiting for their payload", () => {
  for (const [json, binary] of [[25 * 1024 ** 2, 0], [1, 128 * 1024 + 1], [0, 0]]) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(json!); header.writeUInt32BE(binary!, 4);
    expect(() => new FrameDecoder().push(header, () => {})).toThrow("limit");
  }
});

test("binary attachments cannot override other fields or ambiguous contents", () => {
  for (const frame of [
    { message: { event: "exit", code: null }, binary: "write" },
    { message: { event: "filesystem", request: { op: "write", data: "smuggled" } }, binary: "write" },
    { message: { id: "request", response: { result: null } }, binary: "unknown" },
    { message: { event: "exit" } },
  ]) {
    const json = Buffer.from(JSON.stringify(frame)), header = Buffer.alloc(8);
    header.writeUInt32BE(json.length); header.writeUInt32BE(1, 4);
    expect(() => new FrameDecoder().push(Buffer.concat([header, json, Buffer.alloc(1)]), () => {})).toThrow();
  }
});
