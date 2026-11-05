import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLegacyHistoryBackup, readLegacyHistoryBackup } from "./history-v1-backup.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig } from "./types.js";
import { updateCurrentHistoryReceipt } from "./current-history-state.js";
import { assertSessionHistoryRecoveryReady } from "./session-history-undo.js";
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"legalwork-history-backup-"));
  const previous=process.env.LEGALWORK_RUNTIME_DB;process.env.LEGALWORK_RUNTIME_DB=join(root,"runtime.sqlite");
  cleanups.push(async()=>{if(previous===undefined)delete process.env.LEGALWORK_RUNTIME_DB;else process.env.LEGALWORK_RUNTIME_DB=previous;await rm(root,{recursive:true,force:true});});
  const config={configPath:join(root,"server.json")} as ServerConfig;
  const source=join(root,"v1.db"),db=new Database(source);
  db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('immutable original')");db.close();
  const snapshot=async(destination:string)=>{const db=await openSqliteReadonly(source);try{db.run("VACUUM INTO ?",[destination]);}finally{db.close();}};
  return {root,config,source,snapshot};
}
test("original backup remains read-only, private and independent of source/native cleanup",async()=>{
  const {root,config,source,snapshot}=await fixture();
  const backup=await ensureLegacyHistoryBackup(config,source,snapshot),candidate=join(root,"native.db");
  await copyFile(backup.path,candidate);await chmod(candidate,0o600);
  expect((await lstat(backup.path)).ino).not.toBe((await lstat(candidate)).ino);
  if(process.platform!=="win32"){
    expect((await lstat(backup.path)).mode&0o777).toBe(0o400);
    expect((await lstat(join(root,"history-v1"))).mode&0o777).toBe(0o700);
  }
  const sourceDb=new Database(source);sourceDb.exec("UPDATE original SET value='changed later'");sourceDb.close();
  const nativeDb=new Database(candidate);nativeDb.exec("DROP TABLE original");nativeDb.close();
  const original=await openSqliteReadonly(backup.path);
  try{expect(original.all("SELECT value FROM original")[0]?.value).toBe("immutable original");expect(()=>original.run("DELETE FROM original",[])).toThrow();}finally{original.close();}
  expect((await ensureLegacyHistoryBackup(config,source,async()=>{throw new Error("must not refresh an original");})).sha256).toBe(backup.sha256);
});
test("concurrent backup publication converges and tampering is an explicit failure",async()=>{
  const {config,source,snapshot}=await fixture();
  const [first,second]=await Promise.all([ensureLegacyHistoryBackup(config,source,snapshot),ensureLegacyHistoryBackup(config,source,snapshot)]);
  expect(first.sha256).toBe(second.sha256);
  expect(await readLegacyHistoryBackup(config)).toEqual(first);
  await chmod(first.path,0o600);await writeFile(first.path,"tampered original");
  await expect(readLegacyHistoryBackup(config)).rejects.toThrow("integrity check failed");
});

test("native service recovery checks original Undo and durable receipts before any engine can activate",async()=>{
  const {root,config,source,snapshot}=await fixture();
  const original=new Database(source);
  original.exec("CREATE TABLE session(id TEXT,revert TEXT); INSERT INTO session VALUES('plain',NULL)");
  original.prepare("INSERT INTO session VALUES(?,?)").run("older",JSON.stringify({messageID:"old-message",partID:"partial-part"}));original.close();
  const backup=await ensureLegacyHistoryBackup(config,source,snapshot);
  await expect(assertSessionHistoryRecoveryReady(config,[])).resolves.toBeUndefined();
  await expect(assertSessionHistoryRecoveryReady(config,["plain","new-native-chat"])).resolves.toBeUndefined();
  await expect(assertSessionHistoryRecoveryReady(config,["older","older"])).rejects.toMatchObject({status:409,code:"history_undo_recovery_resolution_required",details:{sessions:[{sessionID:"older",reason:"original_undo_not_restored"}]}});
  await updateCurrentHistoryReceipt(config,"undo","older",{version:1,sourceSha256:backup.sha256,sessionID:"older",restoredAt:1});
  await rm(source);
  await expect(assertSessionHistoryRecoveryReady(config,["older"])).resolves.toBeUndefined();
  // The retired archive no longer supplies normal recovery state.
  await chmod(backup.path,0o600);await writeFile(backup.path,"tampered original");
  await expect(assertSessionHistoryRecoveryReady(config,["older"])).resolves.toBeUndefined();
});
