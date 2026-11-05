import assert from "node:assert/strict";
import test from "node:test";
import {
  detectEngineProtocol,
  engineEventIdentity,
  observeSessionActivity,
  observeSessionInteractions,
  sessionTreeIDs,
  skillCatalogIdentity,
} from "./engine-evidence.mjs";
import { summarizeMessages } from "./evidence.mjs";

test("native evidence uses explicit location and complete pagination, never v1 paths", async () => {
  const calls = [];
  const engine = async (path, body) => {
    calls.push({ path, body });
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/info") return { version: "2.1.4" };
    if (url.pathname === "/api/session/ses_fixture/message") {
      if(url.searchParams.has("cursor"))assert.equal(url.searchParams.has("order"),false);
      return url.searchParams.has("cursor")
        ? { data: [{ id: "second", type: "assistant" }], cursor: {} }
        : { data: [{ id: "first", type: "user" }], cursor: { next: "page-2" } };
    }
    if (url.pathname === "/api/session")
      return { data: [{ id: "ses_child" }], cursor: {} };
    if (url.pathname === "/api/session/active")
      return { data: { ses_fixture: { type: "running" } } };
    if (url.pathname === "/api/session/ses_fixture/inbox")
      return { data: [{ id: "queued-native-input", type: "user" }] };
    if (url.pathname.startsWith("/api/rpc/")) throw new Error("Public RPC must remain blocked");
    if (url.pathname === "/api/skill")
      return { data: [{ name: "Complete skill", content: "full content" }] };
    return { data: [] };
  };
  let observerCalls = 0;
  const observerCatalog = async () => { observerCalls++; return {
    observer: { id: "legalwork-benchmark-observer", mutatesEngine: false }, schemaCoverage: "complete",
    tools: [{ id: "source", name: "read", input: { type: "object", $defs: { Complete: { type: "string" } } } }],
  }; };
  const protocol = await detectEngineProtocol({ engine, observerCatalog }, "/private/synthetic");
  assert.equal(protocol.id, "native-v2");
  assert.deepEqual(
    (await protocol.messages("ses_fixture")).map((message) => message.id),
    ["first", "second"],
  );
  assert.equal((await protocol.sessions("ses_fixture"))[0].id, "ses_child");
  assert.equal(protocol.isBusy(await protocol.active(), "ses_fixture"), true);
  assert.equal((await protocol.inbox("ses_fixture"))[0].id,"queued-native-input");
  assert.equal(
    (await protocol.catalogs()).toolCatalog.tools[0].input.$defs.Complete.type,
    "string",
  );
  assert.equal(observerCalls, 1);
  assert.ok(calls.every(call => !call.path.startsWith("/api/rpc/")));
  await protocol.skills();
  const catalogCall = calls.find((call) => call.path.startsWith("/api/skill?"));
  assert.equal(
    new URL(catalogCall.path, "http://fixture").searchParams.get(
      "location[directory]",
    ),
    "/private/synthetic",
  );
  assert.ok(calls.every((call) => call.path.startsWith("/api/")));
  assert.ok(
    calls.every(
      (call) => !new URL(call.path, "http://fixture").searchParams.has("limit"),
    ),
  );
});

test("queued native descendants remain unsettled without a running entry", async () => {
  const protocol = {
    active: async () => ({root:{type:"running"}}),
    inbox: async (id) => id === "child" ? [{id:"accepted-not-running"}] : [],
    isBusy: (active,id) => active[id]?.type === "running",
  };
  const activity = await observeSessionActivity(protocol,new Set(["root","child","finished"]));
  assert.deepEqual(activity.unsettledSessionIDs,["root","child"]);
  assert.deepEqual(activity.inboxBySessionID.child,[{id:"accepted-not-running"}]);
});

test("autonomous interaction observation retains full scoped requests and descendants without answering", async () => {
  const tail = "approval evidence ".repeat(20000) + "TAIL";
  const protocol = {
    sessions: async id => id === "root" ? [{id:"child"}] : [{id:"root"}],
    interactions: async () => ({
      permissions: [{id:"ask",sessionID:"child",action:"outside.read",resources:[tail]}, {id:"other",sessionID:"unrelated"}],
      forms: [{id:"form",sessionID:"root",fields:[{description:tail}]}],
      host: [{id:"host-child",sessionID:"child"},{id:"unattributed"},{id:"host-other",sessionID:"unrelated"}],
    }),
  };
  const ids = await sessionTreeIDs(protocol,"root");
  assert.deepEqual([...ids],["root","child"]);
  const pending = await observeSessionInteractions(protocol,ids);
  assert.equal(pending.permissions.length,1);
  assert.equal(pending.permissions[0].resources[0],tail);
  assert.equal(pending.forms[0].fields[0].description,tail);
  assert.deepEqual(pending.host.map(request=>request.id),["host-child","unattributed"]);
});

test("native and frozen v1 pending interactions use their actual read-only wire endpoints", async () => {
  for (const native of [true,false]) {
    const calls=[];
    const driver={pendingHostApprovals:async()=>[],engine:async path => {
      calls.push(path);
      const pathname=new URL(path,"http://fixture").pathname;
      if(pathname==="/api/info") {
        if(native)return {version:"2.1.4"};
        const error=new Error("not found");error.status=404;throw error;
      }
      if(pathname==="/global/health")return {healthy:true,version:"1.18.29"};
      if(["/api/permission/request","/permission"].includes(pathname))return native ? {data:[{sessionID:"root",id:"ask"}]}:[{sessionID:"root",id:"ask"}];
      if(["/api/form","/question"].includes(pathname))return native ? {data:[]} : [];
      throw new Error(`Unexpected endpoint ${path}`);
    }};
    const protocol=await detectEngineProtocol(driver,"/fixture");
    assert.deepEqual(await observeSessionInteractions(protocol,["root"]),{permissions:[{sessionID:"root",id:"ask"}],forms:[],host:[]});
    assert.ok(calls.some(path=>path.startsWith(native ? "/api/permission/request?" : "/permission")));
    assert.ok(calls.some(path=>path.startsWith(native ? "/api/form?" : "/question")));
  }
});

test("fallback requires endpoint absence, and native repeated cursor is an explicit evidence failure", async () => {
  await assert.rejects(
    () =>
      detectEngineProtocol(
        {
          engine: async () => {
            const error = new Error("unauthorized");
            error.status = 401;
            throw error;
          },
        },
        "/fixture",
      ),
    /unauthorized/,
  );
  const legacy = await detectEngineProtocol(
    {
      engine: async (path) => {
        if (path === "/api/info") {
          const error = new Error("not found");
          error.status = 404;
          throw error;
        }
        return { healthy: true, version: "1.18.29" };
      },
    },
    "/fixture",
  );
  assert.equal(legacy.id, "legacy-v1");
  assert.equal(legacy.eventPath, "/global/event");
  const htmlFallback = { engine: async path => {
    if(path === "/api/info") {const error=new Error("HTML application fallback");error.code="html-fallback-response";throw error;}
    return {healthy:true,version:"1.18.29"};
  }};
  assert.equal((await detectEngineProtocol(htmlFallback,"/fixture")).id,"legacy-v1");
  await assert.rejects(()=>detectEngineProtocol({engine:async path=> {
    if(path === "/api/info") {const error=new Error("HTML fallback");error.code="html-fallback-response";throw error;}
    return {healthy:true,version:"unknown"};
  }},"/fixture"),/supported healthy v1\/v2 engine/);
  const native = await detectEngineProtocol(
    {
      engine: async (path) =>
        path === "/api/info"
          ? { version: "2.1.4" }
          : { data: [], cursor: { next: "repeated" } },
    },
    "/fixture",
  );
  await assert.rejects(
    () => native.messages("ses_fixture"),
    /Repeated native page cursor/,
  );
});

test("native flat history keeps complete tool evidence, model usage, compaction and reminder metadata", () => {
  const tail = "full ".repeat(50000) + "TAIL-🔍";
  const usage = {
    input: 10,
    output: 4,
    reasoning: 2,
    cache: { read: 7, write: 3 },
  };
  const entries = [
    {
      id: "user",
      type: "user",
      text: "visible\n" + tail,
      metadata: {
        legalworkPrompt: { visibleText: "visible", reminders: [tail] },
      },
    },
    {
      id: "hidden",
      type: "synthetic",
      text: tail,
      metadata: { legalworkSystemReminder: true },
    },
    {
      id: "assistant",
      type: "assistant",
      model: { id: "fixture-model", providerID: "fixture", variant: "medium" },
      tokens: usage,
      cost: 0.2,
      content: [
        {
          type: "tool",
          id: "call",
          name: "legalwork_word_read",
          state: {
            status: "completed",
            input: { path: "full.docx" },
            content: [
              { type: "text", text: tail },
              { type: "file", uri: "file:///fixture/full.docx" },
            ],
            metadata: { retained: tail },
          },
        },
      ],
    },
    {
      id: "compact",
      type: "compaction",
      tokens: usage,
      cost: 0.1,
      content: [],
    },
  ];
  const summary = summarizeMessages(entries);
  assert.deepEqual(summary.totals, {
    input: 20,
    output: 8,
    reasoning: 4,
    cacheRead: 14,
    cacheWrite: 6,
  });
  assert.equal(summary.assistantMessages[0].variant, "medium");
  assert.equal(summary.tools[0].state.output, tail);
  assert.equal(
    summary.tools[0].state.content[1].uri,
    "file:///fixture/full.docx",
  );
  assert.equal(summary.tools[0].state.metadata.retained, tail);
  assert.equal(summary.auxiliaryModelMessages[0].id, "compact");
  assert.equal(
    summary.nativeHistory.promptMetadata[0].metadata.legalworkPrompt
      .reminders[0],
    tail,
  );
  assert.deepEqual(summary.nativeHistory.syntheticReminderIDs, ["hidden"]);
  assert.equal(summary.engineCostCurrency, "USD-declared-by-native-MoneyUSD");
  assert.throws(() => summarizeMessages([entries[2], entries[2]]), /Duplicate/);
  assert.deepEqual(
    engineEventIdentity({
      type: "session.tool.success",
      id: "evt",
      location: { directory: "/fixture" },
      data: { sessionID: "ses" },
      durable: { sequence: 2 },
    }),
    {
      protocol: "native-v2",
      type: "session.tool.success",
      id: "evt",
      created: null,
      sessionID: "ses",
      location: { directory: "/fixture" },
      durable: { sequence: 2 },
    },
  );
  assert.equal(
    skillCatalogIdentity([
      { name: "z", content: "Z" },
      { name: "a", content: tail },
    ]),
    skillCatalogIdentity([
      { name: "a", content: tail },
      { name: "z", content: "Z" },
    ]),
  );
});


test("native history attribution is exact-request provenance and rejects cross-session identities",async()=>{
 const {attributeSessionHistory}=await import("./engine-evidence.mjs");
 const {summarizeMessages}=await import("./evidence.mjs");
 const raw={type:"assistant",id:"same-message",content:[{type:"tool",id:"same-call",name:"read",state:{status:"completed",input:{path:"same"},content:[]}}]};
 const a=attributeSessionHistory([raw],"root"),b=attributeSessionHistory([raw],"child");
 assert.equal(raw.benchmarkRequestedSessionID,undefined);
 assert.deepEqual(summarizeMessages([...a,...b]).tools.map(call=>call.sessionID),["root","child"]);
 assert.throws(()=>attributeSessionHistory([{...raw,sessionID:"other"}],"root"),/conflicts/);
 assert.throws(()=>attributeSessionHistory(a,"other"),/conflicts/);
 assert.throws(()=>summarizeMessages([...a,...a]),/Duplicate/);
});
