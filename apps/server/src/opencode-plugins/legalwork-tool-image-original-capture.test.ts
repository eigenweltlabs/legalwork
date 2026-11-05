import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Tool } from "@opencode/schema/tool";
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import { captureToolImageOriginals, skipOriginalImageCapture, type OriginalCaptureLedger } from "./legalwork-tool-image-original-capture.js";
import { nativeTestInvocation } from "./native-plugin-test-support.js";
import { TOOL_IMAGE_METADATA_KEY, toolImageLinkedMetadata } from "../tool-image-original-schema.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
type Completed = Extract<ToolHooks["execute.after"], {status:"completed"}>;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-original-hook-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const previous = { url: process.env.LEGALWORK_SERVER_URL, scoped: process.env.LEGALWORK_WIKI_AGENT_TOKEN, full: process.env.LEGALWORK_SERVER_TOKEN };
  let fail = false, started = () => {}, held = false; const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: root }] });
    expect(request.headers.get("authorization")).toBeNull(); expect(request.headers.get("x-legalwork-wiki-agent-token")).toBe("scoped-only");
    requests.push(path); started();
    if (held) return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("Observed Stop")), {once:true}));
    if (fail) return new Response("owned retention failure", {status:500});
    const form = await request.formData(), metadata = JSON.parse(String(form.get("metadata"))), image = form.get("image");
    if (!(image instanceof Blob)) throw new Error("Missing exact binary");
    const bytes = Buffer.from(await image.arrayBuffer()); expect(bytes.toString("base64")).toBe(encoded);
    return Response.json({ image: {reference:{id:randomUUID(),sessionID:"chat",sha256:createHash("sha256").update(bytes).digest("hex")},bytes:bytes.length,mime:"image/png",header:{status:"unavailable"},provenance:"pre-normalization-tool-original",source:{messageID:metadata.messageID,outerCallID:metadata.callID,tool:metadata.tool,contentIndex:metadata.contentIndex,captureOrdinal:requests.length,linkage:"observed-child-of-native-call",storageNamespace:"unverified",capturedDirectory:root,capturedProjectID:"p",capturedWorkspaceID:"matter",capturedAt:0}} });
  } });
  cleanup.push(() => server.stop(true));
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_WIKI_AGENT_TOKEN = "scoped-only"; process.env.LEGALWORK_SERVER_TOKEN = "must-not-leak";
  cleanup.push(() => { const values: Record<string,string|undefined> = {LEGALWORK_SERVER_URL:previous.url,LEGALWORK_WIKI_AGENT_TOKEN:previous.scoped,LEGALWORK_SERVER_TOKEN:previous.full}; for (const [key,value] of Object.entries(values)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; } });
  const ctx = {session:{get:()=>Effect.succeed({id:"chat",projectID:"p",location:{directory:root}})}};
  const event = (tool = "office.preview"): Completed => ({...nativeTestInvocation("chat"), tool, input:{}, status:"completed", result:{output:{unchanged:true},content:[{type:"file",mime:"image/png",uri:`data:image/png;base64,${encoded}`}]} });
  return {ctx,event,requests,ledger:new Map() satisfies OriginalCaptureLedger,fail:()=>{fail=true;},hold:()=>{held=true; return new Promise<void>(resolve=>{started=resolve;});}};
}

test("successful image then a caught child error retains distinct UUIDs on the actual completed outer call", async () => {
  const f = await fixture(), first = f.event(); await Effect.runPromise(captureToolImageOriginals(f.ctx, first, f.ledger));
  const failed: ToolHooks["execute.after"] = {...nativeTestInvocation("chat"),tool:"unrelated.failure",input:{},status:"error",error:new Tool.Error({message:"Caught by Code Mode"})};
  await Effect.runPromise(captureToolImageOriginals(f.ctx, failed, f.ledger));
  const second = f.event(); await Effect.runPromise(captureToolImageOriginals(f.ctx, second, f.ledger));
  const outer = f.event("execute"); await Effect.runPromise(captureToolImageOriginals(f.ctx, outer, f.ledger));
  const linked = toolImageLinkedMetadata.parse(outer.result.metadata?.[TOOL_IMAGE_METADATA_KEY]);
  expect(linked.originals).toHaveLength(2); expect(new Set(linked.originals.map(image=>image.reference.id)).size).toBe(2);
  expect(f.ledger.size).toBe(0); expect(outer.result.output).toEqual({unchanged:true}); expect(JSON.stringify(outer.result.metadata)).not.toContain(encoded);
  expect(f.requests).toHaveLength(2);
});

test("retention failure is explicit and preserves the completed output without throwing an after-hook retry error", async () => {
  const f = await fixture(); f.fail(); const event = f.event(), content = event.result.content;
  await Effect.runPromise(captureToolImageOriginals(f.ctx,event,f.ledger));
  expect(event.result.output).toEqual({unchanged:true}); expect(Array.isArray(event.result.content) && event.result.content[0]).toEqual(Array.isArray(content)&&content[0]);
  expect(event.result.metadata?.[TOOL_IMAGE_METADATA_KEY]).toMatchObject({status:"unavailable",unavailableCount:1});
  expect(JSON.stringify(event.result.content)).toContain("retention is unavailable");
});

test("retrieval tools never recursively retain recovered originals and terminal outer errors discard pending links", async () => {
  const f = await fixture();
  for (const tool of ["legalwork_history_image_read","legalwork_tool_image_original_read","legalwork_tool_image_original_crop","legalwork_tool_image_original_export","legalwork_tool_output_read"]) {
    expect(skipOriginalImageCapture(tool)).toBe(true); await Effect.runPromise(captureToolImageOriginals(f.ctx,f.event(tool),f.ledger));
  }
  expect(f.requests).toEqual([]);
  await Effect.runPromise(captureToolImageOriginals(f.ctx,f.event(),f.ledger));
  await Effect.runPromise(captureToolImageOriginals(f.ctx,{...nativeTestInvocation("chat"),tool:"execute",input:{},status:"error",error:new Tool.Error({message:"Stopped"})},f.ledger));
  expect(f.ledger.size).toBe(0);
});

test("Stop interrupts the genuine public Effect transport rather than reporting a false preserved reference", async () => {
  const f=await fixture(), started=f.hold(), event=f.event(), stop=new AbortController();
  const pending=Effect.runPromise(captureToolImageOriginals(f.ctx,event,f.ledger),{signal:stop.signal}); await started; stop.abort();
  await expect(pending).rejects.toBeDefined(); expect(event.result.metadata?.[TOOL_IMAGE_METADATA_KEY]).toBeUndefined(); expect(f.ledger.size).toBe(0);
});
