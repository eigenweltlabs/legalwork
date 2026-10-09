import { describe, expect, test } from "bun:test";
import { fetchDesktopStream } from "../src/app/lib/desktop-stream-fetch";

describe("desktop event streams", () => {
  test("preserves split UTF-8 chunks and request authorization without buffering the entire stream", async () => {
    const bytes = new TextEncoder().encode("data: geändert\n\n");
    const chunks = [bytes.slice(0, 8), bytes.slice(8)];
    let reads = 0;
    const response = await fetchDesktopStream({
      async __streamOpen(_id, url, headers) {
        expect(url).toBe("http://localhost/events");
        expect(headers.authorization).toBe("Bearer test");
        return { status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]] };
      },
      async __streamRead() { reads++; return chunks.shift() ?? null; },
      async __streamCancel() {},
    }, new Request("http://localhost/events", { headers: { Authorization: "Bearer test" } }));
    expect(reads).toBeLessThan(3);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: geändert\n\n");
  });

  test("aborting after headers cancels the native stream and rejects the pending body read", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = await fetchDesktopStream({
      async __streamOpen() { return { status: 200, statusText: "OK", headers: [] }; },
      __streamRead() { return new Promise<null>(() => {}); },
      async __streamCancel() { cancelled = true; },
    }, "http://localhost/events", { signal: controller.signal });
    const reading = response.text();
    controller.abort();
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("cancelling a body releases the native stream", async () => {
    let cancelled = false;
    const response = await fetchDesktopStream({
      async __streamOpen() { return { status: 200, statusText: "OK", headers: [] }; },
      __streamRead() { return new Promise<null>(() => {}); },
      async __streamCancel() { cancelled = true; },
    }, "http://localhost/events");
    await response.body?.cancel();
    expect(cancelled).toBe(true);
  });
});
