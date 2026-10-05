# Project calendars and legal deadline skills

Implementation: LegalWork `feat/project-calendars-deadline-skills` and model-api `feat/project-calendars`. The [research and design](project-calendar-deadline-plan.md) explains the jurisdiction choices and later country packages.

## Calendar behavior

Each project's Calendar shows original calendar records and projections of dated project tasks. The separate Calendar icon in the small left sidebar opens the aggregate calendar at `/calendar`, covering local projects, shared project replicas, connected remote workers and dated inbox tasks. Week is the default, with month and agenda views available through the standard view selector. Compact filters share the Tasks control, and deadline creation/editing uses the standard dialog, inputs, assignee picker and reminders. Project Home shows the next five active deadlines within 90 days, with direct create/edit and View all actions. Home retains its new-chat composer. Opening a task in Week, Month or Agenda opens its standard task dialog and preserves the calendar view. These projections do not create duplicate tasks or deadlines.

Manual Fristende is always available. A calculated deadline needs a server-issued receipt from an installed jurisdiction skill. New deadlines start unreviewed; completing a linked task never completes a legal deadline. Date overrides require a reason and retain the original calculation in revision history. Whole-record revisions prevent concurrent date edits from silently overwriting each other. Conflicts and deleted entries have explicit resolution/restore controls.

The RFC 5545 backend retains the imported document, including VEVENT, VTODO, VJOURNAL, VFREEBUSY, VTIMEZONE, recurrence, exclusions, detached/range overrides, participants, relationships, attachments, alarms and extension properties. Expansion is bounded. Limited edits preserve unexposed properties; changing a recurring series' dates requires replacing its ICS against the current revision. Invalid/missing timezone information is refused. Date-only values stay dates; existing timestamp task dates keep their previous meaning.

Import and export remain API capabilities; no ICS import/export controls appear in the calendar UI. Exports use UTF-8 octet folding and CRLF. Calendar-client exports project VTODO into VEVENT; native exports retain imported component types and expose one-off legal deadlines as VTODO with their established cutoff. Recurring deadlines retain their recurrence representation. Custom timezone definitions with conflicting identical TZIDs require separate exports. This is iCalendar storage/import/export, not a CalDAV server or an implementation of invitation delivery.

## Sharing and reminders

Calendar sharing defaults to enabled within the existing Share dialog. The platform enforces active subscription, project membership and calendar scope on every read/write/feed. Task links and dated task projections require task sharing as well. The owner's local records remain when sharing stops. Members lose shared replicas when access ends, following the existing project's explicit decision for pending local changes. An older client cannot silently re-enable a deliberately disabled calendar scope.

Calendar sync maps local workspace IDs onto stable canonical project/item identities, uses a persistent outbox and compare-and-swap revisions, and records history transactionally on the platform. Offline edits remain local until acknowledged. Stale revisions become conflicts. Older platforms lacking the calendar endpoint leave calendar writes pending while document sync continues.

Reminders are queued durably and claimed once. Completed, deleted, withdrawn and superseded entries cannot deliver stale queued reminders. Calculation reminders use the established filing cutoff. Local reminders work offline; the existing platform jobs queue shared reminders while the desktop is closed. Desktop notifications are delivered when a desktop is running or next reconnects. This release does not send reminder emails or mobile push notifications.

With an active subscription, **Subscribe** in a project calendar creates its own calendar URL; **Subscribe** in the aggregate calendar creates a separate URL for all local/shared projects and dated Inbox tasks. The dialog supports copying and disabling either link independently. Connected remote workers expose their own project links. Calendar applications poll these read-only iCalendar URLs on their own refresh schedule.

The hosted service stores a hash of each feed credential. The issuing desktop retains the credential, partitioned by platform/account/organization and project (or aggregate scope), so reopening the dialog returns the same URL. Another desktop can issue an independent link. Ordinary project sharing does not issue a feed. Disabling a link revokes it; creating one again produces a different URL. Membership and subscription are checked on every download. Viewing subscription credentials requires collaborator access to the local runtime.

Shared records and published tasks are read live with their current permissions. Private local calendars and unpublished dated tasks are copied only when a user creates a link, then refreshed by the existing project synchronization loop while LegalWork is running. The latest synced copy remains available while the desktop is closed. Session identifiers and local file attachments are excluded from these private copies. Published, reassigned, withdrawn and deleted tasks use the live task permissions rather than a stale private copy. Removing a local project revokes its link on the next synchronization.

## Executable skill coverage

The three packages live in the standard skill library as SKILL.md plus calculate.mjs. They are skills, not workflows. The agent tool verifies the installed skill, its declared rule and the tested executable's hash before calculating. Deletion, a workflow shadow, missing code, modified code, an unsupported scenario or missing required facts causes a refusal. There is no model-arithmetic fallback. Receipts contain normalized inputs, rule/version, input/code hashes, result, cutoff, trace and legal source links.

| Skill | Supported profiles | Deliberately refused |
| --- | --- | --- |
| `de-civil-deadlines` | BGB §§187–188 event/beginning periods with explicit §193 applicability; ZPO §222 periods; ordinary complete judgments served before the five-month boundary under §§517/520; documented explicit §520 extensions. Regional and municipality-dependent holidays are checked. | Latest commencement after late/no service, supplementary judgments, defective pronouncement, restoration, deemed service, special regimes/orders, and automatic extensions from court closure. |
| `ew-civil-deadlines` | CPR 2.8 day periods, before/after clear days, short-period exclusions, event-defined endpoints, court-office closure adjustment, and an established filing/service cutoff. | Deemed-service inference, service on a nonworking final day, electronic filing without a specific court-system profile, hours/month/year periods and special regimes. |
| `us-federal-civil-deadlines` | FRCP 6(a) day periods for confirmed district-court civil proceedings; federal/state holiday direction rules; documented court-office closures; confirmed court timezone; Rule 6(d) additions for supported service methods. | Hours, appeals, bankruptcy, state procedure, limitation periods, special orders/tolling, and assuming that a physical court closure establishes electronic-system inaccessibility. |

Holiday coverage is 2020–2035 under the reviewed rules, including already enacted one-off holidays. The declared range does not predict future legislative changes: later one-off holidays require official-source inputs or a reviewed release. This is a published coverage matrix, not a claim to calculate every legal deadline in these jurisdictions.

## Verification and rollout

Regular server tests cover primary-source examples, refusals, actual installed-code enforcement, receipts/overrides/history, HTTP auth, cross-project boundaries, offline/two-client sync, conflicting dates, recurrence/DST, VTODO due dates, folding, feeds and reminders. Platform tests use an isolated real Postgres with the actual migrations, exercising membership/scope/subscription changes, stale revisions, idempotence and durable reminder claims.

`pnpm --dir apps/server test:deadline-oracles` performs ten live comparisons against LTO's published calculator and Gebühren-Portal's calculation endpoint. It uses HTTP and only the hash-pinned, reviewed calculation functions in an isolated adapter; it never opens a browser or executes widget initialization/ads. Responses are recorded in `src/calendar/fixtures/deadline-oracles.json` for offline regressions. Changing the LTO executable requires review before updating its hash. Calculator agreement complements primary-law tests; it is not evidence that every legal edge case is supported. For example, the inspected LTO widget misclassified Berlin's one-off 8 May 2020 holiday; the primary-law regression correctly retains 11 May as the adjusted endpoint.

Verify the model-api calendar logging guard, then deploy model-api migrations `0035_project_calendars.sql` and `0036_calendar_subscriptions.sql`, plus the platform routes, authentication proxy and jobs, before releasing cloud calendar sync and subscription links. This development work does not deploy either repository. Local calendars and skills run in the Electron development app immediately.

Calculated recurring all-day reminders retain the receipt's local cutoff clock
on each occurrence, including across daylight-saving changes. Future occurrences
are not queued at the first occurrence's cutoff. Timed recurrence instances use
their own filing time. This schedules reminders; it does not calculate a new
legal period for every recurrence.

Development commands:

```sh
pnpm dev:ui
pnpm --dir apps/desktop dev
```

Use the default development profile (`com.eigenweltlabs.legalwork.dev`), with no custom user-data or server-config overrides. The standard Electron dev command rebuilds native modules and macOS helpers. On this machine the unaccepted Xcode license blocks that rebuild; the current development launch reuses compatible existing native binaries and does not accept the license.

## Deadline context and attachments

Every deadline belongs to its project calendar. The aggregate calendar provides a project selector for new deadlines and a project link when editing. Inside a project, the modal omits the redundant project breadcrumb. It uses the same date, reminder and assignee chips as Tasks, with compact file/session actions and collapsible source/timezone details. `attachmentPaths` names up to 50 visible project-relative files. Users can upload files (up to 20 MB each), choose a project file, or drop a project file into the editor. Removing an attachment removes the link, not the project file. The API validates newly linked files, including their real paths, and rejects traversal and escaping symbolic links.

Attachments accompany calendar sharing even when general document sharing is disabled. The existing project storage, membership checks and file synchronization carry only the referenced documents. iCalendar represents these references as URI-valued `ATTACH:legalwork-file:…` properties and retains other imported attachments. Imported attachment URIs do not automatically link files from the receiving project; linking a local source requires explicit selection.

`sessionIds` links sessions in the same project. The editor opens linked sessions, and agent-created deadlines automatically link the creating session. As with Tasks, session links remain on the originating computer and are stripped from cloud synchronization; syncing revisions or accepting a remote conflict preserves local links.

An unreviewed manual date is labelled “Entered manually”; an unreviewed calculation, imported date or calculated-date override shows “Needs review”. For calculated and imported dates, the editor exposes explicit review confirmation; changing the date or source clears it. This display distinction does not automatically verify user-entered dates.
