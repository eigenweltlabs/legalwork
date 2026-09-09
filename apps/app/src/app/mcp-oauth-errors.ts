import { t } from "@/i18n";

export type McpOAuthErrorKind =
  | "client_registration_required"
  | "invalid_client"
  | "oauth_unsupported"
  | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read error fields, including serialized SDK errors, without dumping request credentials. */
export function getMcpOAuthErrorMessage(error: unknown, fallback = t("mcp.auth.oauth_failed")): string {
  const messages = new Set<string>();
  const seen = new Set<object>();

  const collect = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      const message = value.trim();
      if (!message) return;
      if (message.startsWith("{") || message.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(message);
          collect(parsed, depth + 1);
          return;
        } catch {
          // Plain engine messages sometimes start with a bracket.
        }
      }
      messages.add(message);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    for (const field of ["error_description", "message", "cause", "data", "error", "body", "reason"]) {
      collect(value[field], depth + 1);
    }
  };

  collect(error, 0);
  return messages.size ? [...messages].join(": ") : fallback;
}

/** Provider-independent recovery choices. Invalid clients require setup, never an automatic logout. */
export function classifyMcpOAuthError(error: unknown): McpOAuthErrorKind {
  const message = getMcpOAuthErrorMessage(error, "").toLowerCase();
  if (
    message.includes("needs_client_registration") ||
    message.includes("client_registration_required") ||
    /requires (?:your firm's )?registered app credentials/.test(message) ||
    (message.includes("dynamic client registration") &&
      /does not support|not supported|unsupported|not allowed|not permitted|disabled|only pre-registered/.test(message))
  ) {
    return "client_registration_required";
  }
  if (/invalid[_ ]client|client[_ ]id.{0,30}mismatch/.test(message)) return "invalid_client";
  if (/does not support oauth|oauth (?:authentication )?(?:is )?not supported/.test(message)) {
    return "oauth_unsupported";
  }
  return "unknown";
}
