import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("calendar HTTP auth, receipt creation, aggregation, override history and read-only boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "calendar-http-")), script = join(root, "check.mjs");
  const serverSource = new URL("../server.ts", import.meta.url).href;
  await writeFile(script, `
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import assert from "node:assert/strict";
    const { startServer } = await import(${JSON.stringify(serverSource)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "project");
    await mkdir(join(folder, ".git"), { recursive: true });
    await writeFile(join(folder, "Order.pdf"), "Synthetic court order");
    const config = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: [{ id: "project", name: "Test", path: folder, preset: "starter", workspaceType: "local" }, { id: "other", name: "Other", path: folder, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [folder], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const server = await startServer(config), base = "http://127.0.0.1:" + server.port;
    const call = (path, method="GET", body, token="test") => fetch(base + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const path = "/workspace/project/calendar";
    try {
      assert.equal((await call(path, "GET", undefined, "bad")).status, 401);
      const issued = await fetch(base + "/tokens", { method: "POST", headers: { "x-legalwork-host-token": "host", "content-type": "application/json" }, body: JSON.stringify({ scope: "viewer", label: "calendar-test" }) });
      const viewer = (await issued.json()).token;
      assert.equal((await call(path, "GET", undefined, viewer)).status, 200);
      assert.equal((await call(path + "/subscription", "GET", undefined, viewer)).status, 403);
      assert.equal((await call("/calendar/subscription", "POST", undefined, viewer)).status, 403);
      assert.equal((await (await call("/calendar/subscription")).json()).available, false);
      assert.equal((await call(path, "POST", { title: "Forbidden", start: "2026-09-30" }, viewer)).status, 403);
      assert.equal((await call("/calendar/occurrences?from=invalid&to=2026-10-01")).status, 400);
      assert.equal((await call(path, "POST", { title: "Invalid", start: "2026-02-30" })).status, 400);
      const result = await call(path + "/calculate", "POST", { skill: "de-civil-deadlines", input: { rule: "de-zpo-period", region: "NW", triggerDate: "2026-01-31", duration: 1, unit: "months", source: "Synthetic court service record" } });
      assert.equal(result.status, 200); const receipt = (await result.json()).calculation;
      const saved = await call(path, "POST", { title: "Appeal", start: receipt.deadlineDay, timeZone: receipt.timeZone, calculationId: receipt.id, attachmentPaths: ["Order.pdf"] });
      assert.equal(saved.status, 200); const item = (await saved.json()).item;
      assert.equal(item.provenance.kind, "calculated");
      assert.deepEqual(item.attachmentPaths, ["Order.pdf"]);
      assert.deepEqual(item.sessionIds, []);
      assert.equal(await (await call("/workspace/project/files/raw?path=Order.pdf")).text(), "Synthetic court order");
      assert.equal((await call(path, "POST", { title: "Bad file", start: "2026-10-01", attachmentPaths: ["../outside.pdf"] })).status, 400);
      assert.equal((await call(path, "POST", { title: "Missing file", start: "2026-10-01", attachmentPaths: ["missing.pdf"] })).status, 400);
      assert.equal((await call("/workspace/other/calendar/" + item.id)).status, 404);
      assert.equal((await call("/workspace/other/calendar/" + item.id, "PATCH", { revision: item.revision, title: "Wrong project" })).status, 404);
      assert.equal((await call("/workspace/other/calendar", "POST", { title: "Wrong receipt", start: receipt.deadlineDay, calculationId: receipt.id })).status, 404);
      const untouched = (await (await call(path + "/" + item.id)).json()).item;
      assert.equal(untouched.projectId, "project"); assert.equal(untouched.title, item.title); assert.equal(untouched.revision, item.revision);
      const all = await (await call("/calendar/occurrences?from=2026-03-01&to=2026-04-01")).json();
      assert.equal(all.occurrences.length, 1); assert.equal(all.occurrences[0].itemId, item.id);
      assert.equal((await call(path + "/" + item.id, "PATCH", { revision: 1, start: "2026-03-03" })).status, 400);
      assert.equal((await call(path + "/" + item.id, "PATCH", { revision: 1, start: "2026-03-03", reason: "User supplied a confirmed correction" })).status, 200);
      assert.equal((await call(path + "/" + item.id, "PATCH", { revision: 1, title: "Stale" })).status, 409);
      const history = await (await call(path + "/" + item.id + "/history")).json();
      assert.equal(history.history.length, 2); assert.equal(history.history[1].provenance.calculation.id, receipt.id);
      const feed = await (await call(path + "/feeds", "POST", {})).json();
      assert.equal((await call("/calendar/feed/" + feed.token, "GET", undefined, "")).status, 200);
      await call(path + "/feeds/" + feed.token, "DELETE");
      assert.equal((await call("/calendar/feed/" + feed.token)).status, 404);
      config.readOnly = true;
      assert.equal((await call("/calendar/subscription", "POST")).status, 403);
      assert.equal((await call(path, "POST", { title: "Readonly", start: "2026-09-30" })).status, 403);
      console.log("calendar HTTP checks passed");
    } finally { await server.stop(); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stderr + stdout }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("calendar HTTP checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
