/** Permanent quota failures need user action; temporary throttling still retries. */
const QUOTA_PATTERN =
  /budget[_ ](?:has been )?exceeded|insufficient[_ ](?:quota|credits)|billing[_ ](?:hard[_ ])?limit|(?:credit|account) balance (?:is too low|is insufficient|exhausted)|(?:usage|subscription|spending|spend|monthly|weekly|daily)[_ ]limit[_ ](?:reached|exceeded)|subscription_sharing_usage_(?:limit_exceeded|unavailable)|(?:exceeded|reached|hit|exhausted).{0,40}(?:usage limit|usage quota|current quota|monthly budget)|(?:usage limit|usage quota|monthly budget).{0,30}(?:exceeded|reached|exhausted)|out of credits|not enough credits|no credits remaining/i;
const MARKER = "LegalWork provider usage limit: ";

export function isProviderUsageLimitError(
  error: string | null | undefined,
): boolean {
  return Boolean(error && QUOTA_PATTERN.test(error));
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
