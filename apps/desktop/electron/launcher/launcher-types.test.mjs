import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantSubmitInputSchema, LauncherInvocationSchema } from "@legalwork/types/launcher";

// Electron imports the shared TypeScript package with Node's loader. A .js
// relative import can pass Bundler/TypeScript checks but fail at app startup.
test("the desktop Node runtime loads launcher schemas and preserves invocation context", () => {
  const workspaceContext = { workspaceId: "A", workspaceName: "Project A", paneId: "right", capturedAt: 1, document: { workspaceId: "B", path: "contract.docx", name: "Contract" } };
  assert.deepEqual(LauncherInvocationSchema.parse({ id: "native", action: "open", source: "home", workspaceContext }).workspaceContext, workspaceContext);
  assert.equal(LauncherInvocationSchema.parse({ id: "selection", action: "ask", source: "shortcut", captureSelection: true }).captureSelection, true);
  const parsed = AssistantSubmitInputSchema.parse({ requestId: "request_123", messageId: "msg_12345678901", text: "Explain", context: { items: [], target: { kind: "project", workspaceId: "A" }, searchScope: null, capturedAt: 1, workspaceContext } });
  assert.equal(parsed.context.workspaceContext.document.workspaceId, "B");
  assert.deepEqual(parsed.context.target, { kind: "project", workspaceId: "A" });
});
