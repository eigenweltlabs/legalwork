import type { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { chatToolResult } from "../native-shared-values.js";
import { usageLimitDetailsSchema, type UsageLimitDetails } from "../provider-usage-limit.js";

/** Keep UI results independent of what a Code Mode script chooses to return. */
export async function registerChatToolResults(ctx: Plugin.Context) {
  const executions = new Map<string, { calls: number; results: Array<{ tool: string; input: unknown; output: unknown }>; searchLimit?: UsageLimitDetails }>();
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
        // Null attests that no verified quota failure occurred. Script-authored
        // output cannot create a recovery card on newly recorded executions.
        legalworkWebSearchUsageLimit: execution.searchLimit ?? null,
      } };
      else event.error = new ToolError({ message: event.error.message, error: event.error.error,
        metadata: { ...event.error.metadata, legalworkWebSearchUsageLimit: execution.searchLimit ?? null } });
      return;
    }
    if (event.tool === "legalwork_websearch" && event.status === "error") {
      const limit = usageLimitDetailsSchema.safeParse(event.error.metadata?.legalworkWebSearchUsageLimit);
      if (limit.success) execution.searchLimit = limit.data;
    }
    if (event.status !== "completed") return;
    const output = chatToolResult(event.tool, event.input, event.result.output);
    if (output !== undefined) execution.results.push({ tool: event.tool, input: event.input, output });
  });
  return () => executions.clear();
}
