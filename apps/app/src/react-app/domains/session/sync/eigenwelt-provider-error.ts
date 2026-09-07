import { EIGENWELT_PROVIDER_ID } from "../../../../app/lib/eigenwelt-budget";
import { t } from "../../../../i18n";

/**
 * The gateway's answer when the key behind a request no longer exists
 * (LiteLLM's `token_not_found_in_db`): the sign-in on this device was
 * replaced or revoked. The only way out is signing in again, so the chat
 * should say that instead of echoing the raw 401 body.
 */
const SIGN_IN_EXPIRED_MARKERS = ["token_not_found_in_db", "Invalid proxy server token"];

export function isEigenweltSignInExpiredError(input: {
  status: number | null;
  provider: string | null;
  texts: Array<string | null | undefined>;
}): boolean {
  const mentionsDeadKey = input.texts.some(
    (text) => Boolean(text) && SIGN_IN_EXPIRED_MARKERS.some((marker) => text!.includes(marker)),
  );
  if (mentionsDeadKey) return true;
  return (input.status === 401 || input.status === 403) && input.provider === EIGENWELT_PROVIDER_ID;
}

export function eigenweltSignInExpiredMessage(): string {
  return t("app.error_eigenwelt_signin_expired");
}

/**
 * The gateway's answer when the firm's admin turned the requested model off
 * on the Eigenwelt platform (LiteLLM's `team_model_access_denied`, a 403).
 * Checked BEFORE the sign-in check: a 403 from the eigenwelt provider would
 * otherwise read as an expired sign-in.
 */
const MODEL_OFF_MARKERS = [
  "team_model_access_denied",
  "team not allowed to access model",
  "key not allowed to access model",
];

export function isEigenweltModelDisabledError(input: {
  texts: Array<string | null | undefined>;
}): boolean {
  return input.texts.some(
    (text) => Boolean(text) && MODEL_OFF_MARKERS.some((marker) => text!.includes(marker)),
  );
}

export function eigenweltModelDisabledMessage(): string {
  return t("app.error_eigenwelt_model_off");
}
