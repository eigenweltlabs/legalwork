import { isAbsolute, relative, sep } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import { canonicalFilePath } from "../file-write-lock.js";
import { createEngineClient } from "../engine-client.js";
import { ApiError } from "../errors.js";
import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

/** Full saved history is authoritative even after active context was compacted.
 * Parent traversal is complete, directory-pinned and cycle checked. */
export async function assertToolOutputOwned(client:Pick<OpenCodeClient,"session"|"message">,workspace:Pick<WorkspaceInfo,"path"|"directory">,sessionID:string,outputPath:string,signal?:AbortSignal):Promise<void>{
  const workspacePath=await canonicalFilePath(workspace.directory?.trim() || workspace.path);
  let directory:string|undefined;
  let current:string|undefined=sessionID;
  const visited=new Set<string>();
  while(current){
    signal?.throwIfAborted();
    if(visited.has(current))throw new ApiError(403,"tool_output_invalid_lineage","This chat's parent lineage could not be verified.");
    visited.add(current);
    const session=await client.session.get({sessionID:current},{signal});
    const actual=await canonicalFilePath(session.location.directory);
    const part=relative(workspacePath,actual);
    if(session.id!==current||isAbsolute(part)||part===".."||part.startsWith(`..${sep}`)||directory!==undefined&&actual!==directory)break;
    directory=actual;
    const cursors=new Set<string>();let cursor:string|undefined;
    do{
      const page=await client.message.list({sessionID:current,...(cursor?{cursor}:{order:"asc"})},{signal});
      if(page.data.some(message=>message.type==="assistant"&&message.content.some(part=>part.type==="tool"&&part.state.status==="completed"&&part.state.metadata?.truncated===true&&part.state.metadata.outputPath===outputPath)))return;
      cursor=page.cursor.next??undefined;
      if(cursor&&cursors.has(cursor))throw new ApiError(502,"opencode_invalid_cursor","The engine repeated a saved output history cursor.");
      if(cursor)cursors.add(cursor);
    }while(cursor);
    current=session.parentID;
  }
  throw new ApiError(403,"tool_output_not_owned","This saved output does not belong to the current chat or one of its parent chats.");
}

interface RegisterToolOutputRoutesOptions{
  routes:Route[];config:ServerConfig;
  jsonResponse:(data:unknown,status?:number)=>Response;
  requireClientScope:(ctx:RequestContext,required:TokenScope)=>void;
  resolveWorkspace:(config:ServerConfig,id:string)=>Promise<WorkspaceInfo>;
}
export function registerToolOutputRoutes(options:RegisterToolOutputRoutesOptions):void{
  const{routes,config,jsonResponse,requireClientScope,resolveWorkspace}=options;
  addRoute(routes,"GET","/workspace/:id/sessions/:sessionId/tool-output/authorize","client",async ctx=>{
    requireClientScope(ctx,"viewer");
    const before=await authenticateWikiAgentRequest(config,ctx.request);
    const outputPath=z.string().min(1).max(4096).parse(ctx.url.searchParams.get("outputPath"));
    const workspace=await resolveWorkspace(config,ctx.params.id);
    await assertToolOutputOwned(createEngineClient(config,workspace),workspace,ctx.params.sessionId,outputPath,ctx.request.signal);
    if(before){
      const after=await authenticateWikiAgentRequest(config,ctx.request);
      if(!after||after.generation!==before.generation||after.directory!==before.directory||after.actor.scope!==before.actor.scope)
        throw new ApiError(403,"tool_output_origin_changed","This chat's access changed while authorizing the saved output.");
    }
    ctx.request.signal.throwIfAborted();
    return jsonResponse({ok:true});
  });
}
