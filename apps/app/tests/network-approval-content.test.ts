import assert from "node:assert/strict";
import { test } from "bun:test";
import { networkApprovalContent } from "../src/react-app/domains/session/chat/network-approval-content";

test("network review explains the action and shows query data, form fields and credentials", async () => {
  const content = networkApprovalContent({ method: "POST", url: "https://example.com/upload?matter=Test+matter",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer test" },
    body: "name=Test+document&text=Example+contents", bodyFormat: "text", bodyBytes: 45 });
  assert.equal(content.action, "Send information?");
  assert.equal(content.destination, "example.com");
  assert.equal(content.resource, "/upload");
  assert.deepEqual(content.fields[0], { label: "Matter", value: "Test matter" });
  assert.deepEqual(content.fields[2], { label: "Text", value: "Example contents" });
  assert.match(content.context, /sign-in information/);
  const binary = networkApprovalContent({ method: "POST", url: "http://example.com", headers: {}, body: "AA==", bodyFormat: "base64", bodyBytes: 1 });
  assert.match(binary.fields[0].value, /cannot be shown as readable text/);
  assert.match(binary.context, /not encrypted/);
  const unknown = networkApprovalContent({ method: "CUSTOM", url: "https://example.com", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.match(unknown.description, /does not explain its purpose/);
  const get = networkApprovalContent({ method: "GET", url: "https://example.com/?q=private", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.equal(get.action, "Read information?");
  assert.deepEqual(get.fields, [{ label: "Q", value: "private" }]);
  const deletion = networkApprovalContent({ method: "DELETE", url: "https://example.com/item", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.equal(deletion.action, "Delete information?");
});

const searchBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: "current weather miami florida", numResults: 8, type: "auto", livecrawl: "fallback" } } });
test("search approval leads with the real query and provider, without protocol JSON", () => {
  const input = { method: "POST", url: "https://mcp.exa.ai/mcp", headers: {}, body: searchBody, bodyFormat: "text", bodyBytes: searchBody.length };
  const content = networkApprovalContent(input);
  assert.equal(content.action, "Search the web?");
  assert.deepEqual(content.search, { provider: "Exa Search", query: "current weather miami florida" });
  assert.deepEqual(content.fields, []);
  assert.equal(networkApprovalContent({ ...input, url: "https://mcp.exa.ai.attacker.example/mcp" }).search, null);
  const unexpected = JSON.parse(searchBody);
  unexpected.params.arguments.document = "private document canary";
  const fallback = networkApprovalContent({ ...input, body: JSON.stringify(unexpected) });
  assert.equal(fallback.search, null);
  assert.ok(fallback.fields.some(field => field.value === "private document canary"));
});
test("generic JSON becomes readable fields, while credentials and extra fields are identified", () => {
  const body = JSON.stringify({ documentName: "Agreement", recipient: { email: "review@example.com" }, files: ["a.pdf", "b.pdf"], apiKey: "private-key" });
  const content = networkApprovalContent({ method: "POST", url: "https://example.com", headers: {}, body, bodyFormat: "text", bodyBytes: body.length });
  assert.deepEqual(content.fields.slice(0, 2), [{ label: "Document Name", value: "Agreement" }, { label: "Recipient · Email", value: "review@example.com" }]);
  assert.ok(content.fields.every(field => !field.value.includes("private-key")));
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `Value ${i}`));
  const crowded = networkApprovalContent({ method: "POST", url: "https://example.com", headers: {}, body: many, bodyFormat: "text", bodyBytes: many.length });
  assert.equal(crowded.fields.length, 16);
  assert.equal(crowded.omitted, 14);
});
