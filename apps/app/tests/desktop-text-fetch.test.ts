import { expect, test } from "bun:test";
import { fetchDesktopText } from "../src/app/lib/desktop-text-fetch";
import type { DesktopFetchInit } from "@legalwork/types/desktop-ipc";

test("remote Request credentials, body and cancellation retain their owner ID across IPC", async () => {
  let init: DesktopFetchInit | undefined; let cancelled: string | undefined;
  const controller = new AbortController();
  const request = new Request("https://example.test/prompt", { method: "POST", body: "prompt", headers: { authorization: "Bearer private" }, signal: controller.signal });
  const pending = fetchDesktopText({
    __fetch: async (_url, input) => { init = input; return new Promise(() => {}); },
    __fetchCancel: async id => { cancelled = id; },
  }, request, undefined, 12345);
  for (let i = 0; i < 20 && !init; i++) await Bun.sleep(1);
  expect(init?.body).toBe("prompt"); expect(init?.headers?.authorization).toBe("Bearer private"); expect(init?.timeoutMs).toBe(12345);
  controller.abort(new Error("Changed workspace")); await expect(pending).rejects.toThrow("Changed workspace");
  expect(cancelled).toBe(init?.requestId);
});

test("already cancelled requests never start and empty responses remain valid", async () => {
  let calls = 0;
  const bridge = { __fetch: async () => { calls++; return { status: 204, statusText: "No Content", headers: [], body: "" }; }, __fetchCancel: async () => {} };
  const controller = new AbortController(); controller.abort();
  await expect(fetchDesktopText(bridge, "https://example.test", { signal: controller.signal })).rejects.toThrow(); expect(calls).toBe(0);
  const response = await fetchDesktopText(bridge, "https://example.test"); expect(response.status).toBe(204); expect(response.body).toBeNull();
});
