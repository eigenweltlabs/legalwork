import { EIGENWELT_PROVIDER_ID } from "../../../../app/lib/eigenwelt-budget";
import { t } from "../../../../i18n";
import { isEigenweltEntitledStatus } from "../../../../app/lib/eigenwelt-trial";
import type { EigenweltEntitlementsView } from "../../../../app/lib/legalwork-server";
import { getReactQueryClient } from "../../../infra/query-client";
import {
  eigenweltEntitlementsQueryKey,
  refreshEigenweltEntitlementsAfterAccessError,
} from "../../connections/eigenwelt-entitlements";

type EigenweltProviderError = {
  status: number | null;
  provider: string | null;
  texts: Array<string | null | undefined>;
};

/**
 * The gateway's answer when the key behind a request no longer exists
 * (LiteLLM's `token_not_found_in_db`): the sign-in on this device was
 * replaced or revoked. The only way out is signing in again, so the chat
 * should say that instead of echoing the raw 401 body.
 */
const SIGN_IN_EXPIRED_MARKERS = ["token_not_found_in_db", "Invalid proxy server token"];

export function isEigenweltSignInExpiredError(input: EigenweltProviderError): boolean {
  const mentionsDeadKey = input.texts.some(
    (text) => Boolean(text) && SIGN_IN_EXPIRED_MARKERS.some((marker) => text!.includes(marker)),
  );
  if (mentionsDeadKey) return true;
  return input.status === 401 && input.provider === EIGENWELT_PROVIDER_ID;
}

export function eigenweltSignInExpiredMessage(): string {
  return t("app.error_eigenwelt_signin_expired");
}

/**
 * LiteLLM's model-access denial. A subscription lapse and an administrator
 * disabling the requested model produce the same markers.
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

/** A gateway allowlist denial cannot distinguish a disabled model from a
 * lapsed subscription. Use the account state and refresh it, rather than
 * blaming an administrator or asking a subscribed user to sign in again. */
export function eigenweltProviderRecoveryMessage(input: EigenweltProviderError): string | null {
  if (input.provider && input.provider !== EIGENWELT_PROVIDER_ID) return null;
  if (isEigenweltSignInExpiredError(input)) return eigenweltSignInExpiredMessage();

  const subscriptionRequired = input.texts.some((text) =>
    text?.includes("subscription_required") || text?.includes("subscription required"),
  );
  const accessDenied = subscriptionRequired || isEigenweltModelDisabledError(input) ||
    (input.status === 403 && input.provider === EIGENWELT_PROVIDER_ID);
  if (!accessDenied) return null;

  const view = getReactQueryClient().getQueryData<EigenweltEntitlementsView>(eigenweltEntitlementsQueryKey());
  const ended = view?.connected && view.entitlements &&
    !isEigenweltEntitledStatus(view.entitlements.subscriptionStatus);
  refreshEigenweltEntitlementsAfterAccessError();
  if (subscriptionRequired || ended) {
    return `${t("ai_plans.title_ended")} ${t("ai_plans.subtitle_ended", {
      firm: view?.account?.orgName ?? t("ai_plans.your_firm"),
    })}`;
  }
  return t("session_route.model_unavailable");
}
