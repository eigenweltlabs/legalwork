import { expect, test } from "bun:test";
import { withFileEditorHandoff } from "./file-editor-handoff.js";

test("reads never contact the editor bridge, with or without an open draft", async () => {
  let touched = false;
  const result = await withFileEditorHandoff({ write: false, sessionID: "chat" }, async () => "hashes", async () => { touched = true; throw new Error("offline"); });
  expect(result).toBe("hashes"); expect(touched).toBe(false);
});

test("writes save and release first, then reload after process completion", async () => {
  const events: string[] = [];
  const result = await withFileEditorHandoff({ write: true, sessionID: "chat" }, async () => { events.push("write"); return 7; }, async (_path, options) => {
    const body = options?.body;
    events.push(String(body && typeof body === "object" && Reflect.get(body, "actionId")));
    return { ok: true };
  });
  expect(result).toBe(7);
  expect(events).toEqual(["documents.begin_file_edit", "write", "documents.end_file_edit"]);
});

test("cancellation and failed commands still reload; failed saves never run a write", async () => {
  for (const saveFails of [false, true]) {
    const events: string[] = [];
    await expect(withFileEditorHandoff({ write: true, sessionID: "chat" }, async () => { events.push("write"); throw new Error("cancelled"); }, async (_path, options) => {
      const action = String(options?.body && typeof options.body === "object" && Reflect.get(options.body, "actionId"));
      events.push(action);
      return saveFails && action === "documents.begin_file_edit" ? { ok: false, error: "save failed" } : { ok: true };
    })).rejects.toThrow(saveFails ? "save failed" : "cancelled");
    expect(events).toEqual(saveFails ? ["documents.begin_file_edit", "documents.end_file_edit"] : ["documents.begin_file_edit", "write", "documents.end_file_edit"]);
  }
});

test("Stop aborts a pending handoff, releases ownership and never starts the shell",async()=>{
  const controller=new AbortController();let ran=false;const actions:string[]=[];
  const started=Promise.withResolvers<void>();
  const pending=withFileEditorHandoff({write:true,sessionID:"chat",signal:controller.signal},async()=>{ran=true;},async(_path,options)=>{
    const action=String(options?.body&&typeof options.body==="object"&&Reflect.get(options.body,"actionId"));actions.push(action);
    if(action==="documents.begin_file_edit") {started.resolve();await new Promise((_,reject)=>options?.signal?.addEventListener("abort",()=>reject(options.signal?.reason),{once:true}));}
    else {expect(options?.signal).toBeUndefined();expect(options?.timeoutMs).toBe(5000);}
    return {ok:true};
  });
  await started.promise;controller.abort();await expect(pending).rejects.toThrow();expect(ran).toBe(false);
  expect(actions).toEqual(["documents.begin_file_edit","documents.end_file_edit"]);
});
