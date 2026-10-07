import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("assistant HTTP provisioning, scheduling, source scope, delegation and permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-http-"));
  const script = join(root, "test.mjs");
  await writeFile(script, `
    import assert from "node:assert/strict";
    import { mkdir } from "node:fs/promises";
    import { join } from "node:path";
    const { startServer } = await import(${JSON.stringify(new URL("./server.ts", import.meta.url).href)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "matter");
    await mkdir(folder);
    const sessions = new Map(); const deliveries = [];
    let failSend = false; const running = new Set(); const disposals = [];
    const engine = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      const directory = decodeURIComponent(request.headers.get("x-opencode-directory") || url.searchParams.get("directory") || folder);
      if (path === "/session/status") return Response.json(Object.fromEntries([...running].map(id => [id, { type: "busy" }])));
      if (path === "/instance/dispose") { disposals.push(directory); running.clear(); return Response.json(true); }
      if (path === "/session" && request.method === "GET") return Response.json([...sessions.values()]);
      if (path === "/session" && request.method === "POST") {
        const id = "chat-" + sessions.size;
        const session = { id, title: (await request.json()).title, directory, time: {}, version: "1", slug: id, projectID: "project" };
        sessions.set(id, session); return Response.json(session);
      }
      if (path.endsWith("/prompt_async")) { const sessionId = path.split("/")[2]; deliveries.push({ sessionId, directory, ...await request.json() }); if (!failSend) running.add(sessionId); return new Response(null, { status: failSend ? 503 : 204 }); }
      if (path.endsWith("/todo")) return Response.json([{ content: "Review draft", status: "pending", priority: "medium" }]);
      if (path.endsWith("/message")) return Response.json([{ info: { role: "assistant", providerID: "fixture-provider", modelID: "chosen-model" }, parts: [] }]);
      if (path.startsWith("/session/")) { const item = sessions.get(path.split("/")[2]); return item ? Response.json(item) : new Response(null, { status: 404 }); }
      return Response.json({});
    }});
    const config = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "server.json"), projectsDirectory: join(root, "projects"),
      opencodeBaseUrl: engine.url.origin, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: [{ id: "matter", name: "Matter", path: folder, preset: "starter", workspaceType: "local", baseUrl: engine.url.origin }],
      authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const server = await startServer(config), base = "http://127.0.0.1:" + server.port;
    const call = (path, method="GET", body, token="fixture") => fetch(base + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
      assert.equal((await call("/assistant/current", "POST", {}, "wrong")).status, 401);
      const [a, b] = await Promise.all([call("/assistant/current", "POST", {}), call("/assistant/current", "POST", {})]);
      const assistant = await a.json(); assert.deepEqual(await b.json(), assistant);
      assert.equal(assistant.workspace.preset, "main-assistant");
      assert.equal(assistant.workspace.path, join(root, "projects", "Assistant"));
      assert.equal(sessions.size, 1);
      assert.deepEqual(assistant.profile, { name: null, icon: "cat" });
      assert.equal((await call("/assistant/profile", "PATCH", { name: "Momo", icon: "otter" })).status, 200);
      assert.equal((await (await call("/assistant/current", "POST", {})).json()).workspace.name, "Momo");
      assert.equal((await call("/assistant/profile", "PATCH", { name: " ", icon: "otter" })).status, 400);
      assert.equal((await call("/assistant/profile", "PATCH", { name: "Momo", icon: "unknown" })).status, 400);
      const originalProjects = config.workspaces;
      config.workspaces = Array.from({ length: 500 }, (_, index) => ({ ...originalProjects[0], id: "project-" + String(index).padStart(4, "0"), name: "Project " + String(index).padStart(4, "0") }));
      let cursor = "", listed = [];
      do {
        const page = await (await call("/assistant/projects?limit=50" + (cursor ? "&cursor=" + cursor : ""))).json();
        listed.push(...page.projects.map(project => project.id)); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(listed).size, 500); assert.equal(listed.length, 500);
      assert.equal((await (await call("/assistant/projects?query=0499")).json()).projects[0].id, "project-0499");
      config.workspaces = originalProjects;
      assert.equal((await (await call("/assistant/history")).json()).days[0].sessionId, assistant.day.sessionId);
      assert.equal((await call("/assistant/history?before=bad")).status, 400);
      const schedule = await (await call("/workspace/" + assistant.workspace.id + "/scheduled-tasks", "POST", {
        title: "Morning brief", prompt: "Review open projects", sessionId: assistant.day.sessionId, reuseChat: true, pinSession: true, projectAccess: "project",
        schedule: { kind: "rrule", startAt: "2099-10-08T06:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=DAILY" }
      })).json();
      assert.equal(schedule.task.sessionId, null); assert.equal(schedule.task.reuseChat, false); assert.equal(schedule.task.projectAccess, "all"); assert.equal(schedule.task.pinSession, false);
      const project = await (await call("/assistant/projects", "POST", { name: "Acquisition" })).json();
      assert.equal(project.project.path, join(root, "projects", "Acquisition"));
      for (const projectId of ["matter", project.project.id]) {
        assert.equal((await call("/workspace/" + projectId + "/tasks", "POST", { title: "Review escrow", projectId, dueDate: "2099-10-08" })).status, 201);
        assert.equal((await call("/workspace/" + projectId + "/calendar", "POST", { title: "Escrow filing", kind: "deadline", start: "2099-10-09", source: "Fixture" })).status, 200);
      }
      const tasks = await (await call("/assistant/tasks?query=ESCROW&limit=1")).json();
      assert.equal(tasks.items.length, 1); assert.ok(tasks.nextCursor); assert.equal(tasks.items[0].dueDate, "2099-10-08");
      const moreTasks = await (await call("/assistant/tasks?query=escrow&limit=1&cursor=" + tasks.nextCursor)).json();
      assert.equal(moreTasks.items.length, 1); assert.notEqual(tasks.items[0].id, moreTasks.items[0].id); assert.equal(moreTasks.nextCursor, null);
      assert.equal((await (await call("/assistant/tasks?query=escrow&projectId=matter")).json()).items.length, 1);
      const calendarQuery = "/assistant/calendar?from=2099-10-01&to=2099-11-01&kind=deadline&query=escrow&limit=1";
      const deadlines = await (await call(calendarQuery)).json();
      assert.equal(deadlines.items.length, 1); assert.equal(deadlines.items[0].verified, false); assert.equal(deadlines.items[0].start, "2099-10-09");
      const moreDeadlines = await (await call(calendarQuery + "&cursor=" + deadlines.nextCursor)).json();
      assert.equal(moreDeadlines.items.length, 1); assert.notEqual(deadlines.items[0].itemId, moreDeadlines.items[0].itemId);
      assert.equal((await call("/assistant/sessions/search?query=escrow&scope=project")).status, 400);
      assert.equal((await call("/assistant/calendar?from=2099-10-01&to=2099-09-01")).status, 400);
      const input = { workspaceId: project.project.id, sourceWorkspaceId: assistant.workspace.id, sourceSessionId: assistant.day.sessionId, title: "Review terms", prompt: "Compare liability clauses", scope: "Save a draft for partner review. Do not contact the counterparty." };
      assert.equal((await call("/assistant/delegate", "POST", { ...input, sourceWorkspaceId: "matter" })).status, 400);
      assert.equal((await call("/assistant/delegate", "POST", { ...input, workspaceId: assistant.workspace.id })).status, 400);
      const result = await (await call("/assistant/delegate", "POST", input)).json();
      assert.equal(result.ok, true); assert.equal(result.delegation.workspaceId, project.project.id);
      assert.equal(result.delegation.scope, input.scope); assert.equal(result.delegation.status, "started");
      assert.equal(deliveries.length, 1); assert.equal(deliveries[0].directory, project.project.path);
      assert.equal(deliveries[0].agent, "legalwork"); assert.deepEqual(deliveries[0].model, { providerID: "fixture-provider", modelID: "chosen-model" });
      assert.ok(deliveries[0].parts[0].text.includes(input.scope));
      // The card opens the project by activating it, then loading the running chat.
      const activated = await fetch(base + "/workspaces/" + project.project.id + "/activate", { method: "POST", headers: { "x-legalwork-host-token": "host" } });
      assert.equal(activated.status, 200);
      assert.deepEqual(disposals, [], "Opening delegated work must not reload its engine");
      const status = await (await call("/assistant/projects/" + project.project.id + "/sessions/" + result.delegation.sessionId)).json();
      assert.equal(status.status.type, "busy"); assert.equal(status.todos[0].content, "Review draft");
      assert.equal((await call("/assistant/projects/matter/sessions/" + assistant.day.sessionId)).status, 404);
      failSend = true;
      const unconfirmed = await (await call("/assistant/delegate", "POST", input)).json();
      assert.equal(unconfirmed.ok, false); assert.equal(unconfirmed.delegation.status, "delivery-unconfirmed"); assert.ok(unconfirmed.delegation.sessionId);
      const issued = await fetch(base + "/tokens", { method: "POST", headers: { "x-legalwork-host-token": "host", "content-type": "application/json" }, body: JSON.stringify({ scope: "viewer", label: "reader" }) });
      const viewer = (await issued.json()).token;
      assert.equal((await call("/assistant/profile", "PATCH", { name: "No", icon: "cat" }, viewer)).status, 403);
      assert.equal((await call("/assistant/history", "GET", undefined, viewer)).status, 200);
      for (const route of ["/assistant/current", "/assistant/projects", "/assistant/delegate"]) assert.equal((await call(route, "POST", input, viewer)).status, 403);
      config.readOnly = true; assert.equal((await call("/assistant/current", "POST", {})).status, 403);
      console.log("assistant HTTP checks passed");
    } finally { await server.stop(); engine.stop(true); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), LEGALWORK_PROJECTS_DIR: join(root, "projects") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stdout + stderr }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("assistant HTTP checks passed");
  } finally { await rm(root, { force: true, recursive: true }); }
}, 20000);
