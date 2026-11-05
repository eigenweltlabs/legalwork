import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import outputDefinition from "./legalwork-tool-output.js";
import { nativePluginTools } from "./native-plugin-test-support.js";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { assertToolOutputOwned } from "../routes/tool-output.js";

let root: string;
let directory: string;
let outputPath: string;
let previousData: string | undefined;
let current = "child";
let server:ReturnType<typeof Bun.serve>;
let engine:OpenCodeClient;
let oldUrl:string|undefined,oldToken:string|undefined;
let paginate=false,repeatCursor=false;
let approvals: string[] = [];
const sessions = new Map<string, { id: string; directory: string; parentID?: string }>();
const messages = new Map<string, unknown[]>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "saved-tool-output-"));
  directory = join(root, "project");
  outputPath = join(root, "opencode", "tool-output", "tool_fixture");
  await mkdir(join(root, "opencode", "tool-output"), { recursive: true });
  await mkdir(directory);
  previousData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  current = "child";paginate=false;repeatCursor=false;
  approvals = [];
  sessions.clear(); messages.clear();
  for (const id of ["parent", "child", "unrelated"]) {
    sessions.set(id, { id, directory, ...(id === "child" ? { parentID: "parent" } : {}) });
    messages.set(id, []);
  }
  messages.set("parent", [{ type:"assistant", content: [{ type: "tool", state: { status: "completed", metadata: { truncated: true, outputPath } } }] }]);
  oldUrl=process.env.LEGALWORK_SERVER_URL;oldToken=process.env.LEGALWORK_SERVER_TOKEN;
  server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const url=new URL(request.url),id=url.pathname.split("/")[3];
    if(url.pathname.startsWith("/api/session/")){
      if(url.pathname.endsWith("/message")){
        if(url.searchParams.has("cursor")&&url.searchParams.has("order"))return Response.json({message:"Cursor cannot be combined with order"},{status:400});
        if(repeatCursor)return Response.json({data:[],cursor:{next:"repeat"}});
        if(paginate&&!url.searchParams.has("cursor"))return Response.json({data:[],cursor:{next:"second"}});
        return Response.json({data:messages.get(id)??[],cursor:{}});
      }
      const session=sessions.get(id);return Response.json({data:session?{...session,location:{directory:session.directory}}:undefined});
    }
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    if(url.pathname==="/workspaces")return Response.json({items:[{id:"fixture",path:directory}]});
    try{await assertToolOutputOwned(engine,{path:directory},url.pathname.split("/")[4],url.searchParams.get("outputPath")??"",request.signal);return Response.json({ok:true});}
    catch(error){return Response.json({message:error instanceof Error?error.message:"Denied"},{status:403});}
  }});
  engine=OpenCode.make({baseUrl:server.url.origin});process.env.LEGALWORK_SERVER_URL=server.url.origin;process.env.LEGALWORK_SERVER_TOKEN="fixture-token";
});
afterEach(async () => {
  server.stop(true);
  if(oldUrl===undefined)delete process.env.LEGALWORK_SERVER_URL;else process.env.LEGALWORK_SERVER_URL=oldUrl;
  if(oldToken===undefined)delete process.env.LEGALWORK_SERVER_TOKEN;else process.env.LEGALWORK_SERVER_TOKEN=oldToken;
  if (previousData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousData;
  await rm(root, { recursive: true, force: true });
});

function plugin(){return nativePluginTools(outputDefinition,{directory});}

async function read(input: Record<string, unknown> = {}, deny?: string) {
  const tools = (await plugin()).tool;
  return JSON.parse(await tools.legalwork_tool_output_read.execute({ outputPath, ...input }, {
    directory, sessionID: current,
    ask: async ({ permission }) => { approvals.push(permission); if (permission === deny) throw new Error("Permission denied"); },
  }));
}

test("a child recovers exact content beyond the long-line and 64 KiB boundaries", async () => {
  const content = JSON.stringify({ padding: "a".repeat(80000), result: "complete requested section" });
  await writeFile(outputPath, content);
  const match = await read({ query: "complete requested section" });
  expect(match.found).toBe(true);
  expect(match.matchOffset).toBeGreaterThan(65536);
  expect(match.text).toContain("complete requested section");
  const page = await read({ offset: match.matchOffset });
  expect(page.text).toBe(content.slice(match.matchOffset));
  expect(page.nextOffset).toBeNull();
  expect(approvals).toEqual(["legalwork_tool_output_read", "read", "legalwork_tool_output_read", "read"]);
});

test("successive UTF-8 byte pages reconstruct a single long line exactly", async () => {
  const content = "a".repeat(4096) + "\uFEFF" + "abcdé🙂東京".repeat(5000);
  await writeFile(outputPath, content);
  let offset: number | null = 0;
  let recovered = "";
  while (offset !== null) {
    const result = await read({ offset, limit: 4096 });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4096);
    recovered += result.text;
    offset = result.nextOffset;
  }
  expect(recovered).toBe(content);
  await expect(read({ offset: 4097 })).rejects.toThrow("UTF-8");
});

test("search has bounded scans, finds boundary-spanning matches and continues", async () => {
  const content = "a".repeat(1024 * 1024 - 2) + "needle" + "a".repeat(1024 * 1024) + "needle";
  await writeFile(outputPath, content);
  const first = await read({ query: "needle" });
  expect(first.matchOffset).toBe(1024 * 1024 - 2);
  const second = await read({ query: "needle", offset: first.nextOffset });
  expect(second.found).toBe(false);
  expect(second.nextOffset).not.toBeNull();
  const third = await read({ query: "needle", offset: second.nextOffset });
  expect(third.text).toContain("needle");
  expect(third.nextOffset).toBeNull();
  expect(await read({ query: "missing", offset: content.length })).toMatchObject({ found: false, nextOffset: null });
});

test("unrelated chats, siblings and unverified result text confer no access", async () => {
  await writeFile(outputPath, "private fixture");
  current = "unrelated";
  messages.set(current, [{ type:"assistant", content: [{ type: "text", text: outputPath }, { type: "tool", state: { status: "completed", metadata: { outputPath, truncated: false } } }] }]);
  await expect(read()).rejects.toThrow("does not belong");
  expect(approvals).toEqual([]);
  current = "parent";
  messages.set("child", messages.get("parent")??[]);
  messages.set("parent", []);
  await expect(read()).rejects.toThrow("does not belong");
});

test("parent lineage cannot cross projects or loop", async () => {
  await writeFile(outputPath, "fixture");
  sessions.set("parent", { id: "parent", directory: join(root, "different-project") });
  await expect(read()).rejects.toThrow("does not belong");
  sessions.set("parent", { id: "parent", directory, parentID: "child" });
  messages.set("parent", []);
  await expect(read()).rejects.toThrow("lineage");
});

test("files outside engine storage and symlinks are refused even with metadata", async () => {
  const outside = join(root, "tool_secret");
  await writeFile(outside, "not an output");
  messages.set("parent", [{ type:"assistant", content: [{ type: "tool", state: { status: "completed", metadata: { truncated: true, outputPath: outside } } }] }]);
  await expect(read({ outputPath: outside })).rejects.toThrow("Only an engine-saved");
  messages.set("parent", [{ type:"assistant", content: [{ type: "tool", state: { status: "completed", metadata: { truncated: true, outputPath } } }] }]);
  await symlink(outside, outputPath);
  await expect(read()).rejects.toThrow("regular file");
});

test("native denials and expired output files fail closed", async () => {
  await writeFile(outputPath, "fixture");
  await expect(read({}, "read")).rejects.toThrow("Permission denied");
  await expect(read({}, "legalwork_tool_output_read")).rejects.toThrow("Permission denied");
  await rm(outputPath);
  await expect(read()).rejects.toThrow();
});

test("page sizes and offsets are bounded and newline-heavy output stays one JSON record", async () => {
  await writeFile(outputPath, "\u0000\n".repeat(5000));
  const result = await read({ limit: 4096 });
  expect(result.text).toBe("\u0000\n".repeat(2048));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  await expect(read({ limit: 100000 })).rejects.toThrow();
  await expect(read({ offset: -1 })).rejects.toThrow();
  await expect(read({ offset: 100000 })).rejects.toThrow("beyond");
});


test("full native pagination and more than 32 same-project parents retain saved output access",async()=>{
  await writeFile(outputPath,"Complete retained result");paginate=true;
  for(let index=0;index<40;index++){const id=`ancestor-${index}`;sessions.set(id,{id,directory,...(index<39?{parentID:`ancestor-${index+1}`}:{})});messages.set(id,[]);}
  sessions.set("child",{id:"child",directory,parentID:"ancestor-0"});
  messages.set("ancestor-39",messages.get("parent")??[]);
  expect((await read()).text).toBe("Complete retained result");
  repeatCursor=true;await expect(read()).rejects.toThrow("repeated");
});
