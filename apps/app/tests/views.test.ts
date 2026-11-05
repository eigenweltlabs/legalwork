import { describe, expect, test } from "bun:test";
import { parsePartialJson } from "ai";
import { parseViewReference, viewLink, viewPanelTab } from "../src/react-app/domains/views/view-reference";
import { createPanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import type { ToolPart } from "../src/app/lib/opencode-view";
import { isLocalOpenUIProgram } from "@legalwork/openui/catalog";
import { viewSourceTab } from "../src/react-app/domains/views/view-source";

const viewId = "11111111-1111-4111-8111-111111111111";
describe("saved view references", () => {
  test("a bare ID needs an owner, explicit references survive links and tab restoration", () => {
    const owner = { kind: "wiki", id: "firm wiki" } satisfies NonNullable<ReturnType<typeof parseViewReference>>["owner"];
    expect(parseViewReference(viewId)).toBeNull();
    const reference = parseViewReference(viewId, owner)!;
    expect(parseViewReference(viewLink(reference))).toEqual(reference);
    expect(parseViewReference(`wiki:firm/${viewId}`)).toEqual({ owner: { kind: "wiki", id: "firm" }, viewId });
    const store = createPanelTabStore();
    const tab = viewPanelTab("http://localhost:4242", reference, "Client stages");
    store.getState().openTab("workspace:test", tab);
    store.getState().openTab("workspace:test", tab);
    store.getState().openTab("workspace:test", viewPanelTab("http://localhost:4242", reference));
    const layout = store.getState().sessions["workspace:test"];
    expect(layout.tabs).toHaveLength(1);
    expect(layout.tabs[0].label).toBe("Client stages");
    expect(store.getState().readLayout(JSON.parse(JSON.stringify(layout)))?.tabs).toEqual([tab]);
    expect(viewPanelTab("other-server", reference).id).not.toBe(tab.id);
  });
  test("rejects malformed IDs, external URLs and extra path components", () => {
    for (const value of ["https://example.com/view", "not-an-id", `wiki:x/${viewId}/extra`, `wiki:%ZZ/${viewId}`, `wiki:x/../../${viewId}`]) expect(parseViewReference(value)).toBeNull();
  });
});
test("only view tools preserve pending raw args, including incomplete program text", async () => {
  const raw = '{"input":{"title":"Test","program":"root = Text(\\"Hello';
  const part: ToolPart = { id: "part", messageID: "message", sessionID: "session", type: "tool", callID: "call", tool: "view_create", state: { status: "pending", input: {}, raw } };
  const ui = parseDynamicToolUIPart(part);
  expect(ui?.state).toBe("input-streaming");
  expect(ui?.callProviderMetadata?.opencode).toMatchObject({ rawInput: raw });
  expect((await parsePartialJson(raw)).value).toMatchObject({ input: { program: 'root = Text("Hello' } });
  expect(parseDynamicToolUIPart({ ...part, tool: "write" })).toBeNull();
});
test("cloud bundles, script declarations and mutation capabilities are not accepted", () => {
  expect(isLocalOpenUIProgram('root = Text("Hello")')).toBe(true);
  expect(isLocalOpenUIProgram('root = Text("Hel')).toBe(true);
  for (const program of ['{"program":"root = Text(1)","scripts":{}}', "<script>alert(1)</script>", 'root = Mutation("delete", {})', 'x = Script("foo")', "```openui\nroot = Text(1)"]) expect(isLocalOpenUIProgram(program)).toBe(false);
});
test("a project report's wiki dataset opens its original wiki source, never the report project", () => {
  const source = viewSourceTab("local", { kind: "wiki", id: "firm-knowledge" }, "Clients/Aster.md");
  expect(source).toMatchObject({ type: "wiki", wikiId: "firm-knowledge", location: { kind: "page", path: "Clients/Aster.md" } });
  const projectSource = viewSourceTab("local", { kind: "workspace", id: "project-aster" }, "Diligence.md");
  expect(projectSource).toMatchObject({ type: "artifact", sourceProject: { workspaceId: "project-aster", path: "Diligence.md" } });
  for (const path of ["../secret.md", "/etc/passwd", "https://example.com/x", "file:secret.md", "a\\b", "a/../b", "a\u0000.md"]) expect(viewSourceTab("local", { kind: "wiki", id: "firm" }, path)).toBeNull();
});

test("a generated view becomes the saved tab in its pane and draft tabs never restore", () => {
  const store = createPanelTabStore(), scope = "workspace:demo";
  const draft = { id: "view-generation:one", type: "view-draft", generationId: "view-generation:one", serverUrl: "local", label: "Generating…" } satisfies import("../src/react-app/domains/views/view-generation").ViewDraftTab;
  store.getState().openTab(scope, draft);
  const before = store.getState().sessions[scope];
  const saved = viewPanelTab("local", {owner:{kind:"wiki",id:"demo"},viewId}, "Client dashboard");
  store.getState().resolveViewTab(draft.id, saved);
  const after = store.getState().sessions[scope];
  expect(after.tabs).toEqual([saved]); expect(after.panes[0].id).toBe(before.panes[0].id); expect(after.panes[0].activeTabId).toBe(saved.id);
  expect(store.getState().readLayout(JSON.parse(JSON.stringify(before)))?.tabs ?? []).toEqual([]);
  expect(store.getState().readLayout(JSON.parse(JSON.stringify(after)))?.tabs).toEqual([saved]);
  store.getState().openTab(scope, draft); store.getState().resolveViewTab(draft.id, saved);
  expect(store.getState().sessions[scope].tabs).toEqual([saved]);
});
test("generation errors and malformed success output cannot become a saved report", async () => {
  const { viewToolOutcome, viewProgramInput, useViewGenerationStore, viewGenerationId } = await import("../src/react-app/domains/views/view-generation");
  expect(viewToolOutcome({ok:false,error:{message:"Permission denied"}})).toEqual({error:"Permission denied"});
  expect(viewToolOutcome("created something")).toEqual({error:"The agent did not return a preview."});
  const reminder = '\n\n<system-reminder topic="project-folders">\nFolders changed\n</system-reminder>';
  expect(viewToolOutcome(JSON.stringify({ok:false,error:{message:"Permission denied"}}) + reminder)).toEqual({error:"Permission denied"});
  for (const output of ['{"title":"Unfinished"', '{"title":"Missing saved record"}', 'created something', '{}\nUnexpected trailing text']) {
    expect(viewToolOutcome(output + reminder)).toEqual({error:"The agent did not return a preview."});
  }
  const raw = await parsePartialJson('{"input":{"title":"Client dashboard","program":"root = Text(\\"Client');
  expect(viewProgramInput(raw.value)).toEqual({title:"Client dashboard",program:'root = Text("Client'});
  const id = viewGenerationId("local", "session", "tool");
  useViewGenerationStore.getState().update(id, {serverUrl:"local",workspaceId:"demo",sessionId:"session",toolCallId:"tool",title:"Client dashboard",program:'root = Text("Client',status:"streaming"});
  useViewGenerationStore.getState().fail(id,"Generation cancelled");
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({status:"failed",error:"Generation cancelled"});
  expect(useViewGenerationStore.getState().entries[id].saved).toBeUndefined();
  expect(viewGenerationId("other", "session", "tool")).not.toBe(id);
});
test("view files have their own preview classification", async () => {
  const { classifyOpenTarget } = await import("../src/react-app/domains/session/artifacts/open-target");
  expect(classifyOpenTarget("Views/report.view.json", "file")).toBe("view");
  expect(classifyOpenTarget("renamed/CLIENT.VIEW.JSON", "file")).toBe("view");
  expect(classifyOpenTarget("ordinary.json", "file")).toBe("text");
});
test("updating an already-open view resolves in the generation pane without duplicate tabs", () => {
  const store = createPanelTabStore(), scope = "workspace:duplicates";
  const saved = viewPanelTab("local", {owner:{kind:"wiki",id:"demo"},viewId}, "Existing dashboard");
  const draft = {id:"draft:duplicate",type:"view-draft",generationId:"draft:duplicate",serverUrl:"local",label:"Updating"} satisfies import("../src/react-app/domains/views/view-generation").ViewDraftTab;
  store.getState().openTab(scope,saved);
  store.getState().openTab(scope,draft,"main","right");
  const draftPane = store.getState().sessions[scope].panes.find(pane=>pane.tabIds.includes(draft.id))!.id;
  store.getState().resolveViewTab(draft.id,saved);
  const session = store.getState().sessions[scope];
  expect(session.tabs).toEqual([saved]); expect(session.panes.find(pane=>pane.tabIds.includes(saved.id))?.id).toBe(draftPane);
});
