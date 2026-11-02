# Local mail rules

MAIL-161 adds account-local rules to the existing encrypted mail worker. Schema 37 is additive over scheduling (35) and snooze (36). A rule has an account, UUID, generation/revision, definition, credential generation, activation instant and arrival sequence fence. Deletion leaves a tombstone so a stale create cannot reuse its identity. The host-only read/save/delete routes accept strict typed fields and no credentials, owners, workspaces or matter IDs. IPC responses are bound to the requested account and saved revision/definition.

## Arrival provenance

Only the provider engines capture candidates, synchronously inside their current run/credential-fenced page transaction, before inserting a previously unknown provider identity:

- Gmail: typed `messagesAdded` history changes. Labels, untyped change references, initial enumeration and reconciliation downloads never capture arrivals.
- Graph: non-removed IDs from a folder delta stream with `baseline=0`, using existing immutable identities. Initial, newly discovered and expired-cursor baseline pages never capture arrivals. Current message retrieval remains authoritative about membership and removal.
- IMAP: a per-folder UID floor and UIDVALIDITY are established only after a complete scan. Later scans can capture unseen UIDs at or above that floor in the same epoch. An epoch change requires a new baseline. Migration also establishes a fresh baseline rather than treating existing folders as ready.

Capture requires an enabled rule, current owner/provider, connected credentials and a writable local account (not a retained copy). A unique account/message key persists across replays, updates and restarts. Candidates may precede MIME storage, so they reference the account rather than the message. There is no renderer, HTTP or assistant command for injecting candidates or running historical mail.

## Evaluation and actions

The local runner evaluates at most 25 candidates per two-second turn, with 30-second deferral for missing content or readiness. Deferred rows do not starve later ready arrivals. Seven-day-old pending candidates are skipped. Conditions use the current raw-bound MIME projection, a single parsed sender address and a case-insensitive literal subject. Initial receipt time must be at or after rule activation and cannot be in the future. Only live Inbox messages qualify, excluding Spam and Trash. Rules are account-scoped and sorted by order, then UUID, exactly as displayed. Only the first eligible matching rule acts.

Every save fences the new revision after the current maximum arrival sequence. Enabling, edits and reordering cannot retroactively claim older candidates. Disabled or deleted rules cannot claim more work. Credential generation changes require explicit review and save; refresh within the current generation does not transfer authority. The worker checks current account status, sync pause/readiness and provider write grants before creating an action. Delegated Graph accounts additionally use the existing shared-mailbox write gate. Dispatch retains the native integration proxy's own current account and permission checks.

Read, flag and archive use `MailLocalApiStore.enqueueMutation`, the current stored provider precondition, replay key `rule:<arrival-id>` and the existing journal's manual conflict policy. The arrival claim and queue insertion commit together. The sync engines dispatch with their existing generation, lease, preflight and uncertain-outcome protections. Recent activity resolves current queue state instead of claiming that enqueue means success. Unknown actions are never replayed automatically. Deleting or disabling a rule does not cancel an already queued action; the existing Mail activity control owns that cancellation.

Snooze uses the existing versioned conversation snapshot. It does not replace an active user snooze. Durations are elapsed minutes from processing, with a display zone, rather than wall-clock recurrence. Local events, message changes, action results and snooze wake-ups never create candidates, preventing loops. No send, delete, arbitrary script, assistant workflow, cross-account action or automatic matter filing is allowed.

## Lifecycle and recovery

The runner starts only when the worker is available and the desktop mail lifecycle is running. Suspension stops evaluation synchronously; the existing sync lifecycle separately aborts provider activity. Lock and shutdown stop the timer before closing storage. Ordinary restarts preserve rules and pending provenance. Backup restore explicitly disables rules and finishes old pending candidates. Reconnecting cannot revive their old credential generation.

Execution requires the app, unlocked mail and an awake/unlocked desktop. Provider sync and mutations need a connection. There is no provider scheduler, wake assertion, exact-time guarantee or cross-device rule synchronization. Provider filters remain independent. Headless tests use synthetic transports and actual encrypted Node workers. Standard-profile Mac form checks cover validation, the disabled default, bounded actions, Escape and focus return without saving or enabling a rule. Enabled-rule execution and live-provider acceptance remain unverified.
