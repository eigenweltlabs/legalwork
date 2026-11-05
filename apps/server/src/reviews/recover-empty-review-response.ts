import type { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent } from "@opencode/client";

export const REVIEW_RECOVERY_PROMPT = "The previous response stopped with reasoning only, without an answer or tool call. Continue the already-authorised unfinished review tasks from their saved state. Reuse existing reviews; do not rerun completed inference. Complete the requested deliverables or explain a concrete blocker.";

/** Candidate detection only. The server gate rechecks full saved history, todos,
 * idle state, deletion exclusion and durable recovery markers before admission. */
export function recoverEmptyReviewResponse(ctx: Pick<Plugin.Context,"session">, send: (sessionID:string,messageID:string)=>Promise<void>) {
  const recovering=new Set<string>(), retried=new Map<string,string>();
  return async(event: OpenCodeEvent)=>{
    if(event.type==="session.deleted"){retried.delete(event.data.sessionID);return;}
    if(event.type!=="session.execution.succeeded")return;
    const sessionID=event.data.sessionID;if(recovering.has(sessionID))return;
    recovering.add(sessionID);
    try{
      const history=await ctx.session.context({sessionID});
      const last=history.at(-1);
      if(last?.type!=="assistant"||last.finish!=="stop"||last.error
        ||!last.content.some(part=>part.type==="reasoning"&&part.text.trim())
        ||last.content.some(part=>part.type==="tool"||part.type==="text"&&part.text.trim()))return;
      const user=history.slice(0,-1).reverse().find(message=>message.type==="user");
      if(!user||user.type!=="user"||!user.text.trim()||retried.get(sessionID)===user.id)return;
      if(history.slice(history.indexOf(user)+1).some(message=>message.type==="synthetic"&&message.metadata?.legalworkReviewRecovery===true))return;
      // New input arriving while saved state is being read always takes precedence.
      if((await ctx.session.context({sessionID})).at(-1)?.id!==last.id)return;
      await send(sessionID,last.id);
      retried.set(sessionID,user.id);
    }catch{
      // Optional recovery must not replace the original stop or create a loop.
    }finally{recovering.delete(sessionID);}
  };
}
