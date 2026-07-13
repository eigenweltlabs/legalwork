/**
 * Eigenwelt FREE-tier daily-limit handling.
 *
 * Every install's free-tier key is budget-capped per day by the Eigenwelt
 * gateway (LiteLLM). Once the daily allowance is used up, the gateway answers
 * HTTP 429 with an error message containing "Budget has been exceeded". The
 * engine treats that like any transient provider error and retries with
 * backoff forever. These helpers implement the LegalWork policy on top of the
 * engine's retry loop:
 *
 * - detection is gated on the failing request's provider being
 *   `eigenwelt-free` (all other providers and all other error kinds keep the
 *   default retry behavior),
 * - the engine gets at most {@link EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS}
 *   attempts, after which the app aborts the run and renders a friendly
 *   terminal "daily limit reached" card pointing at the upgrade page.
 *
 * Everything in here is pure/registry state so it can be unit tested without
 * React or the engine.
 *
 * NOTE: this module deliberately mirrors (and stays independent of) the paid
 * branch's `eigenwelt-budget.ts` so the two can merge without collisions; a
 * shared refactor can happen once both are on the same branch.
 */

export const EIGENWELT_FREE_PROVIDER_ID = "eigenwelt-free";

/** Upgrade/contact page, opened externally via `openDesktopUrl`. */
export const EIGENWELT_FREE_UPGRADE_URL = "https://eigenweltlabs.com/contact";

/** Stop the engine's retry loop after this many budget-exceeded attempts. */
export const EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS = 3;

export const EIGENWELT_FREE_LIMIT_TITLE = "Daily free-model limit reached";
export const EIGENWELT_FREE_LIMIT_BODY =
  "You've used today's free allowance. Upgrade for higher limits — or come back tomorrow.";
export const EIGENWELT_FREE_UPGRADE_LABEL = "Upgrade";

/**
 * Text of the synthetic terminal error message injected into the transcript
 * when the app stops a daily-limit retry loop. The chat renderer detects this
 * exact copy (via {@link isEigenweltFreeLimitErrorText}) and swaps the plain
 * error block for the dedicated limit card, so only stops the app itself
 * gated on the eigenwelt-free provider ever render the card.
 */
export const EIGENWELT_FREE_LIMIT_ERROR_TEXT =
  `${EIGENWELT_FREE_LIMIT_TITLE}. ${EIGENWELT_FREE_LIMIT_BODY}`;

/** LiteLLM budget error marker (key-level daily budget: "Budget has been exceeded! Current cost: ... Max budget: ..."). */
const BUDGET_MESSAGE_PATTERN = /budget has been exceeded/i;

/**
 * True only when the failing request went through the Eigenwelt free tier AND
 * the error is LiteLLM's budget-exceeded. Any other provider (including the
 * paid `eigenwelt` provider) or error keeps the engine's default retry
 * behavior.
 */
export function isEigenweltFreeBudgetError(
  providerId: string | null | undefined,
  errorMessage: string | null | undefined,
): boolean {
  if (providerId !== EIGENWELT_FREE_PROVIDER_ID) return false;
  if (!errorMessage) return false;
  return BUDGET_MESSAGE_PATTERN.test(errorMessage);
}

/**
 * True once the engine has burned through the allowed budget-exceeded
 * attempts and the app must abort the run instead of letting it back off
 * forever.
 */
export function shouldStopEigenweltFreeBudgetRetry(
  providerId: string | null | undefined,
  errorMessage: string | null | undefined,
  attempt: number,
): boolean {
  if (!isEigenweltFreeBudgetError(providerId, errorMessage)) return false;
  return attempt >= EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS;
}

/** Matches only the copy injected by the daily-limit stop path. */
export function isEigenweltFreeLimitErrorText(text: string | null | undefined): boolean {
  return Boolean(text && text.includes(EIGENWELT_FREE_LIMIT_TITLE));
}

/**
 * Action block attached to the retry banner while the (up to 3) budget
 * retries are still running, so the upgrade button is available before the
 * run is stopped. Shape mirrors the engine's `SessionStatus` retry action.
 */
export function eigenweltFreeBudgetRetryAction(): {
  reason: string;
  provider: string;
  title: string;
  message: string;
  label: string;
  link?: string;
} {
  return {
    reason: "budget_exceeded",
    provider: EIGENWELT_FREE_PROVIDER_ID,
    title: "Out of free usage?",
    message: EIGENWELT_FREE_LIMIT_BODY,
    label: EIGENWELT_FREE_UPGRADE_LABEL,
    link: EIGENWELT_FREE_UPGRADE_URL,
  };
}

// ---------------------------------------------------------------------------
// Pending-stop registry
// ---------------------------------------------------------------------------
//
// The abort issued by the app makes the engine emit a `session.error` with a
// generic MessageAbortedError ("The message was interrupted"). The session
// surface marks the session here right before aborting; the event-sync layer
// consumes the mark and substitutes the daily-limit copy so the terminal
// message in the chat is the friendly limit card instead of the generic
// interrupt.

const PENDING_STOP_TTL_MS = 60_000;
const pendingStops = new Map<string, number>();

export function markEigenweltFreeBudgetStop(sessionId: string, now: number = Date.now()): void {
  pendingStops.set(sessionId, now);
}

/**
 * Returns true (once) when a daily-limit stop was marked for the session
 * within the TTL. Consuming removes the mark so a later, unrelated session
 * error is not mislabeled.
 */
export function consumeEigenweltFreeBudgetStop(sessionId: string, now: number = Date.now()): boolean {
  const markedAt = pendingStops.get(sessionId);
  if (markedAt === undefined) return false;
  pendingStops.delete(sessionId);
  return now - markedAt <= PENDING_STOP_TTL_MS;
}
