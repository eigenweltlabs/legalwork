# Timekeeping integration with an existing firm directory

The desktop is a client of the firm directory, not a replacement authority for its approval rules. This change does not require changing the firm model or creating a second set of time and invoice records.

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
3. Apply effective-dated increment, rounding, wording, reviewer and fee rules. Keep actual time separate from charge quantity and keep source originals on the originating device. Share only explicitly consented comparison fields with their submitted revision.
4. Allocate invoice numbers centrally and atomically issue the immutable invoice snapshot with an actual PDF attached to the same `invoiceFile`. A retry must return the same issued invoice and file, not allocate another number. Corrections create linked documents rather than rewriting an issued original. Protect the issued file from ordinary replacement.
5. Migrate ordinary directory drafts explicitly. Existing Draft/Submitted text labels alone are not proof of a worker-confirmed workflow revision or partner approval. Preserve record IDs, files and custom fields; do not fabricate start/end times or silently assign an owner contact as an authenticated worker.

## Storage boundaries

Private capture is a per-account JSON file in `private-timesheets`, with directory mode 0700 and file mode 0600, accessed through host-only routes on the loopback LegalWork server. It is not encrypted by the app and is not a remote attestation system. The local host stores the AI suggestions switch per account. Opening a workday refreshes the enabled activity sources. With AI suggestions enabled, the host can use the selected project chat model through session-scoped generation. The request and response do not become chat messages. The generated wording returns only to the requesting view. Scheduled drafting continues to use the local model. Connected-source reads contact the relevant provider.

Ordinary firm records enter the local Back Office outbox immediately on save and synchronize automatically. Pending/offline is a delivery state, not a privacy setting. `Draft` is a business status. Default organization sharing and finance/matter permissions govern visibility independently of that status. In the full workflow, booking already sends the entry to the service; submission changes the reviewer lifecycle. Infrastructure administrators may have access beyond the application's reviewer permissions.

## Verification

Run from `apps/server`:

```
bun test src/back-office-directory-timesheets.e2e.test.ts src/back-office-timesheet.e2e.test.ts src/back-office/files.test.ts src/time-capture
```

The directory integration test runs a synthetic HTTP firm service exposing only the existing directory protocol. It covers capability selection, error handling, identity guards, private-source access, idempotent confirmation, synchronization payloads and the prohibition on duplicate cross-workflow booking. No customer data or screenshots are included.


### Unified table and member identity (18 November 2026)

`GET /back-office/time-members` reads the existing authenticated `/api/intake/members` roster, rechecking the principal after the request. It does not create records. A normal record write may provide `timekeeperUserId`; the local server validates current membership and atomically resolves/creates an ordinary `people` relation using `sourceId = eigenwelt-member:<userId>`. The stable contact UUID includes the organization scope. These are regular records with existing audit/outbox semantics, not a new remote model. The contact link is descriptive, not another user's signature. Other time-entry writes still use their existing permission and concurrency rules.

Host-only private workday actions persist incomplete cell values and AI edits in the account-specific device file. Drafts never enter record sync. Accepting a suggestion still uses the existing booking reservation and confirmed record API. The `reconcile` action requires the current proposal digest and target record revision. It verifies the worker, service date, matter and access before linking the entry and preserving its private source. A stale target revision leaves the suggestion available for review. It publishes no extra entry. Hiding a suggestion is only a display preference; editing does not accept. This storage uses device filesystem permissions and is not independently witnessed audit evidence.

The ordinary record view keeps existing model limits: no native grouped participant allocation or work-product relation. The full timesheet service remains the authority for approvals and invoice issuance. No access to the connected mock backend's code was assumed or required.

## Requested firm capabilities

- Deliver task completion transitions with a stable event ID, task ID, project or inbox scope, UTC completion instant and authenticated actor. Include undated tasks. Keep the event stable across subsequent edits and sync retries, and distinguish a new completion after reopening. A worker’s device can then select their own completions and group them by local workday. The task snapshot currently exposes status, due date, assignee and last update.
- Support grouped time entries through the timesheet workflow. Carry the member ID, actual and chargeable minutes and confirmation per participant. Apply group creation atomically with a retry key and return stable entry IDs. The ordinary directory field `timeEntries.timekeeper` accepts one person.
- Expose the activity-code field and applicable code catalogue for directory records, or enable the existing full timesheet workflow. The current ordinary time-entry schema lacks this field. The workflow already supports codes including DFT (Drafting).
