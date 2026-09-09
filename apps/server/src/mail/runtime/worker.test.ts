import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MailWorkerClient, type WorkerDiagnostic } from "./client.js";
import { workerEnvironment, type WorkerExecutable } from "./executable.js";
import { GMAIL_MAIL_SCOPES } from "../provider-config.js";
import type { MailOAuthSettings } from "../providers/oauth.js";
import { MAIL_SCHEMA_VERSION } from "../storage/schema.js";
import { MAX_WORKER_MESSAGE_BYTES, type WorkerInitialization } from "./protocol.js";

const nodePath = process.env.LEGALWORK_MAIL_TEST_NODE ?? Bun.which("node");
if (!nodePath) throw new Error("Explicit compatible Node executable required");
const node: WorkerExecutable = { kind: "node", path: nodePath };
const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
let entryPoint: string;
const clients: MailWorkerClient[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-real-mail-worker-"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  // Native module resolution follows the built module location, never NODE_PATH or Bun.
  await symlink(join(serverRoot, "node_modules"), join(root, "node_modules"));
  execFileSync("pnpm", ["exec", "tsc", "--outDir", join(root, "build"), "--rootDir", "src", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/runtime/worker.ts"], { cwd: serverRoot, stdio: "pipe", timeout: 30_000 });
  entryPoint = join(root, "build", "mail", "runtime", "worker.js");
}, 30_000);
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.stop())); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const folder = await mkdtemp(join(root, "db-"));
  return { databasePath: join(folder, "mail.sqlite"), encryptionKey: randomBytes(32).toString("base64"), ownerId: "owner-a" };
}
function worker(initialization: WorkerInitialization, executable = node, diagnostics?: WorkerDiagnostic[]) {
  const client = new MailWorkerClient({ entryPoint, executable, initialize: () => initialization, maxRestarts: 0, startupTimeoutMs: 3000,
    requestTimeoutMs: 3000, shutdownTimeoutMs: 1000, onDiagnostic: (value) => diagnostics?.push(value) });
  clients.push(client);
  return client;
}
function seed(initialization: WorkerInitialization, longNames = false, connected = false) {
  const databaseModule = pathToFileURL(join(root, "build", "mail", "storage", "database.js")).href;
  const schemaModule = pathToFileURL(join(root, "build", "mail", "storage", "schema.js")).href;
  const repositoryModule = pathToFileURL(join(root, "build", "mail", "storage", "repository.js")).href;
  const script = `
    import { readFileSync } from 'node:fs';
    import { openEncryptedMailDatabase } from ${JSON.stringify(databaseModule)};
    import { migrateMailSchema } from ${JSON.stringify(schemaModule)};
    import { MailRepository } from ${JSON.stringify(repositoryModule)};
    import { MailCredentialRepository } from ${JSON.stringify(pathToFileURL(join(root, "build", "mail", "storage", "credentials.js")).href)};
    const input=JSON.parse(readFileSync(0,'utf8')); const key=Buffer.from(input.encryptionKey,'base64');
    const db=await openEncryptedMailDatabase({path:input.databasePath,key}); key.fill(0);
    try {
      migrateMailSchema(db); const own=new MailRepository(db,input.ownerId); const other=new MailRepository(db,'owner-b');
      for (const id of ['a','b','c']) own.createAccount({id,provider:'gmail',displayName: input.longNames ? id.repeat(30000) : 'Synthetic '+id});
      other.createAccount({id:'foreign',provider:'graph',displayName:'Foreign private'});
      for (const id of ['f1','f2','f3']) own.putFolder('a',{id,name:input.longNames ? id.repeat(15000) : id,kind:'label'});
      if (input.connected) new MailCredentialRepository(db,input.ownerId).connect('a',
        {provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'synthetic-subject'},null,
        {accessToken:'synthetic-access',expiresAt:Date.now()+3600000,grantedScopes:null,refreshToken:{action:'replace',value:'synthetic-refresh'}});
      if (input.longNames) {
        own.createAccount({id:'oversized',provider:'gmail',displayName:'x'.repeat(70000)});
        own.putFolder('b',{id:'oversized-folder',name:'y'.repeat(70000),kind:'folder'});
      }
    } finally { db.close(); }
  `;
  execFileSync(node.path, ["--input-type=module", "--eval", script], { input: JSON.stringify({ ...initialization, longNames, connected }), env: workerEnvironment(node), stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
}

test("built encrypted worker migrates before ready and reopens after shutdown", async () => {
  const initialization = await setup();
  const client = worker(initialization);
  await client.start();
  expect(await client.request({ operation: "mail.storage.status" })).toEqual({ encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: false });
  expect(await client.request({ operation: "mail.accounts.list" })).toEqual({ accounts: [], nextCursor: null });
  await client.stop();
  const bytes = await readFile(initialization.databasePath);
  expect(bytes.subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
  expect(bytes.includes(Buffer.from("mail_accounts"))).toBe(false);
  await client.start();
  expect(await client.request({ operation: "mail.accounts.list" })).toEqual({ accounts: [], nextCursor: null });
});
test("owned account/folder pagination and foreign/missing account isolation", async () => {
  const initialization = await setup(); seed(initialization);
  const client = worker(initialization); await client.start();
  expect(await client.request({ operation: "mail.accounts.list", limit: 2 })).toEqual({ accounts: [
    { id: "a", provider: "gmail", displayName: "Synthetic a" }, { id: "b", provider: "gmail", displayName: "Synthetic b" },
  ], nextCursor: "b" });
  expect(await client.request({ operation: "mail.accounts.list", limit: 2, after: "b" })).toEqual({ accounts: [{ id: "c", provider: "gmail", displayName: "Synthetic c" }], nextCursor: null });
  expect(await client.request({ operation: "mail.folders.list", accountId: "a", limit: 1 })).toEqual({ folders: [{ id: "f1", name: "f1", kind: "label", parentId: null }], nextCursor: "f1" });
  for (const accountId of ["foreign", "absent"]) {
    await expect(client.request({ operation: "mail.folders.list", accountId })).rejects.toThrow("not_found");
    await expect(client.request({ operation: "mail.status", accountId })).rejects.toThrow("not_found");
  }
  expect(await client.request({ operation: "mail.status", accountId: "a" })).toEqual({ state: "idle", syncSupported: false });
  expect(JSON.stringify(await client.request({ operation: "mail.accounts.list" }))).not.toContain("owner");
});
test("byte cap paginates without skipping rows and rejects oversized individual rows", async () => {
  const initialization = await setup(); seed(initialization, true);
  const client = worker(initialization); await client.start();
  const first = await client.request({ operation: "mail.accounts.list", limit: 100 });
  if (!("accounts" in first)) throw new Error("wrong_result");
  expect(first.accounts.map((account) => account.id)).toEqual(["a", "b"]);
  expect(first.nextCursor).toBe("b");
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(MAX_WORKER_MESSAGE_BYTES);
  const second = await client.request({ operation: "mail.accounts.list", after: "b" });
  if (!("accounts" in second)) throw new Error("wrong_result");
  expect(second.accounts.map((account) => account.id)).toEqual(["c"]);
  expect(second.nextCursor).toBe("c");
  await expect(client.request({ operation: "mail.accounts.list", after: "c" })).rejects.toThrow("response_too_large");
  const folders = await client.request({ operation: "mail.folders.list", accountId: "a" });
  if (!("folders" in folders)) throw new Error("wrong_result");
  expect(folders.folders.map((folder) => folder.id)).toEqual(["f1", "f2"]);
  expect(folders.nextCursor).toBe("f2");
  await expect(client.request({ operation: "mail.folders.list", accountId: "b" })).rejects.toThrow("response_too_large");
});
test("wrong and malformed keys never ready, remain redacted and preserve encrypted database", async () => {
  const initialization = await setup(); seed(initialization);
  const before = await readFile(initialization.databasePath);
  for (const encryptionKey of [randomBytes(32).toString("base64"), "secret-invalid-key", Buffer.alloc(31).toString("base64"), `${"A".repeat(42)}B=`, `${initialization.encryptionKey}\n`]) {
    const diagnostics: WorkerDiagnostic[] = [];
    const client = worker({ ...initialization, encryptionKey }, node, diagnostics);
    await expect(client.start()).rejects.toThrow("initialization_failed");
    expect(diagnostics.some((event) => event.event === "ready")).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain(encryptionKey);
    expect(JSON.stringify(diagnostics)).not.toContain(initialization.databasePath);
    await client.stop();
  }
  expect(await readFile(initialization.databasePath)).toEqual(before);
  const valid = worker(initialization); await valid.start();
  expect(await valid.request({ operation: "ping" })).toEqual({ pong: true });
});
test("owner is mandatory, initialization credentials and unimplemented commands fail closed", async () => {
  const initialization = await setup();
  const noOwner = worker({ databasePath: initialization.databasePath, encryptionKey: initialization.encryptionKey });
  await expect(noOwner.start()).rejects.toThrow("initialization_failed"); await noOwner.stop();
  const withCredentials = worker({ ...initialization, credentials: [{ accountId: "a", provider: "gmail", refreshToken: "secret" }] });
  await expect(withCredentials.start()).rejects.toThrow("initialization_failed"); await withCredentials.stop();
  const client = worker(initialization); await client.start();
  for (const operation of ["mail.sync.start", "mail.sync.stop"]) {
    if (operation === "mail.sync.start" || operation === "mail.sync.stop") await expect(client.request({ operation, accountId: "a" })).rejects.toThrow("unsupported");
  }
  await expect(client.request({ operation: "credentials.update", credentials: { accountId: "a", provider: "gmail", refreshToken: "secret" } })).rejects.toThrow("unsupported");
});

async function raw(initialization: WorkerInitialization, action: "eof" | "signal" | "malformed" | "oversize") {
  const child = spawn(node.path, [entryPoint], { env: workerEnvironment(node), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let acted = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (!acted && stdout.includes('"kind":"ready"')) {
      acted = true;
      if (action === "eof") child.stdin.end();
      if (action === "signal") child.kill("SIGTERM");
      if (action === "malformed") child.stdin.write('secret-non-json\n');
      if (action === "oversize") child.stdin.write("x".repeat(70 * 1024));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.write(`${JSON.stringify({ kind: "initialize", protocol: 1, initialization })}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker_test_timeout")); }, 4000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { code, stdout, stderr };
}
test("production worker closes on parent EOF/signals and rejects malformed/oversize input", async () => {
  const initialization = await setup();
  for (const action of ["eof", "signal", "malformed", "oversize"]) {
    if (action !== "eof" && action !== "signal" && action !== "malformed" && action !== "oversize") continue;
    const result = await raw(initialization, action);
    expect(result.code).toBe(action === "eof" || action === "signal" ? 0 : 1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("secret-non-json");
    expect(result.stdout).not.toContain(initialization.encryptionKey);
  }
  const reopened = worker(initialization); await reopened.start();
  expect(await reopened.request({ operation: "mail.storage.status" })).toEqual({ encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: false });
});
const electronPath = process.env.LEGALWORK_MAIL_TEST_ELECTRON;
test.skipIf(!electronPath)("built encrypted worker opens and reopens under actual Electron Node mode", async () => {
  if (!electronPath) return;
  const initialization = await setup(); seed(initialization);
  const client = worker(initialization, { kind: "electron", path: electronPath });
  await client.start();
  const result = await client.request({ operation: "mail.accounts.list" });
  if (!("accounts" in result)) throw new Error("wrong_result");
  expect(result.accounts.map((account) => account.id)).toEqual(["a", "b", "c"]);
  await client.stop(); await client.start();
  expect(await client.request({ operation: "mail.storage.status" })).toEqual({ encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: false });
});
const syntheticSettings: MailOAuthSettings = { provider: "gmail", applicationType: "desktop", pkceMethod: "S256",
  clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: [...GMAIL_MAIL_SCOPES] };
const connectionRuntimes: WorkerExecutable[] = [node, ...(electronPath ? [{ kind: "electron", path: electronPath } satisfies WorkerExecutable] : [])];
for (const executable of connectionRuntimes) {
  test(`connection lifecycle and retained archive lock in actual ${executable.kind} (no provider HTTP)`, async () => {
    const initialization = await setup(); seed(initialization, false, true);
    const client = worker(initialization, executable); await client.start();
    const started = await client.request({ operation: "mail.connection.begin", settings: syntheticSettings });
    if (!("connectionStarted" in started)) throw new Error("wrong_result");
    const { connectionId, authorizationUrl, expiresAt } = started.connectionStarted;
    expect(new URL(authorizationUrl).hostname).toBe("accounts.google.com");
    expect(JSON.stringify(started)).not.toContain(syntheticSettings.clientSecret);
    expect(await client.request({ operation: "ping" })).toEqual({ pong: true });
    expect(await client.request({ operation: "mail.connection.poll", connectionId })).toEqual({ connection: { connectionId, expiresAt, state: "pending" } });
    expect(await client.request({ operation: "mail.connection.cancel", connectionId })).toEqual({ cancelled: true });
    expect(await client.request({ operation: "mail.connection.poll", connectionId })).toEqual({ connection: { connectionId, expiresAt, state: "cancelled" } });
    await expect(fetch(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "")).rejects.toThrow();
    await expect(client.request({ operation: "mail.account.disconnect", accountId: "foreign" })).rejects.toThrow("not_found");
    expect(await client.request({ operation: "mail.account.disconnect", accountId: "a" })).toEqual({ disconnected: true });
    await client.stop(); await client.start();
    expect(await client.request({ operation: "mail.account.disconnect", accountId: "a" })).toEqual({ disconnected: true });
    await expect(client.request({ operation: "mail.folders.list", accountId: "a" })).rejects.toThrow("locked");
    await expect(client.request({ operation: "mail.status", accountId: "a" })).rejects.toThrow("locked");
    const accounts = await client.request({ operation: "mail.accounts.list" });
    expect("accounts" in accounts && accounts.accounts.some(account => account.id === "a")).toBe(true);
    const active = await client.request({ operation: "mail.connection.begin", settings: syntheticSettings });
    if (!("connectionStarted" in active)) throw new Error("wrong_result");
    await client.stop();
    await expect(fetch(new URL(active.connectionStarted.authorizationUrl).searchParams.get("redirect_uri") ?? "")).rejects.toThrow();
  });
}
for (const executable of connectionRuntimes) {
  test(`pending begin does not block ping and drains safely on ${executable.kind} shutdown`, async () => {
    const initialization = await setup();
    const bootstrap = join(root, `delayed-${executable.kind}.mjs`);
    // Test-only module bootstrap delays entry to the real controller. No seam is exposed by RPC.
    await writeFile(bootstrap, `
      import { MailConnectionController } from ${JSON.stringify(pathToFileURL(join(root, "build/mail/providers/connection-controller.js")).href)};
      const begin = MailConnectionController.prototype.begin;
      MailConnectionController.prototype.begin = async function(...args) {
        await new Promise(resolve => setTimeout(resolve, 250));
        return begin.apply(this, args);
      };
      await import(${JSON.stringify(pathToFileURL(entryPoint).href)});
    `);
    const client = new MailWorkerClient({ entryPoint: bootstrap, executable, initialize: () => initialization,
      maxRestarts: 0, startupTimeoutMs: 3000, shutdownTimeoutMs: 1500 });
    clients.push(client); await client.start();
    let settled = false;
    const pending = client.request({ operation: "mail.connection.begin", settings: syntheticSettings }).then(
      () => { settled = true; return "unexpected_success"; }, () => { settled = true; return "stopped"; });
    expect(await client.request({ operation: "ping" })).toEqual({ pong: true });
    expect(settled).toBe(false);
    await client.stop();
    expect(await pending).toBe("stopped");
    const reopened = worker(initialization, executable); await reopened.start();
    expect(await reopened.request({ operation: "mail.accounts.list" })).toEqual({ accounts: [], nextCursor: null });
    const started = await reopened.request({ operation: "mail.connection.begin", settings: syntheticSettings });
    expect("connectionStarted" in started).toBe(true);
  });
}

for (const stage of ['oauth', 'identity']) {
  test(`independent review: shutdown fences delayed ${stage} completion`, async () => {
    const initialization = await setup();
    const bootstrap = join(root, `review-delayed-${stage}.mjs`);
    await writeFile(bootstrap, `
      import { MailConnectionController } from ${JSON.stringify(pathToFileURL(join(root, 'build/mail/providers/connection-controller.js')).href)};
      import { startMailOAuth } from ${JSON.stringify(pathToFileURL(join(root, 'build/mail/providers/oauth.js')).href)};
      const original = MailConnectionController.prototype.begin;
      MailConnectionController.prototype.begin = async function(...args) {
        this.oauth = async (...input) => {
          const flow = await startMailOAuth(...input);
          return {...flow, result: (async()=>{
            if (${JSON.stringify(stage)} === 'oauth') await new Promise(r=>setTimeout(r,250));
            return {accessToken:'synthetic-review-access',refreshToken:null,tokenType:'Bearer',expiresAt:Date.now()+60000,grantedScopes:args[0].scopes,unverifiedIdToken:null};
          })()};
        };
        this.identity = async () => {
          if (${JSON.stringify(stage)} === 'identity') await new Promise(r=>setTimeout(r,250));
          return {provider:'gmail',authority:'https://accounts.google.com',providerSubject:'review-subject',tenantId:null,email:'review@example.test',displayName:null};
        };
        return original.apply(this,args);
      };
      await import(${JSON.stringify(pathToFileURL(entryPoint).href)});
    `);
    const client = new MailWorkerClient({entryPoint:bootstrap, executable:node, initialize:()=>initialization,maxRestarts:0});
    clients.push(client); await client.start();
    const begun=await client.request({operation:'mail.connection.begin',settings:syntheticSettings});
    if (!('connectionStarted' in begun)) throw new Error('wrong_result');
    const polled=await client.request({operation:'mail.connection.poll',connectionId:begun.connectionStarted.connectionId});
    expect('connection' in polled && polled.connection.state).toBe(stage==='oauth'?'pending':'verifying');
    await client.stop();
    const reopened=worker(initialization);await reopened.start();
    expect(await reopened.request({operation:'mail.accounts.list'})).toEqual({accounts:[],nextCursor:null});
  });
}
