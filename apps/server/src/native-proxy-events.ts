import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { isInternalSession } from "./native-shared-values.js";

/** Native events contain project data. Stream only authorized locations while
 * preserving global catalog invalidations and the complete event payload. */
export function scopedNativeEvents(client: OpenCodeClient, allowed: (directory: string) => Promise<boolean>, signal: AbortSignal, invalidate?: (close: () => void) => () => void) {
  const controller = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const combined = AbortSignal.any([signal, controller.signal]);
  const sessions = new Map<string, boolean>();
  const locations = new Map<string, Promise<boolean>>();
  const locationAllowed = (directory: string) => {
    const found = locations.get(directory);
    if (found) return found;
    const result = allowed(directory);
    locations.set(directory, result);
    return result;
  };
  const sessionAllowed = async (id: string) => {
    if (sessions.has(id)) return sessions.get(id) === true;
    const session = await client.session.get({ sessionID: id }).catch(() => null);
    const result = session && !isInternalSession(session) ? await locationAllowed(session.location.directory) : false;
    sessions.set(id, result);
    return result;
  };
  const visible = async (event: OpenCodeEvent) => {
    if ("data" in event && typeof event.data === "object" && event.data !== null) {
      if (isInternalSession(event.data)) {
        if ("id" in event.data && typeof event.data.id === "string") sessions.set(event.data.id, false);
        return false;
      }
      if ("sessionID" in event.data && typeof event.data.sessionID === "string" && !await sessionAllowed(event.data.sessionID)) return false;
    }
    if (event.location) return locationAllowed(event.location.directory);
    if ("data" in event && typeof event.data === "object" && event.data !== null) {
      if ("location" in event.data && typeof event.data.location === "object" && event.data.location !== null && "directory" in event.data.location && typeof event.data.location.directory === "string") return locationAllowed(event.data.location.directory);
      if ("sessionID" in event.data && typeof event.data.sessionID === "string") return sessionAllowed(event.data.sessionID);
    }
    // Unscoped plugin/session/project payloads are not inherently public.
    return /^(?:server\.|credential\.|integration\.|model\.|models-dev\.|provider\.|config\.)/.test(event.type);
  };
  const encoder = new TextEncoder();
  const iterator = client.event.subscribe({ signal: combined })[Symbol.asyncIterator]();
  return new Response(new ReadableStream<Uint8Array>({
    start() { unsubscribe = invalidate?.(() => controller.abort()); },
    async pull(stream) {
      try {
        while (!combined.aborted) {
          const item = await iterator.next();
          if (item.done) break;
          if (await visible(item.value)) {
            stream.enqueue(encoder.encode(`data: ${JSON.stringify(item.value)}\n\n`));
            return;
          }
        }
        unsubscribe?.();
        stream.close();
      } catch (error) {
        unsubscribe?.();
        if (!combined.aborted) stream.error(error);
        else { try { stream.close(); } catch {} }
      }
    },
    async cancel() { unsubscribe?.(); controller.abort(); await iterator.return?.(); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
