/**
 * Node.js HTTP adapter for the LegalWork server.
 *
 * Provides a `serve()` function with the same interface as Bun.serve()
 * but backed by `node:http`. This allows the server to run in any Node.js
 * environment (including Electron's main process) without Bun.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { Readable } from "node:stream";

export type ServeTlsOptions = {
  /** PEM-encoded certificate chain. */
  cert: string;
  /** PEM-encoded private key. */
  key: string;
};

export type ServeOptions = {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
  idleTimeout?: number;
  /** When set, serve HTTPS instead of HTTP. */
  tls?: ServeTlsOptions;
};

export type ServeResult = {
  port: number;
  stop: () => void | Promise<void>;
};

function isResponseWritable(nodeRes: ServerResponse): boolean {
  return !nodeRes.destroyed && !nodeRes.closed && !nodeRes.writableEnded;
}

function isWriteAfterEndError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ERR_STREAM_WRITE_AFTER_END" || error.message.includes("write after end");
}

function isExpectedConnectionAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    causeCode === "UND_ERR_SOCKET" ||
    error.name === "AbortError" ||
    error.message === "terminated"
  );
}

function endResponse(nodeRes: ServerResponse, chunk?: string): void {
  if (!isResponseWritable(nodeRes)) return;
  nodeRes.end(chunk);
}

async function waitForDrainOrClose(nodeRes: ServerResponse): Promise<void> {
  if (!isResponseWritable(nodeRes)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      nodeRes.off("drain", done);
      nodeRes.off("close", done);
      nodeRes.off("error", fail);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      if (isWriteAfterEndError(error)) {
        resolve();
        return;
      }
      reject(error);
    };

    nodeRes.once("drain", done);
    nodeRes.once("close", done);
    nodeRes.once("error", fail);
  });
}

/**
 * Convert a Node.js IncomingMessage into a Web API Request.
 */
function toWebRequest(nodeReq: IncomingMessage, hostname: string, port: number, scheme: "http" | "https", signal: AbortSignal): Request {
  const url = `${scheme}://${hostname}:${port}${nodeReq.url ?? "/"}`;
  const method = nodeReq.method ?? "GET";
  const headers = new Headers();

  // Node headers can be string | string[] | undefined
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";

  // Readable.toWeb() returns a Node stream/web ReadableStream which is structurally
  // compatible with the global ReadableStream but TypeScript treats them as distinct.
  const body = hasBody
    ? (Readable.toWeb(nodeReq) as unknown as ReadableStream<Uint8Array>)
    : null;

  return new Request(url, {
    method,
    headers,
    body,
    signal,
    // @ts-expect-error duplex is required for streaming request bodies in Node
    duplex: hasBody ? "half" : undefined,
  });
}

/**
 * Write a Web API Response to a Node.js ServerResponse.
 */
async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  const headersObj: Record<string, string | string[]> = {};
  webRes.headers.forEach((value, key) => {
    const existing = headersObj[key];
    if (existing) {
      headersObj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headersObj[key] = value;
    }
  });

  if (!isResponseWritable(nodeRes)) return;

  nodeRes.writeHead(webRes.status, headersObj);

  if (!webRes.body) {
    endResponse(nodeRes);
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!isResponseWritable(nodeRes)) break;
      if (!nodeRes.write(value)) {
        await waitForDrainOrClose(nodeRes);
      }
    }
  } finally {
    reader.releaseLock();
    endResponse(nodeRes);
  }
}

/** Bun 1.3's ordinary response-body consumer leaves an unhandled rejection
 * when a source fails after its first chunk. Its direct sink owns that error
 * path. Forward bytes under backpressure and retain request cancellation. */
function bunStreamingResponse(response: Response, request: Request): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const source: Bun.DirectUnderlyingSource<Uint8Array> = {
    type: "direct",
    async pull(controller) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) { controller.end(); return; }
          await controller.write(next.value);
        }
      } catch (error) {
        if (!isExpectedConnectionAbort(error) && !request.signal.aborted) console.error("[serve-node] Response stream error:", error);
        controller.close(error instanceof Error ? error : new Error("Response stream failed"));
      } finally {
        request.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    },
    async cancel(reason: unknown) { await reader.cancel(reason).catch(() => {}); },
  };
  // @ts-expect-error DOM declarations omit Bun's typed DirectUnderlyingSource constructor overload.
  const body = new ReadableStream<Uint8Array>(source);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Start an HTTP server with a Web-standard fetch handler.
 *
 * Interface mirrors Bun.serve() so the caller doesn't need to change.
 */
export function serve(options: ServeOptions): Promise<ServeResult> {
  // Bun's node:http shim loses disconnect events after a request body is read.
  // Its native Request retains the abort signal while approvals are pending.
  // Electron and ordinary Node continue to use the adapter below.
  if (typeof Bun !== "undefined") {
    const start = (port: number) => Bun.serve({
      hostname: options.hostname, port, idleTimeout: options.idleTimeout,
      development: false,
      // Bun 1.3.14 can share the listener when this is omitted. These are
      // independently authenticated servers; an occupied port must fall back.
      reusePort: false,
      // Raw HTTP preserves complete Fetch bodies. Bound other requests at
      // their existing route readers, without a second global payload cap.
      maxRequestBodySize: Infinity,
      // Body failures happen after fetch has returned. Handle them through
      // Bun's server boundary too; never expose its development error page.
      error(error) {
        if (!isExpectedConnectionAbort(error)) console.error("[serve-node] Response stream error:", error);
        return Response.json({ error: "internal_error" }, { status: 500 });
      },
      ...(options.tls ? { tls: options.tls } : {}),
      fetch: async (request: Request, server) => {
        // A human approval may outlive the connection's idle timeout. Node's
        // keepAliveTimeout likewise does not expire an active request handler.
        server.timeout(request, 0);
        try { return bunStreamingResponse(await options.fetch(request), request); }
        catch (error) {
          if (!isExpectedConnectionAbort(error)) console.error("[serve-node] Unhandled error:", error);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    });
    try {
      let server;
      try { server = start(options.port); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
        server = start(0);
      }
      const port = server.port;
      if (port === undefined) throw new Error("The HTTP server did not bind a port");
      let stopping: Promise<void> | undefined;
      return Promise.resolve({ port, stop: () => stopping ??= server.stop(true) });
    } catch (error) { return Promise.reject(error); }
  }
  const { hostname, port, fetch: fetchHandler } = options;
  const scheme: "http" | "https" = options.tls ? "https" : "http";

  const handleRequest = async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!nodeRes.writableEnded) abort(); };
    nodeReq.once("aborted", abort);
    nodeRes.once("close", close);
    nodeRes.on("error", (error) => {
      if (isWriteAfterEndError(error)) {
        console.warn("[serve-node] Ignored response write after end");
        return;
      }
      console.error("[serve-node] Response stream error:", error);
    });

    try {
      const webReq = toWebRequest(nodeReq, hostname, boundPort, scheme, controller.signal);
      const webRes = await fetchHandler(webReq);
      await writeWebResponse(webRes, nodeRes);
    } catch (error) {
      if (isExpectedConnectionAbort(error)) {
        if (isResponseWritable(nodeRes) && !nodeRes.headersSent) {
          nodeRes.destroy();
        }
        return;
      }
      console.error("[serve-node] Unhandled error:", error);
      if (!isResponseWritable(nodeRes)) return;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { "Content-Type": "application/json" });
      }
      endResponse(nodeRes, JSON.stringify({ error: "internal_error" }));
    } finally {
      nodeReq.off("aborted", abort);
      nodeRes.off("close", close);
    }
  };

  const server = options.tls
    ? createTlsServer({ cert: options.tls.cert, key: options.tls.key }, handleRequest)
    : createServer(handleRequest);

  // Set keep-alive timeout to match Bun's idleTimeout
  if (options.idleTimeout) {
    server.keepAliveTimeout = options.idleTimeout * 1000;
  }

  let boundPort = port;

  return new Promise<ServeResult>((resolve, reject) => {
    // The caller probes port availability before calling us, but that
    // check-then-bind is racy: a just-stopped server may not have released the
    // socket yet. On EADDRINUSE, retry once with an OS-assigned free port
    // (port 0) instead of failing the whole startup.
    let retriedFreePort = false;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && !retriedFreePort) {
        retriedFreePort = true;
        server.listen(0, hostname);
        return;
      }
      reject(error);
    });
    server.listen(port, hostname, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      let stopPromise: Promise<void> | null = null;
      resolve({
        port: boundPort,
        stop: () => {
          if (stopPromise) return stopPromise;
          stopPromise = new Promise<void>((stopResolve, stopReject) => {
            server.close((error) => {
              if (error) {
                if (String(error).includes("ERR_SERVER_NOT_RUNNING") || String(error).includes("Server is not running")) {
                  stopResolve();
                  return;
                }
                stopReject(error);
                return;
              }
              stopResolve();
            });
            server.closeAllConnections();
          });
          return stopPromise;
        },
      });
    });
  });
}
