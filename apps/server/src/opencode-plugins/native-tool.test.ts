import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { nativeTool, nativeToolContext } from "./native-tool.js";

function runtime() {
  let directory = "/project/first";
  let denied: unknown;
  const permissions: unknown[] = [];
  const sessions: unknown[] = [];
  // This fixture deliberately implements only the native domains used by the adapter.
  const ctx = new Proxy({} as Plugin.Context, {
    get(_target, property) {
      if (property === "session") return { get: async (input: unknown) => {
        sessions.push(input);
        return { location: { directory } };
      } };
      if (property === "permission") return { assert: async (input: unknown) => {
        permissions.push(input);
        if (denied) throw denied;
      } };
      throw new Error(`Unexpected native domain ${String(property)}`);
    },
  });
  return { ctx, permissions, sessions, move: (value: string) => { directory = value; }, deny: (error: unknown) => { denied = error; } };
}

function invocation(signal = new AbortController().signal): ToolContext {
  // The real engine supplies branded identifiers; fixtures keep their exact wire values.
  return { sessionID: "ses_office", agent: "legalwork", messageID: "msg_office", id: "call_office", signal, progress: async () => {} } as unknown as ToolContext;
}

describe("native LegalWork tool adapter", () => {
  test("uses the active session location on each call and preserves its approval identity", async () => {
    const env = runtime();
    const tool = nativeTool(env.ctx, { name: "office_read", description: "Read the live document", schema: z.object({ path: z.string() }),
      execute: async (input, context) => JSON.stringify({ path: input.path, directory: context.directory, sessionID: context.sessionID }) });
    expect(await tool.execute({ path: "NDA.docx" }, invocation())).toEqual({ content: JSON.stringify({ path: "NDA.docx", directory: "/project/first", sessionID: "ses_office" }), output:{path:"NDA.docx",directory:"/project/first",sessionID:"ses_office"} });
    env.move("/project/second");
    expect(await tool.execute({ path: "NDA.docx" }, invocation())).toEqual({ content: JSON.stringify({ path: "NDA.docx", directory: "/project/second", sessionID: "ses_office" }),output:{path:"NDA.docx",directory:"/project/second",sessionID:"ses_office"} });
    expect(env.sessions).toEqual([{ sessionID: "ses_office" }, { sessionID: "ses_office" }]);
    expect(env.permissions).toEqual(Array.from({ length: 2 }, () => ({ sessionID: "ses_office", agent: "legalwork",
      source: { type: "tool", messageID: "msg_office", id: "call_office" }, action: "office_read", resources: ["*"], save: ["*"] })));
  });

  test("propagates native denials unchanged without executing the domain action", async () => {
    const env = runtime();
    const denial = new ToolError({ message: "This document is read-only" });
    env.deny(denial);
    let executed = false;
    const tool = nativeTool(env.ctx, { name: "office_write", description: "Edit the live document", schema: z.object({}),
      execute: async () => { executed = true; return "changed"; } });
    await expect(tool.execute({}, invocation())).rejects.toBe(denial);
    expect(executed).toBe(false);
  });

  test("does not start cancelled work and passes cancellation through to the executor", async () => {
    const env = runtime(), controller = new AbortController();
    let signal: AbortSignal | undefined;
    const tool = nativeTool(env.ctx, { name: "office_read", description: "Read", schema: z.object({}),
      execute: async (_input, context) => { signal = context.abort; return { content: "read", metadata: { revision: 2 } }; } });
    expect(await tool.execute({}, invocation(controller.signal))).toEqual({ content: "read", output:"read",metadata: { revision: 2 } });
    expect(signal).toBe(controller.signal);
    const reason = new Error("User stopped this run");
    controller.abort(reason);
    await expect(tool.execute({}, invocation(controller.signal))).rejects.toBe(reason);
    expect(env.sessions).toHaveLength(1);
  });

  test("keeps input defaults optional in JSON schema and parses them for execution", async () => {
    const env = runtime();
    const tool = nativeTool(env.ctx, { name: "office_read", description: "Read", schema: z.object({ limit: z.number().int().min(1).default(100) }),
      execute: async (input) => String(input.limit) });
    expect(tool.input).toMatchObject({ type: "object", properties: { limit: { type: "integer", minimum: 1, default: 100 } } });
    expect(Reflect.get(tool.input, "required")).toBeUndefined();
    expect(await tool.execute({}, invocation())).toEqual({ content: "100",output:100 });
    await expect(tool.execute({ limit: 0 }, invocation())).rejects.toBeInstanceOf(z.ZodError);
  });

  test("maps resource-specific permission requests without widening their scope", async () => {
    const env = runtime();
    const context = await nativeToolContext(env.ctx, invocation());
    await context.ask?.({ permission: "read", patterns: ["/project/template.docx"], always: [], metadata: { template: true } });
    expect(env.permissions).toEqual([{ sessionID: "ses_office", agent: "legalwork", source: { type: "tool", messageID: "msg_office", id: "call_office" },
      action: "read", resources: ["/project/template.docx"], save: [], metadata: { template: true } }]);
  });
});

test("structured results preserve complete long JSON, unknown fields, original text, files and metadata",async()=>{
  const env=runtime(),value={tail:"x".repeat(120000),future:{untouched:[1,true,null]}};const text=JSON.stringify(value,null,2);
  const tool=nativeTool(env.ctx,{name:"long_json",description:"JSON",schema:z.object({}),execute:async()=>({content:[{type:"text",text},{type:"file",uri:"file:///project/evidence.pdf",mime:"application/pdf",name:"Evidence"}],metadata:{revision:2}})});
  const result=await tool.execute({},invocation());expect(result.output).toEqual(value);expect(result.content).toEqual([{type:"text",text},{type:"file",uri:"file:///project/evidence.pdf",mime:"application/pdf",name:"Evidence"}]);expect(result.metadata).toEqual({revision:2});expect(tool.output).toBeDefined();
  const explicit={precise:"authoritative",more:{data:true}},typed=nativeTool(env.ctx,{name:"explicit",description:"Typed",schema:z.object({}),outputSchema:z.object({precise:z.string()}).passthrough(),execute:async()=>({content:"Concise human preview",output:explicit,metadata:{card:true}})});
  expect(await typed.execute({},invocation())).toEqual({content:"Concise human preview",output:explicit,metadata:{card:true}});expect(typed.output).toMatchObject({type:"object",properties:{precise:{type:"string"}},additionalProperties:{}});
});
