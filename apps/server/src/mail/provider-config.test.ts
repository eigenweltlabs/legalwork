import { describe, expect, test } from "bun:test";
import { checkMailProviderReadiness, GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES, type MailProviderConfig } from "./provider-config.js";

const gmail: MailProviderConfig = {
  provider: "gmail", applicationType: "desktop", clientId: "test.apps.googleusercontent.com",
  clientSecretConfigured: true, redirectUri: "http://127.0.0.1:43123/", pkceMethod: "S256", scopes: GMAIL_MAIL_SCOPES,
};
const graph: MailProviderConfig = {
  provider: "graph", applicationType: "desktop", clientId: "11111111-2222-3333-4444-555555555555",
  tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", redirectUri: "http://localhost:43123/mail/callback",
  registeredRedirectUri: "http://localhost/mail/callback", pkceMethod: "S256", scopes: GRAPH_MAIL_SCOPES,
};

describe("mail provider configuration readiness", () => {
  test("valid settings never claim authorization or echo identifiers", () => {
    for (const config of [gmail, graph]) {
      expect(checkMailProviderReadiness(config)).toEqual({ provider: config.provider, configurationReady: true, authorization: "not_checked", issues: [] });
      expect(JSON.stringify(checkMailProviderReadiness(config))).not.toContain(config.clientId);
    }
  });
  test("existing Google read/compose grant does not satisfy full mail operations", () => {
    expect(checkMailProviderReadiness({ ...gmail, scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] }).issues).toContain("missing_required_scopes");
  });
  test("Google direct exchange requires configured installed client secret", () => {
    expect(checkMailProviderReadiness({ ...gmail, clientSecretConfigured: false }).issues).toContain("google_client_secret_missing");
  });
  test("rejects network, credential-bearing, ambiguous and parameter-bearing callbacks", () => {
    for (const redirectUri of ["https://example.com/", "http://0.0.0.0:1234/", "http://127.0.0.1.evil.test/", "http://user:secret@127.0.0.1/", "http://127.1/", "http://2130706433/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/", "http://127.0.0.1/?code=secret", "http://127.0.0.1/#secret", " http://127.0.0.1/", "http://127.0.0.1/\\evil"]) {
      expect(checkMailProviderReadiness({ ...gmail, redirectUri }).issues).toContain("unsafe_redirect");
    }
  });
  test("provider-specific IPv6 support", () => {
    expect(checkMailProviderReadiness({ ...gmail, redirectUri: "http://[::1]:4321/" }).configurationReady).toBe(true);
    expect(checkMailProviderReadiness({ ...graph, redirectUri: "http://[::1]:4321/" }).issues).toContain("unsafe_redirect");
  });
  test("Graph requires send separately from read/write", () => {
    expect(checkMailProviderReadiness({ ...graph, scopes: GRAPH_MAIL_SCOPES.filter((scope) => scope !== "Mail.Send") }).issues).toContain("missing_required_scopes");
  });
  test("Graph pilot disallows broad authorities and injected tenant paths", () => {
    for (const tenantId of ["", "common", "organizations", "consumers", "example.com", "../common", "tenant?secret"]) {
      expect(checkMailProviderReadiness({ ...graph, tenantId }).issues).toContain("explicit_tenant_required");
    }
  });
  test("Graph callback matching preserves host/path and literal-IP port", () => {
    for (const redirectUri of ["http://localhost:43123/Mail/callback", "http://127.0.0.1:43123/mail/callback"]) {
      expect(checkMailProviderReadiness({ ...graph, redirectUri }).issues).toContain("registered_redirect_mismatch");
    }
    expect(checkMailProviderReadiness({ ...graph, redirectUri: "http://127.0.0.1:43123/", registeredRedirectUri: "http://127.0.0.1:43124/" }).issues).toContain("registered_redirect_mismatch");
    expect(checkMailProviderReadiness({ ...graph, redirectUri: "http://127.0.0.1:43123/", registeredRedirectUri: "http://127.0.0.1:43123/" }).configurationReady).toBe(true);
  });
  test("invalid settings report constant errors without reflecting input", () => {
    const result = checkMailProviderReadiness({ ...graph, clientId: "secret-value", registeredRedirectUri: "http://secret-value/" });
    expect(result.configurationReady).toBe(false);
    expect(result.issues).toContain("invalid_client_id");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
