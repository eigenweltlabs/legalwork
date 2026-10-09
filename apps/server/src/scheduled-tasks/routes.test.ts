import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authenticated HTTP lifecycle, local scope, restart delivery and engine integration", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduled-http-")), script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, rename } from "node:fs/promises";
    import { join } from "node:path";
    import assert from "node:assert/strict";
    const { startServer } = await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)});
    const { ScheduledTaskStore } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "project");
    await mkdir(join(folder, ".git"), { recursive: true });
    const sessions = new Map([["existing", { id: "existing", title: "Matter chat", directory: folder, time: {} }], ["foreign", { id: "foreign", title: "Other project", directory: root, time: {} }], ["archived", { id: "archived", title: "Archived", directory: folder, time: { archived: 1 } }]]);
    const { Database } = await import("bun:sqlite");
    const inboxDb = new Database(process.env.OPENCODE_DB);
    inboxDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE INDEX message_session ON message(session_id);");
    for (const session of sessions.values()) inboxDb.query("INSERT INTO session VALUES (?, ?, ?, ?)").run(session.id, session.directory, Date.now(), session.time.archived ?? null);
    inboxDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("user", "existing", 100, JSON.stringify({ role: "user" }));
    inboxDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("summary", "existing", 200, JSON.stringify({ role: "assistant", summary: true }));
    const deliveries = [];
    let restrictiveAgent = true;
    let busy = false, failStatuses = false;
    const agents = () => [{ name: "legalwork-scheduled-project", permission: restrictiveAgent ? [{ permission: "*", pattern: "*", action: "deny" }, { permission: "legalwork_project_read", pattern: "*", action: "allow" }] : [] }, { name: "legalwork-scheduled-all", permission: [] }];
    const engine = Bun.serve({ port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/agent") return Response.json(agents());
      if (path === "/session/status") return failStatuses ? new Response(null, { status: 503 }) : Response.json(busy ? { existing: { type: "busy" } } : {});
      if (path === "/session" && request.method === "GET") return Response.json([...sessions.values()]);
      if (path === "/session" && request.method === "POST") {
        const id = "new-" + sessions.size;
        const session = { id, title: (await request.json()).title, directory: folder, time: {} };
        sessions.set(id, session);
        inboxDb.query("INSERT INTO session VALUES (?, ?, ?, ?)").run(id, folder, Date.now(), null);
        return Response.json(session);
      }
      if (path.endsWith("/prompt_async")) {
        deliveries.push(await request.json());
        inboxDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("reply-" + deliveries.length, path.split("/")[2], 300, JSON.stringify({ role: "assistant", finish: "stop", time: { completed: 400 } }));
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/session/")) { const session = sessions.get(path.split("/")[2]); return session ? Response.json(session) : new Response(null, { status: 404 }); }
      return Response.json({});
    } });
    const config = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], opencodeBaseUrl: "http://127.0.0.1:" + engine.port,
      workspaces: [{ id: "project", name: "Test", path: folder, preset: "starter", workspaceType: "local", baseUrl: "http://127.0.0.1:" + engine.port }, { id: "other", name: "Other", path: root, preset: "starter", workspaceType: "local" }, { id: "remote", name: "Remote", path: root, preset: "starter", workspaceType: "remote" }],
      authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const store = await ScheduledTaskStore.open(process.env.LEGALWORK_RUNTIME_DB);
    const missedDueAt = Date.now() - 5 * 60000;
    const seed = store.create("project", { title: "Catch up", prompt: "Review the matter", sessionId: null, model: null, schedule: { kind: "once", startAt: new Date(missedDueAt).toISOString(), timeZone: "Europe/Berlin" } }, missedDueAt - 60000);
    let server = await startServer(config);
    let base = "http://127.0.0.1:" + server.port;
    const call = (path, method="GET", body, token="test") => fetch(base + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const path = "/workspace/project/scheduled-tasks";
    try {
      for (let i=0; i<100 && store.runs(seed.id)[0]?.status !== "sent"; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 1);
      const inbox = await (await call("/session-inbox")).json();
      assert.equal((await call("/session-inbox", "GET", undefined, "wrong")).status, 401);
      assert.ok(inbox.sessions.every(entry => entry.workspaceId !== "remote"));
      assert.ok(!inbox.sessions.some(entry => entry.sessionId === "archived"));
      assert.equal(inbox.sessions.find(entry => entry.sessionId === "existing").assistantAt, 0);
      assert.deepEqual(inbox.sessions.find(entry => entry.sessionId === store.runs(seed.id)[0].sessionId).automation, { runId: store.runs(seed.id)[0].id, at: Date.parse(store.runs(seed.id)[0].startedAt), pinRunId: store.runs(seed.id)[0].id });
      assert.equal(inbox.sessions.find(entry => entry.sessionId === store.runs(seed.id)[0].sessionId).assistantAt, 400);
      // Acknowledgements and intermediate tool calls are completed messages,
      // but only the terminal result counts as a new reply.
      const addMessage = (id, data) => inboxDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run(id, "existing", 500, JSON.stringify(data));
      addMessage("ack", { role: "assistant", finish: "tool-calls", time: { completed: 600 } });
      addMessage("streaming", { role: "assistant", time: { created: 700 } });
      busy = true;
      let activity = (await (await call("/session-inbox")).json()).sessions.find(entry => entry.sessionId === "existing");
      assert.equal(activity.assistantAt, 0); assert.equal(activity.status, "busy");
      failStatuses = true;
      activity = (await (await call("/session-inbox")).json()).sessions.find(entry => entry.sessionId === "existing");
      assert.equal(activity.status, "unknown");
      failStatuses = false; busy = false;
      addMessage("final", { role: "assistant", finish: "stop", time: { completed: 800 } });
      activity = (await (await call("/session-inbox")).json()).sessions.find(entry => entry.sessionId === "existing");
      assert.equal(activity.assistantAt, 800); assert.equal(activity.status, "idle");
      assert.equal(store.runs(seed.id)[0].status, "sent");
      assert.equal(store.runs(seed.id)[0].dueAt, new Date(missedDueAt).toISOString());
      assert.ok(Date.parse(store.runs(seed.id)[0].startedAt) >= missedDueAt + 5 * 60000);
      assert.equal(deliveries[0].parts[0].text, "[Scheduled task: Catch up]\\n\\nReview the matter");
      assert.equal(deliveries[0].permission, undefined);
      assert.equal(deliveries[0].agent, "legalwork-scheduled-project");
      assert.equal(store.get("project", seed.id).projectAccess, "project");
      assert.equal(store.get("project", seed.id).reuseChat, false);
      assert.equal(store.runs(seed.id)[0].projectAccess, "project");
      assert.equal((await call(path, "GET", undefined, "wrong")).status, 401);
      const issued = await fetch(base + "/tokens", { method: "POST", headers: { "x-legalwork-host-token": "host", "content-type": "application/json" }, body: JSON.stringify({ scope: "viewer", label: "test" }) });
      const viewer = (await issued.json()).token;
      assert.equal((await call(path, "GET", undefined, viewer)).status, 200);
      assert.equal((await call(path, "POST", {}, viewer)).status, 403);
      const draft = { title: "Daily review", prompt: "Summarize open questions", sessionId: "existing", reuseChat: true, pinSession: false, model: { providerID: "test", modelID: "model" }, schedule: { kind: "rrule", startAt: "2099-01-01T09:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=DAILY" } };
      assert.equal((await call(path, "POST", { ...draft, sessionId: "foreign" })).status, 400);
      assert.equal((await call(path, "POST", { ...draft, sessionId: "archived" })).status, 400);
      assert.equal((await call("/workspace/remote/scheduled-tasks", "POST", draft)).status, 400);
      assert.equal((await call(path + "/preview", "POST", { schedule: { ...draft.schedule, rrule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30" } })).status, 400);
      const chats = await (await call(path + "/chats")).json(); assert.deepEqual(chats.sessions.map(chat => chat.id), ["existing", store.runs(seed.id)[0].sessionId]);
      const preview = await (await call(path + "/preview", "POST", { schedule: draft.schedule })).json(); assert.equal(preview.occurrences.length, 3);
      const created = await call(path, "POST", draft); assert.equal(created.status, 200); const task = (await created.json()).task;
      assert.equal((await call("/workspace/other/scheduled-tasks/"+task.id)).status, 404);
      assert.equal((await call(path+"/"+task.id, "PATCH", { revision: 1, status: "paused" }, viewer)).status, 403);
      const paused = (await (await call(path+"/"+task.id, "PATCH", { revision: 1, status: "paused" })).json()).task; assert.equal(paused.status, "paused");
      assert.equal(paused.model.providerID, "test");
      assert.equal(paused.projectAccess, "project");
      assert.equal(paused.reuseChat, true);
      assert.equal(paused.pinSession, false);
      assert.equal((await call(path+"/"+task.id, "PATCH", { revision: 1, title: "Stale" })).status, 409);
      const resumed = (await (await call(path+"/"+task.id, "PATCH", { revision: 2, status: "active", projectAccess: "all" })).json()).task; assert.equal(resumed.status, "active");
      config.readOnly = true; assert.equal((await call(path+"/"+task.id, "DELETE", { revision: 3 })).status, 403); config.readOnly = false;
      await server.stop(); server = await startServer(config); base = "http://127.0.0.1:" + server.port;
      assert.equal((await (await call(path+"/"+task.id)).json()).task.title, "Daily review");
      assert.equal(store.get("project", task.id).projectAccess, "all");
      assert.equal(store.get("project", task.id).reuseChat, true);
      assert.equal(store.get("project", task.id).pinSession, false);
      assert.equal((await call(path+"/"+task.id, "PATCH", { revision: 3, projectAccess: "everything" })).status, 400);
      const allowed = await (await call("/scheduled-tasks/projects")).json();
      assert.deepEqual(allowed.projects.map(project => project.id), ["project", "other"]);
      assert.equal(deliveries.length, 1);
      await rename(folder, folder + "-offline");
      assert.equal((await call(path+"/"+task.id, "PATCH", { revision: 3, status: "paused" })).status, 200);
      assert.equal((await call(path+"/"+task.id, "DELETE", { revision: 4 })).status, 200);
      await rename(folder + "-offline", folder);
      assert.equal((await call(path+"/"+task.id)).status, 404);
      await server.stop();
      restrictiveAgent = false;
      const rejected = store.create("project", { ...draft, schedule: { kind: "once", startAt: new Date(Date.now()-1000).toISOString(), timeZone: "Europe/Berlin" } }, Date.now()-2000);
      server = await startServer(config);
      for (let i=0; i<100 && store.get("project", rejected.id).status !== "paused"; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 1);
      assert.equal(store.get("project", rejected.id).status, "paused");
      assert.match(store.runs(rejected.id)[0].error, /permissions/);
      await server.stop();
      const broad = store.create("project", { ...draft, projectAccess: "all", schedule: { kind: "once", startAt: new Date(Date.now()-1000).toISOString(), timeZone: "Europe/Berlin" } }, Date.now()-2000);
      const chosenModel = { providerID: "selected-provider", modelID: "selected-model" };
      store.update("project", broad.id, broad.revision, { model: chosenModel });
      server = await startServer(config);
      for (let i=0; i<100 && store.runs(broad.id)[0]?.status !== "sent"; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1].agent, "legalwork-scheduled-all");
      assert.deepEqual(deliveries[1].model, chosenModel);
      console.log("scheduled HTTP checks passed");
    } finally { await server.stop(); engine.stop(true); inboxDb.close(); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENCODE_DB: join(root, "opencode.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stderr + stdout }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("scheduled HTTP checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
