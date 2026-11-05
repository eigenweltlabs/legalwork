import { afterEach, describe, expect, test } from "bun:test";
import { registerAppStateReminders } from "./native-app-state-reminders.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

async function reminderRuntime(state: { value: string | null }, runtime = nativePluginTestRuntime()) {
  const reads: Array<{ sessionID: string; directory: string }> = [];
  stops.push(await registerAppStateReminders(runtime.ctx, { topic: "sidebar", cleared: "No document is open.",
    read: async (sessionID, directory) => { reads.push({ sessionID, directory }); return state.value; } }));
  return { runtime, reads };
}

async function prompt(runtime: ReturnType<typeof nativePluginTestRuntime>, sessionID = "ses_1") {
  await runtime.hook("session", "prompt", { sessionID, messageID: "msg_user", prompt: { text: "Review the current document" }, delivery: "steer" });
}

describe("native app context durability", () => {
  test("admits chronological state without changing the user's prompt or a system prefix", async () => {
    const state = { value: "NDA.docx is open" }, { runtime, reads } = await reminderRuntime(state);
    const incoming = { sessionID: "ses_1", messageID: "msg_user", prompt: { text: "Review the current document" }, delivery: "steer" };
    await runtime.hook("session", "prompt", incoming);
    expect(incoming.prompt.text).toStartWith("Review the current document\n\n");
    expect(runtime.prompts).toMatchObject([{ sessionID: "ses_1", text: expect.stringContaining("NDA.docx is open"),
      metadata: { legalworkPrompt: { visibleText: "Review the current document", reminders: [expect.stringContaining("NDA.docx is open")] }, legalworkSystemReminders: { sidebar: "NDA.docx is open" } } }]);
    expect(reads).toEqual([{ sessionID: "ses_1", directory: "/Users/lawyer/Matter" }]);
    await prompt(runtime);
    expect(runtime.prompts[1]?.text).toBe("Review the current document");
    runtime.move("/Users/lawyer/Other");
    state.value = "Other.docx is open";
    await prompt(runtime);
    expect(reads.at(-1)?.directory).toBe("/Users/lawyer/Other");
    expect(runtime.prompts).toHaveLength(3);
  });

  test("reconstructs the latest state from durable history after a fresh plugin instance", async () => {
    const state = { value: "NDA.docx is open" }, { runtime: first } = await reminderRuntime(state);
    await prompt(first);
    const second = nativePluginTestRuntime();
    second.histories.set("ses_1", [...first.histories.get("ses_1") ?? []]);
    await reminderRuntime(state, second);
    await prompt(second);
    expect(second.prompts[0]?.text).toBe("Review the current document");
    state.value = "Budget.xlsx is open";
    await prompt(second);
    expect(second.prompts).toHaveLength(2);
    expect(second.prompts[1]?.text).toContain("Budget.xlsx");
  });

  test("reports a change once across parallel results and keeps files and metadata", async () => {
    const state = { value: "NDA.docx is open" }, { runtime } = await reminderRuntime(state);
    await prompt(runtime);
    state.value = "Budget.xlsx is open";
    const first = { sessionID: "ses_1", status: "completed", result: { content: [{ type: "file", uri: "data:image/png;base64,YQ==", mime: "image/png" }], metadata: { card: "preview" } } };
    const second = { sessionID: "ses_1", status: "completed", result: { content: "other result" } };
    await Promise.all([runtime.hook("tool", "execute.after", first), runtime.hook("tool", "execute.after", second)]);
    expect(first.result.content).toMatchObject([{ type: "text", text: expect.stringContaining("Budget.xlsx") }, { type: "file", mime: "image/png" }]);
    expect(first.result.metadata).toMatchObject({ card: "preview", legalworkSystemReminders: { sidebar: "Budget.xlsx is open" } });
    expect(second.result.content).toBe("other result");
  });

  test("an unavailable state check is not a disconnect, and a real clear is durable", async () => {
    const state: { value: string | null } = { value: "NDA.docx is open" }, { runtime } = await reminderRuntime(state);
    await prompt(runtime);
    state.value = null;
    await prompt(runtime);
    expect(runtime.prompts[1]?.text).toBe("Review the current document");
    state.value = "";
    await prompt(runtime);
    expect(runtime.prompts[2]?.text).toContain("No document is open.");
    await prompt(runtime);
    expect(runtime.prompts[3]?.text).toBe("Review the current document");
  });

  test("failed admission does not mark a reminder delivered or prevent a retry", async () => {
    const state = { value: "NDA.docx is open" }, { runtime } = await reminderRuntime(state);
    const failure = new Error("Storage unavailable");
    let fail = true;
    await runtime.ctx.session.hook("prompt", () => { if (fail) throw failure; });
    await expect(prompt(runtime)).rejects.toBe(failure);
    expect(runtime.prompts).toHaveLength(0);
    fail = false;
    await prompt(runtime);
    expect(runtime.prompts).toHaveLength(1);
  });

  test("reasserts current state after compaction and reloads history after a revert", async () => {
    const state = { value: "NDA.docx is open" }, { runtime } = await reminderRuntime(state);
    await prompt(runtime);
    const original = [...runtime.histories.get("ses_1") ?? []];
    runtime.histories.get("ses_1")?.push({ type: "compaction", id: "msg_compact", status: "completed", summary: "Document review" });
    await runtime.event({ type: "session.compaction.ended", data: { sessionID: "ses_1" } });
    await prompt(runtime);
    expect(runtime.prompts).toHaveLength(2);
    state.value = "Budget.xlsx is open";
    await prompt(runtime);
    runtime.histories.set("ses_1", original);
    await runtime.event({ type: "session.revert.committed", data: { sessionID: "ses_1", to: "msg_user" } });
    await prompt(runtime);
    expect(runtime.prompts).toHaveLength(4);
    expect(runtime.prompts.at(-1)?.text).toContain("Budget.xlsx");
  });
});

test("Code Mode child outputs retain exact JSON while state is published once on the durable outer result",async()=>{
  const state={value:"NDA.docx is open"},{runtime}=await reminderRuntime(state);await prompt(runtime);
  await runtime.hook("tool","execute.before",{tool:"execute",sessionID:"ses_1",messageID:"assistant",id:"parent"});
  state.value="Budget.xlsx is open";
  const child={tool:"legalwork_word_save",sessionID:"ses_1",messageID:"assistant",id:"child",status:"completed",result:{content:'{"ok":true}',output:{ok:true},metadata:{revision:2}}};
  await runtime.hook("tool","execute.after",child);expect(child.result).toEqual({content:'{"ok":true}',output:{ok:true},metadata:{revision:2}});
  const outer={tool:"execute",sessionID:"ses_1",messageID:"assistant",id:"parent",status:"completed",result:{content:"Done",output:{output:"Done",toolCalls:[],files:[]}}};
  await runtime.hook("tool","execute.after",outer);expect(JSON.stringify(outer.result.content)).toContain("Budget.xlsx is open");expect(outer.result.output).toEqual({output:"Done",toolCalls:[],files:[]});
  const unchanged={tool:"read",sessionID:"ses_1",messageID:"assistant",id:"later",status:"completed",result:{content:"read"}};await runtime.hook("tool","execute.after",unchanged);expect(unchanged.result.content).toBe("read");
});

test("Code Mode failures release deferral so later tool results can report current state",async()=>{
  const state={value:"NDA.docx is open"},{runtime}=await reminderRuntime(state);await prompt(runtime);
  await runtime.hook("tool","execute.before",{tool:"execute",sessionID:"ses_1",messageID:"assistant",id:"parent"});
  await runtime.hook("tool","execute.after",{tool:"execute",sessionID:"ses_1",messageID:"assistant",id:"parent",status:"error",error:new Error("denied")});state.value="Another.docx is open";
  const later={tool:"read",sessionID:"ses_1",messageID:"assistant",id:"later",status:"completed",result:{content:"read"}};await runtime.hook("tool","execute.after",later);expect(JSON.stringify(later.result.content)).toContain("Another.docx is open");
});

test("imported legacy reminders deduplicate through synthetic text without migrated metadata", async () => {
  const state = { value: "NDA.docx is open" };
  const runtime = nativePluginTestRuntime();
  runtime.histories.set("ses_1", [{ type: "synthetic", id: "msg_imported", text: '<system-reminder topic="sidebar">\nNDA.docx is open\n</system-reminder>', time: { created: 1 } }]);
  await reminderRuntime(state, runtime);
  await prompt(runtime);
  expect(runtime.prompts[0]?.text).toBe("Review the current document");
  state.value = "Budget.xlsx is open";
  await prompt(runtime);
  expect(runtime.prompts[1]?.text).toContain("Budget.xlsx is open");
});
