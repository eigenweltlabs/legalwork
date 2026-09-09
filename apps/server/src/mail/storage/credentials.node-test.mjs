/** Synthetic-only credential tests on the production encrypted Node adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openEncryptedMailDatabase } from "./database.js";
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from "./schema.js";
import { MailRepository } from "./repository.js";
import { MailContentStore } from "./content-store.js";
import { MailCredentialRepository } from "./credentials.js";
import { assertMailSchema, checkMailConsistency } from "./consistency.js";
const gmail={provider:"gmail",clientId:"synthetic.apps.googleusercontent.com",authority:"https://accounts.google.com",providerSubject:"stable-google-subject"};
const graph={provider:"graph",clientId:"11111111-2222-3333-4444-555555555555",authority:"https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0",providerSubject:"bbbbbbbb-cccc-dddd-eeee-ffffffffffff"};
const ACCESS="synthetic_access_credential_private_marker", REFRESH="synthetic_refresh_credential_private_marker";
const tokens=(extra={})=>({accessToken:ACCESS,expiresAt:5000,grantedScopes:null,refreshToken:{action:"replace",value:REFRESH},...extra});
const error=code=>({message:`mail_credentials_${code}`});
async function fixture(body) {
 const directory=await mkdtemp(join(tmpdir(),"legalwork-mail-credentials-")),path=join(directory,"mail.sqlite"),key=randomBytes(32);
 let db=await openEncryptedMailDatabase({path,key}),isOpen=true,now=1000;
 const close=()=>{if(isOpen){db.close();isOpen=false}};
 migrateMailSchema(db);
 const own=new MailRepository(db,"owner-a");
 for(const [id,provider] of [["a","gmail"],["b","gmail"],["g","graph"]])own.createAccount({id,provider,displayName:"Synthetic"});
 new MailRepository(db,"owner-b").createAccount({id:"foreign",provider:"gmail",displayName:"Foreign"});
 const repo=()=>new MailCredentialRepository(db,"owner-a",()=>now);
 try { await body({db,path,key,repo,close,setTime:value=>{now=value},async reopen(){close();db=await openEncryptedMailDatabase({path,key});isOpen=true;return db}}); }
 finally {close();key.fill(0);await rm(directory,{recursive:true,force:true})}
}

test("credential tokens stay encrypted in live DB/WAL and retain binding/version after reopen",async()=>fixture(async({db,path,repo,reopen,setTime})=>{
 let r=repo();assert.deepEqual(r.status("a"),{state:"unconfigured",archiveLocked:true,version:null});
 const version=r.connect("a",gmail,null,tokens());
 assert.equal(version.revision,1);assert.match(version.generation,/^[0-9a-f-]{36}$/);
 assert.deepEqual(r.readAccess("a",gmail),{accessToken:ACCESS,expiresAt:5000,grantedScopes:null,version});
 assert.deepEqual(r.readForRefresh("a",gmail),{refreshToken:REFRESH,grantedScopes:null,version});
 assert.ok(!JSON.stringify(r.status("a")).includes(ACCESS));assert.ok(!JSON.stringify(r.status("a")).includes(REFRESH));
 for(const file of [path,`${path}-wal`]) {
  const bytes=await readFile(file);assert.ok(bytes.length>0);
  for(const marker of [ACCESS,REFRESH,gmail.providerSubject])assert.equal(bytes.includes(Buffer.from(marker)),false);
  assert.notEqual(bytes.subarray(0,16).toString(),"SQLite format 3\0");
 }
 db=await reopen();r=repo();assert.deepEqual(r.status("a").version,version);assert.equal(r.readForRefresh("a",gmail).refreshToken,REFRESH);
 setTime(5000);assert.throws(()=>r.readAccess("a",gmail),error("access_expired"));assert.equal(r.readForRefresh("a",gmail).refreshToken,REFRESH);
}));

test("immutable owner/account/provider/client/authority/subject binding fails closed",async()=>fixture(({db,repo})=>{
 const r=repo(),version=r.connect("a",gmail,null,tokens());
 const other=new MailCredentialRepository(db,"owner-b",()=>1000);
 for(const fn of [()=>other.status("a"),()=>other.readAccess("a",gmail),()=>other.readForRefresh("a",gmail),()=>other.connect("a",gmail,version,tokens()),()=>other.rotate("a",gmail,version,tokens()),()=>other.disconnect("a",version)])assert.throws(fn,error("account_not_found"));
 assert.throws(()=>r.rotate("b",gmail,version,tokens()),error("disconnected"));
 for(const changed of [{...gmail,clientId:"different.apps.googleusercontent.com"},{...gmail,providerSubject:"other-subject"},graph]){
  assert.throws(()=>r.readAccess("a",changed),error("binding_mismatch"));assert.throws(()=>r.connect("a",changed,version,tokens()),error("binding_mismatch"));
 }
 assert.throws(()=>r.connect("b",{...gmail,authority:"https://attacker.invalid"},null,tokens()),error("invalid_input"));
 r.connect("g",graph,null,tokens());
 assert.equal(r.readAccess("g",{...graph,clientId:graph.clientId.toUpperCase(),authority:graph.authority.toUpperCase(),providerSubject:graph.providerSubject.toUpperCase()}).accessToken,ACCESS);
 assert.throws(()=>r.readAccess("g",{...graph,authority:graph.authority.replace('aaaaaaaa','bbbbbbbb')}),error("binding_mismatch"));
 assert.throws(()=>r.connect("b",gmail,null,tokens({refreshToken:{action:"preserve"}})),error("invalid_input"));
}));

test("refresh CAS has explicit preserve/replace/clear semantics and does not invent grants",async()=>fixture(({repo})=>{
 const r=repo();const initial=r.connect("a",gmail,null,tokens({grantedScopes:["scope-one"]}));
 const first=r.rotate("a",gmail,initial,tokens({accessToken:"access-new",refreshToken:{action:"preserve"}}));
 assert.equal(first.generation,initial.generation);assert.equal(first.revision,2);
 assert.equal(r.readForRefresh("a",gmail).refreshToken,REFRESH);assert.equal(r.readAccess("a",gmail).grantedScopes,null);
 assert.throws(()=>r.rotate("a",gmail,initial,tokens({accessToken:"late-access"})),error("stale_version"));
 const second=r.rotate("a",gmail,first,tokens({refreshToken:{action:"replace",value:"rotated-refresh"}}));
 assert.equal(r.readForRefresh("a",gmail).refreshToken,"rotated-refresh");
 const third=r.rotate("a",gmail,second,tokens({refreshToken:{action:"clear"}}));
 assert.throws(()=>r.readForRefresh("a",gmail),error("refresh_missing"));
 r.rotate("a",gmail,third,tokens({refreshToken:{action:"preserve"}}));
 assert.throws(()=>r.readForRefresh("a",gmail),error("refresh_missing"));
 assert.throws(()=>r.rotate("a",gmail,r.status("a").version,tokens({refreshToken:{action:"replace",value:""}})),error("invalid_input"));
}));

test("disconnect/reconnect fences old refreshes, clears credentials and retains archive bytes",async()=>fixture(async({db,repo,reopen})=>{
 const repository=new MailRepository(db,"owner-a"),store=new MailContentStore(db,"owner-a"),locator={provider:"gmail",messageId:"one"};
 repository.ingestMessage("a",{locator,subject:"Retained",rfcMessageId:null,memberships:[]});
 const ref=await store.writePart("a",locator,{kind:"raw",maxBytes:4},[Buffer.from("mail")]);
 let r=repo();const connected=r.connect("a",gmail,null,tokens()),disconnected=r.disconnect("a",connected);
 assert.notEqual(disconnected.generation,connected.generation);assert.equal(disconnected.revision,2);
 assert.deepEqual(r.status("a"),{state:"disconnected",archiveLocked:true,version:disconnected});
 for(const fn of [()=>r.readAccess("a",gmail),()=>r.readForRefresh("a",gmail),()=>r.rotate("a",gmail,connected,tokens())])assert.throws(fn,error("disconnected"));
 assert.deepEqual(db.get("SELECT access_token,refresh_token,expires_at,granted_scopes_json FROM mail_account_credentials WHERE account_id='a'"),{access_token:null,refresh_token:null,expires_at:null,granted_scopes_json:null});
 assert.throws(()=>r.connect("a",gmail,connected,tokens()),error("stale_version"));
 db=await reopen();r=repo();assert.deepEqual(r.status("a").version,disconnected);
 assert.equal(Buffer.concat([...new MailContentStore(db,"owner-a").read("a",ref.id)]).toString(),"mail"); // Gate wiring is separate.
 const reconnected=r.connect("a",gmail,disconnected,tokens({refreshToken:{action:"clear"}}));
 assert.notEqual(reconnected.generation,disconnected.generation);assert.equal(reconnected.revision,3);
 assert.throws(()=>r.rotate("a",gmail,connected,tokens()),error("stale_version"));
 assert.throws(()=>r.disconnect("a",disconnected),error("stale_version"));
 assert.throws(()=>r.readForRefresh("a",gmail),error("refresh_missing"));
 assert.equal(r.readAccess("a",gmail).accessToken,ACCESS);
}));

test("write failure redacts driver details and rolls token rotation back",async()=>fixture(({db,repo})=>{
 const r=repo(),version=r.connect("a",gmail,null,tokens());
 const faulty={...db,run(sql,parameters){db.run(sql,parameters);throw new Error(`${ACCESS}:${REFRESH}:private-path`)}};
 const bad=new MailCredentialRepository(faulty,"owner-a",()=>1000);
 assert.throws(()=>bad.rotate("a",gmail,version,tokens({refreshToken:{action:"replace",value:"new"}})),error("storage_unavailable"));
 assert.deepEqual(r.status("a").version,version);assert.equal(r.readForRefresh("a",gmail).refreshToken,REFRESH);
 assert.throws(()=>r.connect("b",gmail,null,tokens({accessToken:`${ACCESS}\n`})),error("invalid_input"));
 assert.throws(()=>new MailCredentialRepository({...db,get(){throw new Error(REFRESH)}},"owner-a"),error("storage_unavailable"));
 assert.throws(()=>new MailCredentialRepository({...db,get(sql,parameters){return sql.includes('sqlite3mc_version')?{engine:'stock SQLite'}:db.get(sql,parameters)}},"owner-a"),error("storage_unavailable"));
}));

test("revision overflow and invalid expiry never wrap or partially alter credentials",async()=>fixture(({db,repo,setTime})=>{
 const r=repo();r.connect("a",gmail,null,tokens());
 db.run("UPDATE mail_account_credentials SET revision=?",[Number.MAX_SAFE_INTEGER]);
 const version=r.status("a").version;
 for(const fn of [()=>r.rotate("a",gmail,version,tokens()),()=>r.disconnect("a",version),()=>r.connect("a",gmail,version,tokens())])assert.throws(fn,error("revision_exhausted"));
 assert.deepEqual(r.status("a").version,version);assert.equal(r.readForRefresh("a",gmail).refreshToken,REFRESH);
 assert.throws(()=>r.connect("b",gmail,null,tokens({expiresAt:1000})),error("access_expired"));
 assert.throws(()=>r.connect("b",gmail,null,tokens({expiresAt:Number.MAX_SAFE_INTEGER+1})),error("invalid_input"));
 setTime(NaN);assert.throws(()=>r.connect("b",gmail,null,tokens()),error("invalid_input"));
 assert.equal(r.status("b").state,"unconfigured");
}));

function childRotate(path,key,binding,version,accessToken){
 const script=`
 import{readFileSync}from'node:fs';
 import{openEncryptedMailDatabase}from ${JSON.stringify(new URL('./database.js',import.meta.url).href)};
 import{MailCredentialRepository}from ${JSON.stringify(new URL('./credentials.js',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8'));const key=Buffer.from(input.key,'base64');const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);
 try{const repo=new MailCredentialRepository(db,'owner-a',()=>1000);repo.rotate('a',input.binding,input.version,{accessToken:input.accessToken,expiresAt:5000,grantedScopes:null,refreshToken:{action:'preserve'}});process.stdout.write('success');}
 catch(error){process.stdout.write(error.message==='mail_credentials_stale_version'?'stale':'unexpected');}
 finally{db.close();}`;
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{env:{},stdio:['pipe','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('test_timeout'))},10000);
  child.on('error',reject);child.stdout.on('data',chunk=>out+=chunk.toString());child.stderr.on('data',chunk=>err+=chunk.toString());
  child.on('close',code=>{clearTimeout(timer);if(code!==0||err)reject(new Error('credential_child_failed'));else resolve(out)});
  child.stdin.end(JSON.stringify({path,key:key.toString('base64'),binding,version,accessToken}));
 });
}
test("two actual Node refresh writers sharing a snapshot produce one CAS winner after restart",async()=>fixture(async({repo,path,key,close,reopen})=>{
 const version=repo().connect("a",gmail,null,tokens());close();
 const results=await Promise.all([childRotate(path,key,gmail,version,"synthetic-winner-a"),childRotate(path,key,gmail,version,"synthetic-winner-b")]);
 assert.deepEqual(results.sort(),["stale","success"]);
 await reopen();const current=repo().readAccess("a",gmail);
 assert.equal(current.version.revision,2);assert.equal(current.version.generation,version.generation);
 assert.ok(["synthetic-winner-a","synthetic-winner-b"].includes(current.accessToken));
}));

test("v3 to v4 migration preserves existing data and fast guard requires credential structure",async()=>fixture(({db})=>{
 db.exec("DROP TRIGGER mail_raw_projection_insert; DROP TRIGGER mail_raw_projection_update; DROP TABLE mail_mime_parts; DROP TABLE mail_mime_projections; DROP TABLE mail_gmail_metadata; DROP TABLE mail_gmail_runs; DROP TABLE mail_action_jobs; DROP TABLE mail_account_credentials; UPDATE mail_schema_version SET version=3");
 assert.throws(()=>assertMailSchema(db));assert.deepEqual(checkMailConsistency(db).codes,["schema-upgrade-required"]);
 const faulty={...db,exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE mail_account_credentials'))throw new Error('DDL interrupted')}};
 assert.throws(()=>migrateMailSchema(faulty),/DDL interrupted/);
 assert.equal(db.get("SELECT version FROM mail_schema_version").version,3);
 assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='mail_account_credentials'"),undefined);
 migrateMailSchema(db);migrateMailSchema(db);assertMailSchema(db);
 assert.equal(db.get("SELECT count(*) AS n FROM mail_accounts").n,4);
 assert.equal(db.get("SELECT version FROM mail_schema_version").version,MAIL_SCHEMA_VERSION);
 db.exec("ALTER TABLE mail_account_credentials DROP COLUMN provider_subject");
 assert.throws(()=>assertMailSchema(db));assert.deepEqual(checkMailConsistency(db).codes,["schema-incomplete"]);
}));

test("new account and first credentials share the caller's outer transaction",async()=>fixture(({db,repo})=>{
 const accounts=new MailRepository(db,"owner-a"),credentials=repo();
 assert.throws(()=>db.transaction(()=>{
  accounts.createAccount({id:"new",provider:"gmail",displayName:"Synthetic new"});
  credentials.connect("new",gmail,null,tokens({expiresAt:1000}));
 }),error("access_expired"));
 assert.equal(db.get("SELECT id FROM mail_accounts WHERE id='new'"),undefined);
 assert.equal(db.get("SELECT account_id FROM mail_account_credentials WHERE account_id='new'"),undefined);
 const version=db.transaction(()=>{
  accounts.createAccount({id:"new",provider:"gmail",displayName:"Synthetic new"});
  return credentials.connect("new",gmail,null,tokens());
 });
 assert.deepEqual(credentials.status("new").version,version);
}));
