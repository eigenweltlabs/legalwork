import type { DynamicToolUIPart, TextUIPart } from "ai";
import type { ToolPart } from "@/app/lib/opencode-view";
import { ViewPreviewSchema } from "@legalwork/types/views";
import { codeModeWidgetResults } from "@legalwork/types/chat-tool-results";

import { safeStringify } from "@/app/utils";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** App-state reminders belong to model history, not a JSON widget's payload. */
export function widgetOutput(output: string): string {
  const start = output.indexOf('\n\n<system-reminder topic="');
  if (start < 0) return output;
  const payload = output.slice(0, start);
  const reminders = output.slice(start);
  if (!/^(?:\n\n<system-reminder topic="[^"\r\n]+">\n[\s\S]*?\n<\/system-reminder>)+\s*$/.test(reminders)) return output;
  try { JSON.parse(payload); return payload; }
  catch { return output; }
}

export function parseDynamicToolUIParts(part: ToolPart): DynamicToolUIPart[] {
  const mapped = parseDynamicToolUIPart(part);
  if (!mapped) return [];
  if (part.tool !== "execute" || part.state.status !== "completed") return [mapped];
  const widgets = codeModeWidgetResults(part.callID, part.state.metadata, part.state.output);
  if (!widgets.length) return [mapped];
  const cards: DynamicToolUIPart[] = widgets.map(widget => ({
    type: "dynamic-tool", toolName: widget.tool, toolCallId: widget.callId, input: widget.input,
    state: "output-available", output: JSON.stringify(widget.output),
    callProviderMetadata: { opencode: { partId: part.id, codeModeCallId: part.callID } },
  }));
  return widgets[0].callId === part.callID ? cards : [mapped, ...cards];
}

function shouldDeferInProgressTool(part: ToolPart) {
  if (part.state.status === "completed" || part.state.status === "error") {
    return false;
  }

  if ((part.tool === "view_create" || part.tool === "view_update") && part.state.status === "pending") return false;
  return Object.keys(part.state.input).length === 0;
}

export function parseStructuredOutputUIPart(part: ToolPart): TextUIPart | null {
  if (part.state.status === "error") {
    return null;
  }

  const text = safeStringify(part.state.input);

  if (text === "{}" && part.state.status !== "completed") {
    return null;
  }

  return {
    type: "text",
    text,
    state: part.state.status === "completed" ? "done" : "streaming",
    providerMetadata: { opencode: { partId: `structured-output-${part.callID}`, toolPartId: part.id } },
  };
}

export function parseDynamicToolUIPart(part: ToolPart): DynamicToolUIPart | null {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    return null;
  }

  const metadata = "metadata" in part.state ? part.state.metadata : undefined;
  const childSessionId = part.tool === "subagent" ? metadata?.sessionID : part.tool === "task" ? metadata?.sessionId : undefined;
  const executedTools = part.tool === "execute" && Array.isArray(metadata?.toolCalls)
    ? metadata.toolCalls.flatMap((call: unknown) =>
        call && typeof call === "object" && "tool" in call && typeof call.tool === "string"
          && "status" in call && call.status === "completed" ? [call.tool] : [])
    : [];
  const toolNames = part.tool === "execute" && Array.isArray(metadata?.toolCalls)
    ? metadata.toolCalls.flatMap((call: unknown) =>
        call && typeof call === "object" && "tool" in call && typeof call.tool === "string"
          && "status" in call && typeof call.status === "string" && ["running", "completed", "error"].includes(call.status) ? [call.tool] : [])
    : [];
  const callProviderMetadata = { opencode: {
    partId: part.id,
    ...(executedTools.length ? { executedTools } : {}),
    ...(toolNames.length ? { toolNames } : {}),
    ...((part.tool === "view_create" || part.tool === "view_update") && part.state.status === "pending" && part.state.raw ? { rawInput: part.state.raw.slice(0, 200_000) } : {}),
    ...(typeof childSessionId === "string" ? { sessionId: childSessionId } : {}),
    ...((part.tool === "task" && metadata?.background === true || part.tool === "subagent" && metadata?.status === "running") ? { background: true } : {}),
  } };

  if (part.state.status === "error") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-error",
      input: part.state.input,
      errorText: part.state.error,
      callProviderMetadata,
    };
  }

  if (part.state.status === "completed") {
    const preview = part.tool === "view_create" || part.tool === "view_update"
      ? ViewPreviewSchema.safeParse(metadata?.legalworkViewPreview).data : undefined;
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-available",
      input: part.state.input,
      output: preview ?? widgetOutput(part.state.output),
      callProviderMetadata,
    };
  }

  // OpenCode emits pending/running tool parts with `{}` input before args
  // (e.g. filePath) are filled in. Skip UI until the next part.updated.
  if (shouldDeferInProgressTool(part)) {
    return null;
  }

  return {
    type: "dynamic-tool",
    toolName: part.tool,
    toolCallId: part.callID,
    state: "input-streaming",
    input: part.state.input,
    callProviderMetadata,
  };
}
