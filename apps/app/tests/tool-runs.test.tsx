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
