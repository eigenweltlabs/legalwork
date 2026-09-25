/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { getAssistantRenderGroups, groupAssistantToolRuns } from "../src/components/chat/utils";
import { ToolRun } from "../src/components/chat/tool-run";

const bash: DynamicToolUIPart = { type: "dynamic-tool", toolName: "bash", toolCallId: "shell-1", state: "output-available", input: { command: "python3 -c 'private code'", description: "A long generated description" }, output: "private output" };
const appTool: DynamicToolUIPart = { type: "dynamic-tool", toolName: "inapp_pptx_read", toolCallId: "app-1", state: "input-available", input: { path: "private/matter.pptx" } };
const reasoning: UIMessage["parts"][number] = { type: "reasoning", text: "private reasoning", state: "done" };
function messages(parts: UIMessage["parts"][]) {
  return parts.map((parts, index) => ({ index, message: { id: `m${index}`, role: "assistant", parts } satisfies UIMessage }));
}

test("groups mixed commands across message boundaries, including intervening reasoning", () => {
  const items = messages([[bash], [reasoning], [{ type: "step-start" }, appTool], [{ type: "text", text: "Done." }], [{ ...bash, toolCallId: "shell-2" }]]);
  for (const thinking of [false, true]) {
    const runs = groupAssistantToolRuns(items, thinking);
    expect(runs).toHaveLength(3);
    const groups = getAssistantRenderGroups(runs[0].message.parts, thinking);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("tools");
    expect(runs[1].message.parts).toEqual([{ type: "text", text: "Done." }]);
  }
  expect(items[0].message.parts).toEqual([bash]);
});

test("preserves prose whitespace and splits at files and real prose", () => {
  const file = { type: "file", filename: "draft.md", mediaType: "text/markdown", url: "draft.md" } satisfies UIMessage["parts"][number];
  const runs = groupAssistantToolRuns(messages([[bash, { type: "text", text: "Hello" }, { type: "text", text: " " }, { type: "text", text: "world" }, appTool, file, bash]]), false);
  expect(runs).toHaveLength(5);
  expect(getAssistantRenderGroups(runs[1].message.parts, false)[0]).toEqual({ kind: "text", text: "Hello world" });
});

test("expanded compact groups never render shell text, descriptions, arguments or output", () => {
  let detailedRenders = 0;
  const html = renderToStaticMarkup(<ToolRun defaultOpen parts={[bash, reasoning, appTool]} showDetails={false} renderTool={() => { detailedRenders++; return <pre>private details</pre>; }} />);
  expect(html).toContain("Running commands");
  expect(html).toContain("Ran command");
  expect(html).toContain("Pptx read");
  expect(html).not.toContain("private");
  expect(html).not.toContain("python");
  expect(html).not.toContain("generated description");
  expect(detailedRenders).toBe(0);
});

test("reasoning enables details within the same collapsible group", () => {
  const html = renderToStaticMarkup(<ToolRun defaultOpen parts={[bash, appTool]} showDetails renderTool={(part) => <pre>{JSON.stringify(part.input)}</pre>} />);
  expect(html).toContain("Running commands");
  expect(html).toContain("python3");
  expect(html).toContain("private/matter.pptx");
});

test("completed groups remain collapsible and closed by default", () => {
  const html = renderToStaticMarkup(<ToolRun parts={[bash]} showDetails={false} renderTool={() => <pre>hidden</pre>} />);
  expect(html).toContain("Ran commands");
  expect(html).toContain('aria-expanded="false"');
});
test("a live command run stays active between calls and keeps its key when streamed markers arrive", () => {
  const before = groupAssistantToolRuns(messages([[bash]]), false);
  const after = groupAssistantToolRuns(messages([[{ type: "step-start" }, reasoning, bash], [appTool]]), false);
  expect(after[0].message.id).toBe(before[0].message.id);
  expect(after[0].message.parts).toHaveLength(2);
  const between = renderToStaticMarkup(<ToolRun active parts={[bash]} showDetails={false} renderTool={() => null} />);
  expect(between).toContain("Running commands");
  expect(between).not.toContain("Ran commands");
});

test("project widgets remain visible outside collapsed tool activity, also after reloading history", () => {
  const project: DynamicToolUIPart = { ...bash, toolName: "legalwork_project_list", toolCallId: "project-1", output: "{}" };
  for (const thinking of [false, true]) {
    const runs = groupAssistantToolRuns(messages([[bash], [reasoning, project], [appTool]]), thinking);
    const groups = runs.flatMap((run) => getAssistantRenderGroups(run.message.parts, thinking));
    expect(groups.map((group) => group.kind)).toEqual(["tools", "project", "tools"]);
    expect(groups[1]).toEqual({ kind: "project", part: project });
  }
});

test("review creation and start share one visible card while unrelated commands stay collapsed", () => {
  const output = { ok: true, workspaceId: "project-1", review: { id: "101ec043-4ef0-4df7-88b6-4690869e8830", name: "NDA review", status: "draft", completed: 0, total: 2, documents: 2, columns: 1 } };
  const created: DynamicToolUIPart = { ...bash, toolName: "legalwork_review_create", toolCallId: "review-create", output };
  const started: DynamicToolUIPart = { ...created, toolName: "legalwork_review_start", toolCallId: "review-start", output: JSON.stringify({ ...output, review: { ...output.review, status: "running" } }) };
  for (const thinking of [false, true]) {
    const runs = groupAssistantToolRuns(messages([[bash, created], [reasoning, started], [appTool]]), thinking);
    const groups = runs.flatMap(run => getAssistantRenderGroups(run.message.parts, thinking));
    expect(groups.filter(group => group.kind === "review")).toEqual([{ kind: "review", part: started }]);
    expect(groups.filter(group => group.kind === "tools").flatMap(group => group.parts).filter(part => part.type !== "reasoning")).toEqual([bash, appTool]);
  }
});

test("a pending or failed review action remains visible instead of disappearing into command activity", () => {
  const pending: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_review_create", toolCallId: "review-create", state: "input-available", input: {} };
  const failed: DynamicToolUIPart = { ...pending, state: "output-error", errorText: "Choose compatible columns." };
  for (const part of [pending, failed]) expect(getAssistantRenderGroups([bash, part], false).at(-1)).toEqual({ kind: "review", part });
});
