# Native JMAP and on-premises Exchange evaluation

MAIL-160, 1 November 2026. These are follow-on adapters, excluded from the core release. No native JMAP or EWS account is registered by this change. No real provider account, tenant, server or sending permission was used.

## Decision

Keep one Email client and one Integrations account system. A future Fastmail integration should own its authentication, refresh, identity and write controls, then expose JMAP through the existing mail worker. An on-premises Exchange integration needs the same ownership with an explicitly approved server and authentication authority. Neither should add a second inbox, composer, credential store or outbound queue.

Fastmail over configured IMAP/SMTP remains a separate path through **Settings > Integrations > Communication > iCloud / IMAP / SMTP**. Its live certification is still open in MAIL-135. A JMAP protocol experiment does not certify that path. Native JMAP is the smaller follow-on candidate; EWS needs a named customer configuration before implementation scope can be committed.

## Fastmail and the existing contracts

Fastmail publishes its JMAP session at `https://api.fastmail.com/jmap/session`. Distributed apps should use OAuth; personal API tokens are for JMAP, while app passwords serve other protocols. Its native-client OAuth documentation permits public clients with loopback/private-scheme redirects and describes registration/metadata options. This is an Integrations implementation task, not permission to reuse a Gmail/Graph token or an IMAP password. [Fastmail developer documentation](https://www.fastmail.com/dev/).

JMAP has separate Email, Mailbox and submission capabilities. Email IDs identify objects independently of RFC Message-ID; blob IDs address raw message octets. Mailbox memberships and keywords map to the client's folders and read/flag state. Upload plus Email/import can preserve a reviewed MIME snapshot before a separate submission. An identity's advertised sender rights still need checking; a successful read grant is insufficient. [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html).

| Existing LegalWork contract | Required native JMAP work |
| --- | --- |
| Account and immutable message identity | Add a reviewed `jmap` provider migration and account-scoped remote account/Email IDs. Keep blob and thread IDs distinct. Never impersonate Gmail, Graph, IMAP or archive identities. |
| Integrations custody and access gates | Add Fastmail OAuth in Integrations. Bind local account identity to the authenticated remote account, recheck effective capabilities, and fence disconnect/reconnect generations. Shared accounts need their own rights. |
| Encrypted originals and projections | Stream downloaded originals into the existing chunked encrypted content store and MIME projector. Metadata discovery alone must not mark content or attachments complete. Preserve original bytes for exports. |
| Sync journal | Persist independent Mailbox, Email and query states only with their durable observations. Rebaseline without deleting retained originals when the server can no longer calculate changes. |
| Mutation journal | Use reviewed Email state for `ifInState`; keep conflicts visible. Read/flag patches and mailbox membership changes must preserve unrelated fields. Respect per-object failures even under HTTP 200. |
| Drafts and Outbox | Adapt draft import/update and sender identities to the current versioned drafts and immutable Outbox. Keep one dispatch authority; an interrupted submission stays uncertain until evidence resolves it. |
| Rules, snooze, assistant and matter access | Reuse the existing policy boundaries. Add trusted incremental arrival provenance before enabling local rules. A new transport does not grant assistant, matter or cross-account access. |

JMAP state strings are opaque, and query state is not Email state. `ifInState` provides a server-side state check; it applies to the relevant data type/account, so unrelated mailbox activity can cause conflicts. A method response can succeed while individual objects fail. An expired changes cursor requires invalidation/re-enumeration, not treating an empty result as mass deletion. [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html).

## Measured headless prototype

Run from the repository root:

```sh
node apps/server/scripts/mail-acceptance.mjs --suite providers/jmap-evaluation
```

The injected transport uses synthetic RFC-shaped responses only. It has no default network transport, token input, OAuth browser flow or live mode. It is deliberately limited to one approved example origin; a real Fastmail session's download/CDN origins require separate review. JSON responses are capped at 256 KiB, raw examples at 1 MiB, batches at 100 objects or the smaller advertised limit, and enumeration at ten pages. These experiment limits are not proposed product attachment limits.

Twelve cases cover account/capability selection, three-page and empty baselines, smaller server limits, a changing baseline, two-page opaque delta states, expired state after a partial page, state conflicts, object-level rejection, successful read patches, endpoint/size/account/correlation checks, encrypted original storage, and durable uncertain outcomes after restart.

The fixed 205-message example makes **7 metadata/session requests**, then **1 original download**: **8 requests, 25,777 response bytes, largest response 11,506 bytes**. The suite emits elapsed time for diagnosis. These deterministic counts describe an injected fixture, not Fastmail latency, bandwidth, mailbox completeness or a large-mailbox benchmark. Only one original is downloaded in this measurement.

The prototype confirms two current implementation gaps rather than hiding them:

- The production account and message schemas reject `jmap`. No native provider metadata is persisted under another provider's identity.
- Offline archive accounts reject outbound journal entries. Original-storage reuse is exercised through an explicit archive fixture; provider-independent dispatch/restart behavior uses a separate supported IMAP fixture account without credentials. Neither is a native JMAP account or a live adapter qualification.

The optional evaluation is excluded from both default native suites and the provider-release manifest. It must be requested explicitly and must not be counted as certified provider support.

## On-premises Exchange configurations

Microsoft's supportability matrix identifies Exchange Server Subscription Edition as supported; Exchange 2016/2019 reached end of support on 14 October 2025. Do not use an old protocol reference's version list as a current support promise. Qualification must record the exact SE build, OS, security updates, proxy/TLS setup and authentication policy supplied by the customer's administrator. [Supportability matrix](https://learn.microsoft.com/en-us/exchange/plan-and-deploy/supportability-matrix?view=exchserver-se).

| Reference configuration assessed | Access and LegalWork implication | Qualification still required |
| --- | --- | --- |
| SE, administrator-enabled direct TLS IMAP on 993, permitted password authentication | Candidate for the existing IMAP adapter and Integrations setup. SMTP must be configured and tested independently. Do not enable a service or weaken the customer's authentication policy automatically. | Exact host/build, trusted TLS chain, enabled auth mechanism, mailbox rights, UID behavior, folders, large MIME, reconnect and SMTP/alias rights. |
| SE with pure on-premises AD FS Modern Authentication | EWS is a candidate for a separate adapter and resource-specific OAuth support. The documented AD FS protocol table supports EWS but not IMAP. | Tenant/server authority, app registration, redirect and audience, conditional-access policy, delegated mailbox rights and supported desktop flow. |
| SE with classic hybrid deployment and Hybrid Modern Authentication | EWS remains a separate on-premises resource. The documented HMA table supports EWS but not IMAP. An Entra login alone cannot establish protocol or mailbox access. | Actual classic hybrid topology, approved service URLs/SPNs and token resource, proxy/Extended Protection configuration, mailbox and send rights. |
| Exchange Online mailbox in a hybrid organization | Use the existing Outlook Email Graph integration for that cloud mailbox. Do not add an Exchange Online EWS fallback. | Existing MAIL-173 live Graph acceptance. |
| Exchange 2016/2019 or an unspecified legacy server | No new product support claim or default certification target. Migration/support context must be resolved with the administrator before a pilot is scoped. | Supported target and named requirement. |

IMAP connectivity is disabled by default in Exchange and requires server configuration; the official procedure also treats authenticated SMTP configuration separately. Our adapter currently requires direct TLS, so a host offering only STARTTLS is outside that implementation. [Exchange IMAP configuration](https://learn.microsoft.com/en-us/exchange/clients/pop3-and-imap4/configure-imap4). The EWS/IMAP authentication distinctions above come from Microsoft's [AD FS protocol table](https://learn.microsoft.com/en-us/exchange/plan-and-deploy/post-installation-tasks/enable-modern-auth-in-exchange-server-on-premises) and [HMA protocol table](https://learn.microsoft.com/en-us/microsoft-365/enterprise/configure-exchange-server-for-hybrid-modern-authentication).

Graph's former hybrid REST access to on-premises mailboxes became unavailable in July 2023. Exchange Online's EWS retirement is a different boundary, with full retirement scheduled for 1 April 2027; it does not establish on-premises EWS access or compatibility. [Hybrid REST deprecation](https://learn.microsoft.com/en-us/graph/hybrid-rest-support), [Exchange Online EWS retirement](https://learn.microsoft.com/en-us/skypeforbusiness/hybrid/prepare-for-ews-retirement).

EWS needs its own hierarchy sync and per-folder item state, with bounded GetItem/MIME retrieval and throttling. Notifications are hints, not a replacement for durable sync state. EWS Item IDs can change on move; ChangeKey identifies the observed item version. Do not reuse Graph's immutable-ID assumptions or infer identity from RFC Message-ID/body hash. [EWS synchronization](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/mailbox-synchronization-and-ews-in-exchange), [EWS identifiers](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/ews-identifiers-in-exchange).

A future EWS probe must run against an authorized exact configuration and measure initial/incremental sync, invalid cursors, moves, duplicate Message-IDs, denied MIME/attachments, server busy/backoff and lost mutation/send responses. Safe XML parsing needs response limits and disabled external entities; endpoint discovery must not forward credentials to an arbitrary redirect or server. The same encrypted content store, journal and access policies remain the target. No EWS wire prototype or real Exchange compatibility test is claimed here.

## Demand gate and implementation split

No named customer request, authorized Fastmail test account or exact on-premises pilot configuration is established in this ticket. MAIL-135's live standards-provider gate and MAIL-156's core release gate remain open. Do not manufacture demand or split implementation projects merely because an optional protocol exists.

If demand justifies work, create two separately estimated tracks:

1. Native Fastmail/JMAP: Integrations OAuth/identity, provider migration, resumable baseline/delta, originals, drafts/actions/Outbox, and live conformance. Initial planning range: 6-10 engineer-weeks plus 1-2 specialist-weeks of independent review/remediation.
2. On-premises Exchange: first a 1-2 engineer-week authorized configuration/authentication and wire spike. Re-estimate from its evidence; a complete EWS adapter is provisionally 10-18 further engineer-weeks plus 2-3 specialist-weeks of review. An existing-IMAP-only certification is a smaller, separate scope and cannot certify EWS.

These are scope estimates, not measured delivery commitments. Before either track starts, name its customer requirement, test environment, supported platforms, allowed actions and acceptance evidence. Keep the conditional implementation-split criterion open in Kaneo until that evidence exists.
