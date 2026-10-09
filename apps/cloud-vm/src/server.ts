import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Store, UserId } from "./store.js";
import { Lifecycle } from "./lifecycle.js";
import { E2BRuntime } from "./e2b.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided.replace(/^Bearer /i, ""));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
const token = readFileSync(required("CONTROLLER_TOKEN_FILE"), "utf8").trim();
const store = new Store(required("CONTROLLER_DB"));
const runtime = new E2BRuntime({
  apiKey: readFileSync(required("E2B_API_KEY_FILE"), "utf8").trim(),
  apiUrl: required("E2B_API_URL"), sandboxUrl: required("E2B_SANDBOX_URL"),
});
const lifecycle = new Lifecycle(store, runtime, required("E2B_LEGALWORK_TEMPLATE"));

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.CONTROLLER_PORT ?? "8788"), idleTimeout: 255,
  maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ready: true, workers: store.all().length });
    const match = /^\/users\/([a-zA-Z0-9_-]+)\/(provision|activate|wake|pause|status|worker)(\/.*)?$/.exec(url.pathname);
    if (!match || !UserId.safeParse(match[1]).success) return new Response("Not found", { status: 404 });
    const userId = match[1]!;
    const action = match[2];
    const worker = store.get(userId);
    if (action === "worker") {
      if (!worker || !secretMatches(request.headers.get("authorization"), worker.clientToken)) return new Response("Unauthorized", { status: 401 });
      const suffix = match[3] ?? "/";
      // Only the controller may invoke lifecycle or host-only operations.
      if (suffix.startsWith("/cloud-sync/")) return new Response("Forbidden", { status: 403 });
      try {
        const lease = await lifecycle.acquire(userId);
        try {
          const headers = new Headers(request.headers);
          for (const key of [...headers.keys()]) {
            if (key.startsWith("e2b-") || key.startsWith("x-legalwork-host") || ["host", "connection", "content-length", "transfer-encoding"].includes(key)) headers.delete(key);
          }
          const response = await runtime.request(lease.worker, suffix + url.search, {
            method: request.method, headers, signal: request.signal,
            ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.arrayBuffer() }),
          });
          if (!response.body) { lease.release(); return response; }
          const reader = response.body.getReader();
          return new Response(new ReadableStream({
            async pull(controller) {
              try {
                const value = await reader.read();
                if (value.done) { lease.release(); controller.close(); }
                else controller.enqueue(value.value);
              } catch (error) { lease.release(); controller.error(error); }
            },
            async cancel(reason) { lease.release(); await reader.cancel(reason); },
          }), { status: response.status, headers: response.headers });
        } catch (error) { lease.release(); throw error; }
      } catch { return Response.json({ error: "Worker unavailable; execution is blocked" }, { status: 503 }); }
    }
    if (!secretMatches(request.headers.get("authorization"), token)) return new Response("Unauthorized", { status: 401 });
    try {
      if (action === "status" && request.method === "GET") {
        if (!worker) return new Response("Not found", { status: 404 });
        return Response.json({ userId, sandboxId: worker.sandboxId, state: worker.state, synced: worker.synced, nextRunAt: worker.nextRunAt });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (action === "provision") {
        if (process.env.ALLOW_UNSYNCED_DEVELOPMENT_WORKERS !== "1") return Response.json({ error: "User connection provisioning is not configured" }, { status: 409 });
        const created = await lifecycle.provision(userId);
        return Response.json({ userId, sandboxId: created.sandboxId, synced: false, workerUrl: `/users/${userId}/worker`, clientToken: created.clientToken }, { status: 201 });
      }
      if (action === "wake") await lifecycle.wake(userId);
      else if (action === "pause") await lifecycle.pause(userId);
      else if (action === "activate") await lifecycle.activate(userId);
      return Response.json({ ok: true });
    } catch { return Response.json({ error: "Lifecycle operation failed; check worker state" }, { status: 409 }); }
  },
});
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await lifecycle.tick(); } finally { ticking = false; }
}, 30_000);
console.log(`LegalWork VM controller listening on ${server.hostname}:${server.port}`);
process.on("SIGTERM", async () => {
  clearInterval(timer);
  await server.stop(true);
  store.close();
  process.exit(0);
});
