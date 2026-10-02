import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hosted subscription lifecycle, private snapshots, account isolation and background refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "calendar-subscriptions-"));
  const script = join(root, "check.mjs"), source = new URL("./", import.meta.url).href;
  await writeFile(script, `
    import assert from "node:assert/strict";
    import { createHash, randomBytes, randomUUID } from "node:crypto";
    import { join } from "node:path";
    const { calendarSubscription, changeCalendarSubscription, syncCalendarSubscriptions, subscriptionPayload } = await import(${JSON.stringify(source)} + "subscriptions.ts");
    const { calendarStore } = await import(${JSON.stringify(source)} + "store.ts");
    const { taskStore } = await import(${JSON.stringify(source)} + "../task-store.ts");
    const { projectSyncStore } = await import(${JSON.stringify(source)} + "../project-sync-store.ts");
    const { writeEigenweltConnection } = await import(${JSON.stringify(source)} + "../eigenwelt-connection-store.ts");
    const root = process.env.XDG_CONFIG_HOME;
    const config = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: ["one", "two", "member"].map(id => ({ id, name: id, path: join(root, id), preset: "starter", workspaceType: "local" })),
      authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const feeds = new Map(); let posts = 0, puts = 0, available = true, offline = false;
    const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (offline) return Response.json({ message: "Offline" }, { status: 503 });
      assert.equal(new URL(request.url).pathname, "/api/calendar/feeds");
      const account = request.headers.get("authorization");
      if (request.method === "GET") return Response.json({ entitled: available, feeds: [...feeds.entries()].filter(([, feed]) => feed.account === account).map(([token, feed]) => ({ id: createHash("sha256").update(token).digest("hex"), updatedAt: feed.at })) });
      const body = await request.json();
      if (request.method === "DELETE") { if (feeds.get(body.token)?.account === account) feeds.delete(body.token); return Response.json({ ok: true }); }
      if (!available) return Response.json({ message: "Subscription required" }, { status: 403 });
      if (request.method === "PUT") { assert.equal(feeds.get(body.token)?.account, account); puts++; feeds.set(body.token, { account, body, at: new Date().toISOString() }); return Response.json({ ok: true }); }
      posts++; const token = randomBytes(32).toString("hex"); feeds.set(token, { account, body, at: new Date().toISOString() });
      return Response.json({ token, url: "https://untrusted.invalid/not-used" });
    } });
    process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:" + platform.port;
    const login = userId => writeEigenweltConnection(config, { platformToken: userId, platformTokenExpiresAt: Date.now() + 3600000, account: { userId, userName: userId, userEmail: userId + "@test.invalid", orgId: "firm", orgName: "Test" } });
    try {
      assert.equal((await calendarSubscription(config, null)).available, false);
      await login("alice");
      const db = await calendarStore(config), tasks = await taskStore(config), links = await projectSyncStore(config);
      const deadline = db.create("one", { title: "Reply", start: "2026-10-16", attachmentPaths: ["Court order.pdf"], sessionIds: ["local-session"] });
      const other = db.create("two", { title: "Appeal", start: "2026-11-01" });
      const secret = db.create("member", { title: "Cached member deadline", start: "2026-10-17" });
      tasks.createTask({ title: "Private inbox task", dueDate: "2026-10-18" }, { userId: "alice", name: "Alice", email: null });
      links.saveLink({ workspaceId: "member", projectId: randomUUID(), orgId: "firm", origin: "remote", role: "member", ownerUserId: "owner", confirmed: true, state: "active", settings: { access: "members", memberIds: ["alice"], scope: { metadata: false, notes: false, tasks: true, calendar: true, recordings: false, reviews: false, documents: false } }, remoteUpdatedAt: null, filesReconciledAt: null, allowDeletions: false, lastSyncAt: null, lastError: null, report: null });
      const single = await changeCalendarSubscription(config, "one", true), all = await changeCalendarSubscription(config, null, true);
      assert.notEqual(single.url, all.url); assert(single.url.startsWith(process.env.EIGENWELT_PLATFORM_URL));
      assert.equal(posts, 2);
      const [again, concurrent] = await Promise.all([changeCalendarSubscription(config, "one", true), changeCalendarSubscription(config, "one", true)]);
      assert.equal(again.url, single.url); assert.equal(concurrent.url, single.url); assert.equal(posts, 2);
      const singleToken = single.url.split("/").at(-1), allToken = all.url.split("/").at(-1);
      assert.equal(feeds.get(singleToken).body.snapshot.scope, "project");
      const singleText = JSON.stringify(feeds.get(singleToken).body), allText = JSON.stringify(feeds.get(allToken).body);
      assert(singleText.includes(deadline.uid)); assert(!singleText.includes(other.uid)); assert(!singleText.includes("Court order.pdf")); assert(!singleText.includes("local-session"));
      assert(allText.includes(other.uid)); assert(allText.includes("Private inbox task")); assert(!allText.includes(secret.uid));
      assert(!feeds.get(allToken).body.projectId);
      await syncCalendarSubscriptions(config); assert.equal(puts, 0);
      db.patch("one", deadline.id, { revision: deadline.revision, start: "2026-10-19" });
      offline = true; await assert.rejects(syncCalendarSubscriptions(config)); offline = false;
      assert.equal((await calendarSubscription(config, "one")).url, single.url);
      await syncCalendarSubscriptions(config); assert.equal(puts, 2); assert(JSON.stringify(feeds.get(singleToken).body).includes("2026-10-19"));
      await syncCalendarSubscriptions(config); assert.equal(puts, 2);
      await login("bob"); assert.equal((await calendarSubscription(config, "one")).url, null);
      await changeCalendarSubscription(config, "one", false); assert(feeds.has(singleToken));
      await login("alice"); assert.equal((await calendarSubscription(config, "one")).url, single.url);
      available = false; assert.equal((await calendarSubscription(config, "one")).available, false);
      await assert.rejects(changeCalendarSubscription(config, "two", true));
      available = true;
      links.updateLink("member", { state: "revoked" });
      assert.equal(await subscriptionPayload(config, { orgId: "firm", userId: "alice" }, "member"), null);
      await changeCalendarSubscription(config, "one", false); assert(!feeds.has(singleToken)); assert(feeds.has(allToken));
      assert.equal((await calendarSubscription(config, "one")).url, null);
      const replacement = await changeCalendarSubscription(config, "one", true); assert.notEqual(replacement.url, single.url);
      config.workspaces = config.workspaces.filter(workspace => workspace.id !== "one");
      await syncCalendarSubscriptions(config); assert(!feeds.has(replacement.url.split("/").at(-1)));
      assert(!JSON.stringify(feeds.get(allToken).body).includes(deadline.uid));
      console.log("subscription checks passed");
    } finally { platform.stop(true); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stderr + stdout }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("subscription checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
