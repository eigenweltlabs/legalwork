import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("draft HTTP routes enforce auth, revisions, workspace boundaries and read-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "drafts-http-"));
  const script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import assert from "node:assert/strict";
    const { startServer } = await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "project");
    await mkdir(join(folder, ".git"), { recursive: true });
    await writeFile(join(folder, "contract.txt"), "Synthetic contract");
    const config = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: ["project", "other"].map(id => ({ id, name: id, path: folder, preset: "starter", workspaceType: "local" })),
      authorizedRoots: [folder], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const server = await startServer(config), base = "http://127.0.0.1:" + server.port;
    const call = (path, method="GET", body, token="test") => fetch(base + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const viewer = "owt_retired_viewer";
      for (const kind of ["email", "calendar"]) {
        const path = "/workspace/project/" + kind + "-drafts";
        const input = kind === "email"
          ? { to: "client@example.com", subject: "Review contract", body: "Please review.", attachments: [{ path: "contract.txt", contentType: "text/plain" }] }
          : { title: "Contract review", start: "2026-10-13T14:00:00", end: "2026-10-13T15:00:00", timeZone: "Europe/Berlin", attendees: "guest@example.com", organizer: "host@example.com", location: "Office", url: "https://example.com/meeting", reminders: [15, 60] };
        assert.equal((await call(path, "POST", input, "bad")).status, 401);
        assert.equal((await call(path, "POST", input, viewer)).status, 401);
        const created = await call(path, "POST", input);
        assert.equal(created.status, 200);
        const draft = (await created.json()).draft, itemPath = path + "/" + draft.id;
        assert.equal((await call(itemPath, "GET", undefined, viewer)).status, 401);
        assert.equal((await call(itemPath, "PUT", draft, viewer)).status, 401);
        assert.equal((await call("/workspace/other/" + kind + "-drafts/" + draft.id)).status, 404);
        assert.equal((await call("/workspace/other/" + kind + "-drafts/" + draft.id, "PUT", draft)).status, 409);
        const raw = await call("/workspace/project/files/raw?path=" + encodeURIComponent(draft.path));
        assert.equal(raw.status, 200);
        assert.match(await raw.text(), kind === "email" ? /X-Unsent: 1/ : /BEGIN:VEVENT/);
        const edit = kind === "email" ? { subject: "Human correction" } : { title: "Human correction" };
        const updated = await call(itemPath, "PUT", { ...draft, ...edit });
        assert.equal(updated.status, 200);
        const saved = (await updated.json()).draft;
        assert.notEqual(saved.revision, draft.revision);
        if (kind === "calendar") {
          assert.equal(saved.sequence, 1);
          assert.equal(saved.startInstant, "2026-10-13T12:00:00.000Z");
        }
        assert.equal((await call(itemPath, "PUT", draft)).status, 409);
        assert.deepEqual((await (await call(itemPath)).json()).draft, saved);
        if (kind === "calendar") {
          const action = "/workspace/project/calendar/drafts/" + saved.id;
          assert.equal((await (await call(action)).json()).item, null);
          assert.equal((await call(action, "POST", { draftRevision: saved.revision }, "bad")).status, 401);
          assert.equal((await call(action, "POST", { draftRevision: saved.revision }, viewer)).status, 401);
          assert.equal((await call("/workspace/other/calendar/drafts/" + saved.id, "POST", { draftRevision: saved.revision })).status, 404);
          assert.equal((await call(action, "POST", { draftRevision: draft.revision })).status, 409);
          const added = await call(action, "POST", { draftRevision: saved.revision });
          assert.equal(added.status, 200);
          const status = await added.json(), entry = status.item;
          assert.equal(status.savedRevision, saved.revision);
          assert.equal(entry.kind, "event");
          assert.equal(entry.title, saved.title);
          assert.equal(entry.start, saved.start);
          assert.equal(entry.timeZone, saved.timeZone);
          assert.deepEqual(entry.reminders, [15, 60]);
          for (const value of ["ATTENDEE", "guest@example.com", "ORGANIZER", "host@example.com", "LOCATION:Office", "URL:https://example.com/meeting", "BEGIN:VALARM"]) assert.ok(entry.ical.includes(value), value);
          assert.equal((await (await call(action)).json()).item.id, entry.id);
          assert.equal((await call(action, "POST", { draftRevision: saved.revision })).status, 409);
          const edited = (await (await call(itemPath, "PUT", { ...saved, title: "Rescheduled review" })).json()).draft;
          const replaced = await call(action, "POST", { draftRevision: edited.revision, calendarRevision: entry.revision });
          assert.equal(replaced.status, 200);
          const replacement = (await replaced.json()).item;
          assert.equal(replacement.id, entry.id);
          assert.equal(replacement.title, "Rescheduled review");
          assert.equal((await call(action, "POST", { draftRevision: edited.revision, calendarRevision: entry.revision })).status, 409);
          assert.equal((await (await call("/workspace/project/calendar")).json()).items.length, 1);
          config.readOnly = true;
          assert.equal((await call(action, "POST", { draftRevision: edited.revision, calendarRevision: replacement.revision })).status, 403);
          config.readOnly = false;
          const removed = (await (await call("/workspace/project/calendar/" + entry.id + "/delete", "POST", { revision: replacement.revision })).json()).item;
          assert.equal((await (await call(action)).json()).savedRevision, null);
          assert.equal((await call(action, "POST", { draftRevision: edited.revision, calendarRevision: removed.revision })).status, 410);
        }
        const invalid = kind === "email" ? { ...input, subject: "Injected\\r\\nBcc: other@example.com" } : { ...input, end: input.start };
        assert.equal((await call(path, "POST", invalid)).status, 400);
        config.readOnly = true;
        assert.equal((await call(path, "POST", input)).status, 403);
        assert.equal((await call(itemPath, "PUT", saved)).status, 403);
        assert.equal((await call(itemPath)).status, 200);
        config.readOnly = false;
      }
      const traversal = await call("/workspace/project/email-drafts", "POST", { attachments: [{ path: "../secret" }] });
      assert.equal(traversal.status, 400);
      console.log("draft HTTP checks passed");
    } finally { await server.stop(); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stderr + stdout }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("draft HTTP checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
