import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the live scheduler runs research beside a busy daily chat and returns the complete final result", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-worker-http-"));
  const script = join(root, "test.mjs");
  await writeFile(script, `
    import assert from "node:assert/strict";
    import { mkdir } from "node:fs/promises";
    import { join } from "node:path";
    const { startServer } = await import(${JSON.stringify(new URL("./server.ts", import.meta.url).href)});
    const { writeEigenweltConnection } = await import(${JSON.stringify(new URL("./eigenwelt-connection-store.ts", import.meta.url).href)});
    const { parseEigenweltEntitlements } = await import(${JSON.stringify(new URL("./eigenwelt-auth.ts", import.meta.url).href)});
    const { nativeAssistantFixture } = await import(${JSON.stringify(new URL("./assistant-engine.test-support.ts", import.meta.url).href)});
    const { ScheduledTaskStore } = await import(${JSON.stringify(new URL("./scheduled-tasks/store.ts", import.meta.url).href)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "assistant"); await mkdir(folder);
    const date = new Date(), title = date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0");
    const sessions = new Map([["daily", { id: "daily", title, directory: folder, slug: "daily", projectID: "project", version: "1", time: { created: 1, updated: 1 } }]]);
    const deliveries = []; const enginePaths = []; let dailyBusy = true;
    const engine = Bun.serve({ port: 0, fetch: nativeAssistantFixture(async request => {
      const path = new URL(request.url).pathname, id = path.split("/")[2]; enginePaths.push(request.method + " " + path);
      if (path === "/session/status") return Response.json(dailyBusy ? { daily: { type: "busy" } } : {});
      if (path === "/agent") return Response.json([{ name: "legalwork-scheduled-all", permission: [] }]);
      if (path === "/session" && request.method === "GET") return Response.json([...sessions.values()]);
      if (path === "/session" && request.method === "POST") {
        const input = await request.json(), child = { id: "worker-"+sessions.size, ...input, directory: folder, slug: "worker", projectID: "project", version: "1", time: { created: 1, updated: 1 } };
        sessions.set(child.id, child); return Response.json(child);
      }
      if (path.endsWith("/prompt_async")) { deliveries.push({ id, ...await request.json() }); return new Response(null, { status: 204 }); }
      if (path.endsWith("/children") || path === "/permission" || path === "/question") return Response.json([]);
      if (path.endsWith("/message")) return Response.json(id === "daily" ? [] : [{ info: { id: "result-"+id, sessionID: id, role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", providerID: "fixture", modelID: "model" }, parts: [{ type: "text", text: "Saved briefings/today.md. " + "RESEARCH_DETAIL ".repeat(20000) + "PRIVATE_RAW_END" }] }]);
      if (path.includes("/message/")) return new Response(null, { status: 404 });
      if (path.startsWith("/session/")) return sessions.has(id) ? Response.json(sessions.get(id)) : new Response(null, { status: 404 });
      return Response.json({});
    }, folder) });
    const config = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "server.json"), opencodeBaseUrl: engine.url.origin,
      projectsDirectory: root, workspaces: [{ id: "assistant", name: "Assistant", path: folder, preset: "main-assistant", workspaceType: "local" }], authorizedRoots: [root],
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) });
    const store = await ScheduledTaskStore.open(process.env.LEGALWORK_RUNTIME_DB);
    const task = store.create("assistant", { title: "Briefing", prompt: "RESEARCH_TASK_ONLY: read source records", projectAccess: "all", sessionId: null, reuseChat: false, pinSession: false,
      model: { providerID: "fixture", modelID: "model" }, schedule: { kind: "once", startAt: new Date(Date.now()-1000).toISOString(), timeZone: "UTC" } }, Date.now()-2000);
    const server = await startServer(config);
    try {
      for (let i=0; i<100 && !deliveries.length; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 1, JSON.stringify({ tasks: store.list(), runs: store.runs(task.id), enginePaths }));
      const worker = sessions.get(deliveries[0].id);
      assert.equal(worker.parentID, "daily"); assert.notEqual(worker.id, "daily");
      assert.equal(store.runs(task.id)[0].sessionId, worker.id);
      assert.equal(deliveries[0].agent, "legalwork-scheduled-all");
      assert.match(deliveries[0].parts[0].text, /RESEARCH_TASK_ONLY/);
      assert.equal(deliveries.some(item => item.id === "daily"), false);
      dailyBusy = false;
      for (let i=0; i<850 && deliveries.length<2; i++) await Bun.sleep(20);
      assert.equal(deliveries.length, 2);
      const notice = deliveries[1]; assert.equal(notice.id, "daily");
      assert.equal(notice.agent, "legalwork"); assert.equal(notice.parts[0].synthetic, true);
      assert.match(notice.parts[0].text, /briefings\\/today.md/);
      assert.ok(notice.parts[0].text.length > 300000);
      assert.ok(notice.parts[0].text.includes("PRIVATE_RAW_END"));
      assert.ok(!notice.parts[0].text.includes("RESEARCH_TASK_ONLY"));
    } finally { await server.stop(); engine.stop(true); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, OPENCODE_DB: join(root, "engine.sqlite"), LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), LEGALWORK_PROJECTS_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
