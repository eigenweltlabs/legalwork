# Bounded sync executor

`MailSyncExecutor({journal,handler,...limits})` runs existing download jobs in the explicitly selected `{accountId,scopeId,generation}`. `run(scope)` returns bounded counts (`attempted`, `succeeded`, `retry`, `failed`, `leaseLost`) and a stop reason. It does not enumerate a mailbox, choose the latest generation, infer an empty mailbox, implement a provider request, or dispatch actions. Shared jobs remain deduplicated by the journal across scopes in that generation. Other generations remain independent and are not purged.

Defaults are one simultaneous account, one job at a time per account, and ten attempts per run. Configurable limits are at most eight simultaneous accounts and 100 attempts per run. The conservative default matters for providers whose JSON response parsing consumes substantial memory. A second run for the same account rejects with `busy`, even if its scope or generation differs; exceeding global admission rejects with `capacity`. The bounded loop only claims jobs currently eligible under the persisted journal backoff and attempts budget. It never waits for a future retry or schedules another run.

The trusted handler receives a frozen claimed job, an AbortSignal, `assertCurrent()`, and `complete(metadataCallback, followups?)`. Completion is a synchronous capability, revoked when the attempt exits. It checks the current lease and local lifecycle/monotonic deadline, and uses journal success to commit metadata and optional same-message followups atomically. The metadata callback gets the journal's revocable account-scoped writer. Native async callbacks and returned thenables are rejected; a retained writer cannot perform late writes. Only local lifecycle/deadline checks run inside that callback; the journal performs its own before/after lease checks without reentering its callback guard.

For a content job, finish through the content store's synchronous publication callback:

```ts
await store.writePart(accountId, locator, options, source, () => {
  work.complete(writer => {
    // Apply any verified synchronous metadata here.
  }, discoveredParts);
});
```

Publication and job success then share the outer encrypted transaction. A handler may complete inside a publication transaction that later rolls back, or throw after success has already committed. The executor reads persisted job state after either outcome; an in-memory callback flag is not evidence of durable completion. Existing committed success is never retired or replayed. Completion alone still does not establish that body/attachment discovery is complete or all bytes exist.

These handlers and publication callbacks are trusted internal code, not a sandbox. They must not retain repositories to schedule unfenced writes, call network APIs inside synchronous callbacks, or publish bytes outside the fenced callback pattern. Rejecting a returned thenable rolls back synchronous writes but cannot cancel deferred closures that use externally captured repositories. The provided completion capability and metadata writer do reject such late use through their own interfaces.

Active leases are renewed periodically (default lease 30 seconds, renewal ten seconds). The total per-job deadline is 120 seconds by default, bounded to 10 milliseconds–ten minutes. Both a timer and an absolute monotonic elapsed-time check enforce it, including synchronous work that blocks timer delivery. A stolen or expired lease is never retired using an old token. Provider retry advice supplied via `MailSyncExecutionFailure('retryable', retryAfterMs)` reaches the durable journal without shortening safe nonnegative delays. Explicit `permanent` errors exhaust that job immediately; unknown handler errors and return-without-completion become fixed retryable failures within the persisted attempts budget. No raw exception or job payload is logged or included in the run result.

`pause(accountId)` aborts that run; `close()` aborts all runs and forbids future ones. A valid unfinished lease is retired retryably, preserving the job, budget and backoff. An expired/lost lease is left for owner-aware journal recovery. A new executor/run resumes eligible durable work; neither method deletes jobs. Credentials and provider cancellation remain the integrating engine's responsibility: this substrate does not independently read account credentials, revoke already returned access tokens, or stop another executor instance.

A handler that ignores abort retains its account and global admission slot until its promise settles, even after `run()` returns a paused/timeout result. This prevents repeatedly starting work around admission limits. Its completion capability is already revoked. Truly stuck synchronous code, native calls, network resources or never-settling promises require terminating the worker before constructing a replacement executor; an in-process timer cannot forcibly stop them. One serial storage writer and one executor per store are integration requirements.

## Evidence

`pnpm --dir apps/server exec bun test src/mail/runtime/sync-executor.test.ts` compiles production sources and launches actual Node against encrypted Multiple Ciphers SQLite. Synthetic tests cover account/scope/generation isolation, concurrency caps, renewed/expired/stolen leases, ignored abort, deadline overrun before and during completion, durable provider retry delay after reopen, permanent/budget exhaustion, content publication rollback with followups, committed success followed by error, and late metadata-writer rejection. No provider network, mailbox synchronization or action dispatch is exercised. `pnpm --dir apps/server exec tsc --noEmit` checks types. Worker/API wiring is deliberately absent from this slice.
