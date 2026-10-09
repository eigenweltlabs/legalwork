/** Length-delimited control messages with one bounded binary file chunk.
 * Network requests remain complete JSON so approval still sees the same data. */
const JSON_LIMIT = 24 * 1024 * 1024;
const BINARY_LIMIT = 128 * 1024;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid sandbox frame object.");
  return value;
}
function slot(message: Record<string, unknown>, kind: unknown) {
  const inner = object(message.payload ?? message);
  if (kind === "write" && inner.event === "filesystem") {
    const request = object(inner.request);
    if (request.op === "write") return { parent: request, key: "data" };
  }
  if (kind === "read" && typeof inner.id === "string") return { parent: object(inner.response), key: "result" };
  throw new Error("Invalid sandbox binary attachment.");
}

export function encodeFrame(input: unknown): Buffer {
  const message = { ...object(input) };
  if (message.payload) message.payload = { ...object(message.payload) };
  const inner = object(message.payload ?? message);
  let kind: "read" | "write" | undefined;
  if (inner.event === "filesystem" && isObject(inner.request) && inner.request.op === "write") {
    inner.request = { ...inner.request }; kind = "write";
  } else if (isObject(inner.response) && Buffer.isBuffer(inner.response.result)) {
    inner.response = { ...inner.response }; kind = "read";
  }
  let bytes: Buffer = Buffer.alloc(0);
  if (kind) {
    const { parent, key } = slot(message, kind);
    const value = parent[key];
    if (!Buffer.isBuffer(value) || value.length > BINARY_LIMIT) throw new Error("Invalid sandbox binary chunk.");
    bytes = value;
    parent[key] = null;
  }
  const json = Buffer.from(JSON.stringify({ message, binary: kind }));
  if (json.length > JSON_LIMIT) throw new Error("Sandbox protocol frame exceeded its limit.");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(json.length); header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, json, bytes]);
}

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, receive: (message: unknown) => void): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const jsonLength = this.pending.readUInt32BE(), binaryLength = this.pending.readUInt32BE(4);
      if (!jsonLength || jsonLength > JSON_LIMIT || binaryLength > BINARY_LIMIT) throw new Error("Sandbox protocol frame exceeded its limit.");
      const length = 8 + jsonLength + binaryLength;
      if (this.pending.length < length) return;
      const frame = object(JSON.parse(this.pending.subarray(8, 8 + jsonLength).toString()));
      const message = object(frame.message);
      if (frame.binary !== undefined) {
        const { parent, key } = slot(message, frame.binary);
        if (parent[key] !== null) throw new Error("Ambiguous sandbox binary attachment.");
        parent[key] = Buffer.from(this.pending.subarray(8 + jsonLength, length));
      } else if (binaryLength) throw new Error("Unexpected sandbox binary attachment.");
      this.pending = this.pending.length === length ? Buffer.alloc(0) : this.pending.subarray(length);
      receive(message);
    }
  }
}
