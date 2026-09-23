import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEncryptedMailDatabase } from "../storage/database.js";
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from "../storage/schema.js";
import { MailRepository } from "../storage/repository.js";
import { MailCredentialRepository } from "../storage/credentials.js";
import { MailContacts } from "./contacts.js";
import {
  fetchContactSnapshot,
  contactGraphUrl,
} from "../providers/contacts.js";
import { CONTACT_SCOPES } from "../contacts-view.js";
import { validWorkerCommand } from "./protocol.js";
const binding = {
  provider: "gmail",
  clientId: "synthetic.apps.googleusercontent.com",
  authority: "https://accounts.google.com",
  providerSubject: "synthetic",
};
const token = (grants = [CONTACT_SCOPES.gmail]) => ({
  accessToken: "synthetic",
  expiresAt: Date.now() + 3600000,
  grantedScopes: grants,
  refreshToken: { action: "replace", value: "synthetic-refresh" },
});
const change = (id, address, name = "Synthetic person") => ({
  id,
  name,
  addresses: [address],
  deleted: false,
});
const signal = () => AbortSignal.timeout(5000);
async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(), "contacts-test-")),
    path = join(dir, "mail.sqlite"),
    key = randomBytes(32);
  let db = await openEncryptedMailDatabase({ path, key });
  const runners = [];
  try {
    migrateMailSchema(db);
    const repo = new MailRepository(db, "owner"),
      credentials = new MailCredentialRepository(db, "owner");
    repo.createAccount({
      id: "a",
      provider: "gmail",
      displayName: "Synthetic",
    });
    credentials.connect("a", binding, null, token());
    const make = (fetcher, grants = [CONTACT_SCOPES.gmail]) => {
      const runner = new MailContacts(
        db,
        "owner",
        {
          acquire: async () => ({
            ...token(grants),
            version: credentials.status("a").version,
          }),
        },
        fetcher,
      );
      runners.push(runner);
      return runner;
    };
    await body({ db, path, key, repo, credentials, make });
  } finally {
    for (const runner of runners) await runner.close();
    db.close();
    key.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
}
async function settle(runner) {
  for (let i = 0; i < 100; i++) {
    const status = runner.execute("a", { action: "status" });
    if (status.state !== "syncing") return status;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("contact sync timeout");
}
test("encrypted offline snapshot applies incremental updates/tombstones atomically and isolates owners", () =>
  fixture(async (f) => {
    let snapshot = {
      changes: [
        change("1", "alice@example.test", "Alice Private Marker"),
        change("2", "other@example.test"),
      ],
      cursor: "first",
      full: true,
    };
    const seen = [];
    const runner = f.make(async (input) => {
      seen.push(input.cursor);
      return snapshot;
    });
    runner.execute("a", { action: "sync" });
    assert.equal((await settle(runner)).count, 2);
    assert.equal(
      runner.execute("a", { action: "search", query: "alice" }).items[0]
        .address,
      "alice@example.test",
    );
    snapshot = {
      changes: [
        change("1", "new@example.test", "Alicia"),
        { id: "2", name: "", addresses: [], deleted: true },
        change("3", "NEW@example.test", "Alias"),
      ],
      cursor: "second",
      full: false,
    };
    runner.execute("a", { action: "sync" });
    await settle(runner);
    assert.deepEqual(seen, [null, "first"]);
    assert.equal(
      runner.execute("a", { action: "search", query: "alice" }).items.length,
      0,
    );
    assert.equal(
      runner.execute("a", { action: "search", query: "new@" }).items.length,
      1,
    );
    snapshot = {
      changes: [{ id: "1", name: "Updated name", deleted: false }],
      cursor: "partial",
      full: false,
    };
    runner.execute("a", { action: "sync" });
    await settle(runner);
    assert.equal(
      f.db.get(
        "SELECT addresses_json FROM mail_contact_entries WHERE provider_id='1'",
      ).addresses_json,
      '["new@example.test"]',
    );
    assert.equal(
      f.db.get("SELECT name FROM mail_contact_entries WHERE provider_id='1'")
        .name,
      "Updated name",
    );
    const offline = f.make(async () => {
      throw Error("offline");
    });
    offline.execute("a", { action: "sync" });
    assert.equal((await settle(offline)).error, "unavailable");
    assert.equal(
      offline.execute("a", { action: "search", query: "new@" }).items.length,
      1,
    );
    assert.equal(
      f.db.get("SELECT cursor FROM mail_contact_books").cursor,
      "partial",
    );
    new MailRepository(f.db, "other").createAccount({
      id: "foreign",
      provider: "gmail",
      displayName: "Foreign",
    });
    assert.throws(
      () => runner.execute("foreign", { action: "search", query: "" }),
      { code: "not_found" },
    );
    for (const file of [f.path, f.path + "-wal"])
      assert.equal(
        (await readFile(file)).includes(Buffer.from("new@example.test")),
        false,
      );
  }));
test("scope opt-in, disable cancellation and disconnected-account access are fenced", () =>
  fixture(async (f) => {
    const denied = f.make(async () => {
      throw Error("must not fetch");
    }, []);
    denied.execute("a", { action: "sync" });
    assert.equal((await settle(denied)).error, "permission");
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const runner = f.make(() => pending);
    runner.execute("a", { action: "sync" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    runner.execute("a", { action: "disable" });
    release({
      changes: [change("1", "late@example.test")],
      cursor: "late",
      full: true,
    });
    await settle(runner);
    assert.equal(runner.execute("a", { action: "status" }).state, "disabled");
    assert.equal(f.db.get("SELECT count(*) n FROM mail_contact_entries").n, 0);
    const generation = f.credentials.status("a").version;
    f.credentials.disconnect("a", generation);
    assert.throws(() => runner.execute("a", { action: "search", query: "" }), {
      code: "locked",
    });
  }));
test("new runner reads cached contacts without network and migration31 rolls back atomically", () =>
  fixture(async (f) => {
    const runner = f.make(async () => ({
      changes: [change("1", "offline@example.test")],
      cursor: "c",
      full: true,
    }));
    runner.execute("a", { action: "sync" });
    await settle(runner);
    await runner.close();
    const offline = f.make(async () => {
      throw Error("no network");
    });
    assert.equal(
      offline.execute("a", { action: "search", query: "offline" }).items[0]
        .address,
      "offline@example.test",
    );
    f.db.exec("DROP TABLE mail_contact_entries; DROP TABLE mail_contact_books");
    f.db.run("UPDATE mail_schema_version SET version=30");
    const failing = {
      ...f.db,
      exec(sql) {
        f.db.exec(sql);
        if (sql.includes("CREATE TABLE mail_contact_books"))
          throw Error("synthetic");
      },
    };
    assert.throws(() => migrateMailSchema(failing));
    assert.equal(
      f.db.get("SELECT version FROM mail_schema_version").version,
      30,
    );
    assert.equal(
      f.db.get(
        "SELECT name FROM sqlite_schema WHERE name='mail_contact_books'",
      ),
      undefined,
    );
    migrateMailSchema(f.db);
    assert.equal(
      f.db.get("SELECT version FROM mail_schema_version").version,
      MAIL_SCHEMA_VERSION,
    );
  }));
test("Google pagination preserves parameters and publishes tombstones; expired cursor retries full once", async () => {
  const urls = [];
  const result = await fetchContactSnapshot({
    provider: "gmail",
    accessToken: "secret",
    cursor: "expired",
    signal: signal(),
    fetch: async (url, options) => {
      urls.push(url);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      const parsed = new URL(url);
      if (parsed.searchParams.get("syncToken"))
        return Response.json(
          { error: { details: [{ reason: "EXPIRED_SYNC_TOKEN" }] } },
          { status: 400 },
        );
      if (!parsed.searchParams.get("pageToken"))
        return Response.json({
          connections: [
            {
              resourceName: "people/1",
              names: [{ displayName: "Alice" }],
              emailAddresses: [{ value: "alice@example.test" }],
            },
          ],
          nextPageToken: "p2",
        });
      return Response.json({
        connections: [
          { resourceName: "people/deleted", metadata: { deleted: true } },
        ],
        nextSyncToken: "fresh",
      });
    },
  });
  assert.equal(result.full, true);
  assert.equal(result.cursor, "fresh");
  assert.equal(result.changes[1].deleted, true);
  assert.equal(urls.length, 3);
  for (const url of urls) {
    const u = new URL(url);
    assert.equal(u.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
    assert.equal(
      u.searchParams.get("personFields"),
      "names,emailAddresses,metadata",
    );
  }
});
test("Microsoft discovers default folder, follows pinned delta links, propagates updates/deletions and refuses foreign URLs", async () => {
  const base =
    "https://graph.microsoft.com/v1.0/me/contactFolders/folder/contacts/delta";
  let calls = 0;
  const result = await fetchContactSnapshot({
    provider: "graph",
    accessToken: "secret",
    cursor: null,
    signal: signal(),
    fetch: async (url) => {
      calls++;
      if (url.includes("/me/contacts?"))
        return Response.json({ value: [{ parentFolderId: "folder" }] });
      if (!url.includes("$skiptoken"))
        return Response.json({
          value: [
            {
              id: "1",
              displayName: "Alice",
              emailAddresses: [{ address: "alice@example.test" }],
            },
          ],
          "@odata.nextLink": base + "?$skiptoken=second",
        });
      return Response.json({
        value: [{ id: "2", "@removed": { reason: "deleted" } }],
        "@odata.deltaLink": base + "?$deltatoken=end",
      });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.changes[1].deleted, true);
  assert.equal(result.cursor, base + "?$deltatoken=end");
  for (const url of [
    "https://evil.test/v1.0/me/contactFolders/folder/contacts/delta",
    base.replace("/me/", "/users/"),
    base + "#token",
  ])
    assert.throws(() => contactGraphUrl(url, new URL(base).pathname));
  let attempts = 0;
  await assert.rejects(
    fetchContactSnapshot({
      provider: "graph",
      accessToken: "secret",
      cursor: result.cursor,
      signal: signal(),
      fetch: async () => {
        attempts++;
        return Response.json({
          value: [],
          "@odata.nextLink": "https://evil.test/steal",
        });
      },
    }),
    { code: "invalid_response" },
  );
  assert.equal(attempts, 1);
  const partial = await fetchContactSnapshot({
    provider: "graph",
    accessToken: "secret",
    cursor: result.cursor,
    signal: signal(),
    fetch: async () =>
      Response.json({
        value: [{ id: "1", displayName: "Renamed" }],
        "@odata.deltaLink": base + "?$deltatoken=partial",
      }),
  });
  assert.equal(partial.changes[0].addresses, undefined);
  assert.equal(partial.changes[0].name, "Renamed");
  const empty = await fetchContactSnapshot({
    provider: "graph",
    accessToken: "secret",
    cursor: null,
    signal: signal(),
    fetch: async () => Response.json({ value: [] }),
  });
  assert.deepEqual(empty, { changes: [], cursor: null, full: true });
});
test("incomplete pages, invalid addresses and response budgets cannot advance a cursor", async () => {
  await assert.rejects(
    fetchContactSnapshot({
      provider: "gmail",
      accessToken: "secret",
      cursor: null,
      signal: signal(),
      fetch: async () => Response.json({ connections: [] }),
    }),
    { code: "invalid_response" },
  );
  await assert.rejects(
    fetchContactSnapshot({
      provider: "gmail",
      accessToken: "secret",
      cursor: null,
      signal: signal(),
      fetch: async () => new Response(" ".repeat(4 * 1024 * 1024 + 1)),
    }),
    { code: "limit" },
  );
  const result = await fetchContactSnapshot({
    provider: "gmail",
    accessToken: "secret",
    cursor: null,
    signal: signal(),
    fetch: async () =>
      Response.json({
        connections: [
          {
            resourceName: "p",
            emailAddresses: [
              { value: "bad\r\n@example.test" },
              { value: "good@example.test" },
            ],
          },
        ],
        nextSyncToken: "ok",
      }),
  });
  assert.deepEqual(result.changes[0].addresses, ["good@example.test"]);
  assert.equal(
    validWorkerCommand({
      operation: "mail.contacts",
      accountId: "a",
      input: { action: "search", query: "Alice" },
      url: "https://evil.test",
    }),
    false,
  );
  assert.equal(
    validWorkerCommand({
      operation: "mail.contacts",
      accountId: "a",
      input: { action: "search", query: "Alice" },
    }),
    true,
  );
});
