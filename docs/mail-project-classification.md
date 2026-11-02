# Local email project classification

EIG-199 uses the existing private MailService, encrypted worker store and trusted host project resolver. It is not a separate mailbox, filing system or model service. See the [Email guide](user-guide/email.md) for setup and review controls.

## Capture and decision boundaries

Gmail incremental history, Graph post-baseline delta and IMAP above the existing incremental UID floor call one shared arrival capture alongside mailbox rules. Project capture requires explicit Automatic mode, a connected current credential generation, a non-retained provider account and a previously unknown local identity. It does not alter the mailbox-rule capture contract. Capture and provider projection commit together.

The worker prepares at most five decisions from a bounded 25-row turn. It checks account ownership, app lifecycle, sync readiness, configuration/credential generations, live Inbox membership, provider received date, source removal, MIME metadata and any prior manual decision. It evaluates only stored sender and subject. Exclusions win, conditions within a rule use AND, and competing destination projects abstain. The default requires a reference plus sender/domain in the same rule. The user may explicitly select reference-only or any-rule matching instead. Rule order is presentation, not a tie breaker or probability score.

The parent coordinator resolves the exact current project ID/binding using the existing authorized-root and locally known shared-membership checks. No directory, project file, token or model authority enters the worker. Before committing, the worker repeats its checks and compares the entire prepared plan and source fingerprint. The annotation, immutable rule/configuration evidence and arrival completion commit in one encrypted transaction. No provider mutation or project copy is produced.

The public host-only HTTP classifier accepts configuration, previews, activity and versioned review actions. Private pending/commit commands are absent from that schema. The coordinator never unlocks the store. Lock, suspend, resolver replacement and host read-only state fence in-flight work; project-resolution timeout sends the arrival to review. Worker/host errors back off. Pages are byte bounded and account scoped; inaccessible destination IDs and provenance are redacted at the public project boundary.

## Persistence and user control

Schema 40 extends the existing configuration/association/audit tables and adds an account-owned arrival journal. Message purge also removes its arrival. Automatic associations retain rule names, matched signals, the selected threshold and configuration version. Keeping, correcting, clearing or undoing an automatic assignment creates a manual revision; an automatic pass never overwrites one. Review dismissal records an explicit manual No project decision. Actions compare both arrival and assignment versions, so stale undo cannot erase a later manual confirmation.

Off, configuration changes and reconnect invalidate earlier pending work. Re-enabling or saving a configuration establishes a fresh activation boundary. Backfill, import and older provider dates are not replayed. A restore preserves assignments/evidence, rotates pending edit/undo versions and sets classification Off. Work deferred for more than seven days becomes reviewable instead of assigning silently.

## Validation limits

The 469-case native provider/recovery matrix includes synthetic incremental capture, manual precedence, ambiguous/weak matches, reconnect/Off/configuration fences, late MIME changes, access failure, bounded pages, atomic failure rollback, purge, restore and a real private worker/coordinator round trip. That round trip supplies only canned provider responses and rejects other network requests. It also verifies unlock while suspended retains trusted provider settings until resume. Separate coordinator tests cover timeouts, late resolution, lock/read-only fences and error backoff. Hosted renderer tests cover policy selection, review dismissal, undo focus and manual confirmation using in-memory synthetic messages.

These tests do not certify live provider interoperability or authorize automation on private mail. Standard-profile real accounts remain Off. Project-scoped mail search, learned rules, historical batch classification, semantic/model classification and cross-device automation are not implemented by this change.
