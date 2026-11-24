import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { MANAGED_ENGINE_DB_FILENAME } from "../managed-opencode-db.js";
import { runtimeStorageDir } from "../runtime-opencode-config-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";

test("a host chat submitted from a workspace reaches the activity list with both agent visibility states", async () => {
  const root = await mkdtemp(join(tmpdir(), "timekeeping-chat-route-"));
  const now = Date.now(), started = now - 6000, middle = now - 3000, completed = now - 1000;
  const session = { id: "chat", projectID: "matter", title: "Vendor agreement", location: { directory: root }, time: { created: started, updated: completed } };
  const sent = { id: "msg_local", type: "user", text: "Compare the vendor clauses.", time: { created: started } };
  const reply = { id: "msg_answer", type: "assistant", agent: "fixture", model: { id: "fixture", providerID: "fixture" }, time: { created: started, completed },
    content: [{ type: "reasoning", text: "PRIVATE_REASONING" }, { type: "text", text: "The notice terms differ." }] };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/session/scheduled") return Response.json({ data: { ...session, id: "scheduled", title: "Scheduled precedent check" } });
    if (path === "/api/session/scheduled/message") return Response.json({ data: [{ ...reply, id: "automated", content: [{ type: "text", text: "Checked the new precedent." }] }], cursor: {} });
    if (path === "/api/session/chat") return request.method === "GET" ? Response.json({ data: session }) : new Response(null, { status: 204 });
    if (path === "/api/session/chat/prompt") return Response.json({ data: sent });
    if (path === "/api/session/chat/message") return Response.json({ data: [reply, sent], cursor: {} });
    return Response.json({ data: [] });
  } });
  const config = backOfficeTestConfig(root, { authorizedRoots: [root], workspaces: [{ id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.url.origin }] });
  const storage = runtimeStorageDir(config);
  await mkdir(storage, { recursive: true });
  const db = new Database(join(storage, MANAGED_ENGINE_DB_FILENAME));
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  db.query("INSERT INTO session_v2 VALUES(?, ?)").run("scheduled", root);
  db.query("INSERT INTO session_message VALUES(?, ?, ?, ?)").run("scheduled", "assistant", started, JSON.stringify({ time: { completed } }));
  db.close();
  const server = await startServer(config);
  const call = (path: string, data?: unknown) => fetch("http://127.0.0.1:" + server.port + path, {
    method: data ? "POST" : "GET", headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  try {
    const { profileId } = await (await call("/private-timesheet/activity")).json();
    const dispatched = await call("/workspace/matter/sessions/chat/dispatch", {
      kind: "prompt", id: sent.id, delivery: "steer", text: sent.text + " INTERNAL_REMINDER", metadata: { legalworkPrompt: { visibleText: sent.text } },
    });
    expect({ status: dispatched.status, error: dispatched.ok ? null : await dispatched.text() }).toEqual({ status: 200, error: null });
    const row = { projectId: "matter", stream: "chat", kind: "agent", title: session.title, surface: "chat" };
    expect((await call("/private-timesheet/activity", { profileId, observations: [
      { projectId: null, kind: "window", stream: "local", start: started - 1, end: completed + 1 },
      { ...row, start: started, end: middle, agentVisibility: "foreground" }, { ...row, start: middle, end: completed, agentVisibility: "background" },
    ] })).status).toBe(200);
    const date = new Date(now).toISOString().slice(0, 10);
    const path = "/private-timesheet/activity?" + new URLSearchParams({ profileId, date, zone: "UTC" });
    const response = await call(path);
    expect(response.status).toBe(200);
    const items = await response.json();
    expect(items.filter((r: { observation?: string; narrative: string }) => r.observation === "agent" && r.narrative.includes("Vendor agreement")).map((r: { agentVisibility: string }) => r.agentVisibility)).toEqual(["foreground", "background"]);
    expect(items.map((r: { changeSummary?: string }) => r.changeSummary)).toContain(sent.text);
    expect(items.map((r: { changeSummary?: string }) => r.changeSummary)).toContain("The notice terms differ.");
    expect(items).toContainEqual(expect.objectContaining({ narrative: "Agent run: Scheduled precedent check", agentVisibility: "background" }));
    expect(items).toContainEqual(expect.objectContaining({ changeSummary: "Checked the new precedent." }));
    expect(JSON.stringify(items)).not.toMatch(/INTERNAL_REMINDER|PRIVATE_REASONING/);
    expect((await call(path.replace(profileId, "x".repeat(64)))).status).toBe(409);
  } finally { await server.stop(); engine.stop(true); await rm(root, { recursive: true, force: true }); }
});
