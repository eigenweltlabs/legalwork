import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "./errors.js";

/** Stream an HTTP body to a caller-owned temporary file, with backpressure. */
export async function receiveRequestFile(request: Request, destination: string, maximum: number) {
  if (Number(request.headers.get("content-length")) > maximum) throw new ApiError(413, "file_too_large", "Files must be at most 1 GiB.");
  if (!request.body) throw new ApiError(400, "file_empty", "Provide file bytes.");
  const reader = request.body.getReader(), hash = createHash("sha256");
  let size = 0;
  async function* chunks() {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      size += next.value.byteLength;
      if (size > maximum) throw new ApiError(413, "file_too_large", "Files must be at most 1 GiB.");
      hash.update(next.value); yield next.value;
    }
  }
  try {
    await pipeline(Readable.from(chunks()), createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal: request.signal });
    return { size, sha256: hash.digest("hex") };
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
