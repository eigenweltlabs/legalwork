# Project calendars and legal deadline skills

Implementation: LegalWork `feat/project-calendars-deadline-skills` and model-api `feat/project-calendars`. The [research and design](project-calendar-deadline-plan.md) explains the jurisdiction choices and later country packages.

## Calendar behavior

Each project's Calendar shows original calendar records and projections of dated project tasks. The separate Calendar icon in the small left sidebar opens the aggregate calendar at `/calendar`, covering local projects, shared project replicas, connected remote workers and dated inbox tasks. Week is the default, with month and agenda views available through the standard view selector. Compact filters share the Tasks control, and deadline creation/editing uses the standard dialog, inputs, assignee picker and reminders. Project Home shows the next five active deadlines within 90 days, with direct create/edit and View all actions. Home retains its new-chat composer. Opening a task goes to its project task view. These projections do not create duplicate tasks or deadlines.

Manual Fristende is always available. A calculated deadline needs a server-issued receipt from an installed jurisdiction skill. New deadlines start unreviewed; completing a linked task never completes a legal deadline. Date overrides require a reason and retain the original calculation in revision history. Whole-record revisions prevent concurrent date edits from silently overwriting each other. Conflicts and deleted entries have explicit resolution/restore controls.

The RFC 5545 backend retains the imported document, including VEVENT, VTODO, VJOURNAL, VFREEBUSY, VTIMEZONE, recurrence, exclusions, detached/range overrides, participants, relationships, attachments, alarms and extension properties. Expansion is bounded. Limited edits preserve unexposed properties; changing a recurring series' dates requires replacing its ICS against the current revision. Invalid/missing timezone information is refused. Date-only values stay dates; existing timestamp task dates keep their previous meaning.

Import and export remain API capabilities; no ICS import/export controls appear in the calendar UI. Exports use UTF-8 octet folding and CRLF. Calendar-client exports project VTODO into VEVENT; native exports retain imported component types and expose one-off legal deadlines as VTODO with their established cutoff. Recurring deadlines retain their recurrence representation. Custom timezone definitions with conflicting identical TZIDs require separate exports. This is iCalendar storage/import/export, not a CalDAV server or an implementation of invitation delivery.

## Sharing and reminders

Calendar sharing defaults to enabled within the existing Share dialog. The platform enforces active subscription, project membership and calendar scope on every read/write/feed. Task links and dated task projections require task sharing as well. The owner's local records remain when sharing stops. Members lose shared replicas when access ends, following the existing project's explicit decision for pending local changes. An older client cannot silently re-enable a deliberately disabled calendar scope.

Calendar sync maps local workspace IDs onto stable canonical project/item identities, uses a persistent outbox and compare-and-swap revisions, and records history transactionally on the platform. Offline edits remain local until acknowledged. Stale revisions become conflicts. Older platforms lacking the calendar endpoint leave calendar writes pending while document sync continues.

Reminders are queued durably and claimed once. Completed, deleted, withdrawn and superseded entries cannot deliver stale queued reminders. Calculation reminders use the established filing cutoff. Local reminders work offline; the existing platform jobs queue shared reminders while the desktop is closed. Desktop notifications are delivered when a desktop is running or next reconnects. This release does not send reminder emails or mobile push notifications.

ICS feed credentials are explicitly issued through the API, stored hashed, scoped to the issuing user's current permissions, and revocable. Ordinary sharing does not create a public feed. Platform feeds can aggregate all visible projects or serve one project.

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

Deploy model-api migration `0029_project_calendars.sql` and the platform routes/jobs before releasing cloud calendar sync. This development work does not deploy either repository. Local calendars and skills run in the Electron development app immediately.

Development commands:

```sh
pnpm dev:ui
LEGALWORK_DEV_MODE=1 \
LEGALWORK_ELECTRON_USERDATA="$PWD/.calendar-electron-profile" \
LEGALWORK_SERVER_CONFIG="$PWD/.calendar-electron-profile/server.json" \
LEGALWORK_ELECTRON_START_URL=http://localhost:5173/home \
pnpm --dir apps/desktop electron
```

The standard Electron dev command rebuilds native modules and macOS helpers. On this machine the unaccepted Xcode license blocks that rebuild; the current development launch reuses compatible existing native binaries and does not accept the license.
