# Invitation replies

Email reads pinned downloaded iCalendar attachments. Calendar remains the authority for replying: no event is imported from email and no separate OAuth state is introduced. The host-only invitation routes use the same `createConnectorRequest` transport, activation settings, credential custody, refresh path and Calendar write controls as the existing native integrations. The encrypted worker stores a dispatch journal, never Calendar tokens.

## Matching and review

The host rereads the exact account, message original and attachment hash and selects one parsed invitation. A Calendar lookup uses its UID. The current event must have the same organizer and an invited participant represented by that calendar. Source cancellations and non-REQUEST calendar data cannot authorize a reply. An occurrence lookup must establish the original occurrence identity; a series is never substituted for a missing occurrence.

The review shows current provider content, participant and event/series/occurrence scope. Source values are not copied into a provider update. Reviews expire after five minutes, are consumed before asynchronous work and are erased on lock or shutdown. Confirmation rechecks source, authenticated account, calendar, participant, current response and provider revision. A fresh Calendar read after the journal claim closes delays caused by a contended database writer.

Google account identity is proven through its authenticated primary CalendarList entry. Microsoft identity is proven through `/me`'s immutable ID and current address. The native request's identity callback repeats proof before dispatch, including after token refresh. Calendar IDs are resolved to their canonical provider ID. Delegated replies use Google's self participant or the verified Microsoft calendar owner's invited address, with provider calendar write authorization.

Direct and custom Microsoft connections offer optional shared-calendar consent in the existing Outlook Calendar settings. Reads request `Calendars.Read.Shared`; Calendar write access requests `Calendars.ReadWrite.Shared`, independently of Mail write access. The completed flow records its requested choices privately. Access requires the current choice, completed consent, applicable granted scopes and Calendar write authorization. Changing a setting alone cannot upgrade an old grant. Provider owner/delegate permissions remain required. Managed broker connections retain their fixed grants.

The common native transport verifies the selected calendar owner against `/me` using the actual dispatch token, including refreshes. Secondary calendars owned by the signed-in account remain accessible without shared consent. Shared reads and writes recheck optional access before dispatch. Calendar overlays, assistant tools and Email replies use this same gate. A private consent-generation check also invalidates request objects across reconnects that retain the same public account ID. Disabling shared access blocks new operations without erasing previously downloaded data in Calendar's session cache.

## Provider operations

Google uses [Events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch) with `If-Match`, `sendUpdates=all`, and only the participant's response plus `attendeesOmitted=true`. The [event resource contract](https://developers.google.com/workspace/calendar/api/v3/reference/events) supports updating a participant response without replacing the other attendees. [Instances lookup](https://developers.google.com/workspace/calendar/api/v3/reference/events/instances) uses `originalStart`, so moved Google occurrences are not searched by their new day.

Microsoft uses the selected calendar's [accept](https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0), [tentativelyAccept](https://learn.microsoft.com/en-us/graph/api/event-tentativelyaccept?view=graph-rest-1.0) or [decline](https://learn.microsoft.com/en-us/graph/api/event-decline?view=graph-rest-1.0) action with `sendResponse=true`. Event reads request immutable item IDs, UTC and text descriptions. These action contracts do not document an atomic event-version precondition. The final read detects observed changes before POST, but cannot exclude an organizer update arriving between that read and the action. Do not claim the Google precondition guarantee for Microsoft. Its occurrence search checks the series ID and original timed start within a bounded four-day window. All-day occurrences and occurrences moved out of that window require provider handoff.

## Uncertain outcomes

Schema 34 adds an owner-scoped encrypted journal keyed by a hash of provider, canonical calendar, event and invited participant. It spans source messages, mail accounts and connection refreshes. No event text, account credential or provider token is journaled. These safety records remain with the encrypted mail database when an individual mailbox mirror is removed.

A transaction claims the target as uncertain before any write. Another review cannot claim an unresolved target. A known provider refusal, or a failed preflight that can still update the journal, records rejection. Transport loss, shutdown after dispatch starts, ambiguous success and Microsoft asynchronous success remain uncertain. No path automatically retries an uncertain write. Provider reads can reconcile a matching current participant response; they cannot prove notification delivery. A disappearing Microsoft declined event is not treated as evidence of a delivered reply.

The journal is private worker IPC. It is not an HTTP operation or assistant tool. Public routes accept a pinned source and selected calendar for preview, then only the one-use token for confirmation. They are absent on shared binds and require the local host token. Unknown failures are redacted before reaching the generic server logger or UI.

## Acceptance boundaries

Synthetic provider tests cover participant-only writes, delegated identity, organizer updates, cancellation, series and occurrence lookup, time zones, account/source changes, one-use reviews, permission revocation and uncertain transport. Native Node tests cover encrypted persistence, migration rollback, owner scope, worker validation and lock/unlock. HTTP contract tests verify host-only routes and bounded strict inputs. The owner stopped desktop automation because it steals Mac focus. No new GUI test, app launch, live email or live RSVP is part of this change. Live provider interoperability and final visual/focus acceptance remain separate gates.
