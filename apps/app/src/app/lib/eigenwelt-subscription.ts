import type { EigenweltEntitlementsView } from "./legalwork-server";
import { isEigenweltEntitledStatus } from "./eigenwelt-trial";
import { LANGUAGES, t } from "@/i18n";

export function hasEndedEigenweltSubscription(view: EigenweltEntitlementsView | null | undefined): boolean {
  return Boolean(view?.connected && view.entitlements &&
    !isEigenweltEntitledStatus(view.entitlements.subscriptionStatus));
}

/** Saved chat errors can be in a different language from the current UI. */
export function isEigenweltSubscriptionEndedErrorText(error: string | null | undefined): boolean {
  return Boolean(error && LANGUAGES.some(language => error.startsWith(t("ai_plans.title_ended", language))));
}
