# Standards-provider acceptance — EIG-135

Scope-freeze reconciliation, 12 September 2026, implementation baseline `1a74137dd`. The ticket remains **externally gated, not fully accepted**. Manual and iCloud connection/reconnect, strict transport validation, encrypted custody and the shared Settings flow are implemented. No live iCloud, Yahoo, Fastmail or generic-host conformance run is recorded. The successful Workspace comparison belongs to [EIG-173](live-provider-qualification.md), not to standards-provider certification.

## Current setup paths

| Provider | Available path and prerequisite | Live tested version / platform |
|---|---|---|
| iCloud | iCloud preset, `imap.mail.me.com:993`, implicit TLS; Apple app-specific password entered locally. SMTP is separate in Settings. | None; the selected account still needs its app-specific password entered by the user. |
| Yahoo | Manual IMAP using the provider's current account-specific settings and app authentication. The standard documented incoming host is `imap.mail.yahoo.com:993`; configure SMTP separately. There is no Yahoo OAuth adapter in this client. | None; authorized account and app-password eligibility are missing. |
| Fastmail | Manual `imap.fastmail.com:993`, implicit TLS, full account username and app password with Mail access; SMTP `smtp.fastmail.com:465` implicit TLS or port 587 with required STARTTLS. Basic plans do not provide third-party IMAP/SMTP access. There is no Fastmail OAuth adapter in this client. | None; authorized eligible account and Mail-scoped app password are missing. |
| Generic host 1 | Must be named from actual pilot demand; explicit host/port/username/folder setup and validated implicit TLS. | No pilot host selected or supplied. |
| Generic host 2 | A second distinct named pilot hosting service, with its own authorized account and documented setup. | No pilot host selected or supplied. |

Provider setup references checked on 12 September 2026: [Apple server settings](https://support.apple.com/en-us/102525), [Apple app-specific passwords](https://support.apple.com/en-us/102654), [Yahoo IMAP settings](https://help.yahoo.com/kb/yahoo-mail-imap-settings-sln4075.html), [Fastmail servers and ports](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports), [Fastmail app-password requirements](https://www.fastmail.help/hc/en-us/articles/1500000279921-IMAP-POP-and-SMTP). These are setup references, not evidence that a supplied account authenticated. Yahoo's current search result was available; direct page retrieval returned HTTP 429. Recheck the account's official setup page when its test account is supplied.

## Implemented capability and limit matrix

Every standards-provider row above has the following **implemented, synthetically exercised** transport surface. Actual server extensions, restrictions and limits remain unverified separately for each row; no universal IMAP support claim is made.

| Capability | Local implementation and known bound | Per-provider acceptance still required |
|---|---|---|
| Read / attachments | Original MIME and decoded content are retained locally; incoming raw message limit is 64 MiB. | Compare originals and attachment hashes, Unicode, inline images, attachment-only and large messages against each server. Account/provider limits may be lower. |
| Sync | Full selected-folder history plus incremental reconciliation, restart/cancellation and UIDVALIDITY handling. | Real arrivals, UID resets, disconnect/reconnect, offline and pause behavior. |
| Folders / flags | Server folder discovery and explicit selection; durable read/flag/move/trash actions with extension-aware behavior. | Actual special-use names, hierarchy/delimiters, permission denials and server extension behavior. No global expunge fallback. |
| Send | Separate authenticated SMTP through the durable outbox, implicit TLS or required STARTTLS; accepted/uncertain results are retained. | Controlled delivery, actual advertised SIZE limit, Sent-copy placement and lost acknowledgment. An IMAP connection does not establish SMTP access. |
| Drafts | Lossless encrypted local history plus explicit remote draft sync. IMAP uses a discovered/selected Drafts folder and source/version checks; unsupported safe deletion remains explicit. | APPENDUID/UIDPLUS/CONDSTORE conventions, conflict/recovery and actual server draft cleanup. See [draft synchronization](draft-synchronization.md). |
| Aliases | Explicit authorized sender configuration, identity-bound signatures and From validation. | A user's typed alias is not proof of provider send permission; verify each real alias and rejected identity. See [sender identities](sender-identities.md). |
| Compose / outbound attachments | 10 MiB per attachment, 20 MiB aggregate, 20 parts, 24 KiB combined draft JSON, 30 MiB encoded MIME. | Provider limits may be lower; check actual SMTP/server responses and never silently omit parts. See [compose limits](compose.md). |

The pinned transport libraries at this baseline are ImapFlow `1.7.8` and Nodemailer `10.0.1` (`apps/server/package.json`). These are client dependency versions, **not tested Yahoo/Fastmail/iCloud server versions**. For hosted services without a published server version, record the service/account tier, observed capabilities, date, app revision and OS/architecture instead of inventing a version number.

## Unchanged acceptance criteria and exact remaining inputs

1. **Manual/autoconfig setup, readable endpoint/auth errors, secure credentials and no silent TLS downgrade:** manual setup satisfies the setup alternative. Incoming IMAP requires certificate-validated implicit TLS; unsupported STARTTLS-only retrieval must produce a readable error rather than downgrade. Existing cancellation/identity/credential tests and the actual shared Settings interactions cover the local implementation. No network autoconfiguration service or provider-specific OAuth path is implied.
2. **Test supported paths for iCloud, Yahoo, Fastmail and at least two named pilot hosts:** remains open. The lead needs the iCloud password entered in Settings, authorized Yahoo/Fastmail accounts with eligible app authentication, and the names/configuration of two distinct pilot hosting services. Passwords belong only in local credential controls, not this document, chat or issue text.
3. **Publish per-provider capabilities, limits and tested versions; advertise only after conformance passes:** the matrix now records implementation and unknowns separately. Certification remains unavailable until each real provider's conformance evidence exists. Required evidence includes app revision, platform/date, observed server capabilities, read/sync/folder/draft/alias/attachment results and limits, and an explicitly authorized controlled sender/recipient for outbound cases.

The product lead owns account coordination and selection of pilot hosts; mailbox owners supply their credentials through Settings; provider/tenant administrators own eligibility and permission grants. No new account registration, sign-in attempt, live mailbox mutation, send or extra local Electron run was performed for this reconciliation. Existing personal Outlook verification remains with the lead. Do not repeat the completed Workspace comparison to compensate for missing standards-provider accounts.
