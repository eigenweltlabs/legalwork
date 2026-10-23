/** Buffered HTTP requests owned by a window, with cancellation and body deadlines. */
export function createHttpRequests(fetchImpl = fetch) {
  const owners = new Map();
  function cancel(owner, id) {
    owners.get(owner)?.get(id)?.abort();
  }
  return {
    cancel,
    async fetch(owner, url, init = {}) {
      if (owner.isDestroyed()) throw new Error("Window is closed.");
      if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("HTTP URL required.");
      let requests = owners.get(owner);
      if (!requests) {
        requests = new Map();
        owners.set(owner, requests);
        owner.once("destroyed", () => {
          for (const controller of requests.values()) controller.abort();
          owners.delete(owner);
        });
      }
      const id = init.requestId ?? crypto.randomUUID();
      if (requests.has(id)) throw new Error("Request already exists.");
      const controller = new AbortController();
      requests.set(id, controller);
      const ms = Number(init.timeoutMs);
      const timer = Number.isFinite(ms) && ms > 0 ? setTimeout(() => controller.abort(), ms) : undefined;
      timer?.unref?.();
      try {
        const response = await fetchImpl(url, {
          method: typeof init.method === "string" ? init.method : undefined,
          headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
          body: typeof init.body === "string" ? init.body : undefined,
          signal: controller.signal,
        });
        const body = await response.text();
        controller.signal.throwIfAborted();
        return { status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()), body };
      } finally {
        clearTimeout(timer);
        requests.delete(id);
      }
    },
  };
}
