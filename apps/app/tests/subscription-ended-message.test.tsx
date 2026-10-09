/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { hasEndedEigenweltSubscription, isEigenweltSubscriptionEndedErrorText } from "../src/app/lib/eigenwelt-subscription";
import { usageLimitFixture } from "../src/react-app/design-system/usage-limit-fixture";
import { eigenweltEntitlementsQueryKey } from "../src/react-app/domains/connections/eigenwelt-entitlements";
import { SubscriptionEndedMessage } from "../src/react-app/domains/connections/usage-control/subscription-ended-message";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { LANGUAGES, setLocale, t } from "../src/i18n";

afterEach(() => { getReactQueryClient().clear(); setLocale("en"); });

function render(role?: string, resolved = false) {
  setLocale("en");
  const fixture = usageLimitFixture("pro", role === "org:admin", "eigenwelt");
  if (!fixture.entitlements.account || !fixture.entitlements.entitlements) throw new Error("Expected a connected fixture");
  fixture.entitlements.account.orgRole = role;
  fixture.entitlements.entitlements.subscriptionStatus = "canceled";
  fixture.entitlements.entitlements.features = [];
  fixture.usage.enabled = false;
  const queryClient = getReactQueryClient();
  queryClient.setQueryData(eigenweltEntitlementsQueryKey(), fixture.entitlements);
  const client = createLegalworkServerClient({ baseUrl: "https://preview.invalid", token: "fixture" });
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>
    <SubscriptionEndedMessage client={client} workspaceId="fixture" resolved={resolved} onChoosePlan={async () => {}} />
  </QueryClientProvider>);
}

describe("inline subscription renewal", () => {
  test("admins get a neutral renewal action even after usage controls are disabled", () => {
    const html = render("org:admin");
    expect(html).toContain("Restart subscription");
    expect(html).toContain("Your chats and files are kept");
    expect(html).not.toContain("Ask your admin");
    expect(html).not.toContain("text-destructive");
    expect(html).not.toContain("border-red");
  });
  test("members get plain admin guidance without a button", () => {
    const html = render("org:member");
    expect(html).toContain("Ask your organization’s admin to restart");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Restart subscription");
  });
  test("older platforms with no role keep a route to billing", () => {
    expect(render()).toContain("View plans");
    expect(render()).not.toContain("Restart subscription");
  });
  test("historical errors with a later reply no longer offer renewal", () => {
    const html = render("org:admin", true);
    expect(html).toContain("LegalWork AI is available again");
    expect(html).not.toContain("Restart subscription");
  });
  test("recognizes saved expiry messages in either language, without treating model denials as expiry", () => {
    for (const language of LANGUAGES) {
      expect(isEigenweltSubscriptionEndedErrorText(t("ai_plans.title_ended", language))).toBe(true);
      expect(isEigenweltSubscriptionEndedErrorText(t("session_route.model_unavailable", language))).toBe(false);
    }
    const fixture = usageLimitFixture("pro", false, "eigenwelt");
    expect(hasEndedEigenweltSubscription(fixture.entitlements)).toBe(false);
    if (fixture.entitlements.entitlements) fixture.entitlements.entitlements.subscriptionStatus = "canceled";
    expect(hasEndedEigenweltSubscription(fixture.entitlements)).toBe(true);
    expect(hasEndedEigenweltSubscription({ ...fixture.entitlements, connected: false })).toBe(false);
  });
});
