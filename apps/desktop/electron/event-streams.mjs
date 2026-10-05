// Event streams use Node's transport so full app windows do not exhaust
// Chromium's shared HTTP/1 connection pool. Each read pulls just one chunk.
export function createEventStreams(fetchImpl = fetch) {
  const owners = new Map();

  function cancel(owner, id) {
    const streams = owners.get(owner);
    const stream = streams?.get(id);
    if (!stream) return;
    streams.delete(id);
    stream.controller.abort();
  }

  return {
    async open(owner, id, url, headers) {
      if (owner.isDestroyed()) throw new Error("Window is closed.");
      if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("HTTP URL required.");
      let streams = owners.get(owner);
      if (!streams) {
        streams = new Map();
        owners.set(owner, streams);
        owner.once("destroyed", () => {
          for (const stream of streams.values()) stream.controller.abort();
          owners.delete(owner);
        });
      }
      if (streams.has(id)) throw new Error("Stream already exists.");
      const stream = { controller: new AbortController(), reader: null };
      streams.set(id, stream);
      try {
        const response = await fetchImpl(url, { headers, signal: stream.controller.signal });
        stream.controller.signal.throwIfAborted();
        stream.reader = response.body?.getReader();
        return { status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()) };
      } catch (error) {
        cancel(owner, id);
        throw error;
      }
    },
    async read(owner, id) {
      const stream = owners.get(owner)?.get(id);
      if (!stream) throw new Error("Stream is closed or belongs to another window.");
      try {
        const chunk = stream.reader ? await stream.reader.read() : { done: true };
        if (chunk.done) {
          cancel(owner, id);
          return null;
        }
        return chunk.value;
      } catch (error) {
        const cancelled = stream.controller.signal.aborted;
        cancel(owner, id);
        // Window closure and renderer cancellation are normal end-of-stream.
        if (cancelled) return null;
        throw error;
      }
    },
    cancel,
  };
}
