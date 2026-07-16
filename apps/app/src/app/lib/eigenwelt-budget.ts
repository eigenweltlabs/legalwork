/**
 * Eigenwelt gateway budget-exceeded handling.
 *
 * The Eigenwelt gateway (LiteLLM) answers HTTP 429 with error type
 * `budget_exceeded` and a message containing "Budget has been exceeded" once a
 * seat's daily usage is used up. The engine treats that like any transient
 * provider error and retries with backoff forever. These helpers implement the
 * LegalWork policy on top of the engine's retry loop:
 *
 * - detection is gated on the failing request's provider being `eigenwelt`
 *   (all other providers and all other error kinds keep the default retry
 *   behavior),
 * - the engine gets at most {@link EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS}
 *   attempts, after which the app aborts the run and renders a terminal
 *   "daily usage used up" card pointing at the platform's billing page.
 *
 * Everything in here is pure/registry state so it can be unit tested without
 * React or the engine.
 */

export const EIGENWELT_PROVIDER_ID = "eigenwelt";

/**
 * Prod fallback for the platform billing/upgrade page. The live URL is derived
 * from the *connected* platform origin at the render sites via
 * `eigenweltBillingUrl(eigenweltPremiumPlatformUrl())`; this default is only
 * used when no firm is connected yet (and by unit tests, which run headless).
 */
export const EIGENWELT_BILLING_URL_DEFAULT = "https://platform.eigenweltlabs.com/billing";

/** Stop the engine's retry loop after this many budget-exceeded attempts. */
export const EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS = 3;

export const EIGENWELT_BUDGET_EXCEEDED_TITLE = "Your seat's daily usage has been used up";
export const EIGENWELT_BUDGET_EXCEEDED_BODY =
  "Upgrade to Pro for higher limits, or come back tomorrow.";
export const EIGENWELT_BUDGET_UPGRADE_LABEL = "Upgrade to Pro";
export const EIGENWELT_PRO_LIMIT_TITLE = "Daily usage limit reached";
export const EIGENWELT_PRO_LIMIT_BODY = "You've used today's Pro allowance. Come back tomorrow.";

export type EigenweltBudgetPlan = "plus" | "pro" | null;

/** Plan-aware terminal-card copy. Pro is already the highest usage tier. */
export function eigenweltBudgetLimitDisplay(plan: EigenweltBudgetPlan): {
  title: string;
  body: string;
  upgradeLabel: string | null;
} {
  if (plan === "pro") {
    return {
      title: EIGENWELT_PRO_LIMIT_TITLE,
      body: EIGENWELT_PRO_LIMIT_BODY,
      upgradeLabel: null,
    };
  }
  return {
    title: EIGENWELT_BUDGET_EXCEEDED_TITLE,
    body: EIGENWELT_BUDGET_EXCEEDED_BODY,
    upgradeLabel: EIGENWELT_BUDGET_UPGRADE_LABEL,
  };
}

/**
 * Text of the synthetic terminal error message injected into the transcript
 * when the app stops a budget-exceeded retry loop. The chat renderer detects
 * this exact copy (via {@link isEigenweltBudgetExceededErrorText}) and swaps
 * the plain error block for the dedicated upgrade card, so only stops the app
 * itself gated on the eigenwelt provider ever render the card.
 */
export const EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT =
  `${EIGENWELT_BUDGET_EXCEEDED_TITLE}. ${EIGENWELT_BUDGET_EXCEEDED_BODY}`;

/** LiteLLM budget error marker (message looks like "Budget has been exceeded! ... Team=org_..."). */
const BUDGET_MESSAGE_PATTERN = /budget has been exceeded/i;

/**
 * True only when the failing request went through the Eigenwelt gateway AND
 * the error is LiteLLM's budget-exceeded. Any other provider or error keeps
 * the engine's default retry behavior.
 */
export function isEigenweltBudgetError(
  providerId: string | null | undefined,
  errorMessage: string | null | undefined,
): boolean {
  if (providerId !== EIGENWELT_PROVIDER_ID) return false;
  if (!errorMessage) return false;
  return BUDGET_MESSAGE_PATTERN.test(errorMessage);
}

/**
 * True once the engine has burned through the allowed budget-exceeded
 * attempts and the app must abort the run instead of letting it back off
 * forever.
 */
export function shouldStopEigenweltBudgetRetry(
  providerId: string | null | undefined,
  errorMessage: string | null | undefined,
  attempt: number,
): boolean {
  if (!isEigenweltBudgetError(providerId, errorMessage)) return false;
  return attempt >= EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS;
}

/** Matches only the copy injected by the budget stop path. */
export function isEigenweltBudgetExceededErrorText(text: string | null | undefined): boolean {
  return Boolean(text && text.includes(EIGENWELT_BUDGET_EXCEEDED_TITLE));
}

/**
 * Action block attached to the retry banner while the (up to 3) budget
 * retries are still running, so the upgrade button is available before the
 * run is stopped. Shape mirrors the engine's `SessionStatus` retry action.
 *
 * `billingUrl` is passed in by the (React) caller, resolved against the
 * connected platform origin; it falls back to the prod default so this pure
 * module stays free of React/connection imports.
 */
export function eigenweltBudgetRetryAction(billingUrl: string = EIGENWELT_BILLING_URL_DEFAULT): {
  reason: string;
  provider: string;
  title: string;
  message: string;
  label: string;
  link?: string;
} {
  return {
    reason: "budget_exceeded",
    provider: EIGENWELT_PROVIDER_ID,
    title: "Out of daily usage?",
    message: EIGENWELT_BUDGET_EXCEEDED_BODY,
    label: EIGENWELT_BUDGET_UPGRADE_LABEL,
    link: billingUrl,
  };
}

// ---------------------------------------------------------------------------
// Pending-stop registry
// ---------------------------------------------------------------------------
//
// The abort issued by the app makes the engine emit a `session.error` with a
// generic MessageAbortedError ("The message was interrupted"). The session
// surface marks the session here right before aborting; the event-sync layer
// consumes the mark and substitutes the budget-exceeded copy so the terminal
// message in the chat is the top-up card instead of the generic interrupt.

const PENDING_STOP_TTL_MS = 60_000;
const pendingStops = new Map<string, number>();

export function markEigenweltBudgetStop(sessionId: string, now: number = Date.now()): void {
  pendingStops.set(sessionId, now);
}

/**
 * Returns true (once) when a budget stop was marked for the session within
 * the TTL. Consuming removes the mark so a later, unrelated session error is
 * not mislabeled.
 */
export function consumeEigenweltBudgetStop(sessionId: string, now: number = Date.now()): boolean {
  const markedAt = pendingStops.get(sessionId);
  if (markedAt === undefined) return false;
  pendingStops.delete(sessionId);
  return now - markedAt <= PENDING_STOP_TTL_MS;
}
