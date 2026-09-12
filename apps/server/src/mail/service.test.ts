import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalMailService, type LocalMailServiceOptions } from "./service.js";
import { GMAIL_MAIL_SCOPES } from "./provider-config.js";
import type { MailOAuthSettings } from "./providers/oauth.js";
import { MailWorkerClient } from "./runtime/client.js";
import type { WorkerResult } from "./runtime/protocol.js";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const nodePath = Bun.which("node");
if (!nodePath) throw new Error("Compatible Node is required");
let directory = "";
let entryPoint = "";
const services: LocalMailService[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "legalwork-mail-service-"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await symlink(join(serverRoot, "node_modules"), join(directory, "node_modules"));
  execFileSync("pnpm", ["exec", "tsc", "--outDir", join(directory, "build"), "--rootDir", "src", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/runtime/worker.ts"], { cwd: serverRoot, stdio: "pipe", timeout: 30_000 });
  entryPoint = join(directory, "build/mail/runtime/worker.js");
}, 30_000);
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup(loadKey?: () => Promise<Uint8Array>, loadProviderSettings?: LocalMailServiceOptions["loadProviderSettings"]) {
  const privateDir = await mkdtemp(join(directory, "store-"));
  const databasePath = join(privateDir, "mail.sqlite");
  const key = randomBytes(32);
  const supplied: Uint8Array[] = [];
  const service = new LocalMailService({
    entryPoint, databasePath, ownerId: "desktop-local", executable: { kind: "node", path: nodePath! },
    loadKey: loadKey ?? (async () => { const bytes = new Uint8Array(key); supplied.push(bytes); return bytes; }),
    loadProviderSettings,
  });
  services.push(service);
  return { service, databasePath, supplied };
}
test("service stays locked without vault access until unlock, clears supplied keys, and reopens", async () => {
  const { service, databasePath, supplied } = await setup();
  expect(service.status().state).toBe("locked");
  expect(supplied).toHaveLength(0);
  await expect(stat(databasePath)).rejects.toThrow();
  await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
  const first = service.unlock();
  expect(service.unlock()).toBe(first);
  await first;
  expect(service.status()).toEqual({ protocolVersion: 1, state: "ready", syncSupported: true });
  expect(supplied).toHaveLength(1);
  expect(supplied[0]?.every(byte => byte === 0)).toBe(true);
  expect(await service.listAccounts({ limit: 1 })).toEqual({ items: [], nextCursor: null });
  await expect(service.listFolders("missing", {})).rejects.toThrow("mail_not_found");
  const locking = service.lock();
  await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
  await locking;
  expect(service.status().state).toBe("locked");
  await service.unlock();
  expect(await service.listAccounts({})).toEqual({ items: [], nextCursor: null });
  expect(supplied).toHaveLength(2);
});
test("stop forbids reactivation and new requests before asynchronous cleanup finishes", async () => {
  const { service } = await setup();
  await service.unlock();
  const stopping = service.stop();
  expect(service.status().state).toBe("stopped");
  await expect(service.unlock()).rejects.toThrow("mail_unavailable");
  await expect(service.listAccounts({})).rejects.toThrow("mail_unavailable");
  await stopping;
});

test("account enumeration failure closes the opening generation and can be retried", async () => {
  const { service } = await setup();
  const request = spyOn(MailWorkerClient.prototype, "request").mockRejectedValueOnce(new Error("synthetic enumeration failure"));
  try {
    const opening = service.unlock();
    expect(service.unlock()).toBe(opening);
    await expect(opening).rejects.toThrow("mail_unavailable");
    expect(service.status().state).toBe("locked");
    await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
    await service.unlock();
    expect(service.status().state).toBe("ready");
    expect(await service.listAccounts({})).toEqual({ items: [], nextCursor: null });
  } finally { request.mockRestore(); }
});
test("late enumeration failure cannot overwrite a concurrent lock or the next opening", async () => {
  const { service } = await setup();
  let entered = () => {};
  const enumerating = new Promise<void>(resolve => { entered = resolve; });
  let fail: (error: Error) => void = () => {};
  const delayed = new Promise<WorkerResult>((_, reject) => { fail = reject; });
  const request = spyOn(MailWorkerClient.prototype, "request").mockImplementationOnce(() => { entered(); return delayed; });
  try {
    const opening = service.unlock().then(() => "opened", () => "failed");
    await enumerating;
    const closing = service.lock();
    await expect(service.unlock()).rejects.toThrow("mail_locked");
    fail(new Error("synthetic late enumeration failure"));
    expect(await opening).toBe("failed");
    await closing;
    expect(service.status().state).toBe("locked");
    await service.unlock();
    expect(service.status().state).toBe("ready");
    expect(await service.listAccounts({})).toEqual({ items: [], nextCursor: null });
  } finally { request.mockRestore(); }
});

test("already pending read responses cannot cross a lock and new worker generation", async () => {
  const { service } = await setup(); await service.unlock();
  let deliver: (value: WorkerResult) => void = () => {};
  const delayed = new Promise<WorkerResult>(resolve => { deliver = resolve; });
  const request = spyOn(MailWorkerClient.prototype, "request").mockImplementationOnce(() => delayed);
  try {
    const reading = service.listAccounts({});
    const rejected = reading.then(() => false, error => error instanceof Error && error.message === "mail_locked");
    await service.lock(); await service.unlock();
    deliver({ accounts: [{ id: "private", provider: "gmail", displayName: "Old generation" }], nextCursor: null });
    expect(await rejected).toBe(true);
  } finally { request.mockRestore(); }
});
test("locking while key retrieval is pending prevents a late worker start", async () => {
  let requested = () => {};
  const started = new Promise<void>(resolve => { requested = resolve; });
  let supply: (key: Uint8Array) => void = () => {};
  const pendingKey = new Promise<Uint8Array>(resolve => { supply = resolve; });
  const { service, databasePath } = await setup(async () => { requested(); return pendingKey; });
  const unlocking = service.unlock();
  const rejected = unlocking.then(() => false, () => true);
  await started;
  await service.lock();
  expect(await rejected).toBe(true);
  const key = randomBytes(32);
  supply(key);
  // Observe completion of the supplier's continuation without waiting on a timer.
  await pendingKey; await Promise.resolve(); await Promise.resolve();
  expect(key.every(byte => byte === 0)).toBe(true);
  await expect(stat(databasePath)).rejects.toThrow();
  expect(service.status().state).toBe("locked");
});
test("vault failures and invalid keys are redacted and cannot claim ready", async () => {
  for (const supplier of [async () => { throw new Error("private-path secret-token"); }, async () => new Uint8Array(31)]) {
    const { service, databasePath } = await setup(supplier);
    await expect(service.unlock()).rejects.toThrow("mail_unavailable");
    expect(service.status().state).toBe("locked");
    await expect(stat(databasePath)).rejects.toThrow();
  }
});
const googleSettings: MailOAuthSettings = { provider: "gmail", applicationType: "desktop", pkceMethod: "S256",
  clientId: "123456-synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret-client", scopes: GMAIL_MAIL_SCOPES };
test("service starts and cancels a private OAuth listener without exposing settings or contacting a provider", async () => {
  let loads = 0;
  const { service } = await setup(undefined, async () => { loads++; return googleSettings; });
  await expect(service.beginConnection("gmail")).rejects.toThrow("mail_locked");
  expect(loads).toBe(0);
  await service.unlock();
  const started = await service.beginConnection("gmail");
  expect(loads).toBe(1);
  expect(new URL(started.authorizationUrl).hostname).toBe("accounts.google.com");
  expect(JSON.stringify(started)).not.toContain(googleSettings.clientSecret);
  expect((await service.connectionStatus(started.connectionId)).state).toBe("pending");
  await service.cancelConnection(started.connectionId);
  expect((await service.connectionStatus(started.connectionId)).state).toBe("cancelled");
  expect(await service.listAccounts({})).toEqual({ items: [], nextCursor: null });
  await expect(service.disconnectAccount("missing")).rejects.toThrow("mail_not_found");
});
test("configuration errors are redacted and lock/reopen fences a pending configuration load", async () => {
  const failing = await setup(undefined, async () => { throw new Error("private-token private-config-path"); });
  await failing.service.unlock();
  await expect(failing.service.beginConnection("gmail")).rejects.toThrow("mail_unavailable");
  let started = () => {};
  const loading = new Promise<void>(resolve => { started = resolve; });
  let supply: (settings: MailOAuthSettings) => void = () => {};
  const settings = new Promise<MailOAuthSettings>(resolve => { supply = resolve; });
  const { service } = await setup(undefined, async () => { started(); return settings; });
  await service.unlock();
  const pending = service.beginConnection("gmail").then(() => false, () => true);
  await loading;
  await service.lock();
  await service.unlock();
  supply(googleSettings);
  expect(await pending).toBe(true);
  expect(service.status().state).toBe("ready");
  const fresh = await service.beginConnection("gmail");
  await service.cancelConnection(fresh.connectionId);
});

test("disconnect fences reconnect waiting for private configuration", async () => {
  const key = randomBytes(32);
  let supply: (settings: MailOAuthSettings) => void = () => {};
  const delayed = new Promise<MailOAuthSettings>(resolve => { supply = resolve; });
  let configured = false;
  const { service, databasePath } = await setup(async () => new Uint8Array(key), async () => { if (!configured) { configured = true; throw Error("synthetic automatic configuration unavailable"); } return delayed; });
  const script = `
    import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${JSON.stringify(pathToFileURL(join(directory, "build/mail/storage/database.js")).href)};
    import {migrateMailSchema} from ${JSON.stringify(pathToFileURL(join(directory, "build/mail/storage/schema.js")).href)};
    import {MailRepository} from ${JSON.stringify(pathToFileURL(join(directory, "build/mail/storage/repository.js")).href)};
    import {MailCredentialRepository} from ${JSON.stringify(pathToFileURL(join(directory, "build/mail/storage/credentials.js")).href)};
    const input=JSON.parse(readFileSync(0,'utf8')),key=Buffer.from(input.key,'base64');
    const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);
    try {migrateMailSchema(db);new MailRepository(db,'desktop-local').createAccount({id:'a',provider:'gmail',displayName:'Synthetic'});
    new MailCredentialRepository(db,'desktop-local').connect('a',
      {provider:'gmail',clientId:'123456-synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'synthetic'},null,
      {accessToken:'synthetic-access',expiresAt:Date.now()+3600000,grantedScopes:null,refreshToken:{action:'clear'}});
    }finally{db.close();}
  `;
  execFileSync(nodePath!, ["--input-type=module", "--eval", script], { input: JSON.stringify({ path: databasePath, key: key.toString("base64") }), stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  try {
    await service.unlock();
    const pending = service.beginConnection("gmail", "a").then(() => "started", () => "rejected");
    await service.disconnectAccount("a");
    supply(googleSettings);
    expect(await pending).toBe("rejected");
    expect(service.status().state).toBe("ready");
    await expect(service.listFolders("a", {})).rejects.toThrow("mail_locked");
  } finally { key.fill(0); }
});

test("pause and lock revoke a sync start still waiting for trusted settings", async () => {
  for (const action of ["pause", "lock"]) {
    let loaded = () => {};
    const loading = new Promise<void>(resolve => { loaded = resolve; });
    let supply: (settings: MailOAuthSettings) => void = () => {};
    const delayed = new Promise<MailOAuthSettings>(resolve => { supply = resolve; });
    const key = randomBytes(32);
    const { service, databasePath } = await setup(async () => new Uint8Array(key), async () => { loaded(); return delayed; });
    execFileSync(nodePath!, ["--input-type=module", "--eval", `
      import {openEncryptedMailDatabase} from ${JSON.stringify(pathToFileURL(join(directory,"build/mail/storage/database.js")).href)};
      import {migrateMailSchema} from ${JSON.stringify(pathToFileURL(join(directory,"build/mail/storage/schema.js")).href)};
      import {MailRepository} from ${JSON.stringify(pathToFileURL(join(directory,"build/mail/storage/repository.js")).href)};
      const db=await openEncryptedMailDatabase({path:${JSON.stringify(databasePath)},key:Buffer.from(${JSON.stringify(key.toString("base64"))},'base64')});migrateMailSchema(db);
      new MailRepository(db,'desktop-local').createAccount({id:'missing',provider:'gmail',displayName:'Synthetic'});db.close();
    `], {timeout:10000});
    await service.unlock();
    const pending = service.startSync("missing").then(() => "started", error => error.message);
    await loading;
    if (action === "pause") await service.pauseSync("missing").catch(() => {});
    else { await service.lock(); await service.unlock(); }
    supply(googleSettings);
    expect(await pending).toBe("mail_locked");
    expect(service.status().state).toBe("ready");
    expect((await service.listAccounts({})).items.map(account => account.id)).toEqual(["missing"]);
    key.fill(0);
  }
});

test("maintenance stops the real worker, denies unlock and stop cancels late promotion", async () => {
  const privateDir = await mkdtemp(join(directory, "maintenance-"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let promoted = false;
  const service = new LocalMailService({ entryPoint, databasePath: join(privateDir,"mail.sqlite"), ownerId:"desktop-local", executable:{kind:"node",path:nodePath!}, loadKey: async()=>new Uint8Array(32).fill(7), maintain: async (_operation,_passphrase,signal)=>{ entered(); await blocked; if (signal.aborted) throw Error("synthetic secret must not escape"); promoted=true; } });
  services.push(service);await service.unlock();
  const maintenance=service.maintain("rotate");await started;
  expect(service.status().state).toBe("locked");await expect(service.unlock()).rejects.toThrow("mail_locked");await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
  const stopped=service.stop();release();await expect(maintenance).rejects.toThrow("mail_unavailable");await stopped;expect(promoted).toBe(false);expect(service.status().state).toBe("stopped");
});
