import { backOfficeAccess } from "./access.js";
import {
  writeEigenweltConnection,
  closeEigenweltConnectionForTests,
} from "../eigenwelt-connection-store.js";
import { resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import { afterEach, expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { attachFile, attachedFile, cacheFile, cachedFile } from "./files.js";
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
  const cached = await cachedFile(config, file);
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
  expect(await cachedFile(config, file)).not.toBeNull();
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
    cacheFile(config, file, new Uint8Array([1, 2, 4])),
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
