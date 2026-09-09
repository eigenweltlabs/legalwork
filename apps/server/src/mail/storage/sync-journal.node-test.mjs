/** Synthetic journal evidence on the production encrypted Node adapter; no provider or byte completion claim. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openEncryptedMailDatabase } from "./database.js";
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from "./schema.js";
import { MailRepository } from "./repository.js";
import { MailSyncJournal } from "./sync-journal.js";

const scope = { accountId: "a", scopeId: "inbox", generation: "g1" };
const locator = messageId => ({ provider: "gmail", messageId });
const metadata = (writer, messageId = "one") => writer.ingestMessage({ locator: locator(messageId), subject: "synthetic_journal_private_marker", rfcMessageId: null, memberships: [] });
const page = (extra = {}) => ({ ...scope, expectedCursor: null, expectedRevision: 0, nextCursor: "cursor-1", discoveryComplete: false,
  jobs: [{ kind: "raw", locator: locator("one") }], ...extra });
async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-mail-journal-"));
  const path = join(directory, "mail.sqlite"), key = randomBytes(32);
  let db = await openEncryptedMailDatabase({ path, key });
  migrateMailSchema(db);
  const own = new MailRepository(db, "owner-a");
  own.createAccount({ id: "a", provider: "gmail", displayName: "Synthetic A" });
  own.createAccount({ id: "b", provider: "gmail", displayName: "Synthetic B" });
  new MailRepository(db, "owner-b").createAccount({ id: "foreign", provider: "gmail", displayName: "Synthetic foreign" });
  let isOpen = true;
  const close = () => { if (isOpen) { db.close(); isOpen = false; } };
  let now = 1000;
  const journal = (policy = {}) => new MailSyncJournal(db, "owner-a", () => now, policy);
  try {
    await body({ db, journal, path, key, close, setTime: value => { now = value; },
      async reopen() { close(); db = await openEncryptedMailDatabase({ path, key }); isOpen = true; return db; },
    });
  } finally { close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}

test("page commit dedupes provider identity, rejects replay, binds account and preserves generations", async () => fixture(({ db, journal }) => {
  const j = journal();
  assert.deepEqual(j.readCheckpoint(scope), { cursor: null, revision: 0, discoveryComplete: false });
  j.commitPage(page({ jobs: [...page().jobs, ...page().jobs] }), metadata);
  assert.equal(j.status(scope).jobs.queued, 1);
  let invoked = false;
  assert.throws(() => j.commitPage(page(), () => { invoked = true; }), /Stale sync cursor/);
  assert.equal(invoked, false);
  // Repeating the cursor is valid only with the current revision; ABA/replay remains rejected.
  j.commitPage(page({ expectedCursor: "cursor-1", expectedRevision: 1, jobs: page().jobs }), metadata);
  assert.equal(j.readCheckpoint(scope).revision, 2);
  assert.throws(() => j.commitPage(page({ expectedCursor: "cursor-1", expectedRevision: 1 }), metadata), /Stale/);
  j.commitPage(page({ scopeId: "all-mail" }), metadata);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs WHERE account_id='a'").n, 1);
  j.commitPage(page({ accountId: "b" }), metadata);
  j.commitPage(page({ generation: "g2" }), metadata);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n, 3);
  assert.equal(j.status(scope).jobs.queued, 1);
  assert.equal(j.status({ ...scope, generation: "g2" }).jobs.queued, 1);
  const other = new MailSyncJournal(db, "owner-b");
  assert.throws(() => other.readCheckpoint(scope), /Mail account not found/);
  assert.throws(() => other.commitPage(page(), metadata), /Mail account not found/);
  assert.throws(() => other.claim(scope), /Mail account not found/);
  assert.throws(() => other.reclaimExpired("a"), /Mail account not found/);
  const [job] = j.claim(scope);
  for (const call of [() => other.succeed("a", job.id, job.lease_token, metadata), () => other.fail("a", job.id, job.lease_token, false), () => other.renew("a", job.id, job.lease_token)]) assert.throws(call, /Mail account not found/);
  assert.throws(() => j.fail("b", job.id, job.lease_token, true), /Stale sync lease/);
  assert.equal(j.claim({ ...scope, scopeId: "all-mail" }).length, 0); // Shared job already leased.
}));

test("metadata, cursor and recoverable jobs roll back together on callback, identity or FK failure", async () => fixture(({ db, journal }) => {
  const j = journal();
  assert.throws(() => j.commitPage(page(), writer => { metadata(writer); throw new Error("abort"); }), /abort/);
  assert.throws(() => j.commitPage(page({ jobs: [{ kind: "raw", locator: locator("missing") }] }), metadata), /FOREIGN KEY/);
  assert.throws(() => j.commitPage(page({ jobs: [{ kind: "raw", locator: { provider: "graph", messageId: "one" } }] }), metadata), /Provider identity/);
  for (const table of ["mail_messages", "mail_sync_scopes", "mail_sync_jobs", "mail_sync_scope_jobs"]) assert.equal(db.get(`SELECT count(*) AS n FROM ${table}`).n, 0);
  assert.throws(() => j.commitPage(page({ jobs: Array.from({ length: 1001 }, () => page().jobs[0]) }), metadata));
  j.commitPage(page({ jobs: [...page().jobs, { kind: "body", locator: locator("one") }, { kind: "attachment", locator: locator("one"), partId: "p1" }, { kind: "attachment", locator: locator("one"), partId: "p2" }] }), metadata);
  assert.equal(j.status(scope).jobs.queued, 4);
  for (const limit of [0, 101, 1.5]) assert.throws(() => j.claim(scope, limit));
  assert.equal(j.claim(scope, 2, 1).length, 2);
}));

test("async/thenable metadata rolls back and revoked writer rejects delayed or retained writes", async () => fixture(async ({ db, journal }) => {
  const j = journal(); let called = false;
  assert.throws(() => j.commitPage(page(), async writer => { called = true; metadata(writer); }), /synchronous/);
  assert.equal(called, false);
  let continuation;
  assert.throws(() => j.commitPage(page(), writer => {
    metadata(writer);
    continuation = Promise.resolve().then(() => metadata(writer, "late"));
    return continuation;
  }), /thenables/);
  await assert.rejects(continuation, /writer expired/);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_messages").n, 0);
  assert.equal(j.readCheckpoint(scope).revision, 0);
  assert.throws(() => j.commitPage(page(), () => j.claim(scope)), /reenter/);
  let retained;
  j.commitPage(page(), writer => { retained = writer; metadata(writer); });
  assert.throws(() => metadata(retained, "late"), /writer expired/);
  const [job] = j.claim(scope);
  assert.throws(() => j.succeed("a", job.id, job.lease_token, writer => { metadata(writer, "aborted-result"); return { then() {} }; }), /thenables/);
  assert.equal(j.status(scope).jobs.running, 1);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_messages").n, 1);
}));

test("fenced retries retain backoff and budget through reopen, reclaim only bounded expired leases", async () => fixture(async ({ db, journal, setTime, reopen }) => {
  let j = journal({ maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 150 });
  j.commitPage(page(), metadata);
  const [first] = j.claim(scope, 1, 50);
  assert.equal(first.attempts, 1);
  setTime(1020); j.renew("a", first.id, first.lease_token, 50);
  setTime(1050); assert.equal(j.reclaimExpired("a"), 0);
  setTime(1070);
  assert.throws(() => j.succeed("a", first.id, first.lease_token, () => {}), /Stale sync lease/);
  db = await reopen(); j = journal();
  assert.equal(j.reclaimExpired("a", 1), 1);
  assert.equal(j.claim(scope).length, 0);
  assert.equal(db.get("SELECT available_at FROM mail_sync_jobs").available_at, 1170);
  setTime(1170); const [second] = j.claim(scope, 1, 50);
  assert.equal(second.attempts, 2); assert.notEqual(second.lease_token, first.lease_token);
  for (const call of [() => j.fail("a", first.id, first.lease_token, false), () => j.renew("a", first.id, first.lease_token), () => j.succeed("a", first.id, first.lease_token, () => {})]) assert.throws(call, /Stale sync lease/);
  j.fail("a", second.id, second.lease_token, true);
  assert.equal(db.get("SELECT available_at FROM mail_sync_jobs").available_at, 1320); // Capped, persisted policy.
  setTime(1320); const [third] = j.claim(scope, 1, 50);
  assert.equal(third.attempts, 3);
  setTime(1370); j.reclaimExpired("a");
  assert.equal(j.status(scope).jobs.failed, 1);
  assert.equal(j.claim(scope).length, 0);
  assert.equal(db.get("SELECT last_error FROM mail_sync_jobs").last_error, "lease_expired");
}));

test("expired reclaim obeys its limit and invalid clock cannot mutate checkpoints", async () => fixture(({ db, journal, setTime }) => {
  const j = journal();
  j.commitPage(page({ jobs: [...page().jobs, {kind:"body",locator:locator("one")}] }), metadata);
  j.claim(scope,2,1); setTime(1001);
  assert.equal(j.reclaimExpired("a",1),1);
  assert.equal(j.status(scope).jobs.running,1);
  assert.equal(j.reclaimExpired("a",1),1);
  assert.equal(j.status(scope).jobs.retry,2);
  setTime(NaN);
  assert.throws(() => j.commitPage(page({generation:"bad-clock"}),metadata));
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_scopes").n,1);
}));

test("success and permanent failure are terminal; slow result callbacks cannot revive expired leases", async () => fixture(({ db, journal, setTime }) => {
  const j = journal();
  j.commitPage(page({ jobs: [...page().jobs, { kind: "body", locator: locator("one") }] }), metadata);
  const [first, second] = j.claim(scope, 2, 50);
  assert.throws(() => j.succeed("a", first.id, first.lease_token, writer => { metadata(writer, "late-result"); setTime(1050); }), /Stale sync lease/);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_messages").n, 1);
  setTime(1020); // Controlled test restores clock; production uses wall-clock milliseconds.
  j.succeed("a", first.id, first.lease_token, () => {});
  j.fail("a", second.id, second.lease_token, false);
  assert.equal(j.status(scope).jobs.succeeded, 1); assert.equal(j.status(scope).jobs.failed, 1);
  assert.throws(() => j.succeed("a", first.id, first.lease_token, () => {}), /Stale/);
  assert.equal(new MailRepository(db, "owner-a").readMessage("a", locator("one")).contentState, "downloading");
}));

test("untouched, explicit empty discovery and succeeded jobs remain separate from downloaded bytes", async () => fixture(({ journal }) => {
  const j = journal();
  assert.equal(j.status(scope).checkpoint.discoveryComplete, false);
  j.commitPage(page({ nextCursor: null, jobs: [], discoveryComplete: true }), () => {});
  assert.deepEqual(j.status(scope), { checkpoint: { cursor: null, revision: 1, discoveryComplete: true }, jobs: { queued: 0, running: 0, retry: 0, succeeded: 0, failed: 0 } });
  assert.throws(() => j.commitPage(page({ expectedRevision: 1 }), metadata), /already complete/);
  assert.equal(j.status({ ...scope, generation: "g2" }).checkpoint.discoveryComplete, false);
}));

// Key/path are stdin-only. SIGKILL occurs inside or just after the transaction; no graceful close.
function crash(path, key, mode) {
  const script = `
    import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${JSON.stringify(new URL("./database.js", import.meta.url).href)};
    import {MailSyncJournal} from ${JSON.stringify(new URL("./sync-journal.js", import.meta.url).href)};
    const input=JSON.parse(readFileSync(0,'utf8')); const key=Buffer.from(input.key,'base64');
    const db=await openEncryptedMailDatabase({path:input.path,key}); key.fill(0);
    const j=new MailSyncJournal(db,'owner-a',()=>1000,{maxAttempts:2,retryBaseMs:10,retryMaxMs:10});
    j.commitPage(input.page,writer=>{writer.ingestMessage({locator:{provider:'gmail',messageId:'one'},subject:'synthetic_journal_private_marker',rfcMessageId:null,memberships:[]});
      if(input.mode==='before') process.kill(process.pid,'SIGKILL');});
    if(input.mode==='lease') { const [job]=j.claim(input.scope,1,50); process.stdout.write(JSON.stringify(job.lease_token)+'\\n'); }
    process.kill(process.pid,'SIGKILL');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { input: JSON.stringify({ path, key: key.toString("base64"), mode, page: page(), scope }), encoding: "utf8", env: {}, timeout: 10000 });
  assert.equal(result.signal, "SIGKILL"); assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(key.toString("base64")));
  return result.stdout;
}
for (const mode of ["before", "after", "lease"]) test(`SIGKILL ${mode} page commit recovers encrypted checkpoint/jobs atomically`, async () => fixture(async ({ path, key, close, reopen, journal, setTime }) => {
  close(); // The killed child is the sole open storage writer.
  const result = crash(path, key, mode);
  const db = await reopen(); const j = journal();
  if (mode === "before") {
    assert.equal(j.readCheckpoint(scope).revision, 0);
    assert.equal(db.get("SELECT count(*) AS n FROM mail_messages").n, 0);
    assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n, 0);
    j.commitPage(page(), metadata);
  } else {
    assert.equal(j.readCheckpoint(scope).cursor, "cursor-1");
    assert.equal(db.get("SELECT count(*) AS n FROM mail_messages").n, 1);
    assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n, 1);
  }
  if (mode === "lease") {
    const oldToken = JSON.parse(result);
    setTime(1050); assert.equal(j.reclaimExpired("a"), 1);
    setTime(1060); const [job] = j.claim(scope);
    assert.equal(job.attempts, 2); assert.notEqual(job.lease_token, oldToken);
    assert.throws(() => j.succeed("a", job.id, oldToken, () => {}), /Stale/);
  }
  assert.equal((await readFile(path)).includes(Buffer.from("synthetic_journal_private_marker")), false);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
}));

test("v2 upgrade is additive and atomic; future versions and failed DDL remain unchanged", async () => fixture(({ db }) => {
  db.exec("DROP TABLE mail_account_credentials; DROP TABLE mail_sync_scope_jobs; DROP TABLE mail_sync_jobs; DROP TABLE mail_sync_scopes; UPDATE mail_schema_version SET version=2");
  const faulty = { ...db, exec(sql) { db.exec(sql); if (sql.includes("CREATE TABLE mail_sync_jobs")) throw new Error("migration interruption"); } };
  assert.throws(() => migrateMailSchema(faulty), /migration interruption/);
  assert.equal(db.get("SELECT version FROM mail_schema_version").version, 2);
  assert.equal(db.get("SELECT count(*) AS n FROM sqlite_master WHERE name='mail_sync_scopes'").n, 0);
  migrateMailSchema(db); migrateMailSchema(db);
  assert.equal(db.get("SELECT version FROM mail_schema_version").version, MAIL_SCHEMA_VERSION);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_accounts").n, 3);
  db.run("UPDATE mail_schema_version SET version=?", [MAIL_SCHEMA_VERSION + 1]);
  assert.throws(() => migrateMailSchema(db), /Unsupported mail schema/);
  assert.equal(db.get("SELECT version FROM mail_schema_version").version, MAIL_SCHEMA_VERSION + 1);
}));

const followups = () => [{kind:"body",locator:locator("one")},{kind:"attachment",locator:locator("one"),partId:"p1"}];
test("raw followups commit after enumeration and join every current/later parent scope across reopen", async () => fixture(async ({ db, journal, reopen }) => {
  let j=journal({maxAttempts:2,retryBaseMs:12,retryMaxMs:24});
  j.commitPage(page({discoveryComplete:true}),metadata);
  j.commitPage(page({scopeId:"all-mail",discoveryComplete:true}),metadata);
  j.commitPage(page({accountId:"b",discoveryComplete:true}),metadata);
  j.commitPage(page({generation:"g2",discoveryComplete:true}),metadata);
  const [parent]=j.claim(scope,1);
  db=await reopen(); j=journal({maxAttempts:9,retryBaseMs:999,retryMaxMs:9999});
  j.succeedWithFollowups("a",parent.id,parent.lease_token,[...followups(),...followups()],writer=>writer.setAttachmentsEnumerated(locator("one"),true));
  db=await reopen(); j=journal();
  for (const scopeId of ["inbox","all-mail"]) {
    const status=j.status({...scope,scopeId});
    assert.equal(status.checkpoint.discoveryComplete,true);
    assert.equal(status.checkpoint.revision,1);
    assert.equal(status.jobs.queued,2);assert.equal(status.jobs.succeeded,1);
  }
  assert.equal(j.status({...scope,accountId:"b"}).jobs.queued,1);
  assert.equal(j.status({...scope,generation:"g2"}).jobs.queued,1);
  j.commitPage(page({scopeId:"late-label",discoveryComplete:true}),metadata);
  assert.deepEqual(j.status({...scope,scopeId:"late-label"}).jobs,j.status(scope).jobs);
  const children=db.all("SELECT * FROM mail_sync_jobs WHERE account_id='a' AND generation='g1' AND kind!='raw'");
  assert.equal(children.length,2);
  assert.ok(children.every(job=>job.max_attempts===2 && job.retry_base_ms===12 && job.retry_max_ms===24));
  assert.equal(new MailRepository(db,"owner-a").readMessage("a",locator("one")).contentState,"downloading");
  assert.deepEqual(db.all("PRAGMA foreign_key_check"),[]);
}));

test("followup dedupe preserves succeeded/failed children and prohibits self or recursive part jobs", async () => fixture(({ db,journal }) => {
  const j=journal();j.commitPage(page({jobs:[...page().jobs,...followups()]}),metadata);
  const jobs=j.claim(scope,3);
  const parent=jobs.find(job=>job.kind==='raw'),body=jobs.find(job=>job.kind==='body'),attachment=jobs.find(job=>job.kind==='attachment');
  j.succeed("a",body.id,body.lease_token,()=>{});j.fail("a",attachment.id,attachment.lease_token,false);
  j.succeedWithFollowups("a",parent.id,parent.lease_token,[...followups(),{kind:"attachment",locator:locator("one"),partId:"p2"}],()=>{});
  assert.deepEqual(j.status(scope).jobs,{queued:1,running:0,retry:0,succeeded:2,failed:1});
  assert.equal(db.get("SELECT attempts FROM mail_sync_jobs WHERE id=?",[body.id]).attempts,1);
  const [part]=j.claim(scope,1);
  assert.throws(()=>j.succeedWithFollowups("a",part.id,part.lease_token,followups(),()=>{}),/Only raw/);
  j.succeedWithFollowups("a",part.id,part.lease_token,[],()=>{}); // Existing succeed behavior is preserved.
}));

test("followups reject identity/account/bounds misuse without invoking metadata or hiding work", async () => fixture(({ db,journal }) => {
  const j=journal();j.commitPage(page(),metadata);const [parent]=j.claim(scope);
  let called=0;
  for(const children of [[{kind:"raw",locator:locator("one")}],[{kind:"body",locator:locator("different")}],
    [{kind:"body",locator:{provider:"graph",messageId:"one"}}],[{...followups()[0],accountId:"b"}],Array.from({length:1001},()=>followups()[0])]) {
    assert.throws(()=>j.succeedWithFollowups("a",parent.id,parent.lease_token,children,()=>{called++}));
  }
  assert.throws(()=>j.succeedWithFollowups("b",parent.id,parent.lease_token,followups(),()=>{called++}),/Stale/);
  const foreign=new MailSyncJournal(db,"owner-b");
  assert.throws(()=>foreign.succeedWithFollowups("a",parent.id,parent.lease_token,followups(),()=>{called++}),/Mail account not found/);
  assert.equal(called,0);assert.equal(j.status(scope).jobs.running,1);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n,1);
}));

test("followup insertion failure and thenable callbacks roll back metadata, children and parent success", async () => fixture(async ({ db,journal }) => {
  const j=journal();j.commitPage(page(),metadata);const [parent]=j.claim(scope);
  let fault=true;
  const faulty={...db,run(sql,parameters){const result=db.run(sql,parameters);if(fault && sql.includes('INSERT INTO mail_sync_jobs'))throw new Error('child insert interrupted');return result;}};
  const writer=new MailSyncJournal(faulty,"owner-a",()=>1000);
  assert.throws(()=>writer.succeedWithFollowups("a",parent.id,parent.lease_token,followups(),w=>w.setAttachmentsEnumerated(locator("one"),true)),/child insert interrupted/);
  assert.equal(db.get("SELECT attachments_enumerated FROM mail_messages").attachments_enumerated,0);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n,1);
  assert.equal(j.status(scope).jobs.running,1);
  let delayed;
  assert.throws(()=>j.succeedWithFollowups("a",parent.id,parent.lease_token,followups(),w=>{
    w.setAttachmentsEnumerated(locator("one"),true);delayed=Promise.resolve().then(()=>w.setAttachmentsEnumerated(locator("one"),true));return delayed;
  }),/thenables/);
  await assert.rejects(delayed,/writer expired/);
  assert.equal(db.get("SELECT attachments_enumerated FROM mail_messages").attachments_enumerated,0);
  fault=false;
  writer.succeedWithFollowups("a",parent.id,parent.lease_token,followups(),()=>{});
  assert.equal(j.status(scope).jobs.queued,2);assert.equal(j.status(scope).jobs.succeeded,1);
}));

test("expired and replaced parent leases cannot enqueue children, including after callback expiry", async () => fixture(async ({ db,journal,setTime,reopen }) => {
  let j=journal();j.commitPage(page(),metadata);const [old]=j.claim(scope,1,10);
  assert.throws(()=>j.succeedWithFollowups("a",old.id,old.lease_token,followups(),writer=>{
    writer.setAttachmentsEnumerated(locator("one"),true);setTime(1010);
  }),/Stale/);
  assert.equal(db.get("SELECT count(*) AS n FROM mail_sync_jobs").n,1);
  assert.equal(db.get("SELECT attachments_enumerated FROM mail_messages").attachments_enumerated,0);
  db=await reopen();j=journal();j.reclaimExpired("a");setTime(2010);const [current]=j.claim(scope);
  let called=false;
  assert.throws(()=>j.succeedWithFollowups("a",old.id,old.lease_token,followups(),()=>{called=true}),/Stale/);
  assert.equal(called,false);
  j.succeedWithFollowups("a",current.id,current.lease_token,followups(),()=>{});
  assert.equal(j.status(scope).jobs.queued,2);
}));

for (const mode of ["before","after"]) test(`SIGKILL ${mode} followup commit preserves all-or-nothing discovery`,async()=>fixture(async({db,journal,path,key,close,reopen})=>{
  const j=journal();j.commitPage(page({discoveryComplete:true}),metadata);const [parent]=j.claim(scope);
  close();
  const script=`
    import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${JSON.stringify(new URL('./database.js',import.meta.url).href)};
    import {MailSyncJournal} from ${JSON.stringify(new URL('./sync-journal.js',import.meta.url).href)};
    const input=JSON.parse(readFileSync(0,'utf8'));const key=Buffer.from(input.key,'base64');
    const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);
    const j=new MailSyncJournal(db,'owner-a',()=>1001);
    j.succeedWithFollowups('a',input.parent.id,input.parent.lease_token,input.children,writer=>{
      writer.setAttachmentsEnumerated({provider:'gmail',messageId:'one'},true);
      if(input.mode==='before')process.kill(process.pid,'SIGKILL');
    });
    process.kill(process.pid,'SIGKILL');
  `;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script],{input:JSON.stringify({path,key:key.toString('base64'),parent,children:followups(),mode}),encoding:'utf8',env:{},timeout:10000});
  assert.equal(result.signal,'SIGKILL');assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  db=await reopen();const recovered=journal();const committed=mode==='after';
  assert.equal(db.get('SELECT attachments_enumerated FROM mail_messages').attachments_enumerated,committed?1:0);
  assert.equal(recovered.status(scope).jobs.queued,committed?2:0);
  assert.equal(recovered.status(scope).jobs.running,committed?0:1);
  assert.equal(recovered.status(scope).jobs.succeeded,committed?1:0);
  assert.equal(recovered.readCheckpoint(scope).discoveryComplete,true);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
}));


test("executor fences and provider retry delays remain account scoped and durable", async () => fixture(async ({db,journal,setTime,reopen}) => {
  const j=journal(); j.commitPage(page(),metadata); const [job]=j.claim(scope,1,100);
  j.assertLease('a',job.id,job.lease_token);
  assert.equal(j.readJob('a',job.id).state,'running');
  assert.equal(j.readJob('b',job.id),undefined);
  const foreign=new MailSyncJournal(db,'owner-b');
  assert.throws(()=>foreign.readJob('a',job.id),/account not found/);
  assert.throws(()=>foreign.assertLease('a',job.id,job.lease_token),/account not found/);
  assert.throws(()=>j.fail('a',job.id,job.lease_token,true,-1));
  j.fail('a',job.id,job.lease_token,true,7200000);
  assert.equal(j.readJob('a',job.id).available_at,7201000);
  assert.throws(()=>j.assertLease('a',job.id,job.lease_token),/Stale/);
  await reopen(); const after=journal(); setTime(7200999);
  assert.deepEqual(after.claim(scope,1,100),[]);
  setTime(7201000); const [retry]=after.claim(scope,1,100);
  assert.equal(retry.id,job.id);
  assert.notEqual(retry.lease_token,job.lease_token);
  after.fail('a',retry.id,retry.lease_token,true,Number.MAX_SAFE_INTEGER);
  assert.equal(after.readJob('a',job.id).available_at,Number.MAX_SAFE_INTEGER);
}));
