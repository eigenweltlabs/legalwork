import type { OpenCodeClient,SessionInfo } from "@opencode/client";
import type { HistoryUndoStatus } from "@legalwork/types/session-history";
import { engineStorageDir } from "./engine-storage.js";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { getWorkspaceEngineSession,workspaceEngineLocation } from "./engine-client.js";
import { readCurrentHistory, updateCurrentHistoryReceipt, type CurrentHistoryState } from "./current-history-state.js";
import type { ServerConfig,WorkspaceInfo } from "./types.js";
import { assertEngineProjectReady } from "./engine-project.js";
import { restoreLegacySessionPermissions } from "./session-history-permissions.js";

type Result={session:SessionInfo;state?:HistoryUndoStatus};
const preparing=new Map<string,Promise<Result>>();

/** Before --service starts recovered jobs, no engine or Location may activate.
 * Old Undo must already have a durable success receipt from normal startup. */
export async function assertSessionHistoryRecoveryReady(config:ServerConfig,sessionIDs:readonly string[]):Promise<void>{
 if(!sessionIDs.length)return;
 const unresolved:Array<{sessionID:string;reason:string}>=[];
 const hold=(reason:string):never=>{throw new ApiError(409,"history_undo_recovery_resolution_required","Automatic recovery is paused until older unfinished Undo has been restored safely. Start normally and open the affected chat first.",{sessions:unresolved,reason});};
 const state=await readCurrentHistory(config).catch(()=>hold("current_history_state_unavailable"));
 if(!state)return;
 for(const sessionID of new Set(sessionIDs)){
  const original=state.sessions[sessionID];
  if(!original || original.undo.status==="none")continue;
  const receipt=state.undoReceipts[sessionID];
  if(!receipt)unresolved.push({sessionID,reason:"original_undo_not_restored"});
  else if(receipt.sourceSha256!==state.sourceSha256 || receipt.sessionID!==sessionID)unresolved.push({sessionID,reason:"receipt_source_mismatch"});
 }
 if(unresolved.length)hold("original_undo_not_restored");
}

/** Run after project automation approval and authoritative native ownership.
 * Native staging can activate the location; never run it across unopened,
 * unapproved folders merely because they appear in the backup. */
export async function prepareSessionHistoryUndo(config:ServerConfig,workspace:WorkspaceInfo,client:OpenCodeClient,session:SessionInfo):Promise<Result>{
 let imported:CurrentHistoryState|null;
 try{imported=await readCurrentHistory(config);}catch{return {session,state:{status:"unresolved",reason:"current_history_state_unavailable"}};}
 if(!imported)return {session};
 const state=imported;
 const key=`${engineStorageDir(config)}:${state.sourceSha256}:${session.id}`;
 const existing=preparing.get(key);if(existing)return existing;
 const task=prepare();preparing.set(key,task);
 try{return await task;}finally{preparing.delete(key);}
 async function prepare():Promise<Result>{
  const [expected,actual]=await Promise.all([canonicalFilePath(workspaceEngineLocation(workspace).directory),canonicalFilePath(session.location.directory)]);
  if(expected!==actual)throw new ApiError(404,"session_not_found","Chat not found in this project.");
  const original=state.sessions[session.id];
  if(!original)return {session};
  const receipt=state.undoReceipts[session.id];
  if(receipt){
   if(receipt.sourceSha256!==state.sourceSha256 || receipt.sessionID!==session.id)return unresolved("receipt_source_mismatch");
   return {session,state:{status:"restored"}};
  }
  const revert=original.undo;
  if(revert.status==="none")return {session};
  if(original.directory!==actual)return unresolved("original_ownership_unavailable");
  if(revert.status==="unresolved")return unresolved(revert.reason);
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
  await updateCurrentHistoryReceipt(config,"undo",session.id,{version:1,sourceSha256:state.sourceSha256,sessionID:session.id,restoredAt:Date.now()});
  return {session:await client.session.get({sessionID:session.id}),state:{status:"restored"}};
 }
 function unresolved(reason:string):Result{return {session,state:{status:"unresolved",reason}};}
}

export async function assertSessionHistoryReady(config:ServerConfig,workspace:WorkspaceInfo,client:OpenCodeClient,sessionID:string){
 const session=await restoreLegacySessionPermissions(config,workspace,client,await getWorkspaceEngineSession(client,workspace,sessionID));
 const prepared=await prepareSessionHistoryUndo(config,workspace,client,session);
 if(prepared.state?.status==="unresolved")throw new ApiError(409,"history_undo_resolution_required","This older chat has unfinished Undo state that cannot yet be restored safely. The original backup is preserved.",prepared.state);
 return prepared;
}
