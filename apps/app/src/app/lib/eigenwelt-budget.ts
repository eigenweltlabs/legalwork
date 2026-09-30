import { t } from "@/i18n";
/** Legacy Eigenwelt budget helpers and terminal markers retained for saved chats.
 * New provider quota failures are stopped on their first retry by session-sync.
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
export const EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS = 1;

// Functions, not consts: a module-scope t() would freeze the English copy at
// import time, before initLocale() has picked the language.
export const eigenweltBudgetExceededTitle = () => t("budget.exceeded_title");
export const eigenweltBudgetExceededBody = () => t("budget.exceeded_body");
export const eigenweltBudgetUpgradeLabel = () => t("budget.upgrade_label");

export type EigenweltBudgetPlan = "sync" | "plus" | "pro" | null;

/** Terminal-card copy when the weekly allowance is used up. Plus and Pro
 *  see the same copy (the plan param is kept for callers and future use). */
export function eigenweltBudgetLimitDisplay(_plan: EigenweltBudgetPlan): {
  title: string;
  body: string;
  upgradeLabel: string | null;
} {
  return {
    title: eigenweltBudgetExceededTitle(),
    body: eigenweltBudgetExceededBody(),
    upgradeLabel: eigenweltBudgetUpgradeLabel(),
  };
}

/**
 * Text of the synthetic terminal error message injected into the transcript
 * when the app stops a budget-exceeded retry loop. The chat renderer detects
 * this exact copy (via {@link isEigenweltBudgetExceededErrorText}) and swaps
 * the plain error block for the dedicated upgrade card, for previously stored Eigenwelt failures.
 */
// Deliberately NOT translated. This string is written into a session's stored
// error text and matched back later to swap in the localized upgrade card. A
// localized sentinel would stop matching after a language switch, and the user
// would see this raw text instead of the card.
export const EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT =
  "Your seat's included usage for this week is used up." +
  " It resets next week. Your firm's billing shows this week's usage in detail.";

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

/** The stable prefix of {@link EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT}. */
const EIGENWELT_BUDGET_SENTINEL = "Your seat's included usage for this week is used up";

/** Matches only the copy injected by the budget stop path. */
export function isEigenweltBudgetExceededErrorText(text: string | null | undefined): boolean {
  return Boolean(text && text.includes(EIGENWELT_BUDGET_SENTINEL));
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
    title: t("budget.retry_title"),
    message: eigenweltBudgetExceededBody(),
    label: eigenweltBudgetUpgradeLabel(),
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
const pendingStops = new Map<string, { markedAt: number; errorText: string }>();

export function markEigenweltBudgetStop(sessionId: string, now: number = Date.now(), errorText: string = EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT): void {
  pendingStops.set(sessionId, { markedAt: now, errorText });
}

export function updateProviderUsageLimitStop(sessionId: string, errorText: string): void {
  const stop = pendingStops.get(sessionId);
  if (stop) stop.errorText = errorText;
}

/**
 * Returns true (once) when a budget stop was marked for the session within
 * the TTL. Consuming removes the mark so a later, unrelated session error is
 * not mislabeled.
 */
export function consumeEigenweltBudgetStop(sessionId: string, now: number = Date.now()): boolean {
  return consumeProviderUsageLimitStop(sessionId, now) !== null;
}

export function consumeProviderUsageLimitStop(sessionId: string, now: number = Date.now()): string | null {
  const stop = pendingStops.get(sessionId);
  if (!stop) return null;
  pendingStops.delete(sessionId);
  return now - stop.markedAt <= PENDING_STOP_TTL_MS ? stop.errorText : null;
}
