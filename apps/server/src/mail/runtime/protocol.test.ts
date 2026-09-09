import { expect, test } from "bun:test";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import { parseParentMessage, parseWorkerMessage, resultMatchesCommand } from "./protocol.js";
const settings = { provider: "gmail", applicationType: "desktop", pkceMethod: "S256", clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: [...GMAIL_MAIL_SCOPES] };
const connectionId = "11111111-1111-4111-8111-111111111111";
const parent = (command: unknown) => parseParentMessage(JSON.stringify({ kind: "request", id: "1:1", command }));
const response = (result: unknown) => parseWorkerMessage(JSON.stringify({ kind: "response", id: "1:1", ok: true, result }));
test("connection commands strictly constrain settings and identifiers", () => {
  expect(parent({ operation: "mail.connection.begin", settings })).toBeDefined();
  for (const invalid of [{ ...settings, token: "secret" }, { ...settings, scopes: [...settings.scopes, "extra"] }, { ...settings, clientSecret: "" }, { ...settings, tokenEndpoint: "https://evil.example" }, { ...settings, clientId: "invalid" }]) expect(parent({ operation: "mail.connection.begin", settings: invalid })).toBeUndefined();
  for (const operation of ["mail.connection.poll", "mail.connection.cancel"]) {
    expect(parent({ operation, connectionId })).toBeDefined();
    expect(parent({ operation, connectionId: "bad" })).toBeUndefined();
    expect(parent({ operation, connectionId, token: "secret" })).toBeUndefined();
  }
});
test("connection results reject secrets, malformed states and unsafe URLs", () => {
  expect(response({ connection: { connectionId, expiresAt: 123, state: "pending" } })).toBeDefined();
  expect(response({ connection: { connectionId, expiresAt: 123, state: "pending", accessToken: "secret" } })).toBeUndefined();
  expect(response({ connection: { connectionId, expiresAt: 123, state: "failed", error: "private-provider-message" } })).toBeUndefined();
  expect(response({ connectionStarted: { connectionId, expiresAt: 123, authorizationUrl: "https://evil.example/" } })).toBeUndefined();
});
test("authorization URLs require exact OAuth query, state and loopback callback", () => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({ client_id: settings.clientId, redirect_uri: "http://127.0.0.1:54321/", response_type: "code", scope: settings.scopes.join(" "), state: "a".repeat(43), code_challenge: "b".repeat(43), code_challenge_method: "S256", access_type: "offline", prompt: "consent" })) url.searchParams.set(key, value);
  const result = (authorizationUrl: string) => ({ connectionStarted: { connectionId, expiresAt: 123, authorizationUrl } });
  expect(response(result(url.href))).toBeDefined();
  for (const [key, value] of [["state", "weak"], ["code_challenge_method", "plain"], ["redirect_uri", "http://localhost.evil.example:1234/"], ["scope", "extra"], ["access_token", "secret"]]) {
    const bad = new URL(url); bad.searchParams.set(key, value); expect(response(result(bad.href))).toBeUndefined();
  }
  const duplicate = new URL(url); duplicate.searchParams.append("state", "a".repeat(43));
  expect(response(result(duplicate.href))).toBeUndefined();
});

test("Graph authority and result correlation bind to the originating command", () => {
  const graph = { provider: "graph", applicationType: "desktop", pkceMethod: "S256", clientId: connectionId,
    tenantId: "22222222-2222-4222-8222-222222222222", registeredRedirectUri: "http://localhost/mail/callback", scopes: [...GRAPH_MAIL_SCOPES] };
  const command = parent({ operation: "mail.connection.begin", settings: graph });
  expect(command).toBeDefined();
  expect(parent({ operation: "mail.connection.begin", settings: { ...graph, clientSecret: "secret" } })).toBeUndefined();
  const url = new URL(`https://login.microsoftonline.com/${graph.tenantId}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({ client_id: graph.clientId, redirect_uri: "http://localhost:54321/mail/callback", response_type: "code", scope: graph.scopes.join(" "), state: "a".repeat(43), code_challenge: "b".repeat(43), code_challenge_method: "S256", response_mode: "query" })) url.searchParams.set(key, value);
  const result = { connectionStarted: { connectionId, expiresAt: 123, authorizationUrl: url.href } };
  expect(response(result)).toBeDefined();
  if (command?.kind !== "request") throw new Error("wrong_command");
  expect(resultMatchesCommand(command.command, result)).toBe(true);
  url.pathname = url.pathname.replace(graph.tenantId, connectionId);
  expect(resultMatchesCommand(command.command, { connectionStarted: { ...result.connectionStarted, authorizationUrl: url.href } })).toBe(false);
  expect(resultMatchesCommand({ operation: "mail.connection.poll", connectionId }, { connection: { connectionId: graph.tenantId, expiresAt: 123, state: "pending" } })).toBe(false);
});
