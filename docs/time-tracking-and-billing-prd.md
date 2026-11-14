# LegalWork time tracking and billing

_Product requirements   /   Revision 4   /   14 November 2026_

> The repository findings below describe the pre-implementation review at `bd1dfc3f`. Page numbers refer to the paginated revision 4. The [review addendum](#review-addendum--14-november-2026) records the later list interaction decisions and the scope of this draft.

A lawyer records work in an editable day or week list, often that evening or the next morning. A private activity calendar helps reconstruct the day. The firm reviews submitted work across contributors, applies client billing terms and issues a numbered invoice from the approved statement.

## What the lawyer and reviewer see

At the end of the day the lawyer can see a suggestion for a particular memo, correct its duration or narrative by voice or text, and confirm it. A colleague amending that memo tomorrow can find it in the same matter. Each contribution keeps its own author, date and duration.

When the lawyer submits the reviewer sees the submitted text alongside suggested fixes. A client can require “Amending memo on disclosure” even if the lawyer wrote “Memo on disclosure amended”. The reviewer can accept the wording without editing the recorded work.

When billing is due the reviewer can see hours and fees for the memo, each contributor and the matter as a whole. The approved statement fixes the figures and wording used for the invoice. Finance can retrieve the exact document that was issued.

## Changes to the original design

In Project > Billing settings, “Enforce billing increment” controls which billable durations can be saved. The proposed default is On, with a 10-minute increment. A 6-minute agreement uses 6, 12, 18 and subsequent multiples. The list and activity calendar preserve actual time. Team submission receives a second human review. Solo self-approval remains a distinct policy decision.

The new requirements also cover activity codes, persistent work products, guideline checks and a verifiable history from first manual save or acceptance of a suggestion. The design builds on the existing Back Office finance records and signed history.

## Document guide

| Pages | Contents |
| --- | --- |
| 2 | Repository findings and links to the reviewed source |
| 3–5 | Billing preferences, daily entry and work products |
| 6–7 | Submission, review, revision evidence and invoice issuance |
| 8–9 | Acceptance cases, open decisions and original requirement mapping |
| Final page | Editable lists, shared meetings and keyboard acceptance cases |

## What LegalWork already supports

Static review of eigenweltlabs/legalwork on dev at bd1dfc3f, 14 November 2026. Nine open PRs were screened. None introduces a native timesheet workflow. The finance fields in the stacked launcher PR #323 are already on dev. The findings cover the public desktop and server repository. Hosted platform behaviour and installed builds were outside this review.

| Area | Implemented or reusable | Work still needed for this PRD |
| --- | --- | --- |
| Matter and policy | Matter and client records, project links and a project field that can reference a fee agreement. Agreements store hourly rates, an increment in minutes and terms. | Effective-dated preferences, a project enforcement switch, default of 10 minutes, activity exceptions, language and narrative checks. |
| Time and billing | Editable time entries have a timekeeper, start/end, actual and billable minutes, rate, private note, narrative and status. Finance visibility is enforced. | Local suggestions, daily review, submission of specific revisions, a second reviewer and enforcement across every write path. |
| Evidence | Back Office records already have signed before/after changes, history display and verifiable exports. Tests cover tampering and transaction rollback. | Link suggestion, confirmed entry, subsequent edits, reviewer decisions, statement and invoice. Keep private evidence local. |
| Events and documents | Calendar, tasks and connected mail yield events. Workflows, scheduling, dictation and a Word template filler exist. | A timesheet-specific source/permission boundary, local processing, matter grid, work-product ledger and approved-data mapping into an invoice. |
| Invoicing | Invoice records carry a number, totals, status, original-invoice link and PDF field. Billing items represent fees or expenses. | Immutable statement version, authoritative number allocation, issue-and-attach recovery, and duplicate-billing prevention. |
| Actaport | With Finance and write access enabled, the connector can create or update external time entries and read invoices. | Those operations belong to Actaport. Native review, numbering and evidence still need their own workflow. |

### Source evidence

[Finance model and status fields](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/packages/types/src/back-office.ts#L354-L427)   ·   [Back Office guide](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/user-guide/back-office.md#L79-L95)   ·   [Project agreement link test](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/project-store.test.ts#L185-L193)

[Signed journal and limits](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/back-office-revisions.md#L9-L25)   ·   [Journal tests](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/back-office/journal.test.ts#L103-L170)   ·   [Finance permission tests](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/back-office/back-office.test.ts#L290-L328)

[Event collection](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/assistant-event-sources.ts#L131-L179)   ·   [Schedules](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/user-guide/scheduled-tasks.md#L5-L22)   ·   [Editable skills](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/user-guide/skills-workflows.md#L5-L17)   ·   [Dictation](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/system-wide-dictation.md)

[Word template filler](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/resources/core-opencode/skills/docx-edit/assets/populate-template.py#L1-L6)   ·   [Actaport finance tools](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/packages/actaport-mcp/toolsets.json#L55-L78)

### Roles and responsibility in the current implementation

The platform supplies account membership and an organisation policy. For shared Back Office, the LegalWork server derives model administration, record editing and finance access per user. An organisation admin has the first two automatically. Finance requires explicit membership. The local-only directory gives its local identity all three. In shared projects, owner and member govern sharing. A People type such as Partner and a project field naming the responsible partner record business responsibility. Timesheet approval still needs an enforced permission tied to the acting user and the submitted work.

[Platform policy](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/org-policy.ts#L308-L347)   ·   [Back Office rights](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/apps/server/src/back-office/access.ts#L22-L55)   ·   [People types](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/user-guide/back-office.md#L63-L67)   ·   [Project assignments](https://github.com/eigenweltlabs/legalwork/blob/bd1dfc3fa3773d178588cf52534c5c96ca1fb645/docs/user-guide/projects-sharing.md#L36-L46)

## Billing preferences

An authorised user can save client terms and open Project > Billing settings to see the effective increment, its source and effective date. Each project has a two-state “Enforce billing increment” switch. Proposed starting state for a new project is On. A binding client agreement can require enforcement. Show the reason and who may authorise an exception.

### How terms are selected

Proposed precedence is firm default, then client, then applicable matter agreement, then an expressly authorised project exception. Resolve each field separately. A blank value inherits. A project can tighten a client rule. Relaxing a binding client term requires a documented, authorised exception. Where several clients or agreements fit, ask the user to identify the bill-to client and agreement before submission.

| Preference | Required behaviour |
| --- | --- |
| Billing increment | Default 10 minutes. The client or project agreement can select 6 or another positive increment. With the switch On, each positive billable duration must be a whole multiple of that increment. At 10, the choices are 10, 20, 30 and so on. With it Off, 4 and 6 minutes may be entered as separate billable lines on the same day. |
| Rounding | Validate every billable entry at save, submit, reviewer edit, approval and issue, including agent, import and API writes. The day total cannot validate two invalid lines. Retain exact worked time. If a rounding rule is configured, preview its result. Otherwise ask the user to choose a permitted amount. A full write-off can still carry zero billable minutes. |
| External time limit | Proposed meaning of the 120-minute default is per billable position for external work. A 150-minute session remains 150 recorded minutes. Show the breach and hold that line for review. The reviewer can reduce the charge or apply an authorised activity exception. No silent splitting or truncation. |
| Activity exceptions | Set a different maximum for a named activity and scope, for example 180 minutes for data room review on one matter. An exception for review does not automatically extend to drafting the due diligence report. Internal work can have its own policy. |
| Narrative | Store the billing language, activity-specific action words, word order, permitted abbreviations and a sample. A client can require English and opening verbs such as Drafting or Amending. The application language is independent. |
| Changes over time | Select terms by service date. Save the rule version and effective value with the entry and the approved statement. Show any deliberate repricing or reassignment as a new reviewable adjustment. |

### Acceptance

With enforcement On at 10 minutes, reject separate billable lines of 4 and 6 even if their total is 10. With enforcement Off, accept both. With enforcement On at 6, accept 6 and 12. Changing mode, project or client previews affected open lines. Pin the effective rule and switch state to the approved version.

## Daily capture and manual entry

### Choose sources and generate suggestions

Settings lists each supported system, application, platform and calendar source with its permission and capture state. Disabling a source stops new events immediately. The user sets an interval or requests suggestions for a selected day. Both paths use the current Suggest Timesheet skill, editable in Workflows. Resolve matters from Back Office or another permitted source named in that skill.

Every step that reads raw events executes on the device. Raw events stay out of remote model calls, connector requests, telemetry, shared records, audit exports and invoices. A workflow may consult an enabled connector using permitted lookup data. It cannot enable a disabled source. A generic scheduled agent with a remotely hosted model does not meet these conditions simply because the schedule runs on a desktop.

### Review a day or enter time from memory

Open the personal list on any work date. In the optional AI workday view, the timeline shows real clock times vertically and initially shows only matters with suggestions. If two of twenty matters have suggestions, show two columns. The user can add a matter for a manual entry. Each column shows its own effective billing increment. Mixed increments do not distort the shared time axis.

Distinguish calendar context, unconfirmed suggestions and confirmed entries. An overlapping calendar appointment and app event can support one suggestion. Neither becomes billable automatically. The user can correct the time range, matter, activity, work product or narrative directly, by text or by voice. A request to move twelve actual minutes to another matter previews both actual and proposed billable minutes before confirmation.

Manual entry works with every activity source disabled. A user records date, start/end or duration, matter, bill-to client when needed, activity, narrative and an optional or required work product according to the activity. A duration-only entry marks clock times unknown. It does not fabricate a start or end. New manual entries record the acting user and contributor separately when a colleague records the work. See the editable list requirements on the final page.

### Confirm selected entries

Confirm or dismiss suggestions individually. An accepted entry is linked to the matter and authenticated contributor. Keep the original proposed billing fields locally alongside the first accepted version, including user changes before acceptance. A manual entry starts its history on its first deliberate save. Re-running a day preserves confirmed entries and does not recreate the same work.

Unconfirmed suggestions remain personal and out of billing. At confirmation, only confirmed billing details enter shared records. Acceptance, submission and approval are three visible actions. The first records work, the second sends a version for review, and the third fixes the client-facing statement.

## Activities and work products

An activity describes what a person did. A work product identifies the particular deliverable in the matter, such as the reply brief dated 12 May. Many time entries can point to it. A product has a stable ID, matter, title, type, creator and creation date. A file or email is an optional link. Renaming it or moving an attached file preserves the product identity.

| Activity family | Starter catalogue and item behaviour |
| --- | --- |
| Research and preparation | RES for research. Separate choices for studying the case file and strategy. Link an existing work product where relevant. |
| Meetings and calls | External appointment, internal meeting and phone call. Record the correct activity even when no document results. |
| Correspondence | External email short, external email long, internal email, short letter and long letter. EML can create an email item directly. Select the subtype and identify the subject or deliverable. |
| Drafting | DFT creates a work product on first drafting, or links to the identified existing one. Offer pleading, memo, letter, email and due diligence report as types. The catalogue includes drafting a pleading and drafting a data room due diligence report. |
| Review and amendment | Data room review is a distinct activity with its own cap exception. MOD or Amending selects the concrete existing product in the current matter. A later contributor records a new entry against that product. |

The firm can maintain activity labels and codes while retaining historical meanings. RES, DFT, MOD and EML are the proposed shorthand. Confirm the DFT/BFT transcription and final codes before release. Keep document type, activity and the individual work product independently selectable.

### From first draft to cost per document

Anna records 40 minutes drafting a reply brief at EUR 300/hour. Ben selects MOD in the same matter and sees that brief, its creator, creation date and distinguishing title. He selects it and records 20 minutes at EUR 240/hour. A second brief with the same title or a brief in another matter must not receive his entry by inference. Search is permission-filtered. An older imported brief can be explicitly registered once and selected.

At these exact billable durations, the product shows 60 recorded minutes, 60 billable minutes and EUR 280 in fees. If Ben’s approved line becomes 10 billable minutes, the product still shows 60 recorded, now 50 approved and EUR 240 in approved fees. Show invoiced fees separately when issued. The same lines roll up by contributor, matter and client without duplicate counting.

Use the effective rate and currency for each line. Keep currencies separate. If a rate or a flat-fee allocation is missing, show the time and mark the monetary allocation unresolved. An internal cost figure would require a separate cost rate. A billable charge is a client fee.

## Submission and independent review

The worker submits a version of their timesheet for a defined period. A compact, cell-editable billing list selects a matter and a period and brings together eligible submitted entries across people. It shows the version of each entry under review, individual subtotals and the combined total. Confirmed but unsubmitted work can be identified as pending.

### Check wording against the client’s rules

On submission, check the submitted billing text automatically. Show proposals when the reviewer opens the queue and offer a Check billing text action to rerun after edits. Show suggested corrections for spelling, billing language and activity wording, with the applicable rule, before/after text and the affected entries. A reviewer can accept a single suggestion, accept a previewed selection, edit it, decline it or return the entry. Suggestions have no effect until a person accepts them.

For “Memo XY amended”, an English action-first rule suggests “Amending memo XY”. The proposed correction preserves the activity, work product, contributor, duration, rate and matter. If the source lacks enough information for an accurate narrative, ask for clarification. A change to a charge or a fact is a separate, explicit decision.

### Who can approve

The proposed team default requires a second authorised individual after submission, whether the firm designates Back Office or a partner. For combined statements, the checker cannot approve their own contributed lines. Another authorised person reviews those lines. Finance visibility and an occupational title are insufficient on their own to grant approval authority.

The original permits solo self-approval. Preserve it as an explicitly enabled firm policy with a visible self-approval event. If the firm requires independent review and an eligible reviewer is unavailable, retain the submission in the queue. A correction to a submitted entry creates a new revision, marks the old review stale and requires resubmission or explicit review of the replacement.

For the proposed billing workflow, let the firm assign an eligible reviewer per project and bind that assignment to an authenticated account. At approval, the server checks the assignment, current permissions, contributor identity and submitted revision. A change to a directory title or project label alone cannot grant approval.

### What the history proves

Record the first manual save or the accepted suggestion, then every saved change that day or later. Store before/after, author and role, time, source, version IDs, policy version and links to the original entry and work product. Preserve worker edits, submissions, reviewer suggestions and decisions, write-downs, approvals and later adjustments. An agent suggestion and the human who accepted it are distinguishable.

Use the existing signed Back Office journal for eligible business records. Keep the original proposal’s billing fields private on device and bind them to acceptance through a verifiable reference. At submission the worker can preview and explicitly share a billing-only comparison of original suggestion and accepted text, time and activity for that entry. An authorised reviewer can then compare original, confirmed, submitted and final versions. Withheld values appear as private. Raw event evidence and private notes stay out of the review packet. A failed journal append must also fail the associated business change.

Approval pins the precise descriptions, quantities, contributors, work products, rate versions and totals. Later changes create a linked amendment or adjustment with its own approval. The issued copy and its underlying approved version remain retrievable.

## Invoices and release requirements

### Issue a numbered copy from the approved statement

Create Invoice accepts an approved statement version and a selected firm template. Deterministic document automation fills its approved narratives, quantities and amounts. A preview consumes no number. The issuance service checks eligibility, reserves the approved lines against duplicate invoicing, assigns the next firm number atomically and links the final document to the invoice record and statement version.

The final document and record carry the same number. Concurrent issuance of two distinct invoices yields two distinct sequential numbers. A repeated request for the same invoice reuses its record and number. If storage fails after allocation, show a recoverable pending-document state and attach on retry. If allocation authority is unavailable, keep the draft available for preview and defer issuance.

Retrieve the issued copy from Back Office. With restricted permissions, only authorised users may see payment amounts, original documents and historical details. An external connector may be used where authorised. Its side effects and identifiers must be reconciled explicitly if the firm also uses native billing.

### Release checks on Windows and macOS

Test every supported source on each operating system. Record source, platform, event time and result. Deny, revoke and restore access while capturing. Verify exclusion when disabled and resumption when permitted. Exercise scheduled and manual runs against the same event set and current skill, including duplicate and overlapping events.

Use a distinctive synthetic raw event. Inspect outbound model and connector requests, telemetry, shared Back Office writes, signed exports and invoices. Verify that only permitted confirmed billing details leave the private capture boundary. Repeat with a remote provider configured and with unavailable local processing. Manual entry remains available.

### Schema audit and protected migration

Audit the existing model, write routes, permissions and hosted counterpart before choosing migrations. Identify fields and constraints that can be reused. Verify that generic record edits, imports, agent tools, sync and retry cannot bypass reviewer separation, history or invoice uniqueness. Firm-wide allocation needs an authoritative writer shared by all issuers.

If changes are needed, ship a versioned migration. Rehearse on a populated copy with historical time entries, attachments, permissions and existing numbers. Verify recovery and recognisable pre-migration baselines. Reconcile ambiguous legacy statuses or numbers before issuance. When the last issued number is 1042 the next is 1043. Concurrent issuance and attachment retries preserve uniqueness.

History verification distinguishes a valid local chain from one anchored to an independently retained trusted checkpoint. Use existing export verification when proof beyond the device is needed. Preserve access filtering throughout history and exports.

## Acceptance cases and decisions

| Case | Observable result |
| --- | --- |
| Mixed policies | For a 10-minute project with enforcement On, reject 4 and 6 as separate billable entries, even for the same day. Accept 10, 20 and 30. With enforcement Off, accept 4 and 6. On a strict 6-minute project accept 6 and 12, reject 10. Recheck a reviewer edit and an API import. Preserve actual minutes and prior approved versions. |
| Cap and exception | A 150-minute external call against a 120-minute cap is flagged. One 150-minute data room review is eligible when its authorised activity limit is 180. The original duration survives review. Splitting the call solely to evade the limit is flagged. |
| Work product | Two contributors select DFT then MOD on one brief. A separate EML entry creates an email product without DFT. Renaming the brief preserves its contributors, time and charges. The worked fees example on page 5 reconciles to its matter. |
| Original PRD arithmetic | Under the 6-minute client policy, 48 + 30 = 78 billable minutes. Writing down the second contribution by 6 gives 24 and a total of 72. The worker’s 30 recorded minutes and the reviewer’s reason remain visible to authorised users. |
| Independent review | Auto-suggested wording is compared with the submitted text. A worker’s later edit invalidates a pending suggestion. A partner who contributed cannot approve their own lines in team mode. Concurrent reviewers cannot approve competing versions. |
| Revision evidence | Compare the private original proposal, first accepted version, next-day correction and reviewer decision using authorised views. Editing or removing a signed revision breaks verification. With injected audit failure, neither entry change nor approval commits. |
| Invoice recovery | The preview allocates no number. With 1042 already issued, two new invoices receive 1043 and 1044. Attachment failure on 1043 resumes on that record. An approved line already used cannot be billed twice. |

### Decisions for product review

1. Confirm the 120-minute limit is per external billable position and who can approve an exception. If a client caps a person’s daily total or an entire activity instead, specify that scope separately.

2. Per-entry multiples and the project switch are specified. Confirm the initial On setting, the default rounding direction for proposed charges and who may authorise an exception to a binding client term. A 10-minute increment alone does not determine whether 11 actual minutes should be billed as 10 or 20.

3. Confirm whether any firm may opt into solo self-approval, grant final authority to Back Office, or require partner sign-off. The team flow uses a second person by default.

4. Confirm the remaining activity abbreviations and the fee allocation approach for fixed-fee work products. Time and hourly client charges can already be specified independently of that decision.

## Changes from the original PRD

This crosswalk identifies the substantive revisions to the four-page product requirements document dated 13 November 2026. Page references on the left refer to that source. The numbered stories and their release tests can be traced below.

| Original requirement | Disposition and location in this revision |
| --- | --- |
| p1 · Product goal | Expanded. Recalled work and private suggestions still become matter-linked time. Manual entry, work-product fees and the independent team review are now explicit. See pp. 1, 4–6. |
| pp1–2 · Six-minute suggestions and grid | Replaced the universal six-minute grid with actual-time capture and a project billing switch. With enforcement On, each billable line follows the effective increment (default 10). With it Off, free minute amounts are valid. Six-minute client terms and the original arithmetic remain available. See pp. 3, 4 and 8. |
| p2 · Story 1 · Sources and skill | Retained source controls, permissions, interval and on-demand runs, editable skill, optional enabled connectors and local-only processing. Added controls for audit exports and unavailable local processing. See pp. 4 and 7. |
| p2 · Story 2 · Daily review and lock | Retained matter columns, calendar context, editable blocks, voice/text correction, selective acceptance, dismissal and duplicate prevention. Clarified lock as a preserved first accepted version. Later corrections append revisions. Manual saves start a baseline. See pp. 4 and 6. |
| p3 · Story 3 · Combined bill and approval | Retained review by matter, period and contributor, manual and agent-assisted adjustments, subtotals and frozen approved output. Added submission, optional sharing of a billing-only proposal comparison, automatic wording checks and product-level rollups. Changed general self-approval to an explicit solo-policy option. See pp. 5, 6 and 8. |
| p3 · Story 4 · Final invoice | Retained approved input, firm template, deterministic preview, issue-time numbering, document retrieval, concurrent numbering and retry on the same record. Added explicit line-level duplicate checks. See pp. 7 and 8. |
| p4 · Release requirements | Retained per-source Windows/macOS tests, privacy checks, schema audit, protected migration, recovery on populated data and numbering continuity. Extended tests to include the policy, reviewer and evidence cases. See pp. 7 and 8. |

### Additions requested in this revision

Client and project billing preferences, activity-specific maximums, billing language and wording, a maintained activity catalogue, persistent deliverables across contributors, a direct manual-entry path, a second review with proposed corrections, and a verifiable revision history starting with the worker’s first saved or accepted entry.

### Changes since revision 2

Specified the project switch, per-entry validation and free-minute mode. Kept rounding as a separate question for suggested charges. Added the current source of permissions and distinguished project responsibility from approval authority. See pp. 2, 3, 6 and 8.

## Editable time and review lists

Revision 4 makes the personal day list the entry point. The week shows the same editable rows and daily totals. Calendar evidence stays in the AI workday view. This revises the placement of the original daily timeline and keeps its capture, correction and confirmation workflow.

### Enter and correct time in the grid

Keep one input row visible throughout entry. Carry the work date, previous matter and current contributor forward. Accept duration alone. Tab and Shift+Tab traverse fields. Enter saves a completed line and keeps the keyboard in the list. A click on an existing editable value focuses that exact cell. Escape discards its uncommitted row edits. Editing and validating a duration or narrative takes place within the table.

Match clients and matters by name or file reference. Offer activity codes and matching work products. MOD searches only the selected matter. Permit a new product title or an independent narrative. Reusing a title must retain its product identity across contributors. Show worked time, its billable and non-billable portions, and the proposed chargeable duration separately. A write-down may reduce the charge while leaving billable work time intact.

### Record a meeting for colleagues

An authorised contributor can enter a line for a colleague alone or select multiple attendees. Store creator and worker separately. Give the meeting one shared identifier and each worker one personal line. Proposed policy: colleagues confirm or decline their own copy before it enters their totals or a submission. A retry or a matching calendar event must not duplicate a participant’s time. Changes to one attendee’s duration leave the others’ lines intact.

### Review three weeks of fees

Show one compact row per submitted position and the total for the period. Reviewers can filter to policy or wording exceptions, edit the narrative and billing duration in place, and compare original, proposed and approved versions on demand. Show the selected count and fee before batch approval. Approval pins the exact revisions reviewed and checks permission and policy on the server.

### Acceptance

Enter 14 retrospective lines without a mouse or dialog. Correct a saved narrative and charge in its own cells. Confirm totals and the recorded before/after values. Record one meeting for two people and verify one confirmed line per attendee. Review 56 lines worth EUR 15,000 over three weeks, resolve a wording exception and approve a selected subset at the displayed amount.

## Review addendum · 14 November 2026

### Copy and edit an entire time entry

Use the existing Back Office table as the visual reference. Keep day and week in one compact period selector, with worked, billable, non-billable and proposed charge totals in a small line above the grid. Open the personal list by default. The workday timeline is available when someone wants to reconstruct their day from evidence.

Selecting a saved row and pressing **⌘C / Ctrl+C**, choosing a target day and pressing **⌘V / Ctrl+V** starts a new editable row. Carry over the bill-to client, matter or project, activity, exact work-product ID, narrative, billable flag and durations. Use the target date and current worker. Allocate a new identity upon save. Approval, invoice references, history and the original clock range belong to the source entry. The user can change the pasted values before pressing **Enter**. An existing unfinished row must survive an attempted paste. Text selected inside an editing cell copies as text.

**Acceptance.** Copy a reviewed drafting entry, paste it on a different day, change its narrative and save. Reopen the day and verify the new entry has its own history and the same work-product ID, including when another product has the same title. The original approved wording and amount must still be retrievable.

### Scope of the draft implementation

- The local workflow covers retrospective keyboard entry, work on behalf of colleagues, billing preferences, independent review, signed revisions, per-product fees, numbered invoices and linked adjustments. The invoice template produces a downloadable HTML document. [Back Office user guide](user-guide/back-office.md)
- In the review scenario, 56 submitted positions across three weeks total EUR 15,000. Selecting three positions displays EUR 690 and sends those exact revisions for approval. A separate case checks that a 150-minute entry can be submitted, reduced to a charge of 120 minutes and approved with its full worked duration intact. [Review scenarios](../apps/app/tests/fixtures/billing-review.tsx)
- Firm-wide use requires the hosted platform timesheet endpoint and authenticated review. Automated coverage exercises local workflow permissions with distinct actors. Live Google and Microsoft account checks on Windows and macOS remain release work. The draft supports opted-in sources inside LegalWork and connected accounts. OS-wide active-window capture remains open. [Release checks](#release-checks-on-windows-and-macos)
