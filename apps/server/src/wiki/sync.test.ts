import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseFrontmatter } from "../frontmatter.js";
import { WikiStore } from "./store.js";
import { WikiSync } from "./sync.js";
import { WikiTeamClient } from "./team-client.js";
import { wikiTeamFixture } from "./team-test-helper.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
async function setup() {
  const fixture = await wikiTeamFixture(); cleanups.push(() => fixture.close());
  async function computer(userId = "owner") {
    const account = await fixture.account(userId), store = new WikiStore(account.config), client = new WikiTeamClient(account.config), sync = new WikiSync(account.config, store, { client, intervalMs: 30 });
    cleanups.push(async () => { await sync.stop(); await store.close(); });
    return { ...account, store, client, sync };
  }
  const a = await computer(), b = await computer("member");
  const wiki = await a.store.create({ name: "Knowledge", root: join(a.directory, "content"), attach: true });
  const remote = await a.sync.share(wiki.id, { access: "members", memberIds: ["member"] });
  const joined = await b.sync.join({ wikiId: remote.id, root: join(b.directory, "content") });
  async function save(machine: typeof a, id: string, path: string, content: string) { const previous = await machine.store.read(id, path).catch(() => null); return machine.store.write(id, path, content, previous?.revision ?? ""); }
  async function exchange() { expect((await a.sync.sync(wiki.id)).state).toBe("idle"); expect((await b.sync.sync(joined.id)).state).toBe("idle"); }
  return { fixture, computer, a, b, wiki, joined, remote, save, exchange, readA: async (path: string) => (await a.store.read(wiki.id, path)).content, readB: async (path: string) => (await b.store.read(joined.id, path)).content };
}

async function downloadBatch() {
  const context = await setup();
  const { fixture, a, b, wiki } = context;
  // Drive these rounds explicitly so the join timer cannot start a transfer.
  await a.sync.stop(); await b.sync.stop();
  const files = Array.from({ length: 14 }, (_, index) => ({
    path: index % 2 ? `Attachments/${index}.bin` : `Pages/${index}.md`,
    data: Buffer.from(`# Shared file ${index}\n`),
  }));
  for (const file of files) await a.store.writeAsset(wiki.id, file.path, file.data, "");
  expect((await a.sync.sync(wiki.id)).state).toBe("idle");
  const gates = files.map(() => Promise.withResolvers<void>());
  let started = 0, active = 0, peak = 0;
  fixture.control.beforeDownload = async () => {
    const gate = gates[started++];
    active++;
    peak = Math.max(peak, active);
    await gate?.promise;
    active--;
  };
  return { ...context, files, gates, counts: () => ({ started, active, peak }), release: () => gates.forEach(gate => gate.resolve()) };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise(done => setTimeout(done, 10));
  expect(condition()).toBe(true);
}

describe("Automatic independent wiki sync across local folders", () => {
  test("downloads six files concurrently, refills available slots, and preserves edits made during transfer", async () => {
    const { a, b, wiki, joined, files, gates, counts, release, save, readB } = await downloadBatch();
    const run = b.sync.sync(joined.id);
    try {
      await waitFor(() => counts().started >= 6);
      expect(counts()).toEqual({ started: 6, active: 6, peak: 6 });
      await save(b, joined.id, "Pages/0.md", "# Edited during download\n");
      gates[0].resolve();
      await waitFor(() => counts().started >= 7);
      expect(counts()).toEqual({ started: 7, active: 6, peak: 6 });
    } finally { release(); await run; }
    expect((await run).state).toBe("idle");
    expect(counts()).toEqual({ started: files.length, active: 0, peak: 6 });
    expect(await readB("Pages/0.md")).toBe("# Edited during download\n");
    for (const file of files) if (file.path !== "Pages/0.md") expect(await b.store.readAsset(joined.id, file.path)).toEqual(file.data);
    // A later round must reconcile the edit, never mark the remote copy as saved.
    expect((await b.sync.sync(joined.id)).state).toBe("idle");
    expect((await a.sync.sync(wiki.id)).state).toBe("idle");
    const copies = (await b.store.files(joined.id)).filter(file => file.path.includes(".conflict-"));
    expect(copies).toHaveLength(1);
    expect(await readB(copies[0].path)).toBe("# Edited during download\n");
  });
  test("a corrupt concurrent download drains in-flight work before retry and does not start queued files", async () => {
    const { fixture, b, joined, files, gates, counts, release } = await downloadBatch();
    const failed = Promise.withResolvers<void>();
    const read = b.client.read.bind(b.client);
    b.client.read = async (...args) => {
      try { return await read(...args); }
      catch (error) { failed.resolve(); throw error; }
    };
    fixture.control.corruptDownload = true;
    let settled = false;
    const run = b.sync.sync(joined.id).then(status => { settled = true; return status; });
    let retry: ReturnType<WikiSync["sync"]> | undefined;
    try {
      await waitFor(() => counts().started >= 6);
      gates[0].resolve();
      await failed.promise;
      await new Promise(done => setTimeout(done, 20));
      expect(settled).toBe(false);
      retry = b.sync.sync(joined.id, true);
      expect(counts()).toEqual({ started: 6, active: 5, peak: 6 });
    } finally { release(); await run; }
    expect((await run).state).toBe("error");
    expect(await retry).toEqual(await run);
    expect(counts()).toEqual({ started: 6, active: 0, peak: 6 });
    expect(await b.store.files(joined.id)).toEqual([]);
    fixture.control.corruptDownload = false;
    fixture.control.beforeDownload = null;
    expect((await b.sync.sync(joined.id)).state).toBe("idle");
    for (const file of files) expect(await b.store.readAsset(joined.id, file.path)).toEqual(file.data);
  });
  test("revoking access during concurrent downloads prevents every in-flight file from being saved", async () => {
    const { fixture, b, joined, counts, release } = await downloadBatch();
    const run = b.sync.sync(joined.id);
    try {
      await waitFor(() => counts().started >= 6);
      fixture.revoked.add("member");
    } finally { release(); await run; }
    expect((await run).state).toBe("error");
    expect(counts()).toEqual({ started: 6, active: 0, peak: 6 });
    expect(await b.store.files(joined.id)).toEqual([]);
  });
  test("a save and explicit sync during an upload wait for the follow-up round", async () => {
    const { fixture, a, wiki, remote, save, exchange } = await setup();
    await save(a, wiki.id, "First.md", "# Initial\n"); await exchange();
    await save(a, wiki.id, "First.md", "# Updated\n");
    let joined: Promise<unknown> | undefined;
    fixture.control.beforeCommit = async () => {
      fixture.control.beforeCommit = null;
      await save(a, wiki.id, "Second.md", "# Saved during upload\n");
      a.sync.changed(wiki.id);
      joined = a.sync.sync(wiki.id, true);
    };
    expect((await a.sync.sync(wiki.id)).state).toBe("idle");
    await joined;
    expect(fixture.wikis.get(remote.id)?.files.get("Second.md")?.data.toString()).toBe("# Saved during upload\n");
  });
  test("all Markdown, views, templates and supporting files share without starter contamination; deletes propagate", async () => {
    const { a, b, wiki, joined, save, exchange, readB } = await setup();
    expect(await b.store.files(joined.id)).toEqual([]);
    await save(a, wiki.id, "Page.md", "# Knowledge\n"); await save(a, wiki.id, "Structure.md", "# Structure\n");
    await save(a, wiki.id, "Views.md", "# Views\n"); await save(a, wiki.id, "Templates/Example.md", "# Example\n");
    await a.store.writeAsset(wiki.id, "Attachments/image.png", Buffer.from([0, 1, 255]), "");
    await exchange(); expect(await readB("Page.md")).toBe("# Knowledge\n"); expect(await b.store.readAsset(joined.id, "Attachments/image.png")).toEqual(Buffer.from([0, 1, 255]));
    await a.store.remove(wiki.id, "Page.md", (await a.store.read(wiki.id, "Page.md")).revision); await exchange();
    await expect(b.store.read(joined.id, "Page.md")).rejects.toMatchObject({ status: 404 });
  });
  test("independent text edits merge while overlapping edits preserve both versions", async () => {
    const { a, b, wiki, joined, save, exchange, readA, readB } = await setup();
    await save(a, wiki.id, "Page.md", "# Page\n\nfirst\n\nlast\n"); await exchange();
    await save(a, wiki.id, "Page.md", "# Page\n\nfirst changed\n\nlast\n"); await save(b, joined.id, "Page.md", "# Page\n\nfirst\n\nlast changed\n");
    await exchange(); await exchange(); expect(await readA("Page.md")).toContain("last changed"); expect(await readB("Page.md")).toContain("first changed");
    await save(a, wiki.id, "Page.md", "# Owner\n"); await save(b, joined.id, "Page.md", "# Member\n"); await a.sync.sync(wiki.id);
    const result = await b.sync.sync(joined.id); expect(result.state).toBe("idle"); expect(result.conflicts).toContain("Page.md");
    expect(await readB("Page.md")).toBe("# Owner\n");
    const copy = (await b.store.files(joined.id)).find(file => file.path.includes(".conflict-")); expect(copy).toBeDefined();
    if (!copy) throw new Error("Conflict copy missing"); expect(await readB(copy.path)).toBe("# Member\n");
    await exchange(); expect(await readA(copy.path)).toBe("# Member\n");
  });
  test("owner offline edits remain local, sign-out/wrong firm/member denial never publishes", async () => {
    const { fixture, a, b, wiki, joined, save, exchange, remote } = await setup();
    await save(a, wiki.id, "Page.md", "# Initial\n"); await exchange();
    fixture.control.failure = 503;
    await a.sync.ensureWritable(await a.store.get(wiki.id), true);
    await expect(b.sync.ensureWritable(await b.store.get(joined.id), true)).rejects.toMatchObject({ status: 503 });
    await save(a, wiki.id, "Page.md", "# Offline edit\n"); expect((await a.sync.sync(wiki.id)).state).toBe("error");
    expect(fixture.wikis.get(remote.id)?.files.get("Page.md")?.data.toString()).toBe("# Initial\n");
    fixture.control.failure = 0; await exchange();
    fixture.revoked.add("member"); await expect(b.sync.ensureWritable(await b.store.get(joined.id), true)).rejects.toMatchObject({ status: 404 });
    await writeEigenweltConnection(a.config, { account: { userId: "owner", userName: "Owner", userEmail: null, orgId: "other", orgName: "Other" } });
    await expect(a.sync.ensureWritable(await a.store.get(wiki.id), true)).rejects.toMatchObject({ status: 403 });
    await writeEigenweltConnection(a.config, { account: null, platformToken: null, refreshToken: null });
    await expect(a.sync.ensureReadable(await a.store.get(wiki.id), true)).rejects.toMatchObject({ code: "wiki_team_sign_in" });
  });
  test("CAS failure preserves local edits and another save made during download survives", async () => {
    const { fixture, a, b, wiki, joined, remote, save, exchange, readA, readB } = await setup();
    await save(a, wiki.id, "Page.md", "# Initial\n"); await exchange();
    await save(a, wiki.id, "Page.md", "# Owner edit\n");
    fixture.control.beforeCommit = async (id, path) => {
      fixture.control.beforeCommit = null;
      await save(b, joined.id, path, "# Concurrent remote edit\n");
      await b.sync.sync(joined.id);
    };
    expect((await a.sync.sync(wiki.id)).state).toBe("error"); expect(await readA("Page.md")).toBe("# Owner edit\n");
    await a.sync.sync(wiki.id);
    fixture.control.beforeDownload = async () => { fixture.control.beforeDownload = null; await save(b, joined.id, "Page.md", "# New local save during download\n"); };
    await b.sync.sync(joined.id); expect(await readB("Page.md")).toBe("# New local save during download\n");
    expect(fixture.wikis.get(remote.id)?.files.get("Page.md")).toBeDefined();
  });
  test("unknown create outcome retries same independent ID; stopping preserves files and re-sharing uses fresh ID", async () => {
    const { fixture, a, computer } = await setup();
    const local = await a.store.create({ name: "Second", root: join(a.directory, "second"), attach: true });
    await a.store.write(local.id, "Private.md", "# Waiting for sharing\n", "");
    fixture.control.unknownCreate = true;
    await expect(a.sync.share(local.id, { access: "members", memberIds: [] })).rejects.toMatchObject({ status: 503 });
    expect(await a.sync.pendingSharing(local.id)).toEqual({ access: "members", memberIds: [] });
    expect((await a.store.get(local.id)).sync).toBeNull();
    const count = fixture.wikis.size;
    const [one, two] = await Promise.all([a.sync.share(local.id, { access: "members", memberIds: [] }), a.sync.share(local.id, { access: "members", memberIds: [] })]);
    expect(one.id).toBe(two.id); expect(fixture.wikis.size).toBe(count); expect(one.id).not.toBe(local.id);
    await a.sync.sync(local.id); const member = await computer("member");
    await expect(member.sync.join({ wikiId: one.id })).rejects.toMatchObject({ status: 404 });
    await a.sync.stopSharing(local.id); expect((await a.store.read(local.id, "Private.md")).content).toBe("# Waiting for sharing\n");
    expect((await a.store.get(local.id)).sync).toBeNull(); const again = await a.sync.share(local.id, { access: "org", memberIds: [] }); expect(again.id).not.toBe(one.id);
  });
  test("legacy registrations never auto-upload and explicit migration preserves content", async () => {
    const { fixture, a } = await setup();
    const local = await a.store.create({ name: "Legacy", root: join(a.directory, "legacy"), attach: true, sync: { workspaceId: "old-project", connectionId: "old-storage", path: "Old" } });
    await a.store.write(local.id, "Legacy.md", "# Old local files\n", "");
    const requests = fixture.requests.length;
    expect((await a.sync.sync(local.id)).error).toContain("retired connector sharing"); expect(fixture.requests.length).toBe(requests);
    await a.sync.ensureReadable(local, true); await expect(a.sync.ensureReadable(local)).rejects.toMatchObject({ code: "wiki_sharing_migration_required" });
    const remote = await a.sync.share(local.id, { access: "members", memberIds: [] }); await a.sync.sync(local.id);
    expect(fixture.wikis.get(remote.id)?.files.get("Legacy.md")?.data.toString()).toBe("# Old local files\n");
  });
  test("external saves poll automatically; oversized pages and damaged state retain files", async () => {
    const { fixture, a, wiki, remote, save } = await setup();
    a.sync.start(); await writeFile(join(wiki.root, "External.md"), "# External editor\n");
    for (let i = 0; i < 50 && !fixture.wikis.get(remote.id)?.files.has("External.md"); i++) await new Promise(done => setTimeout(done, 20));
    expect(fixture.wikis.get(remote.id)?.files.has("External.md")).toBe(true); await a.sync.stop();
    const statePath = join(a.directory, "wiki-sync", `${wiki.id}.md`); expect(parseFrontmatter(await readFile(statePath, "utf8")).data).toHaveProperty("binding");
    await writeFile(statePath, "broken state"); await save(a, wiki.id, "External.md", "# Retained\n"); expect((await a.sync.sync(wiki.id)).state).toBe("error");
    expect((await a.store.read(wiki.id, "External.md")).content).toBe("# Retained\n");
  });
});
