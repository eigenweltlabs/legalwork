import { expect, test } from "bun:test";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import { parseParentMessage, parseWorkerMessage, resultMatchesCommand } from "./protocol.js";
const settings = { provider: "gmail", applicationType: "desktop", pkceMethod: "S256", clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: [...GMAIL_MAIL_SCOPES] };
const connectionId = "11111111-1111-4111-8111-111111111111";
const parent = (command: unknown) => parseParentMessage(JSON.stringify({ kind: "request", id: "1:1", command }));
const response = (result: unknown) => parseWorkerMessage(JSON.stringify({ kind: "response", id: "1:1", ok: true, result }));
test("sync protocol validates optional trusted settings and bounded, account-correlated progress", () => {
  expect(parent({ operation: "mail.sync.start", accountId: "a", settings })).toBeDefined();
  // IMAP uses its stored configuration. OAuth providers are checked in the worker.
  expect(parent({ operation: "mail.sync.start", accountId: "a" })).toBeDefined();
  expect(parent({ operation: "mail.sync.start", accountId: "a", settings: null })).toBeUndefined();
  expect(parent({ operation: "mail.sync.start", accountId: "a", ownerId: "foreign" })).toBeUndefined();
  expect(parent({ operation: "mail.sync.start", accountId: "a", settings: { ...settings, accessToken: "private" } })).toBeUndefined();
  const sync = { accountId: "a", provider: "gmail", state: "syncing", enumerated: 5,
    downloaded: 3, projected: 2, removed: 0, retained: 0, failed: 0, pending: 3, nextRetryAt: null, error: null };
  expect(response({ sync })).toBeDefined();
  for (const invalid of [{ ...sync, accessToken: "private" }, { ...sync, error: "provider secret" },
    { ...sync, downloaded: -1 }, { ...sync, pending: Number.MAX_SAFE_INTEGER + 1 }, { ...sync, state: ["complete"] }]) {
    expect(response({ sync: invalid })).toBeUndefined();
  }
  const parsed = response({ sync });
  if (parsed?.kind !== "response" || !parsed.ok) throw new Error("wrong_response");
  expect(resultMatchesCommand({ operation: "mail.status", accountId: "a" }, parsed.result)).toBe(true);
  expect(resultMatchesCommand({ operation: "mail.status", accountId: "other" }, parsed.result)).toBe(false);
});
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

test("connection states reject coercible arrays and objects", () => {
  for (const state of [["pending"], ["verifying"], ["cancelled"], ["expired"], { toString: "pending" }, null, true]) {
    expect(response({ connection: { connectionId, expiresAt: 123, state } })).toBeUndefined();
  }
});

test("offline read protocol binds identity and content ranges without accepting injected scope or stalled cursors", () => {
  const locator = { provider: "gmail", messageId: "m" } satisfies import("../model.js").ProviderMessageLocator;
  const referenceId = `sha256:${"0".repeat(64)}`;
  const command = { operation: "mail.content.read", accountId: "a", locator, request: { kind: "raw", referenceId } } satisfies import("./protocol.js").WorkerCommand;
  expect(parent(command)).toBeDefined();
  expect(parent({ ...command, ownerId: "other" })).toBeUndefined();
  expect(parent({ ...command, request: { ...command.request, limit: 24577 } })).toBeUndefined();
  expect(parent({ operation: "mail.messages.list", accountId: "a", page: { ownerId: "other" } })).toBeUndefined();
  const content = { accountId: "a", locator, referenceId, offset: 0, totalBytes: 1, sha256: "0".repeat(64), data: "YQ==", nextOffset: null };
  const parsed = response({ content });
  if (parsed?.kind !== "response" || !parsed.ok) throw new Error("wrong_response");
  expect(resultMatchesCommand(command, parsed.result)).toBe(true);
  expect(resultMatchesCommand({ ...command, accountId: "other" }, parsed.result)).toBe(false);
  expect(resultMatchesCommand({ ...command, locator: { ...locator, messageId: "other" } }, parsed.result)).toBe(false);
  for (const invalid of [{ ...content, data: "", nextOffset: 0 }, { ...content, data: "YR==" }, { ...content, nextOffset: 2 }, { ...content, accessToken: "secret" }, { ...content, referenceId: "different" }]) {
    expect(response({ content: invalid })).toBeUndefined();
  }
});
test("search protocol rejects extra scope, coercible filters and foreign result correlation",()=>{
  expect(parseParentMessage(JSON.stringify({kind:"request",id:"1:1",command:{operation:"mail.search",input:{accountIds:["a"],unread:"false"}}}))).toBeUndefined();
  expect(parseParentMessage(JSON.stringify({kind:"request",id:"1:1",command:{operation:"mail.search",input:{ownerId:"foreign"}}}))).toBeUndefined();
  expect(parseParentMessage(JSON.stringify({kind:"request",id:"1:1",command:{operation:"mail.search.rebuild",input:{accountId:"a",limit:26}}}))).toBeUndefined();
  expect(parseWorkerMessage(JSON.stringify({kind:"response",id:"1:1",ok:true,result:{search:{items:[],total:-1,pending:0,incomplete:0,nextOffset:null}}}))).toBeUndefined();
});

test("search continuations above 10000 remain valid requests",()=>{
  const parsed=response({search:{items:[],total:10026,pending:0,incomplete:0,nextOffset:10025}});
  if(parsed?.kind!=="response"||!parsed.ok||!("search" in parsed.result))throw Error("invalid search response");
  expect(parent({operation:"mail.search",input:{offset:parsed.result.search.nextOffset}})).toBeDefined();
  expect(parent({operation:"mail.search",input:{offset:Number.MAX_SAFE_INTEGER+1}})).toBeUndefined();
});

test("desktop commands validate bounded private targets and reject extra authority",()=>{
 const input={sessionId:'11111111-1111-4111-8111-111111111111',enabled:true,preview:'none'};
 expect(parent({operation:'mail.notifications.poll',input})).toBeDefined();
 expect(parent({operation:'mail.notifications.poll',input:{...input,ownerId:'other'}})).toBeUndefined();
 expect(parent({operation:'mail.lifecycle.set',input:{suspended:true}})).toBeDefined();
 expect(parent({operation:'mail.lifecycle.set',input:{suspended:'true'}})).toBeUndefined();
 const item={id:input.sessionId,target:{accountId:'a',locator:{provider:'gmail',messageId:'one'}},title:'New mail',body:'Open LegalWork'};
 expect(response({notifications:{items:[item],suppressed:0}})).toBeDefined();
 expect(response({notifications:{items:Array(6).fill(item),suppressed:0}})).toBeUndefined();
 expect(response({notifications:{items:[{...item,body:'x'.repeat(301)}],suppressed:0}})).toBeUndefined();
 expect(response({lifecycle:{state:'running'}})).toBeDefined();
});
