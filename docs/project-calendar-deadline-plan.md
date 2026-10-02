# LegalWork project calendars and jurisdiction specific deadline skills

Planning proposal, researched on 30 September 2026. Implementation order: calendar foundation and manual deadlines, project sync and Home aggregation, German deadline calculation skills, England and Wales, then US federal civil procedure. This document proposes application changes; it does not implement them or certify any deadline calculation.

Every project should have a calendar showing its dated tasks and legal deadlines. Home in the small left sidebar should provide an aggregate calendar across accessible projects. Local use should work without a subscription; a subscription enables calendar sync through the existing project-sharing system, with Calendar enabled by default when sharing. A user can always enter a Fristende directly. An agent can calculate a legal deadline only through an installed jurisdiction-specific skill whose executable code explicitly supports the applicable rule and scenario.

The implementation baseline is the latest inspected development branch, [LegalWork development commit 338e36e](https://github.com/eigenweltlabs/legalwork/commit/338e36e256ac8ef73ac5288829827f92c6f59706). The local checkout is older, on `feat/workflow-library-editors`. Work should start from the current integration branch so it builds on the existing project workspaces and sharing implementation. Repository observations below describe that inspected development revision.

1. **Project and Home experience**

   Add Calendar to project navigation, alongside Tasks and Files. Start with month and agenda views, date navigation, filters, and a detail drawer. Show deadlines distinctly from ordinary task due dates. Each entry identifies its project, responsible person, status, and whether its date was entered manually or calculated. Project Home can also show the next deadlines.

   Add the aggregate calendar inside Home, reachable from the small left sidebar. It is a view over the underlying calendars, not a second collection of copied events. Opening or editing an item returns to its original project. Filter by project, assignee, item type, and status. Include dated tasks without a project in a separate inbox calendar so those dates are not lost.

   A task appears when it has a date and disappears from the calendar when that date is removed. Its task record remains the authority for its title, status, and due date; calendar edits call the task API. A dedicated legal deadline has its own record and can link to one or more tasks. Completing a task must not automatically mark a legal deadline as complied with: preparing a brief and filing it are different actions. Record deadline completion explicitly, with an optional filing receipt or other evidence.

   Manual deadline entry requires a title and date; it can optionally include a time, jurisdiction, responsible person, source document, and reminder. Preserve the entered date exactly. Do not automatically move a manually entered date off a weekend. Use separate fields for internal Vorfristen and the legal deadline, so a preparation target never replaces the actual Fristende.

2. **Calendar backend and date model**

   Add a server-owned calendar store and APIs before building the React views. Use the repository's existing SQLite, typed schemas, Zod validation, TanStack Query, and server event patterns. Persist structured records; do not use a shared `.ics` file as the mutable database.

   Proposed records:

   | Record | Purpose |
   | --- | --- |
   | Calendar | Stable identity, project binding, name, default time zone, revision, sharing scope |
   | Calendar component | Event, task projection, recurrence definition, overrides, metadata, preserved properties |
   | Legal deadline | Human deadline day, optional precise cutoff, legal context, task links, provenance, compliance status |
   | Calculation receipt | Immutable inputs, result, explanation, source references, plugin and data versions |
   | Reminder and delivery | Trigger, recipients, channel, occurrence identity, idempotency and delivery state |
   | Change history and sync outbox | Revision, actor, prior state, deletion tombstones, offline changes |

   Distinguish a plain calendar date from a time-zone-based date and time, a UTC instant, and a floating date and time. A legal deadline with a time needs the jurisdiction's applicable zone; changing the computer's zone must not change the legal deadline. Keep the human deadline day separately from the cutoff instant.

   The existing `tasks-api.ts` converts `YYYY-MM-DD` into midnight on the current computer and then stores an ISO timestamp. That loses the original date-only intent. Extend the task date representation on both the local server and platform. Keep compatibility with old clients, preserve existing timestamps, and convert legacy values only when their original date and zone can be established. Never silently guess from a UTC-midnight timestamp.

   Proposed API responsibilities are project calendar listing, bounded occurrence queries, Home aggregation, component mutations, manual deadline creation, calculation-based creation, import/export, reminders, and history. Use conditional revisions for writes. Legal inputs, calculated date, and receipt change atomically; a conflicting offline edit must not combine one person's inputs with another person's result.

3. **iCalendar coverage**

   Treat [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) as the calendar data contract. Support `VEVENT`, `VTODO`, `VALARM`, and `VTIMEZONE`; date and date-time values; recurrence rules, additions, exclusions, and instance overrides; identities and revision properties; relationships; participants; attachments; categories; status; and location. Preserve supported standard fields and unknown extension properties across import, export, and limited frontend edits. Include `VJOURNAL` and `VFREEBUSY` in the backend component model even when the initial UI cannot author them.

   The backend needs actual recurrence expansion, time-zone handling, override operations, and reminder execution. Merely keeping raw text does not count as implementing those behaviors. Maintain a documented conformance matrix and use a maintained parser/serializer and recurrence library where it passes our fixtures. Bound expansion and import size. Frontend PATCH operations must preserve fields they do not expose; complex items can use the advanced API until the UI supports them.

   A deadline usable through 30 September has a cutoff at the start of 1 October in the relevant zone. For an all-day event, export 30 September with an exclusive end of 1 October. For a native task, express the actual cutoff rather than pretending that midnight at the start of 30 September is the end of that day. RFC 5545's date-only `VTODO` example is already overdue at midnight on its `DUE` date. Test client presentation of this boundary carefully. Do not invent `24:00` or use `23:59:59` as an approximation.

   Provide two deliberate export profiles: native tasks as `VTODO`, and a compatibility calendar that represents task due dates and legal deadlines as `VEVENT`. Verify compatibility with Apple Calendar, Outlook, and Google Calendar rather than assuming every client displays tasks. Never emit both representations of the same item in one compatibility feed. Use stable, deterministic identities per profile and relationships back to the canonical record; use those same identities in project and aggregate exports.

   Support `.ics` import and export and an optional read-only subscription feed. Internal colleague sync uses LegalWork's project sync. iCalendar itself is not a sync protocol: [CalDAV](https://www.rfc-editor.org/rfc/rfc4791) is a separate access protocol, and [iTIP](https://www.rfc-editor.org/rfc/rfc5546) covers scheduling exchanges. Design adapters for these, but do not claim two-way external calendar sync or meeting invitations in the first release. Importing attendees or alarm addresses must not send invitations or email automatically.

4. **Project sharing and aggregate access**

   Extend `ProjectSyncScope` and the existing What is shared panel with `calendar`. Default it to enabled when a project is shared, including the migration default for shared projects unless the owner turns it off. Apply that default centrally and document it in the sharing panel. Older clients must not accidentally erase the new setting when saving the scope.

   Reuse the current project link: a local workspace ID maps to the canonical firm project ID in `project_links`. Task `projectId` currently refers to the local workspace, so preserve the existing mapping rather than inventing another project identity. Calendar and item identities must survive multiple devices, folder reattachment, and reinstall without duplicate calendars.

   Keep sharing scopes independent:

   | Calendar sharing | Task sharing | What a colleague's calendar receives |
   | --- | --- | --- |
   | On | On | Shared deadlines and calendar entries, plus dated shared tasks |
   | On | Off | Shared deadlines and calendar entries; no private task titles, dates, descriptions, or links |
   | Off | On | No shared project calendar; shared tasks remain available in Tasks |
   | Off | Off | No calendar or task data shared |

   An owner's local calendar still shows their local data. A shared deadline linked to a private task must omit that private task's identity and details from the colleague's payload. An imported or linked source document is not implicitly shared merely because a deadline references it; use existing document access rules.

   Use the existing subscription entitlement, membership checks, outbox/pull-cursor mechanism, and platform/app SSE notifications. Calendar changes should invalidate both project and Home queries. Enforce authorization on platform writes, reads, occurrence expansion, aggregate queries, and subscription feeds. Home never grants additional access. Its source selection must honor the Calendar switch even when tasks are otherwise shared.

   Turning Calendar off withdraws remote calendar data while preserving the owner's local records. Turning it back on publishes the same item identities. Revoking access removes the replica and aggregate entries using the existing project access-ending behavior. Imported calendars and locally owned material follow the repository's existing preservation rules.

   Add calendar sync routes to the platform as well as the local server; this is not a frontend-only feature. Reuse the existing project/task integration test setup. Preserve legal deadline revisions atomically instead of copying ordinary tasks' per-field last-write-wins behavior.

   External subscription feeds require a separate opt-in, revocable user-scoped credentials, fresh access checks, and safe caching. A downloaded external calendar copy cannot be remotely erased. External clients may refresh late, so a feed is not a replacement for LegalWork reminders. Cloud delivery can run while subscribed users' desktop apps are closed; local reminders need an active local runtime, with missed-reminder recovery on restart.

5. **Jurisdiction specific deadline calculation skills**

   Provide jurisdiction-specific deadline calculation skills through LegalWork's existing standard skill library, loaded when the agent needs to calculate a deadline. Each skill contains instructions for identifying its supported rules, collecting the required facts, calling its tested executable code, explaining the result, and recording the deadline. Proposed skill boundaries are German civil procedure, England and Wales civil procedure, and US federal civil procedure. Keep discovery, installation, library visibility, execution, and scope in the existing skill system.

   Publish these entries as `kind: "skill"`. The existing authenticated skill-library APIs persist entries where the engine and Settings read them. The existing cloud plugin bundle supports skills and executable tools. Extend those paths with the calculator adapter and rule metadata, while keeping the user-facing capability in the standard skill library.

   A country plugin is an existing distribution bundle containing one or more jurisdiction-specific deadline calculation skills, typed input schemas, executable calculation code, versioned legal and holiday data, fixtures, and a declared support matrix. Country can group distribution; jurisdiction, procedure, court, locality, and exact rule determine each skill's support. Installing a German skill must not authorize every German deadline.

   The bundle's calculator metadata should declare skill and plugin identities and versions, executable hash, supported rule IDs, jurisdiction/procedure, effective dates, covered holiday years and localities, required facts, explicit exclusions, sources, and reviewed test coverage. Reuse LegalWork's existing plugin bundle and tool-loading infrastructure. Register tested calculation functions as typed tools through a narrow server adapter; do not execute arbitrary model-written snippets as a trusted calculator. A text-only skill does not establish calculation support: the installed executable must also pass the capability check. Editing a skill's instructions must not expand the backend's tested rule boundary.

   Each rule exposes an input schema, a capability check, and a deterministic calculation. It returns either a result with a step-by-step trace or a structured refusal such as `missing_inputs`, `unsupported_rule`, `unsupported_scenario`, or `outside_coverage`. Its pinned code and data must reproduce the result offline. It must not depend on today's date, a live website, or the model's interpretation of a holiday list.

   Skill execution follows these steps:

   1. Query installed capabilities and select an exact supported rule.
   2. Extract required facts and evidence: trigger, service method and date, court/locality, applicable procedure, and any proven extension or special order.
   3. Ask for missing or ambiguous facts; never substitute assumptions silently.
   4. Call the plugin with validated inputs.
   5. Receive a server-created receipt containing the normalized inputs, result, trace, rule references, plugin/data versions, and content hashes.
   6. Create the deadline by receipt ID. The backend verifies the receipt against the project, actor, inputs, and executable version and stores the exact result.

   Suggested tools are `deadline_capabilities`, `deadline_calculate`, `deadline_create_from_calculation`, and `deadline_create_manual`. A generic mutation route, imported `.ics`, or ordinary task tool must not be able to mark a guessed date as plugin-calculated. The agent must not fall back to mental arithmetic, shell date arithmetic, or a web calculator when no installed rule supports the case.

   Users may always enter or override a date manually. An agent may transcribe a date explicitly supplied by the user or a document and record that source, without calling it calculated. Preserve prior calculations and require an override reason in the audit record. Separate calculation provenance from human verification: a deterministic result can still use an incorrect service date or inapplicable rule. Show pending verification visibly; firm policy may require a second reviewer, but do not hide pending deadlines or disable their reminders.

   Plugin updates, removal, and legal amendments must not silently recalculate existing deadlines. Keep the historical executable/data version or an immutable reproducibility artifact, flag affected records for review, and create a new calculation revision when deliberately recalculated.

6. **German rules and the first support boundary**

   The supplied [LTO calculator](https://www.lto.de/juristen/rechner/fristenrechner) provides BGB arithmetic and distinguishes event-triggered and beginning-of-day periods. Its interactive form also asks whether the deadline concerns performance or a declaration. [Gebührenportal](https://gebuehren-portal.de/fristenrechner) provides court/deadline presets, a Bundesland selection, service date, and optional extensions. These are useful comparison targets; neither form establishes coverage of every legal scenario.

   The plugin needs separate rules for event and beginning-of-day triggers, day/week/month/year periods, month-end and leap-year treatment, and the applicable final-day adjustment. These distinctions follow [BGB § 187](https://www.gesetze-im-internet.de/bgb/__187.html), [§ 188](https://www.gesetze-im-internet.de/bgb/__188.html), and [§ 193](https://www.gesetze-im-internet.de/bgb/__193.html). A generic month-clamp-then-subtract-one algorithm is not a safe replacement for the statutory branches.

   The same duration does not have the same behavior in every procedure. [ZPO § 222](https://www.gesetze-im-internet.de/zpo/__222.html) excludes weekends and holidays from hour-based periods. [VwVfG § 31](https://www.gesetze-im-internet.de/vwvfg/__31.html) counts them for hour-based periods and has distinct rules for fixed appointments and expressly fixed dates. Implement them as distinct profiles, or refuse the unsupported profile.

   Bundesland alone is insufficient. [Bavaria's holiday law](https://www.gesetze-bayern.de/Content/Document/BayFTG/true) includes Augsburg's local holiday and municipality-dependent Assumption Day. The official [Bavarian statistics office](https://www.statistik.bayern.de/presse/mitteilungen/2025/pm217/index.html) documents changes to the municipality classification from 2025. Holiday data therefore needs locality and effective year, not just a reusable national list.

   Weekend adjustment is not universal for every legal period. The [Federal Labour Court's decision 2 AZR 1057/12](https://www.bundesarbeitsgericht.de/entscheidung/2-azr-1057-12/) rejects applying BGB § 193 to the six-month employment-protection waiting period. The support matrix must distinguish legal categories rather than applying one final-day rule to all of them.

   Named deadlines need their own triggers and restrictions. [ZPO § 517](https://www.gesetze-im-internet.de/zpo/__517.html) requires the fully drafted judgment's service and the latest commencement after five months from pronouncement. [ZPO § 520](https://www.gesetze-im-internet.de/zpo/BJNR005330950.html) separately governs the two-month reasoning period and permitted extensions. An extension request is not evidence that an extension was granted. Judgment supplementation under § 518 also needs an explicit branch or refusal.

   Service presumptions cannot be guessed. Current [VwVfG § 41](https://www.gesetze-im-internet.de/vwvfg/__41.html) and [AO § 122](https://www.gesetze-im-internet.de/ao_1977/__122.html) contain four-day domestic notification presumptions, with qualifications and different treatment of some other delivery scenarios. Historic rule versions must be selected correctly. These calculations should ship only in separately reviewed administrative/tax profiles.

   Proposed first release: reviewed BGB arithmetic profiles, ZPO computation for an explicitly established duration, and named § 517/§ 520 profiles only after their trigger, latest-commencement, supplementation, and extension branches are implemented or explicitly excluded. An ordinary § 4 KSchG profile can follow once receipt and special-case requirements are reviewed. Generic arithmetic is a labelled calculation aid for an established legal period, not permission for the agent to invent the period's duration.

   Initially refuse unsupported service presumptions, special/defective service, uncertain receipt, restoration, suspension, limitation disputes, cross-border special rules, and procedure-specific exceptions. Add StPO, administrative, tax, family, and other profiles through separate reviewed releases. “All edge cases” should mean tested coverage of every declared branch and a refusal for everything outside it; it cannot honestly mean every German legal deadline at launch.

7. **Testing against the supplied websites**

   Include comparison tests against both supplied calculators, as requested. Use only synthetic inputs. Capture each input, selected options, displayed result, source URL, retrieval date, and coverage limitation in a fixture. Test our plugin against these committed fixtures in normal CI. Add an explicit, rate-limited live comparison command for refreshing them; normal builds must not depend on third-party websites staying available.

   Match equivalent profiles, not merely equal start dates. LTO's performance/declaration setting and event/beginning setting matter; Gebührenportal's named court/deadline preset matters. A missing input, validation popup, failed request, or incomplete result is an unavailable comparison, never a pass or an expected deadline. Live adapters must detect validation states and stop rather than repeatedly submit a form. Avoid bringing those checks into the user's foreground browser.

   This research did not complete a reliable comparison run against both sites. One LTO display was observed for an event on 31 January 2026, one month, NRW, performance/declaration enabled: 2 March 2026 at the end of the day. That observation is a candidate fixture, not a validated test suite. Gebührenportal interactions encountered an incomplete form state and browser timeouts. Website comparison coverage remains pending.

   Do not decide a disagreement by majority vote. Check the statutory rule, applicable case law, and facts with a qualified reviewer. Record the decision and source in the fixture. Website limitations cannot replace cases their forms do not support.

   Required test groups:

   - Every supported rule branch, trigger variant, month end, leap year, final-day shift, locality-specific holiday, and effective-date boundary.
   - Consecutive holidays and weekends, different hour-counting profiles, fixed dates, evidence of granted extensions, and § 517/§ 520 latest-commencement boundaries.
   - Refusal for missing inputs, unsupported scenarios, incorrect rule/version, uncovered holiday years, and ambiguous service.
   - Agent attempts to substitute results, use generic mutation routes, claim manual/imported dates were calculated, or reuse a receipt with changed inputs.
   - Deterministic replay, reviewed source fixtures, and properties such as reproducibility and valid final dates. Code coverage alone does not establish legal correctness.
   - Calendar import/export, unknown property preservation, Unicode line folding and escaping, recurrence/override identity, daylight saving, date-only boundaries, and compatibility clients.
   - Owner/member sync, all scope combinations, offline edits, simultaneous deadline revisions, access revocation, duplicate project roots, sign-out, reminder deduplication, and old/new client migrations.

   Release each legal rule only after its support matrix, expected fixtures, refusal behavior, and source interpretation have been reviewed. Preserve reviewer, source edition, and review date as package metadata.

8. **Other jurisdiction skills and priority**

   These are feasibility findings and proposed package boundaries, not available implementations. Following the user's selection, prioritize England and Wales and US federal courts after Germany.

   | Priority | Package boundary | Research finding and implementation consequence |
   | --- | --- | --- |
   | 2 | England and Wales civil procedure | [CPR Part 2](https://www.justice.gov.uk/courts/procedure-rules/civil/rules/part02) uses clear days, excludes specified nonworking days for periods of five days or less, and distinguishes event-relative periods. Include service rules, court orders, filing channel, and time cutoffs as separately supported branches. This is not a UK-wide plugin. |
   | 3 | US federal civil procedure | [FRCP Rule 6](https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf) counts intermediate weekends, adjusts the final day, distinguishes hours and forward/backward counting, and differentiates electronic filing from clerk-office closing time. Rule 6(d)'s extra days depend on service method. Add district/local-rule overlays; exclude state courts and other federal procedures initially. |
   | Later | Austrian civil procedure | [ZPO § 222](https://www.ris.bka.gv.at/eli/rgbl/1895/113/P222/NOR40124564) suspends specified appeal periods during stated summer/winter windows, with exceptions. A feasible package, but German arithmetic plus an Austrian holiday list is insufficient. |
   | Later | Swiss civil procedure | Current [ZPO Arts. 142–146](https://www.fedlex.admin.ch/eli/cc/2010/262/de#art_142) distinguish holidays at the court location, ordinary-post delivery on nonworking days, and procedural vacation periods and exclusions. Scope by procedure and canton/locality; keep effective versions for the 2025 changes. |
   | Later | French civil procedure | [CPC Art. 641](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006411002) and [Art. 642](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006411003) provide separate day/month computations and final-day adjustment. Territorial and service extensions need additional reviewed rules before being supported. |
   | Later | Spanish civil procedure | Current [LEC Arts. 130, 133 and 135](https://www.boe.es/buscar/pdf/2000/BOE-A-2000-323-consolidado.pdf) distinguish nonworking days, August/winter periods, urgency exceptions, and a next-working-day 15:00 submission provision. Store ordinary expiry separately from any applicable filing grace; include regional/local holidays. |

   England and Wales readiness has one specific research gap: the Justice UK Part 2 page retrieved here reports an older update date, while a 2025 amendment affecting time/electronic filing was identified. The official [2025 instrument](https://www.legislation.gov.uk/uksi/2025/893/contents/made) could not be retrieved reliably in this session. Verify the effective consolidated CPR, amendments, and relevant practice directions before implementing the filing-closure branch. Do not ship a result based solely on that older web page.

   Country expansion is practical with a shared date/holiday framework and separate executable rule profiles. The expensive ongoing work is jurisdiction-specific source interpretation, fixtures, and updates. Start each package with a narrow published coverage matrix, then expand it independently.

9. **Delivery sequence and acceptance**

   **First:** typed date migration, calendar/deadline storage and APIs, manual deadline entry, dated-task projection, project Calendar, and Home aggregation. Acceptance: a date remains the intended day across devices and zones; edits have one source of truth; multiple deadlines can link to a task; compliance remains separate.

   **Second:** Calendar sharing scope, platform/local sync, conflicts, access removal, reminders, `.ics` import/export, subscription feeds, and the broader backend calendar operations. Acceptance: owner/member scenarios and all scope combinations pass, stable identities survive reattachment, limited forms preserve advanced properties, and recurrence/reminder behavior works through the server API even without full frontend editors.

   **Third:** jurisdiction-specific deadline calculation skills in the existing standard library, their tested executable code and typed calculator tools through the existing plugin system, capability discovery, immutable receipts, manual/calculated provenance, refusal handling, and the reviewed German rules. Acceptance: the agent loads the applicable skill and executes its supported calculation code, unsupported cases cannot become calculated deadlines even if skill instructions are edited, altered receipts are rejected, and all declared rules pass reviewed statutory and website comparison fixtures.

   **Fourth:** England and Wales, then US federal civil procedure with specific district coverage. Acceptance: effective source versions and filing-channel branches are verified, support boundaries are published, and jurisdiction-specific tests pass independently of Germany.

   Build through the current server and platform paths, then add frontend views using existing components. Update `docs/project-sync.md` and the plugin documentation alongside implementation. Run the repository's relevant server, application, desktop, type, and i18n checks for the eventual code changes. No application tests have been run for this planning-only document.
