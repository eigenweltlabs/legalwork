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
    const sessions = new Map([["existing", { id: "existing", title: "Matter chat", location: { directory: folder }, time: {} }], ["foreign", { id: "foreign", title: "Other project", location: { directory: root }, time: {} }], ["archived", { id: "archived", title: "Archived", location: { directory: folder }, time: { archived: 1 } }]]);
    const { Database } = await import("bun:sqlite");
    const inboxDb = new Database(process.env.OPENCODE_DB);
    // Native v2 read-model fixture; real native scheduling behavior is covered
    // separately by scheduled-tasks/engine.test.ts.
    inboxDb.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT); CREATE INDEX message_session ON session_message(session_id);");
    for (const session of sessions.values()) inboxDb.query("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(session.id, session.location.directory, Date.now(), session.time.archived ?? null);
    inboxDb.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run("user", "existing", "user", 100, JSON.stringify({ text: "Matter question" }));
    inboxDb.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run("summary", "existing", "compaction", 200, JSON.stringify({}));
    const deliveries = [];
    const deliveryWaiters = new Map();
    const waitForDelivery = count => deliveries.length >= count ? Promise.resolve() : new Promise(resolve => deliveryWaiters.set(count, resolve));
    let restrictiveAgent = true;
    const agents = () => [{ id: "legalwork-scheduled-project", permissions: restrictiveAgent ? [{ action: "*", resource: "*", effect: "deny" }, { action: "legalwork_project_read", resource: "*", effect: "allow" }] : [] }, { id: "legalwork-scheduled-all", permissions: [] }];
    const engine = Bun.serve({ port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/agent") return Response.json({ location: { directory: folder }, data: agents() });
      if (path === "/api/model") return Response.json({ location: { directory: folder }, data: [] });
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/session" && request.method === "GET") return Response.json({ data: [...sessions.values()].filter(session => session.location.directory === folder), cursor: { next: null } });
      if (path === "/api/session" && request.method === "POST") {
        const id = "new-" + sessions.size;
        const input = await request.json();
        assert.deepEqual(input.location, { directory: folder });
        const session = { id, title: input.title, location: input.location, time: {} };
        sessions.set(id, session);
        inboxDb.query("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(id, folder, Date.now(), null);
        return Response.json({ data: session });
      }
      const id = path.split("/")[3], session = sessions.get(id);
      if (!session) return Response.json({ error: "Unknown session" }, { status: 404 });
      if (path.endsWith("/inbox")) return Response.json({ data: [] });
      if (path.endsWith("/message")) return Response.json({ data: [], cursor: { next: null } });
      if (path.endsWith("/agent") && request.method === "POST") { session.agent = (await request.json()).agent; return new Response(null, { status: 204 }); }
      if (path.endsWith("/model") && request.method === "POST") { session.model = (await request.json()).model; return new Response(null, { status: 204 }); }
      if (path.endsWith("/prompt")) {
        const input = await request.json();
        deliveries.push({ ...input, agent: session.agent, model: session.model });
        deliveryWaiters.get(deliveries.length)?.();
        deliveryWaiters.delete(deliveries.length);
        inboxDb.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run("reply-" + deliveries.length, id, "assistant", 300, JSON.stringify({ time: { completed: 400 } }));
        session.outcome = "succeeded";
        return Response.json({ data: { type: "user", id: input.id, text: input.text, time: { created: 300 } } });
      }
      if (request.method === "PATCH") { const input = await request.json(); if (input.archived === false) delete session.time.archived; return new Response(null, { status: 204 }); }
      if (path === "/api/session/" + id) return Response.json({ data: session });
      return Response.json({ error: "Unexpected native request: " + path }, { status: 404 });
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
      // A persisted queue admission is not proof of the later native HTTP send.
      await waitForDelivery(1);
      for (let i=0; i<100 && store.runs(seed.id)[0]?.status !== "sent"; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 1);
      const inbox = await (await call("/session-inbox")).json();
      assert.equal((await call("/session-inbox", "GET", undefined, "wrong")).status, 401);
      assert.ok(inbox.sessions.every(entry => entry.workspaceId !== "remote"));
      assert.ok(!inbox.sessions.some(entry => entry.sessionId === "archived"));
      assert.equal(inbox.sessions.find(entry => entry.sessionId === "existing").assistantAt, 0);
      assert.deepEqual(inbox.sessions.find(entry => entry.sessionId === store.runs(seed.id)[0].sessionId).automation, { runId: store.runs(seed.id)[0].id, at: Date.parse(store.runs(seed.id)[0].startedAt), pinRunId: store.runs(seed.id)[0].id });
      assert.equal(inbox.sessions.find(entry => entry.sessionId === store.runs(seed.id)[0].sessionId).assistantAt, 400);
      assert.equal(store.runs(seed.id)[0].status, "sent");
      assert.equal(store.runs(seed.id)[0].dueAt, new Date(missedDueAt).toISOString());
      assert.ok(Date.parse(store.runs(seed.id)[0].startedAt) >= missedDueAt + 5 * 60000);
      assert.equal(deliveries[0].text, "[Scheduled task: Catch up]\\n\\nReview the matter");
      assert.deepEqual(deliveries[0].metadata, { legalworkScheduledTask: { taskId: seed.id, workspaceId: "project", title: "Catch up" } });
      assert.equal(deliveries[0].permission, undefined);
      assert.equal(deliveries[0].agent, "legalwork-scheduled-project");
      assert.equal(store.get("project", seed.id).projectAccess, "project");
      assert.equal(store.get("project", seed.id).reuseChat, false);
      assert.equal(store.runs(seed.id)[0].projectAccess, "project");
      assert.equal((await call(path, "GET", undefined, "wrong")).status, 401);
      const viewer = "owt_retired_viewer";
      assert.equal((await call(path, "GET", undefined, viewer)).status, 401);
      assert.equal((await call(path, "POST", {}, viewer)).status, 401);
      const draft = { title: "Daily review", prompt: "Summarize open questions", sessionId: "existing", reuseChat: true, pinSession: false, model: { providerID: "test", modelID: "model" }, schedule: { kind: "rrule", startAt: "2099-01-01T09:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=DAILY" } };
      assert.equal((await call(path, "POST", { ...draft, wikiScope: "owner" })).status, 400);
      const ownerCreated = await fetch(base + path, { method: "POST", headers: { "x-legalwork-host-token": "host", "content-type": "application/json" }, body: JSON.stringify(draft) });
      const ownerTask = (await ownerCreated.json()).task;
      assert.equal(ownerTask.wikiScope, "owner");
      const collaborator = config.token;
      assert.equal((await call(path + "/" + ownerTask.id, "PATCH", { revision: 1, wikiScope: "owner" }, collaborator)).status, 400);
      const downgraded = (await (await call(path + "/" + ownerTask.id, "PATCH", { revision: 1, title: "Collaborator review" }, collaborator)).json()).task;
      assert.equal(downgraded.wikiScope, "collaborator");
      assert.equal((await call(path + "/" + ownerTask.id, "DELETE", { revision: 2 })).status, 200);
      assert.equal((await call(path, "POST", { ...draft, sessionId: "foreign" })).status, 400);
      assert.equal((await call(path, "POST", { ...draft, sessionId: "archived" })).status, 400);
      assert.equal((await call("/workspace/remote/scheduled-tasks", "POST", draft)).status, 404);
      assert.equal((await call(path + "/preview", "POST", { schedule: { ...draft.schedule, rrule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30" } })).status, 400);
      const chats = await (await call(path + "/chats")).json(); assert.deepEqual(chats.sessions.map(chat => chat.id), ["existing", store.runs(seed.id)[0].sessionId]);
      const preview = await (await call(path + "/preview", "POST", { schedule: draft.schedule })).json(); assert.equal(preview.occurrences.length, 3);
      const created = await call(path, "POST", draft); assert.equal(created.status, 200); const task = (await created.json()).task;
      assert.equal((await call("/workspace/other/scheduled-tasks/"+task.id)).status, 404);
      assert.equal((await call(path+"/"+task.id, "PATCH", { revision: 1, status: "paused" }, viewer)).status, 401);
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
      await waitForDelivery(2);
      for (let i=0; i<100 && store.runs(broad.id)[0]?.status !== "sent"; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1].agent, "legalwork-scheduled-all");
      assert.deepEqual(deliveries[1].model, { providerID: chosenModel.providerID, id: chosenModel.modelID });
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
