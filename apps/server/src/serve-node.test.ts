import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "./serve-node.js";

describe("serve", () => {
  test("an occupied port cannot replace or share another server's authenticated listener", async () => {
    const first = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("first server") });
    let second: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      second = await serve({ hostname: "127.0.0.1", port: first.port, fetch: () => new Response("second server") });
      expect(second.port).not.toBe(first.port);
      expect(await (await fetch(`http://127.0.0.1:${first.port}`)).text()).toBe("first server");
      expect(await (await fetch(`http://127.0.0.1:${second.port}`)).text()).toBe("second server");
    } finally { await second?.stop(); await first.stop(); }
  });

  test("streams raw HTTP envelopes beyond the former 256 MiB ceiling", async () => {
    const totalBytes = 256 * 1024 * 1024 + 1;
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent === totalBytes) { controller.close(); return; }
      const size = Math.min(chunk.length, totalBytes - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    } });
    const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Expected an attachment body");
      let received = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        received += item.value.byteLength;
      }
      return Response.json({ received });
    } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/attachment`, { method: "POST", body });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: totalBytes });
    } finally { await server.stop(); }
  }, 10_000);

  test("keeps an active approval wait open beyond the connection idle timeout", async () => {
    const server = await serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1,
      fetch: async request => {
        const proposal = await request.json();
        await delay(5_000);
        return Response.json({ allowed: true, proposal });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/approval`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "wiki.write" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ allowed: true, proposal: { action: "wiki.write" } });
    } finally { await server.stop(); }
  }, 10_000);

  test("aborts the Web request when the client disconnects while awaiting approval", async () => {
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let aborted: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        started();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => {
          aborted();
          resolve();
        }, { once: true }));
        return Response.json({ allowed: false });
      },
    });
    try {
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${server.port}/approval`, { signal: controller.signal }).catch(() => undefined);
      await ready;
      controller.abort();
      await cancelled;
      await response;
    } finally {
      await server.stop();
    }
  });

  test("does not write an error response after a streaming response has ended", async () => {
    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaughtException);

    const encoder = new TextEncoder();
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true });
        }

        let wroteChunk = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!wroteChunk) {
                wroteChunk = true;
                controller.enqueue(encoder.encode("partial"));
                return;
              }
              controller.error(new Error("stream failed after response started"));
            },
          }),
        );
      },
    });

    try {
      // A transport may expose the original prefix or reject the body. It
      // must never append an unrelated second JSON response to that prefix.
      const text = await fetch(`http://127.0.0.1:${server.port}/stream`).then(response => response.text()).catch(() => undefined);
      if (text !== undefined) expect(text).toBe("partial");
      await delay(25);

      expect(uncaught).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      process.off("uncaughtException", onUncaughtException);
      await server.stop();
    }
  });

  test("awaits shutdown before resolving stop", async () => {
    const first = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const port = first.port;

    await first.stop();

    const second = await serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true }),
    });
    expect(second.port).toBe(port);
    await second.stop();
  });

  test("reuses the in-flight shutdown for repeated stop calls", async () => {
    const first = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const port = first.port;

    await Promise.all([first.stop(), first.stop()]);

    const second = await serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true }),
    });
    expect(second.port).toBe(port);
    await second.stop();
  });

  test("does not log expected connection aborts as unhandled errors", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true });
        }
        throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
      },
    });

    try {
      await fetch(`http://127.0.0.1:${server.port}/abort`).catch(() => undefined);
      await delay(25);
      expect(errors).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      console.error = originalError;
      await server.stop();
    }
  });
});
