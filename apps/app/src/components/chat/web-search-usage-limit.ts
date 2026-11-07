import { isToolUIPart, type UIMessage } from "ai";
import { eigenweltUsageLimitFromText, providerUsageLimitErrorText } from "@legalwork/types/provider-usage-limit";

/** Search is billed to Eigenwelt even when the chat model comes from another provider. */
export function webSearchUsageLimitError(parts: UIMessage["parts"]) {
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const source = part.callProviderMetadata?.opencode;
    const search = part.type === "dynamic-tool" && part.toolName === "legalwork_websearch";
    const nested = part.type === "dynamic-tool" && part.toolName === "execute" && Array.isArray(source?.failedTools)
      && source.failedTools.includes("legalwork_websearch");
    if (!search && !nested) continue;
    // Native Code Mode completes its wrapper with failed-child metadata and
    // the child's error as output; the outer call need not be output-error.
    const text = part.state === "output-error" ? part.errorText
      : nested && part.state === "output-available" && typeof part.output === "string" ? part.output : null;
    const limit = eigenweltUsageLimitFromText(text);
    if (limit) return providerUsageLimitErrorText("eigenwelt", limit);
  }
  return null;
}
