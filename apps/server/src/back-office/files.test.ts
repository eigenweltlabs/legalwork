import { backOfficeAccess } from "./access.js";
import {
  writeEigenweltConnection,
  closeEigenweltConnectionForTests,
} from "../eigenwelt-connection-store.js";
import { resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import { afterEach, expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { openSqlite } from "../runtime-db.js";
import { startServer } from "../server.js";
import { backOfficeStore, closeBackOfficeStoreForTests, BackOfficeStore } from "./store.js";
import { attachFile, attachedFile, historicalFile, encryptedFilePath, cacheFile, cachedFile, migrateLegacyFiles } from "./files.js";
import { localBackOfficeHistoryPage } from "./history.js";
import {
  BACK_OFFICE_FILE_LIMIT,
  BackOfficeFileSchema,
  BackOfficeFieldSchema,
  validateBackOfficeValues,
  type BackOfficeActor,
} from "./schema.js";

const owner: BackOfficeActor = {
  userId: "owner",
  model: true,
  edit: true,
  finance: true,
};
const other: BackOfficeActor = {
  userId: "other",
  model: false,
  edit: true,
  finance: false,
};
const fixtures: { root: string; store: BackOfficeStore }[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bo-attachments-"));
  const config: ServerConfig = {
    configPath: join(root, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "test-host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  fixtures.push({ root, store });
  return { root, config, store };
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
function invoice(store: BackOfficeStore) {
  return store.saveRecord("local", owner, {
    objectId: "invoices",
    revision: 0,
    values: { name: "Invoice" },
  });
}

test("an attachment is an immutable named version; removal keeps its managed copy without exposing it", async () => {
  const { root, store, config } = await fixture();
  const record = invoice(store);
  const original = join(root, "Invoice.pdf");
  await writeFile(original, "%PDF-first version");
  const file = await attachFile(
    config,
    store,
    "local",
    owner,
    record.id,
    "invoiceFile",
    "Invoice.pdf",
    await readFile(original),
  );
  const saved = store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: { invoiceFile: [file] },
  });
  await writeFile(original, "%PDF-new version");
  const cached = await cachedFile(config, file, store, "local", owner);
  if (!cached) throw new Error("The attachment was not cached.");
  expect(new TextDecoder().decode(cached)).toBe(
    "%PDF-first version",
  );
  expect(
    attachedFile(store, "local", owner, record.id, "invoiceFile", file.id),
  ).toEqual(file);
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: saved.revision,
    values: { invoiceFile: [] },
  });
  expect(() =>
    attachedFile(store, "local", owner, record.id, "invoiceFile", file.id),
  ).toThrow("unavailable");
  expect(await cachedFile(config, file, store, "local", owner)).not.toBeNull();
  const item = localBackOfficeHistoryPage(store, "local", owner, { type: "record", id: record.id }).items.find(item => JSON.stringify(item.after).includes(file.id));
  if (!item) throw new Error("The original attachment revision is missing.");
  expect(historicalFile(store, "local", owner, record.id, "invoiceFile", file.id, item.eventId)).toEqual(file);
  expect(() => historicalFile(store, "local", other, record.id, "invoiceFile", file.id, item.eventId)).toThrow("unavailable");
  expect(() => historicalFile(store, "local", owner, record.id, "invoiceFile", file.id, randomUUID())).toThrow("unavailable");
});

test("scoped encrypted file caches preserve local originals and permitted versions while revocation erases only removed keys", async () => {
  const { config, store } = await fixture();
  const record = invoice(store), bytes = new TextEncoder().encode("%PDF sensitive immutable original");
  const file = await attachFile(config, store, "local", owner, record.id, "invoiceFile", "Original.pdf", bytes);
  store.saveRecord("firm", owner, { id: record.id, create: true, objectId: "invoices", revision: 0, values: { name: "Shared invoice" } });
  await cacheFile(config, file, bytes, store, "firm", owner);
  const local = store.fileManifest("local", file.id)!, team = store.fileManifest("firm", file.id)!;
  expect(team.keyId).not.toBe(local.keyId);
  const encrypted = await readFile(encryptedFilePath(config, file, "firm", team.keyId), "utf8");
  expect(encrypted).not.toContain("sensitive immutable original");
  store.restrictTeamAccess("firm", owner);
  expect(await cachedFile(config, file, store, "firm", owner)).toEqual(bytes);
  store.restrictTeamAccess("firm", other);
  expect(store.journal.storage.fileKey(team.keyId)).toBeNull();
  expect(await cachedFile(config, file, store, "firm", owner)).toBeNull();
  expect(await cachedFile(config, file, store, "local", owner)).toEqual(bytes);
  expect(store.journal.evidence("local").entries.some(entry => entry.payload.action === "file.commit")).toBe(true);
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("changed encrypted bytes and replacement keys fail verification without rewriting accepted evidence", async () => {
  const { config, store } = await fixture();
  const record = invoice(store);
  const file = await attachFile(config, store, "local", owner, record.id, "invoiceFile", "Original.pdf", new TextEncoder().encode("%PDF original"));
  const manifest = store.fileManifest("local", file.id)!;
  const path = encryptedFilePath(config, file, "local", manifest.keyId), original = await readFile(path);
  await writeFile(path, "changed ciphertext");
  await expect(cachedFile(config, file, store, "local", owner)).rejects.toBeDefined();
  await writeFile(path, original);
  const heads = store.journal.storage.heads();
  store.journal.storage.eraseFileKey(manifest.keyId);
  store.journal.storage.createFileKey(manifest.keyId);
  expect(() => store.checkIntegrity()).toThrow("attachment key");
  expect(() => store.saveRecord("local", owner, { objectId: "people", revision: 0, values: { name: "Blocked" } })).toThrow("attachment key");
  expect(store.journal.storage.heads()).toEqual(heads);
});

test("legacy Back Office attachment copies migrate to encrypted versions before the old cache is removed", async () => {
  const { config, store, root } = await fixture();
  const record = invoice(store), bytes = new TextEncoder().encode("%PDF original legacy");
  const file = await attachFile(config, store, "local", owner, record.id, "invoiceFile", "Legacy.pdf", bytes);
  store.saveRecord("local", owner, { ...record, values: { invoiceFile: [file] } });
  const directory = join(root, "back-office-files", file.recordId, file.id);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, file.sha256), bytes);
  // A committed old field reference is preserved even when the new cache has not been populated.
  store.transaction(() => store.db.run("DELETE FROM bo_files WHERE scope='local' AND id=?", [file.id]));
  await migrateLegacyFiles(config, store);
  expect(await cachedFile(config, file, store, "local", owner)).toEqual(bytes);
  await expect(readFile(join(directory, file.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("financial fields, record access and file ownership are checked independently of knowing a file ID", async () => {
  const { store, config } = await fixture();
  const record = invoice(store);
  const file = await attachFile(
    config,
    store,
    "local",
    owner,
    record.id,
    "invoiceFile",
    "Invoice.pdf",
    new TextEncoder().encode("%PDF-test"),
  );
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: { invoiceFile: [file] },
  });
  expect(() =>
    attachedFile(store, "local", other, record.id, "invoiceFile", file.id),
  ).toThrow("unavailable");
  await expect(
    attachFile(
      config,
      store,
      "local",
      other,
      record.id,
      "invoiceFile",
      "Other.pdf",
      new Uint8Array([1]),
    ),
  ).rejects.toMatchObject({ status: 404 });
  const another = invoice(store);
  expect(() =>
    store.saveRecord("local", owner, {
      id: another.id,
      objectId: another.objectId,
      revision: another.revision,
      values: { invoiceFile: [file] },
    }),
  ).toThrow("this record and field");
  const model = store.model("local");
  const object = model.objects.find((item) => item.id === "companies")!;
  object.fields.push(
    BackOfficeFieldSchema.parse({
      id: "privateFile",
      label: "Private file",
      type: "file",
      visibility: "private",
    }),
  );
  store.saveModel("local", owner, model, model.revision);
  const company = store.saveRecord("local", owner, {
    objectId: "companies",
    revision: 0,
    values: { name: "Company" },
  });
  const privateFile = await attachFile(
    config,
    store,
    "local",
    owner,
    company.id,
    "privateFile",
    "Private.pdf",
    new Uint8Array([2]),
  );
  store.saveRecord("local", owner, {
    id: company.id,
    objectId: company.objectId,
    revision: company.revision,
    values: { privateFile: [privateFile] },
  });
  expect(
    store.records("local", other, "companies")[0].values,
  ).not.toHaveProperty("privateFile");
  expect(() =>
    attachedFile(
      store,
      "local",
      other,
      company.id,
      "privateFile",
      privateFile.id,
    ),
  ).toThrow("unavailable");
});

test("file size, names, cardinality and content hashes are validated", async () => {
  const { store, config } = await fixture();
  const record = invoice(store);
  await expect(
    attachFile(
      config,
      store,
      "local",
      owner,
      record.id,
      "invoiceFile",
      "Empty.pdf",
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    attachFile(
      config,
      store,
      "local",
      owner,
      record.id,
      "invoiceFile",
      "../Escape.pdf",
      new Uint8Array([1]),
    ),
  ).rejects.toThrow();
  await expect(
    attachFile(
      config,
      store,
      "local",
      owner,
      record.id,
      "invoiceFile",
      "Large.pdf",
      new Uint8Array(BACK_OFFICE_FILE_LIMIT + 1),
    ),
  ).rejects.toMatchObject({ status: 413 });
  const file = await attachFile(
    config,
    store,
    "local",
    owner,
    record.id,
    "invoiceFile",
    "Invoice.pdf",
    new Uint8Array([1, 2, 3]),
  );
  expect(
    BackOfficeFileSchema.safeParse({ ...file, contentType: "text/html" })
      .success,
  ).toBe(false);
  const object = store
    .model("local")
    .objects.find((item) => item.id === "invoices")!;
  expect(() =>
    validateBackOfficeValues(object, {
      name: "Invoice",
      invoiceFile: [file, { ...file, id: randomUUID() }],
    }),
  ).toThrow("one file");
  await expect(
    cacheFile(config, file, new Uint8Array([1, 2, 4]), store, "local", owner),
  ).rejects.toMatchObject({ status: 409 });
});

test("a required file can be attached to a draft UUID and saved atomically with the new record", async () => {
  const { store, config } = await fixture();
  const model = store.model("local");
  const company = model.objects.find((item) => item.id === "companies")!;
  company.fields.push(
    BackOfficeFieldSchema.parse({
      id: "contract",
      label: "Contract",
      type: "file",
      required: true,
      multiple: true,
    }),
  );
  store.saveModel("local", owner, model, model.revision);
  expect(() =>
    validateBackOfficeValues(company, { name: "Company", contract: [] }),
  ).toThrow("required");
  const id = randomUUID();
  const file = await attachFile(
    config,
    store,
    "local",
    owner,
    id,
    "contract",
    "Contract.pdf",
    new Uint8Array([1]),
    "companies",
  );
  const saved = store.saveRecord("local", owner, {
    id,
    create: true,
    objectId: "companies",
    revision: 0,
    values: { name: "Company", contract: [file] },
  });
  expect(saved.id).toBe(id);
  expect(
    attachedFile(store, "local", owner, id, "contract", file.id).sha256,
  ).toBe(file.sha256);
  expect(() =>
    store.saveRecord("local", owner, {
      id,
      create: true,
      objectId: "companies",
      revision: 0,
      values: { name: "Duplicate", contract: [file] },
    }),
  ).toThrow("already exists");
});

test("a signed-in account on an older platform keeps file attachments local without a sync policy", async () => {
  const { config, store } = await fixture();
  const network = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("The old platform must not be required for local attachments."),
  );
  const previousURL = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:1";
  try {
    await writeEigenweltConnection(config, {
      platformURL: "http://127.0.0.1:1",
      platformToken: "unused-fixture-token",
      accessTokenExpiresAt: Date.now() + 3600000,
      account: {
        userId: "old-user",
        orgId: "old-firm",
        orgName: "Old platform",
        orgRole: "org:member",
        userName: null,
        userEmail: null,
      },
    });
    const access = await backOfficeAccess(config);
    expect(access.scope).toBe("local");
    expect(access.sharingAllowed).toBe(false);
    const record = store.saveRecord(access.scope, access.actor, {
      objectId: "invoices",
      revision: 0,
      values: { name: "Local invoice" },
    });
    const file = await attachFile(
      config,
      store,
      access.scope,
      access.actor,
      record.id,
      "invoiceFile",
      "Invoice.pdf",
      new Uint8Array([1, 2]),
    );
    store.saveRecord(access.scope, access.actor, {
      id: record.id,
      objectId: "invoices",
      revision: record.revision,
      values: { invoiceFile: [file] },
    });
    expect(
      attachedFile(
        store,
        access.scope,
        access.actor,
        record.id,
        "invoiceFile",
        file.id,
      ).id,
    ).toBe(file.id);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    if (previousURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
    else process.env.EIGENWELT_PLATFORM_URL = previousURL;
    await closeEigenweltConnectionForTests(config);
    await resetOrgPolicyRuntimeForTests(config);
  }
});

test("a project attachment uses the document folder and rejects links outside it", async () => {
  const { root, config } = await fixture();
  const engine = join(root, "engine"), documents = join(root, "documents");
  await Promise.all([mkdir(engine), mkdir(documents)]);
  config.authorizedRoots.push(engine, documents);
  config.workspaces.push({ id: "case", name: "Case", workspaceType: "local", preset: "starter", path: engine, contentPath: documents });
  const content = "%PDF-selected document";
  await writeFile(join(documents, "invoice.pdf"), content);
  await writeFile(join(engine, "invoice.pdf"), "%PDF-private");
  await symlink(join(engine, "invoice.pdf"), join(documents, "outside.pdf"));
  const server = await startServer(config);
  try {
    const record = invoice(await backOfficeStore(config));
    const attach = (path: string) => fetch(`http://127.0.0.1:${server.port}/back-office/records/${record.id}/files/invoiceFile`, {
      method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ source: { workspaceId: "case", path } }),
    });
    const result = await attach("invoice.pdf");
    expect(result.status, result.ok ? undefined : await result.text()).toBe(200);
    expect(await result.json()).toMatchObject({ file: { name: "invoice.pdf", size: content.length } });
    expect((await attach("outside.pdf")).status).toBe(403);
  } finally {
    await server.stop();
    await closeBackOfficeStoreForTests(config);
  }
});
