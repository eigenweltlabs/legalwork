import type { DesktopFetchInit, DesktopFetchResult } from "@legalwork/types/desktop-ipc";

type TextBridge = {
  __fetch: (url: string, init: DesktopFetchInit) => Promise<DesktopFetchResult>;
  __fetchCancel: (id: string) => Promise<void>;
};

/** Carry cancellation across IPC, including while the main process reads the body. */
export async function fetchDesktopText(bridge: TextBridge, input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal;
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? request?.headers);
  const method = init?.method ?? request?.method;
  const body = typeof init?.body === "string" ? init.body : request?.body ? await request.clone().text() : undefined;
  signal?.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void bridge.__fetchCancel(id).catch(() => {});
      reject(signal?.reason ?? new DOMException("Request cancelled", "AbortError"));
    };
  });
  // Start before registering abort: IPC messages from this renderer retain order.
  const pending = bridge.__fetch(url, { requestId: id, method, headers: Object.fromEntries(headers.entries()), body, timeoutMs });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([pending, cancelled]);
    return new Response([101, 204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status, statusText: result.statusText, headers: result.headers,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
