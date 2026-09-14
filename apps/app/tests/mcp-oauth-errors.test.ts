import { describe, expect, test } from "bun:test";

import { classifyMcpOAuthError, getMcpOAuthErrorMessage } from "../src/app/mcp-oauth-errors";

const dropboxError = "Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed.";

describe("MCP OAuth errors", () => {
  test("recognizes Dropbox's actual rejection through a serialized SDK error", () => {
    const error = new Error(JSON.stringify({ _tag: "UnknownError", data: { message: dropboxError } }));
    expect(getMcpOAuthErrorMessage(error)).toBe(dropboxError);
    expect(classifyMcpOAuthError(error)).toBe("client_registration_required");
  });

  test("recognizes registration restrictions without depending on a provider name", () => {
    for (const message of [
      "This server does not support dynamic client registration",
      "Dynamic client registration not supported",
      "Dynamic client registration is not allowed",
      "Dynamic client registration is disabled",
      "needs_client_registration",
    ]) {
      expect(classifyMcpOAuthError(message)).toBe("client_registration_required");
    }
  });

  test("preserves provider details and invalid_client in OAuth response bodies", () => {
    const error = {
      message: "OAuth completion failed",
      cause: { body: JSON.stringify({ error: "invalid_client", error_description: "Check the registered client ID." }) },
    };
    expect(getMcpOAuthErrorMessage(error)).toBe("OAuth completion failed: Check the registered client ID.: invalid_client");
    expect(classifyMcpOAuthError(error)).toBe("invalid_client");
    expect(classifyMcpOAuthError("OAuth completion failed: Client ID mismatch")).toBe("invalid_client");
  });

  test("extracts only error fields rather than exposing SDK request headers or credentials", () => {
    const error = { data: { message: dropboxError, clientSecret: "secret-value" }, request: { headers: { Authorization: "secret-token" } } };
    expect(getMcpOAuthErrorMessage(error)).toBe(dropboxError);
    expect(getMcpOAuthErrorMessage({ _tag: "UnknownError", request: error.request }, "Try again.")).toBe("Try again.");
  });

  test("handles causes, duplicate messages, and circular errors", () => {
    const error = new Error("Provider unavailable", { cause: new Error("Provider unavailable") });
    error.cause = { message: "Provider unavailable", cause: error };
    expect(getMcpOAuthErrorMessage(error)).toBe("Provider unavailable");
    expect(getMcpOAuthErrorMessage(null)).toBe("OAuth authentication failed.");
  });

  test("keeps unsupported OAuth separate from registration restrictions and transient failures", () => {
    expect(classifyMcpOAuthError("Server does not support OAuth authentication")).toBe("oauth_unsupported");
    expect(classifyMcpOAuthError("OAuth authentication is not supported")).toBe("oauth_unsupported");
    expect(classifyMcpOAuthError("Dynamic client registration supports this client but the request timed out")).toBe("unknown");
    expect(classifyMcpOAuthError("Network request failed")).toBe("unknown");
  });
});
