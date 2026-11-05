import { request } from "node:http";

function streamError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The benchmark observes an authenticated, already-scoped loopback endpoint.
// A dedicated standard HTTP request has no fetch/Undici body idle deadline,
// transparent decoding, redirect, reconnect, or shared dispatcher mutation.
export function openEventStream(endpoint, { headers, signal }) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash) {
    throw streamError("Event capture requires an explicit loopback HTTP endpoint", "EVENT_STREAM_ENDPOINT");
  }
  if (!signal || typeof signal.addEventListener !== "function") {
    throw streamError("Event capture requires its owned AbortSignal", "EVENT_STREAM_SIGNAL");
  }
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      agent: false,
      timeout: 0,
      signal,
      headers: { ...headers, accept: "text/event-stream", "accept-encoding": "identity" },
    });
    req.once("error", reject);
    req.once("response", response => {
      const status = response.statusCode;
      const mediaType = response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      let error;
      if (status < 200 || status >= 300) error = streamError(`Event capture HTTP ${status}`, "EVENT_STREAM_HTTP_STATUS");
      else if (mediaType !== "text/event-stream") error = streamError("Event capture response is not text/event-stream", "EVENT_STREAM_CONTENT_TYPE");
      else if (encoding && encoding !== "identity") error = streamError("Event capture response unexpectedly encoded its bytes", "EVENT_STREAM_CONTENT_ENCODING");
      if (error) {
        response.destroy();
        reject(error);
        return;
      }
      resolve(response);
    });
    req.end();
  });
}

// Store only Error diagnostics, never request objects or authorization headers.
// The complete cause chain is retained privately, including native error codes.
export function eventStreamErrorEvidence(error, seen = new Set()) {
  if (error === null || typeof error !== "object") return { value: String(error) };
  if (seen.has(error)) return { circular: true };
  seen.add(error);
  const record = {};
  for (const field of ["name", "message", "stack", "code", "errno", "syscall", "address", "port"]) {
    if (["string", "number"].includes(typeof error[field])) record[field] = error[field];
  }
  if (error.cause !== undefined) record.cause = eventStreamErrorEvidence(error.cause, seen);
  if (Array.isArray(error.errors)) record.errors = error.errors.map(item => eventStreamErrorEvidence(item, seen));
  return record;
}
