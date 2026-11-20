# Timekeeping integration with an existing firm directory

The accepted [workspace and invoicing amendment](timekeeping-workspace-amendment.md) determines product behavior. This document identifies the existing directory operations and the additional contracts the firm service must implement.

## Available now

- `POST /api/back-office` remains the synchronization transport for `timeEntries` and `invoices`. The app uses the existing Back Office table, field validation, sharing, conflict resolution, signed local journal and outbox.
- `POST /api/back-office/files` and its prepare/commit/download flow remain the attachment transport. `invoices.invoiceFile` already stores versioned files, with matter and client relationships on the invoice record.
- A 404 or 501 from `GET /api/back-office/timesheet` exposes directory mode in the time workspace. Authentication errors, network failures and malformed responses remain errors. Workflow mutations never fall back to local organization state.
- A private proposal can prepare an ordinary record. The local `POST /back-office/records` accepts a device-only `privateProposal` reference, verifies the account, host access and original, then saves through the existing record store. This reference and raw original do not enter the record or outbox. A proposal cannot be booked once as a generic record and again through the richer workflow.

Ordinary records identify the author through record ownership and can refer to a timekeeper contact. They lack signed worker confirmation, separate actual time allocations, activity and work-product links, and effective project policies. Chargeable time needs a service day and billing client. Models with `serviceDate` store that date alongside source `startedAt` and `endedAt` timestamps, even when a clock instant’s UTC date differs from the service date. Older team models accept a date-only `YYYY-MM-DD` value in `startedAt` for duration-only work. The record sheet keeps genuine clock values until the user changes the date.

## Required before enabling the full firm workflow

Implement workflow commands centrally against the existing record identities and their revision transactions. Extra workflow metadata can live beside those records, but must not create separately editable copies of time or invoices. The existing types in `packages/types/src/timesheet.ts` describe the current client contract; the route name is not an architectural requirement if the platform provides an equivalent advertised command surface.

The service must:

1. Derive organization, user and permissions from authentication; enforce worker, author, reviewer and matter access on every read and write, including ordinary record APIs, exports and files. A client-side filter cannot establish private server drafts.
2. Return supported capabilities explicitly. Enforce optimistic revisions, idempotent creation, participant confirmation and independent review. Preserve every accepted edit and submission revision in the central audit system.
3. Apply effective-dated increment, rounding, wording, reviewer and fee rules. Keep actual time separate from charge quantity and keep source originals on the originating device. Only the confirmed service description, code, allocations and accounting metadata belong in the submitted revision. Reject legacy requests to transmit the private proposal.
4. Allocate invoice numbers centrally and atomically issue the immutable invoice snapshot with its DOCX and PDF artifacts linked to the same issued invoice. A retry must return the same issued invoice and file, not allocate another number. Corrections create linked documents rather than rewriting an issued original. Protect the issued file from ordinary replacement.
5. Migrate ordinary directory drafts explicitly. Existing Draft/Submitted text labels alone are not proof of a worker-confirmed workflow revision or partner approval. Preserve record IDs, files and custom fields; do not fabricate start/end times or silently assign an owner contact as an authenticated worker.

## Storage boundaries

Private capture uses per-account files in `private-timesheets`, with directory mode 0700 and file mode 0600, and host-only routes on the loopback LegalWork server. Both on-open and scheduled reconstruction use the selected model and the same validated evidence pipeline. Connected sources contact their providers. Connected model requests receive the evidence and billing context needed for the selected task. Day grouping receives minimal evidence. Separate wording calls receive only the resolved matter and document context. Direct generation creates no user-facing model transcript. The private device store retains editable suggestions, explicit instructions and a short chat history. Capture files use device filesystem protection. Domain-specific encryption and remote attestation are outside this interface.

Ordinary firm records enter the local Back Office outbox immediately on save and synchronize automatically. Pending/offline is a delivery state, not a privacy setting. `Draft` is a business status. Default organization sharing and finance/matter permissions govern visibility independently of that status. In the full workflow, booking already sends the entry to the service; submission changes the reviewer lifecycle. Infrastructure administrators may have access beyond the application's reviewer permissions.

## Verification

Run from `apps/server`:

```
bun test src/back-office-directory-timesheets.e2e.test.ts src/back-office-timesheet.e2e.test.ts src/back-office/files.test.ts src/time-capture
```

The directory integration test runs a synthetic HTTP firm service exposing only the existing directory protocol. It covers capability selection, error handling, identity guards, private-source access, idempotent confirmation, synchronization payloads and the prohibition on duplicate cross-workflow booking. No customer data or screenshots are included.


### Entry records and member identity

`GET /back-office/time-members` reads the existing authenticated `/api/intake/members` roster, rechecking the principal after the request. It does not create records. A normal record write may provide `timekeeperUserId`; the local server checks the actor’s current time-entry grant and atomically resolves/creates an ordinary `people` relation using `sourceId = eigenwelt-member:<userId>`. The stable contact UUID includes the organization scope. These are regular records with existing audit/outbox semantics, not a new remote model. The contact link is descriptive, not another user's signature. Other time-entry writes still use their existing permission and concurrency rules.

Host-only private workday actions persist incomplete cell values and AI edits in the account-specific device file. Drafts never enter record sync. Accepting a suggestion still uses the existing booking reservation and confirmed record API. The `reconcile` action requires the current proposal digest and target record revision. It verifies the worker, service date, matter and access before linking the entry and preserving its private source. A stale target revision leaves the suggestion available for review. It publishes no extra entry. Hiding a suggestion is only a display preference; editing does not accept. This storage uses device filesystem permissions and is not independently witnessed audit evidence.

The ordinary record view keeps existing model limits: no native grouped participant allocation or work-product relation. The full timesheet service remains the authority for approvals and invoice issuance. No access to the connected mock backend's code was assumed or required.

## Requested firm capabilities

- Deliver task completion transitions with a stable event ID, task ID, project or inbox scope, UTC completion instant and authenticated actor. Include undated tasks. Keep the event stable across subsequent edits and sync retries, and distinguish a new completion after reopening. A worker’s device can then select their own completions and group them by local workday. The task snapshot currently exposes status, due date, assignee and last update.
- Maintain the organization chart in the firm backend with stable member IDs and effective reporting lines. Maintain secretariat delegations separately, scoped to the workers the secretariat can book for. Derive effective grants from the authenticated actor and organization. The desktop consumes the result and treats self as the only available worker until the service advertises delegation.
- Advertise the actor-specific boolean `canRecordTimeFor` per member on `/api/intake/members` and per person on `/api/back-office/timesheet`. A positive flag permits recording for that person. Omission or false grants no authority over another worker. Keep worker selection separate from record visibility, private activity sources, billing review, finance access and confirmation on behalf of a worker.
- Enforce the same grants in the central write transaction for directory sync (including replayed outbox changes), workflow creates, edits, reassignments, and every participant in a grouped booking. Validate former and new assignees when moving an entry. Reject a revoked grant, peer, superior, or cross-firm target with a permission error. Attribute the change to the signed-in actor and retain the actual worker on the entry. Test self, manager, scoped secretary, unrelated employee, cross-firm attempts and revocation before sync.
- Support grouped time entries through the timesheet workflow. Carry the member ID, actual and chargeable minutes and confirmation per participant. Apply group creation atomically with a retry key and return stable entry IDs. The ordinary directory field `timeEntries.timekeeper` accepts one person.
- Expose the activity-code field and applicable code catalogue for directory records, or enable the existing full timesheet workflow. The current ordinary time-entry schema lacks this field. The workflow already supports codes including DFT (Drafting).

### Document wording, invoice periods and Word templates

- Provide a stable document ID and revision on create, save, rename and move events. Link it to the matter’s work product. Expose its approved billing title and latest confirmed descriptions to an authorized contributor. A corrected title such as “Revision” must follow that document across dates and renames. Two identically named files must retain separate histories. Preserve the source event and prior issued wording.
- Make uploaded billing guidelines available as versioned, matter-scoped rules with effective dates, language, DFT/MOD opening words and approved terminology. Identify the applicable version for a service date. The private drafting request should use those rules, authorized prior entries for the same document, and a supported change summary when available. Respect the model’s data-sharing permissions. A file save alone establishes the action and title. A concrete change description needs evidence or worker input. Recheck the same rules at partner review.
- Let billing users select a service-date range or all approved, unbilled entries for hourly or fixed-price invoicing through a cutoff for the chosen client, matter and currency. Include older work approved after the previous invoice. Keep each entry’s invoicing status, invoice ID and approved revision consistent across all firm clients. Test overlapping periods, backdated entries, two issuers and idempotent retries.
- Support a versioned firm DOCX invoice template editable in Word. Preview it using the exact approved statement, fee lines, currency and totals. Bind the final partner release to the statement and template revisions before issuing. A change to either requires renewed approval. On issuance render and store the DOCX/PDF pair, number, template revision and line links together. Retrieving or retrying the issued invoice must return the same document. Preserve historical PDFs after template changes and recover from conversion failures without charging the entries twice.

## Accepted workspace and invoice contract (20 November 2026)

[The accepted amendment](timekeeping-workspace-amendment.md) supersedes earlier product plans. The private device service reconstructs day-level evidence and keeps private suggestions, chat and learning scoped to the active account. Accepting a proposal or finishing a manual line uses the existing authorized record or timesheet path. Window observations and running-agent intervals do not belong in the firm sync payload.

A firm implementing the full invoice workflow advertises `supportsInvoiceDrafts` on its authenticated timesheet state. `prepareInvoice` builds a matter/recipient/period selection with versioned lines, selected adjustments and the active template revision. `approveInvoice` pins the exact content revision and reviewer. `issueInvoice` checks that same revision, assigns one number and links the included positions atomically. Replaying a request or retrieving its documents must return the same invoice. `supportsInvoiceWordingReview` separately enables optional AI review. The shared request and response types are in `packages/types/src/timesheet.ts`.

Return both artifacts from the issuing authority. The authorized `POST /api/back-office/timesheet/template-preview` validates the proposed Word template and returns its sample PDF. The connected service's authenticated `GET /api/back-office/timesheet/drafts/:id/document?format=docx|pdf` returns the requested format and contentBase64; the issued counterpart under `/invoices/:id/document` also returns its number. Both files derive from the frozen recipient, approved lines and versioned Word template. The local authority stores the pair together. An interrupted generation is recoverable from the same invoice snapshot. For historical HTML-only invoices the original document remains available.

The firm team owns the organization hierarchy and authorized directory projection, delegated secretariat/billing roles, central document identities and revision evidence, effective shared guideline uploads, consolidated pricing, concurrency-safe numbering, revocation and immutable archive. The client consumes advertised capabilities. Ordinary records do not stand in for these authorities. Tariff invoicing is deferred.
