import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import pluginDefinition from "./legalwork-openai-tool-call-ids.js";
import { nativeProviderTestFetch } from "./native-plugin-test-support.js";

const calls:Array<{input:Parameters<typeof fetch>[0];init?:RequestInit}>=[];
let patchedFetch:typeof fetch;let runtime:Awaited<ReturnType<typeof nativeProviderTestFetch>>["runtime"];
beforeAll(async()=>{const fixture=await nativeProviderTestFetch(pluginDefinition,async request=>{calls.push({input:request,init:{body:await request.clone().text(),headers:request.headers}});return new Response("{}");});patchedFetch=fixture.send;runtime=fixture.runtime;});
afterAll(async()=>{await runtime.close();});

const signedId = `call_sample__thought__${"a".repeat(868)}`;
const shortId = "call_short";
const compactId = (id: string) => `call_lw_${createHash("sha256").update(id).digest("hex").slice(0, 56)}`;

async function send(body: unknown, path = "/v1/responses") {
  calls.length = 0;
  await patchedFetch(`https://models.example${path}`, { method: "POST", body: JSON.stringify(body) });
  const sent = calls[0]?.init?.body;
  if (typeof sent !== "string") throw new Error("expected request body");
  const parsed: unknown = JSON.parse(sent);
  return { parsed, sent };
}

describe("OpenAI tool-call IDs", () => {
  test("replays Gemini history with matching bounded Responses IDs, without changing content", async () => {
    const body = { model: "gpt-6.1-sol", input: [
      { type: "function_call", call_id: signedId, name: "legalwork_extension_list_actions", arguments: '{"connector":"gmail"}' },
      { type: "function_call_output", call_id: signedId, output: "existing result" },
      { type: "function_call", call_id: shortId, name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: shortId, output: "unchanged" },
      { role: "user", content: signedId },
    ] };
    const { parsed } = await send(body);
    expect(parsed).toEqual({ ...body, input: body.input.map(item => "call_id" in item && item.call_id === signedId ? { ...item, call_id: compactId(signedId) } : item) });
    expect(compactId(signedId).length).toBe(64);
    expect(body.input[0]?.call_id).toBe(signedId);
  });

  test("uses stable distinct IDs across reordered requests and retries", async () => {
    const other = `${signedId}b`;
    const input = [signedId, other].map(call_id => ({ type: "function_call_output", call_id, output: "ok" }));
    expect((await send({ input })).parsed).toEqual({ input: input.map(item => ({ ...item, call_id: compactId(item.call_id) })) });
    expect((await send({ input: [...input].reverse() })).parsed).toEqual({ input: [...input].reverse().map(item => ({ ...item, call_id: compactId(item.call_id) })) });
    expect(compactId(signedId)).not.toBe(compactId(other));
  });

  test("preserves Gemini signatures in Chat Completions requests", async () => {
    const body = { model: "Eigenwelt Europe Gemini", messages: [
      { role: "assistant", tool_calls: [{ id: signedId, type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: signedId, content: "ok" },
    ] };
    expect((await send(body, "/v1/chat/completions")).parsed).toEqual(body);
  });

  test("normalizes OpenAI Chat Completions call and result IDs", async () => {
    const body = { model: "gpt-6.1-sol", messages: [
      { role: "assistant", tool_calls: [{ id: signedId, type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: signedId, content: "ok" },
    ] };
    expect((await send(body, "/v1/chat/completions")).parsed).toEqual({ ...body, messages: [
      { ...body.messages[0], tool_calls: [{ ...body.messages[0]?.tool_calls?.[0], id: compactId(signedId) }] },
      { ...body.messages[1], tool_call_id: compactId(signedId) },
    ] });
  });

  test("leaves valid boundary-length IDs and unrelated JSON byte-for-byte intact", async () => {
    const body = { input: [{ type: "function_call", call_id: "x".repeat(64) }, { type: "message", call_id: signedId }] };
    expect((await send(body)).sent).toBe(JSON.stringify(body));
    expect((await send({ input: [{ type: "function_call", call_id: signedId }] }, "/v1/messages")).sent).toContain(signedId);
  });

  test("passes through malformed JSON and only exports the plugin factory", async () => {
    calls.length = 0;
    await patchedFetch("https://models.example/responses", { method: "POST", body: "not JSON" });
    expect(calls[0]?.init?.body).toBe("not JSON");
    expect(Object.keys(await import("./legalwork-openai-tool-call-ids.js"))).toEqual(["default"]);
  });

  test("avoids an existing short ID matching the hash of a long ID", async () => {
    const reserved = compactId(signedId);
    const alternate = `call_lw_${createHash("sha256").update(signedId).update("\0" + 1).digest("hex").slice(0, 56)}`;
    const input = [reserved, signedId, signedId].map(call_id => ({ type: "function_call_output", call_id, output: "ok" }));
    expect((await send({ input })).parsed).toEqual({ input: input.map(item => ({ ...item, call_id: item.call_id === signedId ? alternate : reserved })) });
  });

  test("normalizes Request bodies and keeps authentication, headers and abort signals", async () => {
    calls.length = 0;
    const controller = new AbortController();
    const request = new Request("https://models.example/codex/responses?stream=true", {
      method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json", "Content-Length": "1000" },
      body: JSON.stringify({ input: [{ type: "function_call_output", call_id: signedId, output: "ok" }] }),
    });
    await patchedFetch(request, { signal: controller.signal });
    const forwarded = calls[0]?.input;
    if (!(forwarded instanceof Request)) throw new Error("expected forwarded Request");
    expect(await forwarded.json()).toEqual({ input: [{ type: "function_call_output", call_id: compactId(signedId), output: "ok" }] });
    expect(forwarded.headers.get("Authorization")).toBe("Bearer test-key");
    expect(forwarded.headers.get("Content-Type")).toBe("application/json");
    expect(forwarded.headers.get("Content-Length")).toBeNull();
    expect(request.bodyUsed).toBe(false);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });
});

test("native WebSocket Responses use the same stable ID mapping and preserve control frames",async()=>{
  const fixture=await nativeProviderTestFetch(pluginDefinition,async()=>new Response("{}"));
  try{
    const body={type:"response.create",model:"gpt-6.1-sol",input:[{type:"function_call",call_id:signedId,name:"read",arguments:"{}"},{type:"function_call_output",call_id:signedId,output:"ok"}]};
    const event={frame:JSON.stringify(body)};await fixture.runtime.hook("session","experimental.ws.send",event);
    expect(JSON.parse(event.frame)).toEqual({...body,input:body.input.map(item=>({...item,call_id:compactId(signedId)}))});
    const control={frame:'{ "type": "session.update" }'};await fixture.runtime.hook("session","experimental.ws.send",control);expect(control.frame).toBe('{ "type": "session.update" }');expect(body.input[0].call_id).toBe(signedId);
  }finally{await fixture.runtime.close();}
});
