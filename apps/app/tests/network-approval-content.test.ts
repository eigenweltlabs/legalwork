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
  assert.match(content.sent, /matter: Test matter/);
  assert.match(content.sent, /text: Example contents/);
  assert.match(content.context, /sign-in information/);
  const binary = networkApprovalContent({ method: "POST", url: "http://example.com", headers: {}, body: "AA==", bodyFormat: "base64", bodyBytes: 1 });
  assert.match(binary.sent, /cannot be shown as readable text/);
  assert.match(binary.context, /not encrypted/);
  const unknown = networkApprovalContent({ method: "CUSTOM", url: "https://example.com", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.match(unknown.description, /does not explain its purpose/);
  const get = networkApprovalContent({ method: "GET", url: "https://example.com/?q=private", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.equal(get.action, "Read information?");
  assert.match(get.sent, /q: private/);
  const deletion = networkApprovalContent({ method: "DELETE", url: "https://example.com/item", headers: {}, body: "", bodyFormat: "text", bodyBytes: 0 });
  assert.equal(deletion.action, "Delete information?");
});
