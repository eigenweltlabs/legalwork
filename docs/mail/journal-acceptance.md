# EIG-127 acceptance record

Accepted 9 September 2026 after lead integration and independent Astra review. This work package is the durable backend execution and action-intent foundation. Actual Gmail/Graph/IMAP adapters, ongoing background scheduling, product controls and outbound provider calls remain in their existing implementation tickets; this record does not qualify a complete mail client or live provider behavior.

| Original criterion | Implemented evidence |
| --- | --- |
| Persist discovery/content/reconciliation and mutation work with bounded concurrency, budgets, backoff and inspectable errors | Generation/scoped checkpoints and download jobs; bounded `MailSyncExecutor`; v5 `MailActionJournal`; typed status/counts, retry state, fixed error codes and legacy unresolved counts. No successful stub provider commands. |
| Commit checkpoints with metadata and recoverable jobs; content completion requires durable bytes | Atomic page transactions, raw-job follow-up closure, verified encrypted content chunks and synchronous publication/job completion in one outer transaction. Expired leases and publication failures roll back both. |
| Recover after restart, offline/suspend-length gaps and throttling; isolate accounts | Persisted deadlines/retry budgets, lease renewal and expiry recovery, provider minimum retry delays across reopen, two-account admission/isolation, pause/resume and SIGKILL before/after commit boundaries. Actual OS lifecycle qualification remains EIG-152. |
| Specify conflict, cancellation and uncertain sends without exactly-once assumptions | Immutable replay keys/preconditions, explicit conflict policy, dispatch marker before side effects, pre-dispatch safe retry, post-dispatch uncertainty, CAS cancellation/reconciliation and no automatic uncertain replay. Legacy actions remain preserved and unmanaged. |

## Reviewed commits

- `d184aa25d`: content publication coupled to fenced job completion and durable provider retry minimums.
- `b4f3d33ba`: v5 action journal and migration/legacy preservation.
- `eb22ae5b7`: bounded sync executor, deadline/lease fencing and persisted outcomes.
- The following EIG-127 retry correction preserves provider minimum delays for pre-dispatch actions; its commit is identifiable by that title in git history.

The initial checkpoint/follow-up commits and previous/current hash mapping are in [linear-commits.md](linear-commits.md). Every implementation commit carries its Linear ticket.

## Verification

The lead ran the complete mail suite after schema v5 integration: 147 tests passed with the actual Electron executable enabled. After adding the executor and final action-throttling regression, the changed executor/action/journal/content launchers all passed under actual Node with encrypted SQLite: 14 executor, 13 action, 19 sync-journal and 10 content cases. Full server and Electron typechecks passed. Independent reviews additionally passed three executor adversarial probes, three action probes and retry saturation/reopen checks. Findings discovered during the wider connection work were fixed and verified before acceptance.

A host execution stall interrupted one agent's combined test run; the focused executor had passed, and the affected unchanged journal/content checks passed on rerun without extending test timeouts. No assertion failure remains.

```sh
pnpm --dir apps/server exec bun test src/mail/runtime/sync-executor.test.ts src/mail/storage/action-journal.test.ts src/mail/storage/sync-journal.test.ts src/mail/storage/content-store.test.ts
pnpm --dir apps/server typecheck
pnpm --dir apps/desktop typecheck:electron
```

Native tests compile sources into temporary directories and launch Node/Electron; Bun does not load the encrypted native module directly. All data and provider responses are synthetic. Signed OS-vault behavior, cross-platform release, live provider access, background scheduling and actual outbound execution are not claimed by this gate. EIG-123 owns further worker/API consumption; EIG-128 onward own provider sync; EIG-144/EIG-146 own provider actions/submission; EIG-147/EIG-152 own product/OS lifecycle qualification. These requirements remain open rather than being counted as delivered journal behavior.
