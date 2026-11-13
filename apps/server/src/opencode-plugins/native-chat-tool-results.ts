import type { Plugin } from "@opencode/plugin";
import { chatToolResult } from "../native-shared-values.js";

/** Keep UI results independent of what a Code Mode script chooses to return. */
export async function registerChatToolResults(ctx: Plugin.Context) {
  const executions = new Map<string, { calls: number; results: Array<{ tool: string; input: unknown; output: unknown }> }>();
  const key = (event: { sessionID: string; messageID: string; id: string }) => `${event.sessionID}:${event.messageID}:${event.id}`;
  await ctx.tool.hook("execute.before", event => {
    if (event.tool === "execute") {
      executions.set(key(event), { calls: 0, results: [] });
      return;
    }
    const execution = executions.get(key(event));
    if (!execution) return;
    const previous = execution.calls++;
    if (event.tool === "legalwork_assistant_react" && previous !== 0)
      throw new Error("A reaction must be your first action. Continue normally without adding one now.");
  });
  await ctx.tool.hook("execute.after", event => {
    const execution = executions.get(key(event));
    if (!execution) return;
    if (event.tool === "execute") {
      executions.delete(key(event));
      if (event.status === "completed") event.result = { ...event.result, metadata: {
        ...event.result.metadata, legalworkToolResults: execution.results,
      } };
      return;
    }
    if (event.status !== "completed") return;
    const output = chatToolResult(event.tool, event.input, event.result.output);
    if (output !== undefined) execution.results.push({ tool: event.tool, input: event.input, output });
  });
  return () => executions.clear();
}
