# LegalMemory with the single native OpenCode engine

LegalWork keeps its existing six non-agent routes: tree roots, children and search; related-document graph; open document; open folder. These continue to perform explicit human interface actions without asking a model. The general MCP gateway from PR 303 is not adopted.

`legalmemory-native.ts` authorizes the LegalWork collaborator, workspace and permitted member/firm connector name. Its private native RPC receives only the configured server name and a small read operation. The app-owned `legalwork.legalmemory-access` plugin obtains the exact effective, environment/file-expanded remote definition through the public synchronous `ctx.mcp.transform`. URLs, configured headers, OAuth access/refresh tokens and client secrets stay inside the engine. Metadata discovery returns names only. Authored native definitions and shared LegalWork settings use the same native loader and OAuth owner.

The plugin runs ordinary MCP reads through the public registered native tool's `Info.execute`, using the native MCP executor's own assertion of its action, wildcard resource and exact invocation source. Direct HTTP reads assert the corresponding native read permission explicitly; no duplicate approval is added around native MCP execution. This retains the engine's MCP connection, OAuth refresh, permissions and cancellation. A short-lived app-owned native context has permission only for the six required read tool identities; firm and project permission hooks still apply. It submits no model prompt, never modifies an existing chat, and removes its context in `finally`. Old crash contexts are removed through the `cleanup` RPC after startup, or on the next interface access, only for the exact canonical location and only when older than the current engine process. `legalworkInternal` is a presentation marker, not authorization.

For the appliance's tree HTTP API, the plugin resolves OAuth through public `integration.connection.active/resolve` inside the engine. A known expired token, or the first tree HTTP 401, triggers the existing read-only native `list_connectors` tool. The native MCP transport performs any refresh and rotation; the plugin then resolves again. It never rotates, invalidates, reconnects or disconnects the connection itself. There is one read-only authentication replay per interface operation, preventing a broken authentication response from causing an unbounded loop. Missing refresh tools fail explicitly; the existing tree MCP fallback remains available. Permission denial, cancellation and wrong-project/connector failures never become a fallback to another tool. Redirects on these engine-local HTTP requests are rejected, including redirects to another origin.

## Human approvals without a selected chat

A private per-location operation map binds an opaque operation ID to the real native session and exact tool source. The narrow LegalWork permission routes list only matching native action/resources/firm message and accept only one-time allow or rejection. They expose no internal session/transcript or credential. A viewer can inspect this safe metadata; only a collaborator can reply. Forged or completed operation/request pairs are rejected, and cross-project RPC contexts cannot see them.

A global approval dialog observes these requests only while one of the six human LegalMemory reads is active, including when no chat is selected. Its 500 ms polling cadence observes readiness and imposes no approval deadline. It submits the exact native reply. Native source-bound cancellation rejects only the matching pending request and deletes the context, including when cancellation occurs during policy evaluation. Unmount/caller cancellation stops active reads. Existing 10-second tree/graph,30-second document and5-minute folder client waits are removed for these six requests so a person can read the firm's permission notice; caller cancellation and explicit connection stage limits remain.

## The narrow download exception

Released 2.1.4 lowers non-media MCP binary resources into human-readable tool-output path text. It drops the original resource filename and supplies no invocation/session-owned file identifier. Treating an arbitrary tool-result text path as authority could read another session's output. Public `file.read` also deliberately confines reads to the workspace. This was verified against the actual released executable.

Only the existing `download_document` request therefore retains its small HTTP MCP protocol adapter, moved inside the engine. It accepts only document identity, optional version identity and `inline_blob`; it uses the configured LegalMemory endpoint and native-resolved credentials. It does not implement OAuth or refresh. It negotiates and echoes the MCP protocol header, closes its temporary protocol session when possible, and reads complete JSON or matching SSE result frames, including SSE streams that remain open. Original binary bytes, filename, MIME type and structured metadata survive. It never parses or reads a tool-output path. Cancellation stops its HTTP work; deleting a remote temporary MCP session is best effort and cannot replace a successfully completed download.

## Limits and remaining boundaries

No model-context, tool-output, schema-size, session-count or default compatibility-request deadline was added. Normal native tool calls retain OpenCode's own stage defaults (30 s startup/catalog,12 h execution). The narrow manual download path honors explicitly configured native startup/execution timeouts; absent those settings, it keeps the previous uncapped request behavior. Its direct tree HTTP path remains caller-cancelled. Missing native read tools are an explicit error, and a just-connected native catalog may still be updating briefly after OAuth completes; availability must be reconciled from native catalog events rather than assumed from connection status alone.

Existing application limits are unchanged and remain visible: original downloads buffer at most96 MiB; a folder export stops at200 files or12 levels and reports truncation; folder requests page by 200 with continuations. The route's children page maximum 250, search maximum 100, tree-path length 4096, request-body bounds and three concurrent folder-download workers remain the existing UI/export behavior. The existing MCP fallback's first matter query defaults to 500 entries; recursive connector extraction stops after 8 levels and blob/filename extraction after 6. These are inherited implementation limitations, not agent-output changes introduced by the migration. They should not be mistaken for exhaustive estate coverage on deployments lacking the native tree API.

The released fixture is a real engine/native OAuth/MCP protocol test against a local synthetic LegalMemory service. It proves rotating-token concurrency, no hidden reconnect, source-bound native denial and ASK cancellation, cross-project refusal, redirect refusal, full binary/name/MIME and large graph retention, native MCP cancellation, no credential export and zero model calls. It is not a claim that a live production LegalMemory appliance or a paid-agent task has been tested. Its15 s readiness watchdog,30 s engine startup watchdog and60 s test timeout bound test infrastructure only; application capability is unchanged.

Validation:

```sh
LEGALWORK_TEST_OPENCODE_BIN=/tmp/legalwork-v2-release-runtime/opencode \
  pnpm --filter legalwork-server exec bun test \
  src/legalmemory-native.released.test.ts src/legalmemory-native.test.ts \
  src/legalmemory-folder.test.ts src/legalmemory-tree.test.ts \
  src/legalmemory-open-folder.e2e.test.ts
```

Upstream source: [public MCP client](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/mcp/client.ts), [native OAuth refresh](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/mcp/oauth.ts), [native MCP tool/result lowering](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/mcp.ts), [public plugin Promise adapter](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/adapter.ts).
