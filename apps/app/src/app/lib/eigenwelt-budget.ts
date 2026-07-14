/**
 * Eigenwelt gateway budget-exceeded handling.
 *
 * The Eigenwelt gateway (LiteLLM) answers HTTP 429 with error type
 * `budget_exceeded` and a message containing "Budget has been exceeded" once a
 * firm's credits are used up. The engine treats that like any transient
 * provider error and retries with backoff forever. These helpers implement the
 * LegalWork policy on top of the engine's retry loop:
 *
 * - detection is gated on the failing request's provider being `eigenwelt`
 *   (all other providers and all other error kinds keep the default retry
 *   behavior),
 * - the engine gets at most {@link EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS}
 *   attempts, after which the app aborts the run and renders a terminal
 *   "credits used up" card pointing at the platform's top-up page.
 *
 * Everything in here is pure/registry state so it can be unit tested without
 * React or the engine.
 */

export const EIGENWELT_PROVIDER_ID = "eigenwelt";

/** Production platform top-up page, opened externally via `openDesktopUrl`. */
export const EIGENWELT_CREDITS_URL = "https://platform.eigenweltlabs.com/credits";

/** Stop the engine's retry loop after this many budget-exceeded attempts. */
export const EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS = 3;

export const EIGENWELT_BUDGET_EXCEEDED_TITLE = "Your firm's credits are used up";
export const EIGENWELT_BUDGET_EXCEEDED_BODY =
  "Top up your firm's balance to continue — usage resumes immediately.";
export const EIGENWELT_BUDGET_TOP_UP_LABEL = "Top up credits";

/**
 * Text of the synthetic terminal error message injected into the transcript
 * when the app stops a budget-exceeded retry loop. The chat renderer detects
 * this exact copy (via {@link isEigenweltBudgetExceededErrorText}) and swaps
 * the plain error block for the dedicated top-up card, so only stops the app
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
 * retries are still running, so the top-up button is available before the
 * run is stopped. Shape mirrors the engine's `SessionStatus` retry action.
 */
export function eigenweltBudgetRetryAction(): {
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
    title: "Out of credits?",
    message: EIGENWELT_BUDGET_EXCEEDED_BODY,
    label: EIGENWELT_BUDGET_TOP_UP_LABEL,
    link: EIGENWELT_CREDITS_URL,
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
