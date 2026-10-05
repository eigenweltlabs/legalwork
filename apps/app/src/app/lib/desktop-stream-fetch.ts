import type { DesktopCommandInvokers } from "@legalwork/types/desktop-ipc";

type StreamBridge = Pick<DesktopCommandInvokers, "__streamOpen" | "__streamRead" | "__streamCancel">;

/** Pull-based IPC keeps event streams out of the renderer's shared HTTP pool. */
export async function fetchDesktopStream(bridge: StreamBridge, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.method !== "GET") throw new Error("Event streams require GET.");
  request.signal.throwIfAborted();
  const id = crypto.randomUUID();
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const cleanup = () => {
    finished = true;
    request.signal.removeEventListener("abort", abort);
  };
  const cancel = () => { void bridge.__streamCancel(id).catch(() => {}); };
  const abort = () => {
    cleanup();
    body?.error(request.signal.reason);
    cancel();
  };
  // Start before installing the abort handler so cancellation cannot overtake open.
  const opening = bridge.__streamOpen(id, request.url, Object.fromEntries(request.headers.entries()));
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const metadata = await opening;
    request.signal.throwIfAborted();
    if ([204, 205, 304].includes(metadata.status)) {
      cleanup();
      cancel();
      return new Response(null, metadata);
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { body = controller; },
      async pull(controller) {
        try {
          const chunk = await bridge.__streamRead(id);
          if (finished) return;
          if (chunk === null) {
            cleanup();
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        } catch (error) {
          if (finished) return;
          cleanup();
          cancel();
          controller.error(error);
        }
      },
      cancel() { cleanup(); cancel(); },
    }), metadata);
  } catch (error) {
    cleanup();
    cancel();
    throw error;
  }
}
