/**
 * A dead Eigenwelt key (LiteLLM "token_not_found_in_db": the sign-in on this
 * device was replaced or revoked) must surface as "sign in again", not as the
 * raw 401 body, on both chat error paths (request errors and session errors).
 */
import { describe, expect, test } from "bun:test";

import {
  eigenweltSignInExpiredMessage,
  isEigenweltSignInExpiredError,
} from "../src/react-app/domains/session/sync/eigenwelt-provider-error";
import { describeOpencodeSessionError } from "../src/react-app/domains/session/sync/usechat-adapter";

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

  test("treats any 401/403 from the eigenwelt provider as an expired sign-in", () => {
    expect(isEigenweltSignInExpiredError({ status: 401, provider: "eigenwelt", texts: [] })).toBe(true);
    expect(isEigenweltSignInExpiredError({ status: 403, provider: "eigenwelt", texts: [] })).toBe(true);
  });

  test("leaves other providers and other failures alone", () => {
    expect(isEigenweltSignInExpiredError({ status: 401, provider: "openai", texts: ["bad key"] })).toBe(false);
    expect(isEigenweltSignInExpiredError({ status: 429, provider: "eigenwelt", texts: ["slow down"] })).toBe(false);
    expect(isEigenweltSignInExpiredError({ status: null, provider: null, texts: [null, undefined] })).toBe(false);
  });
});

describe("describeOpencodeSessionError", () => {
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
    expect(text).toContain("Status: 401");
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
