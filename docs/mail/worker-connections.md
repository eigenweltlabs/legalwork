# Private connection worker boundary

The keyed Node/Electron worker creates its owner-bound connection controller after migration and the schema guard. Parent-only `mail.connection.begin` accepts canonical desktop settings and an optional reconnect account ID. Its result is `{connectionStarted:{connectionId,authorizationUrl,expiresAt}}`. Poll returns `{connection:<secret-free controller status>}`; cancel and disconnect return `{cancelled:true}` and `{disconnected:true}`. Settings are never returned. Reserved `credentials.update` remains unsupported; sync support remains false.

The 64 KiB frame cap applies both directions. Exact command/settings/result keys reject token, endpoint, owner and transport overrides. Authorization URLs allow only the provider's fixed HTTPS authorization endpoint, exact OAuth query keys, S256 challenge, random-state shape, canonical scopes and provider-specific ephemeral loopback redirect. The parent correlates begin responses with provider/client/tenant and poll responses with connection ID. These URLs contain sensitive transient authorization state and must not be logged or exposed through generic status APIs.

Up to 64 requests can be in flight. Awaiting begin/cancel/disconnect does not serialize ping or other requests. Shutdown marks the worker closing, closes/aborts the controller, drains pending commands, then closes SQLite; late results are not written to stdout. The existing two-second hard shutdown deadline remains the final process bound. Controller cancellation guards protect detached provider continuations from persisting after close.

Disconnect clears usable credentials and persists the archive lock. Folder/status reads reject persisted disconnected accounts with fixed `locked`; account enumeration retains only its existing metadata shape. Legacy unconfigured accounts retain their existing read behavior. This is not a complete future message/content API gate: each new content operation must enforce the same persisted access policy. No network sync executor is introduced.

## Evidence

`LEGALWORK_MAIL_TEST_ELECTRON=<Electron executable> pnpm --dir apps/server exec bun test src/mail/runtime` runs the production compiled worker under actual Node and, when configured, actual Electron RUN_AS_NODE. Synthetic tests cover encrypted reopen, owner isolation, begin/poll/cancel, disconnect/reopen locking, retained metadata, and closed loopback listeners. A test-only bootstrap delays entry to the real controller to prove ping proceeds during begin and shutdown drains without creating an account. The bootstrap is not a protocol capability. No provider token exchange, browser consent or live account is exercised. Controller-level tests separately cover delayed OAuth/identity completion fencing.

`pnpm --dir apps/server exec tsc --noEmit` checks server types. Add `src/mail/runtime/protocol.test.ts` to any manifest test command that lists files explicitly; this slice intentionally does not edit manifests.
