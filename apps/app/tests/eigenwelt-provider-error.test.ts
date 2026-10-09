/**
 * A dead Eigenwelt key (LiteLLM "token_not_found_in_db": the sign-in on this
 * device was replaced or revoked) must surface as "sign in again", not as the
 * raw 401 body, on both chat error paths (request errors and session errors).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { eigenweltEntitlementsQueryKey, eigenweltEntitlementsQueryOptions } from "../src/react-app/domains/connections/eigenwelt-entitlements";
import { createLegalworkServerClient, type EigenweltEntitlementsView } from "../src/app/lib/legalwork-server";
import { aiAccessState } from "../src/app/lib/eigenwelt-access";
import { t } from "../src/i18n";

afterEach(() => getReactQueryClient().clear());

import {
  eigenweltModelDisabledMessage,
  eigenweltSignInExpiredMessage,
  isEigenweltModelDisabledError,
  isEigenweltSignInExpiredError,
} from "../src/react-app/domains/session/sync/eigenwelt-provider-error";
import { describeOpencodeSessionError } from "../src/react-app/domains/session/sync/usechat-adapter";

const LITELLM_MODEL_OFF_BODY =
  '{"error":{"message":"team not allowed to access model. This team can only access models=[\'Eigenwelt Europe\']. Tried to access Eigenwelt US","type":"team_model_access_denied","param":"model","code":"403"}}';

describe("isEigenweltModelDisabledError", () => {
  test("recognizes the gateway's team_model_access_denied body", () => {
    expect(isEigenweltModelDisabledError({ texts: [LITELLM_MODEL_OFF_BODY] })).toBe(true);
    expect(isEigenweltModelDisabledError({ texts: [null, "key not allowed to access model"] })).toBe(true);
    expect(isEigenweltModelDisabledError({ texts: [LITELLM_DEAD_KEY_BODY, undefined] })).toBe(false);
  });

  test("an access denial does not blame sign-in or an administrator without current account state", () => {
    const text = describeOpencodeSessionError({
      name: "APIError",
      message: LITELLM_MODEL_OFF_BODY,
      statusCode: 403,
      providerID: "eigenwelt",
    });
    expect(text).toBe(t("session_route.model_unavailable"));
    expect(text).not.toContain(eigenweltSignInExpiredMessage());
    expect(text).not.toContain("team_model_access_denied");
    expect(describeOpencodeSessionError(new Error(LITELLM_MODEL_OFF_BODY))).toBe(
      t("session_route.model_unavailable"),
    );
  });
});

const LITELLM_DEAD_KEY_BODY =
  '{"error":{"message":"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...qrtQ, Key Hash (Token) =bfc5. Unable to find token in cache or `LiteLLM_VerificationTokenTable`","type":"token_not_found_in_db","param":"key","code":"401"}}';

describe("isEigenweltSignInExpiredError", () => {
  test("recognizes LiteLLM's dead-key body wherever it appears", () => {
    expect(
      isEigenweltSignInExpiredError({ status: null, provider: null, texts: [LITELLM_DEAD_KEY_BODY] }),
    ).toBe(true);
    expect(
      isEigenweltSignInExpiredError({
        status: null,
        provider: null,
        texts: [null, "Invalid proxy server token passed"],
      }),
    ).toBe(true);
  });

  test("only a 401 from the eigenwelt provider means the sign-in expired", () => {
    expect(isEigenweltSignInExpiredError({ status: 401, provider: "eigenwelt", texts: [] })).toBe(true);
    expect(isEigenweltSignInExpiredError({ status: 403, provider: "eigenwelt", texts: [] })).toBe(false);
  });

  test("leaves other providers and other failures alone", () => {
    expect(isEigenweltSignInExpiredError({ status: 401, provider: "openai", texts: ["bad key"] })).toBe(false);
    expect(isEigenweltSignInExpiredError({ status: 429, provider: "eigenwelt", texts: ["slow down"] })).toBe(false);
    expect(isEigenweltSignInExpiredError({ status: null, provider: null, texts: [null, undefined] })).toBe(false);
  });
});

describe("describeOpencodeSessionError", () => {
  test("renders request-size errors without the gateway HTML body", () => {
    const error = { name: "APIError", data: { message: "Request Entity Too Large", statusCode: 413, responseBody: "<html><body>413 Request Entity Too Large nginx/1.27.5</body></html>" } };
    const text = describeOpencodeSessionError(error);
    expect(text).toContain("Compact the conversation");
    expect(text).not.toContain("<html>");
    expect(text).not.toContain("nginx");
    expect(describeOpencodeSessionError(new Error("413 Request Entity Too Large"))).toBe(text);
  });
  test("replaces the raw 401 body with the sign-in-again message", () => {
    const text = describeOpencodeSessionError({
      name: "ProviderAuthError",
      data: {
        providerID: "eigenwelt",
        message: "Provider authentication failed",
        statusCode: 401,
        responseBody: LITELLM_DEAD_KEY_BODY,
      },
    });
    expect(text.startsWith(eigenweltSignInExpiredMessage())).toBe(true);
    expect(text).not.toContain("token_not_found_in_db");
    expect(text).not.toContain("LiteLLM_VerificationTokenTable");
    expect(text).not.toContain("Status: 401");
  });

  test("handles the body arriving as a plain Error message", () => {
    const text = describeOpencodeSessionError(new Error(`Request failed - Response: ${LITELLM_DEAD_KEY_BODY}`));
    expect(text).toBe(eigenweltSignInExpiredMessage());
  });

  test("keeps unrelated provider errors verbatim", () => {
    const text = describeOpencodeSessionError({
      name: "ProviderError",
      data: { providerID: "openai", message: "Rate limit exceeded", statusCode: 429 },
    });
    expect(text).toContain("Rate limit exceeded");
    expect(text).not.toContain(eigenweltSignInExpiredMessage());
  });
});


describe("subscription expiry recovery", () => {
  function expiredAccount() {
    getReactQueryClient().setQueryData(eigenweltEntitlementsQueryKey(), {
      connected: true,
      platformURL: "https://platform.example.test",
      account: { orgName: "Example Firm" },
      entitlements: { plan: null, subscriptionStatus: "canceled", features: [], seats: 3 },
    });
  }

  test("a lapsed subscription is not blamed on sign-in or an administrator", () => {
    expiredAccount();
    const text = describeOpencodeSessionError({ name: "APIError", data: {
      message: "Forbidden", statusCode: 403, responseBody: LITELLM_MODEL_OFF_BODY,
    } }, "Session failed", "eigenwelt");
    expect(text).toContain(t("ai_plans.title_ended"));
    expect(text).toContain("Example Firm");
    expect(text).toContain("Restart a plan");
    expect(text).not.toContain(eigenweltSignInExpiredMessage());
    expect(text).not.toContain(eigenweltModelDisabledMessage());
    expect(text).not.toContain("403");
    expect(text).not.toContain("team_model_access_denied");
  });

  test("the same expiry is explained when OpenCode only sends a string", () => {
    expiredAccount();
    expect(describeOpencodeSessionError(new Error(LITELLM_MODEL_OFF_BODY))).toContain(t("ai_plans.title_ended"));
  });

  test("an unclassified Eigenwelt 403 does not tell the user to sign in again", () => {
    const text = describeOpencodeSessionError({ data: {
      message: "Forbidden", statusCode: 403, responseBody: "<html>403 Forbidden</html>",
    } }, "Session failed", "eigenwelt");
    expect(text).toBe(t("session_route.model_unavailable"));
  });

  test("a subscription-required response has renewal guidance", () => {
    const text = describeOpencodeSessionError({ data: {
      statusCode: 403, providerID: "eigenwelt", responseBody: '{"code":"subscription_required"}',
    } });
    expect(text).toContain(t("ai_plans.title_ended"));
    expect(text).not.toContain("subscription_required");
  });

  test("an unrelated provider keeps its own access error despite the expired Eigenwelt plan", () => {
    expiredAccount();
    const text = describeOpencodeSessionError({ data: {
      statusCode: 403, providerID: "openai", message: "Forbidden", responseBody: "OpenAI access denied",
    } });
    expect(text).toContain("OpenAI access denied");
    expect(text).not.toContain(t("ai_plans.title_ended"));
  });

  test("a denial refreshes a recently cached active plan and opens the ended-plan screen", async () => {
    const queryClient = getReactQueryClient();
    const account = { userId: "user_1", userName: null, userEmail: null, orgId: "org_1", orgName: "Example Firm" };
    const initial: EigenweltEntitlementsView = {
      connected: true, account, platformURL: "https://platform.example.test",
      entitlements: { plan: "pro", subscriptionStatus: "active", trialEndsAt: null, seats: 3,
        features: ["premium_models"],
        usage: { window: "week", allowanceCents: 100, remainingCents: 100, usedPercent: 0, resetsAt: null,
          dailyAllowanceCents: 100, dailyRemainingCents: 100, extraUsageEnabled: false, prepaidBalanceCents: 0 },
      },
    };
    const expired: EigenweltEntitlementsView = {
      ...initial,
      entitlements: initial.entitlements ? { ...initial.entitlements, plan: null, subscriptionStatus: "canceled", features: [] } : null,
    };
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      return Response.json(url.searchParams.get("refresh") === "1" ? expired : initial);
    } });
    const options = eigenweltEntitlementsQueryOptions({
      client: createLegalworkServerClient({ baseUrl: server.url.href }), workspaceId: "workspace_1",
    });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 60_000);
    queryClient.setQueryData(options.queryKey, initial);
    const observer = new QueryObserver(queryClient, options);
    let unsubscribe = () => {};
    try {
      const refreshed = new Promise<void>((resolve) => {
        unsubscribe = observer.subscribe((result) => {
          if (result.data?.entitlements?.subscriptionStatus === "canceled") resolve();
        });
      });
      const error = { statusCode: 403, providerID: "eigenwelt", responseBody: LITELLM_MODEL_OFF_BODY };
      describeOpencodeSessionError(error);
      describeOpencodeSessionError(error);
      await refreshed;
      expect(requests).toEqual(["/workspace/workspace_1/eigenwelt/entitlements?refresh=1"]);
      const view = queryClient.getQueryData<EigenweltEntitlementsView>(options.queryKey);
      expect(aiAccessState({ connectedProviders: [{ id: "eigenwelt", models: { claude: {} } }],
        eigenwelt: view, signedInBefore: true })).toBe("ended");
      expect(describeOpencodeSessionError(error)).toContain(t("ai_plans.title_ended"));
      expect(aiAccessState({ connectedProviders: [{ id: "openai", models: { gpt: {} } }],
        eigenwelt: view, signedInBefore: true })).toBe("ready");
    } finally {
      unsubscribe();
      clock.mockRestore();
      server.stop(true);
    }
  });
});
