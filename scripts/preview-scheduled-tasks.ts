// Isolated visual fixture: real server/store/scheduler, simulated OpenCode delivery.
// Run: pnpm exec bun scripts/preview-scheduled-tasks.ts
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../apps/server/src/types";

const root = await mkdtemp(join(tmpdir(), "legalwork-scheduled-preview-"));
process.env.XDG_CONFIG_HOME = root;
process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
const { startServer } = await import("../apps/server/src/server");
const { ScheduledTaskStore } = await import("../apps/server/src/scheduled-tasks/store");
const folder = join(root, "Northstar Legal");
await mkdir(join(folder, ".git"), { recursive: true });
const sessions = new Map(["Matter planning", "Weekly practice review", "Acquisition due diligence"].map((title, index) => [`chat-${index}`, { id: `chat-${index}`, title, directory: folder, time: {} }]));
const engine = Bun.serve({ port: 0, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname === "/agent") return Response.json([{ name: "legalwork-scheduled-project", permission: [{ permission: "*", pattern: "*", action: "deny" }] }, { name: "legalwork-scheduled-all", permission: [] }]);
  if (url.pathname === "/session/status") return Response.json({});
  if (url.pathname === "/session" && request.method === "GET") return Response.json([...sessions.values()].filter(session => session.title.toLowerCase().includes((url.searchParams.get("search") ?? "").toLowerCase())));
  if (url.pathname === "/session" && request.method === "POST") {
    const id = `chat-${sessions.size}`;
    const session = { id, title: "Scheduled run", directory: folder, time: {} }; sessions.set(id, session); return Response.json(session);
  }
  if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
  const session = sessions.get(url.pathname.split("/")[2]);
  return session ? Response.json(session) : new Response(null, { status: 404 });
} });
const config: ServerConfig = {
  host: "127.0.0.1", port: 8798, token: "scheduled-preview", hostToken: "scheduled-preview-host", configPath: join(root, "server.json"),
  approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["http://localhost:5197", "http://127.0.0.1:5197", "http://localhost:5213"],
  workspaces: [{ id: "preview", name: "Northstar Legal", path: folder, preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` }],
  authorizedRoots: [folder], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
};
const store = await ScheduledTaskStore.open(process.env.LEGALWORK_RUNTIME_DB);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
store.create("preview", { title: "Morning matter brief", prompt: "Review this project's tasks and calendar. Summarize upcoming deadlines, open work and items that need my attention. Link to the source records.", sessionId: "chat-0", model: null, schedule: { kind: "rrule", startAt: `${tomorrow}T09:00:00`, timeZone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" } });
store.create("preview", { title: "Weekly project review", prompt: "Summarize this week's progress, outstanding questions and decisions needed from me.", sessionId: null, model: null, schedule: { kind: "rrule", startAt: `${tomorrow}T16:00:00`, timeZone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=FR" } });
const paused = store.create("preview", { title: "Check document intake", prompt: "Summarize newly received documents. Flag missing information for review.", sessionId: "chat-2", model: null, schedule: { kind: "interval", startAt: `${tomorrow}T10:00:00`, timeZone: "Europe/Berlin", minutes: 120 } });
store.update("preview", paused.id, paused.revision, { status: "paused" });
const server = await startServer(config);
console.log(`Scheduling preview API: http://127.0.0.1:${server.port}. Model responses are simulated; state is isolated in a temporary directory.`);
const cleanup = async () => { await server.stop(); engine.stop(true); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", cleanup); process.once("SIGTERM", cleanup);
