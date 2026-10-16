# MCP authentication and session approval investigation

Status: open for persistent authentication loss. A concurrent refresh defect is reproducible in the pinned OpenCode v1.18.29 engine, but the observed failure recovers on the next request. This does not establish a cause for persistent sign-out on a real provider.

## Synthetic reproduction

Run from the repository root, after installing dependencies with `pnpm install --frozen-lockfile`:

```sh
OPENCODE_TEST_BINARY=/absolute/path/to/opencode pnpm --filter legalwork-server exec bun test src/mcp.oauth-refresh.e2e.test.ts
```

The engine test checks the binary version against `constants.json`. With no explicit binary it discovers the platform sidecar or skips if unavailable. It starts its own loopback OAuth/MCP server and engine, uses temporary projects and XDG directories, overrides the engine test home, disables default plugins, Claude configuration, and model fetching, and removes the processes and temporary state afterward. It uses no provider account, real credentials, external model, or running desktop app. The mock exposes count-only `/stats` and a test-only `POST /expire` endpoint.

Observed on macOS arm64 with OpenCode v1.18.29 and Bun 1.3.9:

| Scenario | Observed result |
| --- | --- |
| One active workspace, one-second access token expires | Resource request succeeds after one refresh; replacement access and refresh tokens are persisted. |
| Provider refresh response omits an unchanged refresh token | Previous refresh token is retained; two consecutive expirations recover without authorization. |
| Two active workspaces share a connector; access token is rejected; rotated refresh response is delayed 250 ms | Both instances attempt the same rotating refresh token. One grant succeeds and one returns `invalid_grant`. One resource list contains the resource and the other is empty. |
| Retry after that race | Stored refresh token remains present, both statuses remain `connected`, and both resource lists succeed without another sign-in. |

The three-test harness passes by **characterizing the current defect**. The concurrent test explicitly expects one lost request and one rejected refresh grant. A green result is evidence that the defect reproduces, not evidence of refresh reliability. After fixing refresh coordination, change that test to require two successful requests and zero rejected grants. The initial assertion of that desired behavior failed with resource counts `[1, 0]`.

The mock previously accepted any refresh token and never expired access tokens, so existing sign-in tests could not expose this failure. It now validates refresh grants, binds them to their client, rejects consumed tokens, and supports short lifetimes and responses that omit an unchanged refresh token. Defaults retain the one-hour access-token lifetime.

## Engine fix direction

The engine creates separate MCP transports for workspace instances while sharing connector credentials. Its auth store locks individual reads and writes; that does not serialize the complete read-refresh-persist sequence across transports. Relevant pinned source:

- [MCP transport creation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/mcp/index.ts)
- [OAuth provider token persistence](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/mcp/oauth-provider.ts)
- [Shared credential store](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/mcp/auth.ts)

Investigate a shared refresh coordinator keyed by the credential identity. Re-read credentials after acquiring the coordinator, reuse a replacement another transport has already saved, and prevent an older failed refresh from invalidating a newer saved token. If multiple engine processes can share this store, coordinate across those processes as well. Keep refresh failures distinct from authorization revocation and transport failures. Do not work around the race by restarting the whole engine or disconnecting other workspaces.

Still to test before claiming a persistent-sign-out fix:

- A provider that revokes a token family after refresh-token reuse.
- Refresh failure or process interruption after the provider rotates a token but before persistence.
- Server restart, sleep/wake, transport reconnect, and multiple engine processes sharing credentials.
- Actual MCP tool calls and desktop connection-status transitions. The harness exercises active MCP resource requests through the engine API without involving a model.

## Repeated permissions

Sandbox approvals remember the exact workspace, chat, permission, target, paths, network request, and effective policy. Identical sequential network requests reuse an approval. A changed URL or a child session prompts separately, even when the child inherits the parent's sandbox settings. Real permission changes revoke the previous approval and stop affected running commands. These boundaries should remain intact.

A separate local defect was reproduced: writing an unchanged workspace runtime config cleared remembered approvals, so the next identical request prompted again. Unchanged global permission writes could also interrupt active commands. The companion completed-work PR contains the fix and regression tests; this investigation branch does not. The fix snapshots normalized config before the updater and skips a byte-identical serialized result. It preserves object-key order because rule ordering is meaningful, and real changes continue to notify and revoke. Regression tests cover in-place updater mutations, reordered permission rules, approval retention, and cancellation on real tightening.

This finding does not cover every approval surface. OpenCode-native tool approvals and desktop presentation still need an exact repeated-request trace if prompts recur after this fix. Useful private diagnostic fields are app/engine version, time, approval source, permission type, chosen decision, workspace/chat/subagent relationship, and whether the target or effective settings changed. For authentication, add provider type, token grant result, HTTP status, engine lifecycle event, and refresh overlap. Do not put tokens, authorization URLs/codes, request bodies, workspace paths, personal identifiers, or production traces in a public issue or PR.

## Validation

- Engine auth harness: 3 passed, including the explicitly named defect characterization.
- Approval, sandbox service, runtime config store, and runtime config generation suites: 77 passed on the companion completed-work branch (`pnpm --filter legalwork-server exec bun test src/approvals.test.ts src/agent-sandbox/service.test.ts src/runtime-opencode-config-store.test.ts src/legalwork-runtime-config.test.ts`).
- Server typecheck (`pnpm --filter legalwork-server typecheck`) and mock syntax check (`node --check scripts/mock-oauth-mcp-server.mjs`) passed.
- No desktop video was captured. The reproduction is a model-free engine/API fixture with exact commands and assertions above.
