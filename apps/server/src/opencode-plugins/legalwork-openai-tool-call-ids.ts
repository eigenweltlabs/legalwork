import { Plugin } from "@opencode/plugin";
import { nativeProviderRequest } from "./native-provider-request.js";
import { createHash } from "node:crypto";
import { checkModelResponse } from "./model-request-errors.js";

// LiteLLM carries Gemini thought signatures in tool IDs. Replaying those IDs
// after switching to OpenAI exceeds its 64-character limit. Rewrite only the
// wire payload, preserving saved history and signatures needed by Gemini.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function normalizeBody(body: string, path: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return null; }
  if (!isRecord(parsed)) return null;
  const references: { item: Record<string, unknown>; key: string; id: string }[] = [];
  const add = (item: Record<string, unknown>, key: string) => {
    const id = item[key];
    if (typeof id === "string") references.push({ item, key, id });
  };
  if (/\/responses\/?$/.test(path) && Array.isArray(parsed.input)) {
    for (const item of parsed.input) {
      if (isRecord(item) && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(item.type))) add(item, "call_id");
    }
  } else if (/\/chat\/completions\/?$/.test(path) && typeof parsed.model === "string" && /(?:^|[\s/])(?:gpt-|chatgpt-|o[1-9](?:-|$))/i.test(parsed.model) && Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!isRecord(message)) continue;
      if (message.role === "tool") add(message, "tool_call_id");
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) if (isRecord(call)) add(call, "id");
      }
    }
  }
  const longIds = [...new Set(references.filter(ref => ref.id.length > 64).map(ref => ref.id))].sort();
  if (!longIds.length) return null;
  const used = new Set(references.filter(ref => ref.id.length <= 64).map(ref => ref.id));
  const replacements = new Map<string, string>();
  for (const id of longIds) {
    let salt = 0;
    let compact: string;
    do {
      const hash = createHash("sha256").update(id);
      if (salt) hash.update(`\0${salt}`);
      compact = `call_lw_${hash.digest("hex").slice(0, 56)}`;
      salt += 1;
    } while (used.has(compact));
    used.add(compact);
    replacements.set(id, compact);
  }
  for (const ref of references) {
    const compact = replacements.get(ref.id);
    if (compact) ref.item[ref.key] = compact;
  }
  return JSON.stringify(parsed);
}

export default Plugin.define({id:"legalwork.openai.tool-call-ids",async setup(ctx){
  await ctx.session.hook("http.request",async event=>{
    const path=new URL(event.request.url).pathname;
    if(!/\/(?:responses|chat\/completions)\/?$/.test(path))return;
    event.request=await nativeProviderRequest(event.request,body=>normalizeBody(body,path));
  });
  await ctx.session.hook("http.response", async event => {
    if (event.response.status !== 413) return;
    const bytes = event.request.method === "POST" ? (await event.request.clone().arrayBuffer()).byteLength : undefined;
    try { await checkModelResponse(event.response, bytes); }
    catch (error) {
      // Native hooks mutate the response; throwing here is a plugin defect.
      // A byte-limit rejection must be an ordinary non-retryable model error.
      event.response = Response.json({ error: { code: "legalwork_request_byte_limit", message: (error instanceof Error ? error.message : String(error)).replace("request_too_large:", "Request byte limit:") } }, { status: 400 });
    }
  });
  await ctx.session.hook("experimental.ws.send",event=>{
    // Native Responses WebSocket requests are flattened response.create frames.
    // Other control frames have no input list and remain byte-for-byte intact.
    const normalized=normalizeBody(event.frame,"/responses");if(normalized!==null)event.frame=normalized;
  });
}});
