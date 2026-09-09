import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { startServer, type StartedServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { MailServiceError, type MailService, type MailServiceStatus } from "./service-interface.js";
import type { MailSyncView } from "./sync-view.js";
import { LocalMailService } from "./service.js";
import { mailContentChunkSchema, mailMessageViewSchema, mailPartViewSchema } from "./read-view.js";

const auth = { "x-legalwork-host-token": "synthetic-mail-host" };
let directory = "";
const running: StartedServer[] = [];
const envNames = ["LEGALWORK_ENV_STORE", "LEGALWORK_TOKEN_STORE", "XDG_DATA_HOME"];
const originalEnv = new Map(envNames.map(name => [name, process.env[name]]));
function progress(accountId: string, state: MailSyncView["state"]): MailSyncView {
  return { accountId, provider: "gmail", state, enumerated: 3, downloaded: 2, projected: 1,
    removed: 0, retained: 0, failed: 0, pending: 2, nextRetryAt: null, error: null };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "legalwork-mail-api-"));
  process.env.LEGALWORK_ENV_STORE = join(directory, "env.json");
  process.env.LEGALWORK_TOKEN_STORE = join(directory, "tokens.json");
  process.env.XDG_DATA_HOME = join(directory, "data");
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
function mockService() {
  let state: MailServiceStatus["state"] = "locked";
  let calls = 0;
  let stops = 0;
  const service: MailService = {
    async imapDiscovery(){throw new MailServiceError("unsupported");},
    async cancelImapConnection(){},
    async connectImap(){throw new MailServiceError("unsupported");},
    async extractionStatus(){throw new MailServiceError('not_found');},async extractionRead(){throw new MailServiceError('not_found');},async extractionReset(){throw new MailServiceError('not_found');},
    async saveDraft(){throw new MailServiceError("not_found");},
    async readDraft(){throw new MailServiceError("not_found");},
    async deleteDraft(){throw new MailServiceError("not_found");},
    async readDraftAttachment(){throw new MailServiceError("not_found");},
    async listDrafts(){throw new MailServiceError("not_found");},
    async enqueueSubmission(){throw new MailServiceError("not_found");},
    async enqueueMutation(){throw new MailServiceError("not_found");},
    async readAction(){throw new MailServiceError("not_found");},
    async listActions(){throw new MailServiceError("not_found");},
    async cancelAction(){throw new MailServiceError("not_found");},
    async listEvents(){throw new MailServiceError("not_found");},

    async search(){return {items:[],total:0,pending:0,incomplete:0,nextOffset:null};},
    async rebuildSearch(){return {processed:0,pending:0,incomplete:0};},
    status() { return { protocolVersion: 1, state, syncSupported: false }; },
    async unlock() { calls++; state = "ready"; },
    async lock() { calls++; state = "locked"; },
    async listAccounts(page) { calls++; return { items: [{ id: page.after ?? "local", provider: "graph", displayName: "Synthetic" }], nextCursor: null }; },
    async listFolders(id) {
      calls++;
      if (id !== "local") throw new MailServiceError("not_found");
      return { items: [], nextCursor: null };
    },
    async listMessages() { calls++; return { items: [], nextCursor: null }; },
    async readMessage() { calls++; throw new MailServiceError("not_found"); },
    async listParts() { calls++; return { items: [], nextCursor: null }; },
    async readContent() { calls++; throw new MailServiceError("not_found"); },
    async beginConnection(provider) { calls++; return { connectionId: "synthetic-connection", authorizationUrl: `https://${provider === "gmail" ? "accounts.google.com" : "login.microsoftonline.com"}/authorize`, expiresAt: 2000000000000 }; },
    async connectionStatus(id) { calls++; return { connectionId: id, state: "pending", expiresAt: 2000000000000 }; },
    async cancelConnection() { calls++; },
    async disconnectAccount() { calls++; },
    async startSync(id) { calls++; return progress(id, "syncing"); },
    async pauseSync(id) { calls++; return progress(id, "paused"); },
    async syncStatus(id) { calls++; return progress(id, "waiting"); },
    async stop() { stops++; state = "stopped"; },
  };
  return { service, calls: () => calls, stops: () => stops };
}
async function boot(service?: MailService, host = "127.0.0.1") {
  const config: ServerConfig = {
    host, port: 0, token: "synthetic-mail-collaborator", hostToken: auth["x-legalwork-host-token"],
    configPath: join(directory, "server.json"), approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config, { mail: service });
  running.push(server);
  return { server, base: `http://127.0.0.1:${server.port}/mail/v1`, root: `http://127.0.0.1:${server.port}` };
}

test("local HTTP reads complete encrypted originals and attachments offline with scope, lock and page bounds", async () => {
  const executable = Bun.which("node");
  if (!executable) throw new Error("Actual Node required");
  const runtime = join(directory, "runtime"), serverRoot = fileURLToPath(new URL("../../", import.meta.url));
  await mkdir(runtime); await writeFile(join(runtime, "package.json"), '{"type":"module"}');
  await symlink(await realpath(join(serverRoot, "node_modules")), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  execFileSync(executable, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "--outDir", join(runtime, "build"), "--rootDir", "src", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/runtime/worker.ts"], { cwd: serverRoot, stdio: "pipe", timeout: 30000 });
  const privateDir = join(directory, "private"); await mkdir(privateDir, { mode: 0o700 });
  const databasePath = join(privateDir, "mail.sqlite"), key = randomBytes(32), locator = { provider: "gmail", messageId: "m1" } satisfies import("./model.js").ProviderMessageLocator;
  const attachment = Buffer.alloc(100003, 0xa7);
  const raw = Buffer.from(`Subject: Offline ÄÖÜ case 12 O 123/26\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nOffline body\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=case.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString("base64")}\r\n--fixture--\r\n`);
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(runtime, "build/mail/storage", name)).href);
  const seed = `import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${moduleUrl("database.js")}; import {migrateMailSchema} from ${moduleUrl("schema.js")};
    import {MailRepository} from ${moduleUrl("repository.js")}; import {MailContentStore} from ${moduleUrl("content-store.js")}; import {MimeProjectionStore} from ${moduleUrl("mime-projection-store.js")};
    import {MailCredentialRepository} from ${moduleUrl("credentials.js")};
    const input=JSON.parse(readFileSync(0,'utf8')); const db=await openEncryptedMailDatabase({path:input.path,key:Buffer.from(input.key,'base64')});
    try { migrateMailSchema(db); const repo=new MailRepository(db,'owner'),content=new MailContentStore(db,'owner'),projections=new MimeProjectionStore(db,'owner');
      repo.createAccount({id:'a',provider:'gmail',displayName:'Offline fixture'}); new MailRepository(db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Private'});
      new MailCredentialRepository(db,'owner').connect('a',{provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'synthetic-subject'},null,{accessToken:'synthetic-access',expiresAt:Date.now()+3600000,grantedScopes:['https://www.googleapis.com/auth/gmail.modify'],refreshToken:{action:'replace',value:'synthetic-refresh'}});
      repo.putFolder('a',{id:'INBOX',name:'Inbox',kind:'label'}); repo.putFolder('a',{id:'UNREAD',name:'Unread',kind:'label'});
      for(const id of ['m1','m2','m3']) repo.ingestMessage('a',{locator:{provider:'gmail',messageId:id},rfcMessageId:null,subject:id==='m3'?'x'.repeat(70000):'Offline ÄÖÜ case 12 O 123/26',threadId:'thread',memberships:['INBOX','UNREAD']});
      function* chunks(bytes){for(let at=0;at<bytes.length;at+=65536)yield bytes.subarray(at,at+65536);}
      const rawBytes=Buffer.from(input.raw,'base64'),attachmentBytes=Buffer.from(input.attachment,'base64'),bodyBytes=Buffer.from(JSON.stringify({version:1,bodies:[{partId:'text',contentType:'text/plain',text:'Offline body'}]}));
      const loc={provider:'gmail',messageId:'m1'};
      const rawRef=await content.writePart('a',loc,{kind:'raw',maxBytes:rawBytes.length},chunks(rawBytes));
      const body=await content.writePart('a',loc,{kind:'body',maxBytes:bodyBytes.length},chunks(bodyBytes));
      const part=await content.writePart('a',loc,{kind:'attachment',partId:'part',maxBytes:attachmentBytes.length},chunks(attachmentBytes));
      projections.complete('a',loc,rawRef.id,{metadata:{subject:'Offline ÄÖÜ case 12 O 123/26',from:'sender@example.test',to:'owner@example.test',cc:null,bcc:null,replyTo:null,date:'2026-01-01T00:00:00.000Z',messageId:null},bodies:[{partId:'text',contentType:'text/plain'}],body,attachments:[{partId:'part',filename:'case.bin',contentType:'application/octet-stream',disposition:'attachment',contentId:null,reference:part}]}); repo.setAttachmentsEnumerated('a',loc,true);
      db.run("INSERT INTO mail_tombstones VALUES('a',?,'gmail-removed','2026-01-01')",[JSON.stringify(['gmail','m2'])]);
    } finally {db.close();}`;
  execFileSync(executable, ["--input-type=module", "--eval", seed], { input: JSON.stringify({ path: databasePath, key: key.toString("base64"), raw: raw.toString("base64"), attachment: attachment.toString("base64") }), stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  const service = new LocalMailService({ executable: { kind: "node", path: executable }, entryPoint: join(runtime, "build/mail/runtime/worker.js"), databasePath, ownerId: "owner", loadKey: async () => Buffer.from(key) });
  const { base } = await boot(service);
  const post = (operation: string, value: unknown, accountId = "a", headers: Record<string,string> = auth) => fetch(`${base}/accounts/${accountId}/messages/${operation}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(value) });
  try {
    expect((await post("query", {})).status).toBe(423);
    await service.unlock();
    expect((await post("query", {}, "a", {})).status).toBe(401);
    for (const accountId of ["foreign", "missing"]) expect((await post("read", { locator }, accountId)).status).toBe(404);
    expect((await post("read", { locator, ownerId: "other" })).status).toBe(400);
    expect((await post("read", { locator: { provider: "gmail", messageId: "missing" } })).status).toBe(404);
    const first = z.object({ items: z.array(mailMessageViewSchema), nextCursor: z.string().nullable() }).parse(await (await post("query", { limit: 2, folderId: "INBOX", threadId: "thread", includeRemoved: true })).json());
    expect(first.items.map(item => item.locator)).toEqual([locator, { provider: "gmail", messageId: "m2" }]);
    expect(first.items[1]?.removed).toBe(true);
    expect((await post("query", { after: first.nextCursor })).status).toBe(413);
    expect((await post("read", { locator: { provider: "gmail", messageId: "m3" } })).status).toBe(413);
    const filtered = z.object({ items: z.array(mailMessageViewSchema), nextCursor: z.string().nullable() }).parse(await (await post("query", {})).json());
    expect(filtered.items.map(item => item.locator)).toEqual([locator]);
    expect(filtered.nextCursor).toBe(JSON.stringify(["gmail", "m1"]));
    const message = mailMessageViewSchema.parse(await (await post("read", { locator })).json());
    expect(message.metadata?.from).toBe("sender@example.test"); expect(message.contentState).toBe("complete");
    const parts = z.object({ items: z.array(mailPartViewSchema), nextCursor: z.string().nullable() }).parse(await (await post("parts", { locator })).json());
    expect(parts.items).toHaveLength(3);
    for (const kind of ["raw", "attachment"]) {
      const part = parts.items.find(item => item.kind === kind); if (!part?.referenceId || !part.sha256) throw new Error("missing fixture part");
      const chunks: Buffer[] = []; let offset = 0;
      while (true) {
        const response = await post("content", { locator, request: { kind, partId: part.partId, referenceId: part.referenceId, offset, limit: 16387 } });
        expect(response.headers.get("cache-control")).toBe("no-store");
        const chunk = mailContentChunkSchema.parse(await response.json());
        chunks.push(Buffer.from(chunk.data, "base64")); if (chunk.nextOffset === null) break; offset = chunk.nextOffset;
      }
      const bytes = Buffer.concat(chunks); expect(bytes).toEqual(kind === "raw" ? raw : attachment);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(part.sha256);
    }
    const part = parts.items.find(item => item.kind === "raw"); if (!part?.referenceId) throw new Error("missing raw");
    expect((await post("content", { locator: { provider: "gmail", messageId: "m2" }, request: { kind: "raw", referenceId: part.referenceId } })).status).toBe(404);
    expect((await post("content", { locator, request: { kind: "raw", referenceId: part.referenceId, limit: 24577 } })).status).toBe(400);
    await service.lock(); await service.unlock(); expect((await post("read", { locator })).status).toBe(200);
    await service.disconnectAccount("a"); expect((await post("read", { locator })).status).toBe(423);
    expect((await post("content", { locator, request: { kind: "raw", referenceId: part.referenceId } })).status).toBe(423);
  } finally { await service.stop(); key.fill(0); }
}, 30000);

test("mail routes are absent by default and when sharing binds all interfaces", async () => {
  const absent = await boot();
  expect((await fetch(`${absent.base}/status`, { headers: auth })).status).toBe(404);
  const mock = mockService();
  const shared = await boot(mock.service, "0.0.0.0");
  expect((await fetch(`${shared.base}/status`, { headers: auth })).status).toBe(404);
  expect(mock.calls()).toBe(0);
});
test("sync controls require a local host token and reject settings in bodies or query strings", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  const path = `${base}/accounts/local/sync`;
  for (const action of ["start", "pause"]) {
    expect((await fetch(`${path}/${action}`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${path}/${action}`, { method: "POST", headers: { authorization: "Bearer synthetic-mail-collaborator" } })).status).toBe(401);
    expect((await fetch(`${path}/${action}?ownerId=other`, { method: "POST", headers: auth })).status).toBe(400);
    expect((await fetch(`${path}/${action}`, { method: "POST", headers: auth, body: '{"accessToken":"private"}' })).status).toBe(400);
  }
  expect(mock.calls()).toBe(0);
  for (const [action, state] of [["start", "syncing"], ["pause", "paused"]]) {
    const result = await fetch(`${path}/${action}`, { method: "POST", headers: auth });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(progress("local", state === "syncing" ? "syncing" : "paused"));
  }
  const result = await fetch(path, { headers: auth });
  expect(await result.json()).toEqual(progress("local", "waiting"));
  expect(mock.calls()).toBe(3);
});
test("connection routes accept provider selection but reject credentials, paths, owners and excess input", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  for (const input of [{ provider: "imap" }, { provider: "gmail", clientSecret: "private" },
    { provider: "gmail", ownerId: "other" }, { provider: "gmail", configPath: "/private/file" },
    { provider: "gmail", reconnectAccountId: "" }, { provider: "gmail", extra: "x".repeat(8192) }]) {
    const response = await fetch(`${base}/connections`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(400);
  }
  expect(mock.calls()).toBe(0);
  const forbidden = await fetch(`${base}/connections`, { method: "POST", headers: { authorization: "Bearer synthetic-mail-collaborator", "content-type": "application/json" }, body: '{"provider":"gmail"}' });
  expect(forbidden.status).toBe(401);
  expect(mock.calls()).toBe(0);
  const response = await fetch(`${base}/connections`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"provider":"gmail"}' });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).connectionId).toBe("synthetic-connection");
  expect((await fetch(`${base}/connections/synthetic-connection`, { headers: auth })).status).toBe(200);
  expect((await fetch(`${base}/connections/synthetic-connection/cancel`, { method: "POST", headers: auth })).status).toBe(200);
  expect((await fetch(`${base}/accounts/local/disconnect`, { method: "POST", headers: auth })).status).toBe(200);
  expect(mock.calls()).toBe(4);
});
test("only host-token auth can access mail; all remote bearer scopes are denied", async () => {
  const mock = mockService();
  const { root, base } = await boot(mock.service);
  expect((await fetch(`${base}/accounts`)).status).toBe(401);
  for (const scope of ["owner", "collaborator", "viewer"]) {
    const issued = await fetch(`${root}/tokens`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ scope, label: "mail isolation test" }) });
    expect(issued.status).toBe(201);
    const { token } = z.object({ token: z.string() }).parse(await issued.json());
    expect((await fetch(`${base}/accounts`, { headers: { authorization: `Bearer ${token}`, "x-legalwork-client-id": "desktop-local" } })).status).toBe(401);
  }
  expect(mock.calls()).toBe(0);
  const allowed = await fetch(`${base}/accounts`, { headers: auth });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await allowed.json())).not.toContain("owner_id");
});
test("request bodies, owner overrides and malformed pagination cannot reach mail service", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  for (const query of ["ownerId=other", "limit=0", "limit=101", "limit=1&limit=2", "after=", "limit=1e1"]) {
    expect((await fetch(`${base}/accounts?${query}`, { headers: auth })).status).toBe(400);
  }
  const body = await fetch(`${base}/unlock`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"ownerId":"other"}' });
  expect(body.status).toBe(400);
  expect(mock.calls()).toBe(0);
});
test("lock/unlock and bounded pagination flow through injected service; account errors are indistinguishable", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  for (const [operation, state] of [["unlock", "ready"], ["lock", "locked"]]) {
    const response = await fetch(`${base}/${operation}`, { method: "POST", headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: 1, state, syncSupported: false });
  }
  expect((await fetch(`${base}/accounts?limit=1&after=next`, { headers: auth })).status).toBe(200);
  const missing = await fetch(`${base}/accounts/missing/folders`, { headers: auth });
  const foreign = await fetch(`${base}/accounts/foreign-owner/folders`, { headers: auth });
  expect(missing.status).toBe(404);
  expect(foreign.status).toBe(404);
  expect(await missing.json()).toEqual(await foreign.json());
});
test("native/keychain errors are redacted and server shutdown stops the service", async () => {
  const mock = mockService();
  const { base, server } = await boot(mock.service);
  for (const error of [new Error("secret-token private-path mailbox-content"), new ApiError(500, "private", "mail-content", { token: "private-token" })]) {
    mock.service.unlock = async () => { throw error; };
    const response = await fetch(`${base}/unlock`, { method: "POST", headers: auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "mail_unavailable", message: "Mail storage is unavailable" });
  }
  await server.stop();
  running.splice(running.indexOf(server), 1);
  expect(mock.stops()).toBe(1);
});

test("security maintenance accepts only host-bound operations and redacts backup secrets", async () => {
  const fixture=mockService();let calls=0;
  fixture.service.maintain=async(operation,passphrase)=>{calls++;if(operation==='restore')throw Error(`synthetic-private:${passphrase}`);};
  const {base}=await boot(fixture.service);
  const url=`${base}/security/backup`,body=JSON.stringify({passphrase:'synthetic strong recovery passphrase'});
  expect((await fetch(url,{method:'POST',body})).status).toBe(401);
  expect((await fetch(url,{method:'POST',headers:auth,body:JSON.stringify({passphrase:'synthetic strong recovery passphrase',path:'/arbitrary'})})).status).toBe(400);
  expect(calls).toBe(0);
  const accepted=await fetch(url,{method:'POST',headers:auth,body});expect(accepted.status).toBe(200);expect(await accepted.json()).toEqual({completed:true,state:'locked'});
  const failed=await fetch(`${base}/security/restore`,{method:'POST',headers:auth,body});expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('synthetic');
});
test('onboarding HTTP forwards explicit personal selection and bounded cancellable TLS input only for host',async()=>{
 const mock=mockService(),seen:unknown[]=[];
 mock.service.beginConnection=async(provider,reconnectAccountId,personal)=>{seen.push({provider,reconnectAccountId,personal});return {connectionId:'personal',authorizationUrl:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',expiresAt:Date.now()+60000};};
 mock.service.connectImap=async(input,requestId)=>{seen.push({input,requestId});return {accountId:'imap',provider:'imap'};};
 mock.service.cancelImapConnection=async requestId=>{seen.push({cancel:requestId});};
 const {base}=await boot(mock.service),post=(path:string,input:unknown,headers=auth)=>fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(input)});
 expect((await post('/connections',{provider:'graph',personal:true})).status).toBe(200);
 expect(seen[0]).toEqual({provider:'graph',personal:true,reconnectAccountId:undefined});
 for(const input of [{provider:'gmail',personal:true},{provider:'graph',personal:'consumers'},{provider:'graph',tenantId:'common'}])expect((await post('/connections',input)).status).toBe(400);
 const requestId='11111111-2222-4333-8444-555555555555',input={host:'imap.mail.me.com',port:993,username:'synthetic',password:'synthetic-password'};
 expect((await post('/imap/connections',{...input,requestId})).status).toBe(200);expect(seen[1]).toEqual({input,requestId});
 expect((await fetch(base+`/imap/connections/${requestId}/cancel`,{method:'POST',headers:auth})).status).toBe(200);expect(seen[2]).toEqual({cancel:requestId});
 expect((await post('/imap/connections',{...input,tls:false})).status).toBe(400);
 expect((await fetch(base+`/imap/connections/${requestId}/cancel`,{method:'POST',headers:{authorization:'Bearer synthetic-mail-collaborator'}})).status).toBe(401);
});
