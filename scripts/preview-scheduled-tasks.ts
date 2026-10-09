// Isolated visual fixture: real server/store/scheduler, simulated OpenCode delivery.
// Run: pnpm exec bun scripts/preview-scheduled-tasks.ts
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../apps/server/src/types";

const root = await mkdtemp(join(tmpdir(), "legalwork-scheduled-preview-"));
process.env.XDG_CONFIG_HOME = root;
process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
process.env.OPENCODE_DB = join(root, "opencode.sqlite");
const inboxDb = new Database(process.env.OPENCODE_DB);
inboxDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE INDEX message_session ON message(session_id);");
const { startServer } = await import("../apps/server/src/server");
const { ScheduledTaskStore } = await import("../apps/server/src/scheduled-tasks/store");
const folder = join(root, "Northstar Legal");
await mkdir(join(folder, ".git"), { recursive: true });
const sessions = new Map(["Matter planning", "Weekly practice review", "Acquisition due diligence"].map((title, index) => [`chat-${index}`, { id: `chat-${index}`, title, directory: folder, slug: `chat-${index}`, version: "1", projectID: "preview", time: { created: Date.now(), updated: Date.now() } }]));
for (const session of sessions.values()) inboxDb.query("INSERT INTO session VALUES (?, ?, ?, NULL)").run(session.id, folder, session.time.updated);
const engine = Bun.serve({ port: 0, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname === "/agent") return Response.json([{ name: "legalwork-scheduled-project", permission: [{ permission: "*", pattern: "*", action: "deny" }] }, { name: "legalwork-scheduled-all", permission: [] }]);
  if (url.pathname === "/session/status") return Response.json({});
  if (url.pathname === "/session" && request.method === "GET") return Response.json([...sessions.values()].filter(session => session.title.toLowerCase().includes((url.searchParams.get("search") ?? "").toLowerCase())));
  if (url.pathname === "/session" && request.method === "POST") {
    const id = `chat-${sessions.size}`;
    const body = await request.json();
    const session = { id, title: body.title ?? "Scheduled run", directory: folder, slug: id, version: "1", projectID: "preview", time: { created: Date.now(), updated: Date.now() } };
    sessions.set(id, session);
    inboxDb.query("INSERT INTO session VALUES (?, ?, ?, NULL)").run(id, folder, session.time.updated);
    return Response.json(session);
  }
  if (url.pathname.endsWith("/prompt_async")) {
    const id = url.pathname.split("/")[2], at = Date.now();
    inboxDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run(`reply-${at}`, id, at, JSON.stringify({ role: "assistant", time: { completed: at } }));
    inboxDb.query("UPDATE session SET time_updated = ? WHERE id = ?").run(at, id);
    return new Response(null, { status: 204 });
  }
  if (url.pathname.endsWith("/message") || url.pathname.endsWith("/todo") || url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
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
store.create("preview", { title: "Morning matter brief", prompt: "Review this project's tasks and calendar. Summarize upcoming deadlines, open work and items that need my attention. Link to the source records.", sessionId: "chat-0", model: null, schedule: { kind: "rrule", startAt: `${tomorrow}T06:00:00`, timeZone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" } });
store.create("preview", { title: "End of Week review", prompt: "Summarize this week's progress, outstanding questions and decisions needed from me.", sessionId: null, model: null, schedule: { kind: "rrule", startAt: `${tomorrow}T16:00:00`, timeZone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=FR" } });
const paused = store.create("preview", { title: "Check document intake", prompt: "Summarize newly received documents. Flag missing information for review.", sessionId: "chat-2", model: null, schedule: { kind: "interval", startAt: `${tomorrow}T10:00:00`, timeZone: "Europe/Berlin", minutes: 120 } });
store.update("preview", paused.id, paused.revision, { status: "paused" });
const server = await startServer(config);
console.log(`Scheduling preview API: http://127.0.0.1:${server.port}. Model responses are simulated; state is isolated in a temporary directory.`);
const cleanup = async () => { await server.stop(); engine.stop(true); inboxDb.close(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", cleanup); process.once("SIGTERM", cleanup);
