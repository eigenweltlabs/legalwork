import { describe, expect, test } from "bun:test";
import { isAnthropicUsageLimitError, isProviderUsageLimitError, providerFromUsageLimitError } from "../src/app/lib/provider-usage-limit";
import { describeOpencodeSessionError, snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";

function apiError(statusCode: number, type: string, options: {
  code?: string;
  headers?: Record<string, string>;
  message?: string;
} = {}) {
  return {
    name: "APIError",
    data: {
      statusCode,
      message: options.message ?? "Provider wording may change or be translated.",
      isRetryable: statusCode === 429,
      responseHeaders: options.headers,
      responseBody: JSON.stringify({
        type: "error",
        error: { type, message: options.message, details: { error_code: options.code } },
      }),
    },
  };
}

describe("structured Anthropic usage recovery", () => {
  test("billing errors use status and JSON type independently of wording", () => {
    const error = apiError(402, "billing_error");
    expect(isAnthropicUsageLimitError(error)).toBe(true);
    expect(isProviderUsageLimitError(error, "anthropic")).toBe(true);
    expect(providerFromUsageLimitError(describeOpencodeSessionError(error))).toBe("anthropic");
  });

  test("the enforced spend code distinguishes spend caps from request throttling", () => {
    for (const { status, type } of [{ status: 400, type: "invalid_request_error" }, { status: 429, type: "rate_limit_error" }]) {
      expect(isAnthropicUsageLimitError(apiError(status, type, { code: "enforced_spend_limit_reached" }))).toBe(true);
    }
    expect(isAnthropicUsageLimitError(apiError(429, "rate_limit_error"))).toBe(false);
  });

  test("Claude subscription rejections use the unified status header", () => {
    for (const name of ["anthropic-ratelimit-unified-status", "Anthropic-Ratelimit-Unified-Status"]) {
      expect(isAnthropicUsageLimitError(apiError(429, "rate_limit_error", { headers: { [name]: "rejected", "retry-after": "3600" } }))).toBe(true);
    }
    for (const status of ["allowed", "allowed_warning"]) {
      expect(isAnthropicUsageLimitError(apiError(429, "rate_limit_error", { headers: { "anthropic-ratelimit-unified-status": status } }))).toBe(false);
    }
  });

  test("temporary throttling never becomes an upsell because its prose mentions quota", () => {
    const error = apiError(429, "rate_limit_error", { message: "You've hit your usage limit; retry this request shortly.", headers: { "Retry-After": "2" } });
    expect(isProviderUsageLimitError(error, "anthropic")).toBe(false);
    expect(isProviderUsageLimitError("You've hit your usage limit", "anthropic")).toBe(false);
    expect(isProviderUsageLimitError("billing_error", "anthropic")).toBe(false);
  });

  test("authentication, malformed requests and overload do not show the limit card", () => {
    for (const { status, type } of [{ status: 400, type: "invalid_request_error" }, { status: 401, type: "authentication_error" }, { status: 403, type: "permission_error" }, { status: 500, type: "api_error" }, { status: 529, type: "overloaded_error" }]) {
      expect(isProviderUsageLimitError(apiError(status, type, { message: "insufficient_quota" }), "anthropic")).toBe(false);
    }
    expect(isAnthropicUsageLimitError(apiError(401, "billing_error"))).toBe(false);
    expect(isAnthropicUsageLimitError({ data: { statusCode: 402, responseBody: "not JSON" } })).toBe(false);
    expect(isAnthropicUsageLimitError({ data: { statusCode: "402", responseBody: JSON.stringify({ type: "error", error: { type: "billing_error" } }) } })).toBe(false);
  });

  test("mid-stream JSON errors retain the same recovery and original provider", () => {
    const body = { type: "error", error: { type: "billing_error" } };
    expect(isAnthropicUsageLimitError(body)).toBe(true);
    expect(isAnthropicUsageLimitError(apiError(200, "billing_error"))).toBe(true);
    expect(providerFromUsageLimitError(describeOpencodeSessionError(apiError(402, "billing_error"), "Session failed", "openrouter"))).toBe("openrouter");
  });

  test("reload preserves structured recovery without converting transient errors", () => {
    const snapshot: LegalworkSessionSnapshot = {
      session: {
        id: "claude-session",
        slug: "claude",
        projectID: "project",
        directory: "/project",
        title: "Claude task",
        version: "1",
        time: { created: 1, updated: 2 },
      },
      messages: [{
        info: {
          id: "claude-turn",
          sessionID: "claude-session",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parentID: "user-turn",
          modelID: "claude-sonnet",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          error: {
            name: "APIError",
            data: apiError(429, "rate_limit_error", { code: "enforced_spend_limit_reached" }).data,
          },
        },
        parts: [],
      }],
      todos: [],
      status: { type: "idle" },
    };
    const recovered = snapshotToUIMessages(snapshot);
    expect(recovered).toHaveLength(1);
    const text = recovered[0]?.parts.find(part => part.type === "text");
    expect(text?.type === "text" && providerFromUsageLimitError(text.text)).toBe("anthropic");

    const info = snapshot.messages[0]?.info;
    if (!info || info.role !== "assistant") throw new Error("Missing assistant fixture");
    info.error = {
      name: "APIError",
      data: apiError(429, "rate_limit_error", { message: "You've hit your usage limit; retry shortly." }).data,
    };
    const transient = snapshotToUIMessages(snapshot)[0]?.parts.find(part => part.type === "text");
    expect(transient?.type === "text" && providerFromUsageLimitError(transient.text)).toBeNull();
    expect(transient?.type === "text" && transient.text).toContain("retry shortly");
  });
});
