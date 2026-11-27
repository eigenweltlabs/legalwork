import type { SessionMessageInfo } from "@opencode/client";

function errorKind(text: string, fallback: string, status?: number) {
  if (/model.{0,100}(?:not supported|unsupported|not found|not available)|(?:unsupported|unknown) model/i.test(text))
    return "model_unavailable_or_unsupported";
  if (/(?:not support|unsupported).{0,60}(?:tool calling|tools|image|pdf|attachment)|(?:tool calling|images?|pdf).{0,60}(?:not supported|unsupported)/i.test(text))
    return "model_capability_unsupported";
  if (status === 429 || /rate limit|too many requests/i.test(text)) return "rate_limited";
  if (/context length|context window|too many tokens/i.test(text)) return "context_limit";
  if (/invalid (?:input|arguments|parameters)|validation (?:error|failed)|schema mismatch/i.test(text)) return "invalid_tool_or_request_input";
  if (status === 401 || /unauthori[sz]ed|expired token|invalid api key/i.test(text)) return "provider_authentication";
  if (/ETIMEDOUT|ECONNREFUSED|network error|timed? out/i.test(text)) return "network_connection_or_timeout";
  return fallback;
}

/** Only technical fields from this chat reach the model. Error strings and logs can contain document text. */
export function summarizeChatDiagnostics(messages: readonly SessionMessageInfo[], logLines: readonly string[]) {
  const issues = messages.flatMap(message => {
    if (message.type !== "assistant") return [];
    const metadata = { time: message.time.created, provider: message.model.providerID, model: message.model.id };
    const errors = [
      ...(message.error ? [{ ...metadata, kind: errorKind(message.error.message, "model_error", message.error.status) }] : []),
      ...(message.retry ? [{ ...metadata, kind: errorKind(message.retry.error.message, "model_retry", message.retry.error.status) }] : []),
    ];
    const tools = message.content.flatMap(part => {
      if (part.type !== "tool" || part.state.status !== "error") return [];
      return [{ ...metadata, tool: part.name, kind: errorKind(part.state.error.message, "tool_error", part.state.error.status) }];
    });
    return [...errors, ...tools];
  }).slice(0, 16);
  return {
    issues,
    desktopLogSignals: [...new Set(logLines.map(line => errorKind(line, "")).filter(Boolean))],
  };
}
