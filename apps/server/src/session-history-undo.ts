import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,rename,rm,writeFile } from "node:fs/promises";
import { dirname,join } from "node:path";
import { z } from "zod";
import type { OpenCodeClient,SessionInfo } from "@opencode/client";
import type { HistoryUndoStatus } from "@legalwork/types/session-history";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { getWorkspaceEngineSession,workspaceEngineLocation } from "./engine-client.js";
import { legacyHistoryBackupDirectory,readLegacyHistoryBackup } from "./history-v1-backup.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig,WorkspaceInfo } from "./types.js";
import { assertEngineProjectReady } from "./engine-project.js";

const Revert=z.object({messageID:z.string(),partID:z.string().optional(),snapshot:z.string().optional(),diff:z.string().optional(),files:z.array(z.unknown()).optional()});
const Receipt=z.object({version:z.literal(1),sourceSha256:z.string(),sessionID:z.string(),restoredAt:z.number()});
type Result={session:SessionInfo;state?:HistoryUndoStatus};
const preparing=new Map<string,Promise<Result>>();
function isMissing(error:unknown){return error && typeof error==="object" && "code" in error && error.code==="ENOENT";}
const receiptPathFor=(config:ServerConfig,sessionID:string)=>join(legacyHistoryBackupDirectory(config),"undo-receipts",createHash("sha256").update(sessionID).digest("hex")+".json");

/** Before --service starts recovered jobs, no engine or Location may activate.
 * Old Undo must already have a durable success receipt from normal startup. */
export async function assertSessionHistoryRecoveryReady(config:ServerConfig,sessionIDs:readonly string[]):Promise<void>{
 if(!sessionIDs.length)return;
 const unresolved:Array<{sessionID:string;reason:string}>=[];
 const hold=(reason:string):never=>{throw new ApiError(409,"history_undo_recovery_resolution_required","Automatic recovery is paused until older unfinished Undo has been restored safely. Start normally and open the affected chat first.",{sessions:unresolved,reason});};
 const backup=await readLegacyHistoryBackup(config).catch(()=>hold("original_backup_unavailable"));
 if(!backup)return;
 const db=await openSqliteReadonly(backup.path).catch(()=>hold("original_backup_unavailable"));
 try{
  const tables=new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row=>row.name));
  if(!tables.has("session") || !db.all("PRAGMA table_info(session)").some(row=>row.name==="revert"))return;
  for(const sessionID of new Set(sessionIDs)){
   const original=db.all("SELECT revert FROM session WHERE id=?",[sessionID])[0];
   if(!original || original.revert===null || original.revert===undefined)continue;
   try{
    const receipt=Receipt.parse(JSON.parse(await readFile(receiptPathFor(config,sessionID),"utf8")));
    if(receipt.sourceSha256!==backup.sha256 || receipt.sessionID!==sessionID)unresolved.push({sessionID,reason:"receipt_source_mismatch"});
   }catch(error){unresolved.push({sessionID,reason:isMissing(error)?"original_undo_not_restored":"receipt_unavailable"});}
  }
 }catch(error){if(error instanceof ApiError)throw error;hold("original_backup_unavailable");}finally{db.close();}
 if(unresolved.length)hold("original_undo_not_restored");
}

/** Run after project automation approval and authoritative native ownership.
 * Native staging can activate the location; never run it across unopened,
 * unapproved folders merely because they appear in the backup. */
export async function prepareSessionHistoryUndo(config:ServerConfig,workspace:WorkspaceInfo,client:OpenCodeClient,session:SessionInfo):Promise<Result>{
 let backup:Awaited<ReturnType<typeof readLegacyHistoryBackup>>;
 try{backup=await readLegacyHistoryBackup(config);}catch{return {session,state:{status:"unresolved",reason:"original_backup_unavailable"}};}
 if(!backup)return {session};
 const key=`${backup.path}:${session.id}`;
 const existing=preparing.get(key);if(existing)return existing;
 const task=prepare();preparing.set(key,task);
 try{return await task;}finally{preparing.delete(key);}
 async function prepare():Promise<Result>{
  const [expected,actual]=await Promise.all([canonicalFilePath(workspaceEngineLocation(workspace).directory),canonicalFilePath(session.location.directory)]);
  if(expected!==actual)throw new ApiError(404,"session_not_found","Chat not found in this project.");
  const receiptPath=receiptPathFor(config,session.id);
  try{
   const receipt=Receipt.parse(JSON.parse(await readFile(receiptPath,"utf8")));
   if(receipt.sourceSha256!==backup!.sha256 || receipt.sessionID!==session.id)return unresolved("receipt_source_mismatch");
   return {session,state:{status:"restored"}};
  }catch(error){if(!isMissing(error))return unresolved("receipt_unavailable");}
  const db=await openSqliteReadonly(backup!.path);
  let revert:z.infer<typeof Revert>|undefined;
  try{
   const tables=new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row=>row.name));
   if(!tables.has("session") || !db.all("PRAGMA table_info(session)").some(row=>row.name==="revert"))return {session};
   const original=db.all("SELECT directory,revert FROM session WHERE id=?",[session.id])[0];
   if(!original || original.revert===null || original.revert===undefined)return {session};
   if(typeof original.directory!=="string" || await canonicalFilePath(original.directory)!==actual)return unresolved("original_ownership_unavailable");
   try{revert=Revert.parse(JSON.parse(String(original.revert)));}catch{return unresolved("original_revert_invalid");}
   if(revert.partID)return unresolved("partial_part_revert_unsupported");
   if(revert.diff?.trim() || revert.files?.length)return unresolved("file_redo_state_unsupported");
   if(!tables.has("part"))return unresolved("original_patch_evidence_unavailable");
   for(const row of db.iterate("SELECT data FROM part WHERE session_id=? AND message_id>=?",[session.id,revert.messageID])){
    let value:unknown;try{value=JSON.parse(String(row.data));}catch{return unresolved("original_patch_evidence_invalid");}
    if(value && typeof value==="object" && "type" in value && value.type==="patch" && "files" in value && Array.isArray(value.files) && value.files.length)return unresolved("file_patch_revert_unsupported");
   }
  }finally{db.close();}
  await assertEngineProjectReady(config,workspace);
  try{await client.session.message.get({sessionID:session.id,messageID:revert.messageID});}catch{return unresolved("original_revert_message_unavailable");}
  const [active,inbox]=await Promise.all([client.session.active(),client.session.inbox.list({sessionID:session.id})]);
  if(active[session.id] || inbox.length)return unresolved("native_work_already_pending");
  if(session.revert && (session.revert.messageID!==revert.messageID || session.revert.partID || session.revert.files?.length))return unresolved("native_revert_conflict");
  const staged=session.revert ?? await client.session.revert.stage({sessionID:session.id,messageID:revert.messageID,files:false});
  if(revert.snapshot && staged.snapshot!==revert.snapshot){
   if(!session.revert)await client.session.revert.clear({sessionID:session.id});
   return unresolved("original_snapshot_does_not_match_current_files");
  }
  // A receipt preserves the user's later Clear/Commit choice across restart.
  // It stores migration state only, never a duplicate transcript or file.
  await mkdir(dirname(receiptPath),{recursive:true,mode:0o700});
  const temporary=`${receiptPath}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify({version:1,sourceSha256:backup!.sha256,sessionID:session.id,restoredAt:Date.now()})+"\n",{mode:0o600,flag:"wx"});await rename(temporary,receiptPath);}finally{await rm(temporary,{force:true});}
  return {session:await client.session.get({sessionID:session.id}),state:{status:"restored"}};
 }
 function unresolved(reason:string):Result{return {session,state:{status:"unresolved",reason}};}
}

export async function assertSessionHistoryReady(config:ServerConfig,workspace:WorkspaceInfo,client:OpenCodeClient,sessionID:string){
 const prepared=await prepareSessionHistoryUndo(config,workspace,client,await getWorkspaceEngineSession(client,workspace,sessionID));
 if(prepared.state?.status==="unresolved")throw new ApiError(409,"history_undo_resolution_required","This older chat has unfinished Undo state that cannot yet be restored safely. The original backup is preserved.",prepared.state);
 return prepared;
}
