/** Permanent quota failures need user action; temporary throttling still retries. */
const QUOTA_PATTERN =
  /budget[_ ](?:has been )?exceeded|insufficient[_ ](?:quota|credits)|billing[_ ](?:hard[_ ])?limit|(?:credit|account) balance (?:is too low|is insufficient|exhausted)|(?:usage|subscription|spending|spend|monthly|weekly|daily)[_ ]limit[_ ](?:reached|exceeded)|subscription_sharing_usage_(?:limit_exceeded|unavailable)|(?:exceeded|reached|hit|exhausted).{0,40}(?:usage limit|usage quota|current quota|monthly budget)|(?:usage limit|usage quota|monthly budget).{0,30}(?:exceeded|reached|exhausted)|out of credits|not enough credits|no credits remaining/i;
const MARKER = "LegalWork provider usage limit: ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function apiErrorData(error: unknown) {
  if (!isRecord(error)) return null;
  return isRecord(error.data) ? error.data : error;
}

function responseBody(data: Record<string, unknown>) {
  if (data.type === "error" && isRecord(data.error)) return data;
  if (isRecord(data.responseBody)) return data.responseBody;
  if (typeof data.responseBody !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data.responseBody);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Anthropic's JSON discriminator and subscription headers, never message wording. */
export function isAnthropicUsageLimitError(error: unknown): boolean {
  const data = apiErrorData(error);
  if (!data) return false;
  const status = data.statusCode;
  if (status !== undefined && typeof status !== "number") return false;
  const body = responseBody(data);
  if (body?.type !== "error" || !isRecord(body.error)) return false;
  const type = body.error.type;
  // Mid-stream error events have no HTTP failure status (or retain HTTP 200).
  const streamed = status === undefined || status === 200;
  if (type === "billing_error") return streamed || status === 402;
  const details = body.error.details;
  if (isRecord(details) && details.error_code === "enforced_spend_limit_reached") {
    return (type === "invalid_request_error" && (streamed || status === 400))
      || (type === "rate_limit_error" && (streamed || status === 429));
  }
  if (type !== "rate_limit_error" || status !== 429 || !isRecord(data.responseHeaders)) return false;
  // Claude subscription limits share rate_limit_error with transient API throttling.
  return Object.entries(data.responseHeaders).some(([name, value]) =>
    name.toLowerCase() === "anthropic-ratelimit-unified-status" && value === "rejected",
  );
}

export function isProviderUsageLimitError(
  error: unknown,
  providerId?: string,
): boolean {
  const data = apiErrorData(error);
  const body = data && responseBody(data);
  // A typed Anthropic response is authoritative, including a negative result.
  if (providerId === "anthropic" || body?.type === "error") {
    return isAnthropicUsageLimitError(error);
  }
  const message = typeof error === "string" ? error : data?.message;
  return typeof message === "string" && QUOTA_PATTERN.test(message);
}

export function usageLimitRetryEvent(properties: unknown) {
  if (!isRecord(properties) || typeof properties.sessionID !== "string") return null;
  return { sessionId: properties.sessionID, error: properties.error };
}

export function providerUsageLimitErrorText(providerId: string): string {
  return MARKER + encodeURIComponent(providerId);
}

export function providerFromUsageLimitError(
  error: string | null | undefined,
): string | null {
  if (!error?.startsWith(MARKER)) return null;
  try {
    return decodeURIComponent(error.slice(MARKER.length));
  } catch {
    return null;
  }
}

export function usageLimitOptions(plan: "sync" | "plus" | "pro" | null) {
  const plans: Array<"plus" | "pro"> =
    plan === "pro" ? [] : plan === "plus" ? ["pro"] : ["plus", "pro"];
  return { plans, topUp: plan !== null };
}
