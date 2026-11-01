# Global calendar verification

The calendar now retains loaded pages in memory for 30 minutes after they become inactive, shares Monday-based pages between views, and refreshes in the background. The week timetable uses a rolling three-week strip with a pinned time gutter. Scrolling rebases the strip without resetting the vertical time position.

Connected-event previews use compact date and time rows, a content-dependent width, expandable attendees, and a recurrence card with a readable interval, selected weekdays and end condition. Empty events have no empty body or redundant footer. Instance responses that do not supply a recurrence rule point to the source calendar for the full schedule. Outlook attachment contents remain in Outlook; supplied Google attachment links are exposed directly.

## Checks

- `pnpm --filter @legalwork/app exec env TZ=Europe/Berlin bun test tests/calendar-recurrence.test.ts tests/calendar-cache.test.ts tests/connected-calendars.test.ts tests/calendar-format.test.ts tests/calendar-layout.test.ts tests/calendar-session.test.ts tests/calendar-colors.test.ts`: 49 passed.
- From `apps/server`: `pnpm dlx bun@1.4.4 test src/connectors/calendar.test.ts src/connectors/calendar-colors.test.ts src/connectors/drafts.test.ts`: 33 passed. The installed Bun 1.3.9 cannot run the draft suite because Undici 8 requires `node:worker_threads.markAsUncloneable`; Bun 1.4.4 runs it successfully. No dependency changes were required.
- `pnpm --filter @legalwork/app typecheck`: passed.
- `pnpm --filter legalwork-server typecheck`: passed.
- `pnpm --filter @legalwork/app test:i18n`: passed for English and German.
- `pnpm docs:generate` and `pnpm docs:check`: passed.
- `pnpm --filter @legalwork/app build`: passed, with the existing bundle-size and dependency annotation warnings.

Browser checks used the real CalendarView with synthetic provider responses, including a 900 ms delay, an all-day event, a recurring event, HTML descriptions, 12 attendees, a meeting link and attachments. These are fixture timings, not live Google or Outlook benchmarks: initial load was 1,547 ms, cached reopen was 66 ms, and provider requests stayed at three. The cache-observer tests separately verify synchronous cache reuse and no request on a fresh remount. An isolated QueryObserver lifecycle comparison with the same 900 ms delay measured 901.66 ms to reopen with the previous `gcTime: 0` policy (two requests total), versus 0.19 ms with the retained cache (one request total).

The browser flow also verified forward/backward horizontal scrolling, preserved vertical position, 700 px calendar resizing without changing the selected week, a 480 px event preview without overflow, cached events surviving an outage, an open preview updating after an edit, and the preview closing after deletion. Executable HTML, images and embedded frames were stripped. Expanded attendee lists remained accessible. The minimal all-day preview measured 480 × 175 px.

## Manual reproduction

1. Run `pnpm dev` using the standard LegalWork development profile and UI origin `http://localhost:5173`.
2. Connect a Google or Outlook calendar through **Add > Plugins**. Open **Calendar** and show it through **Connected calendars**.
3. Load a week, leave Calendar, then reopen it. Previously loaded events should appear immediately. Navigate to another date and return. **Refresh** should update events without clearing the timetable.
4. Scroll horizontally in **Week** through multiple weeks and back. The date heading follows the visible week and the vertical time position remains stable. Resize the window, then try **Today** and the arrow buttons.
5. Open a recurring event with a description, attendees, reminders and meeting information. Inspect **Repeats**, expand attendees and use the meeting/source links. Open a minimal all-day event and check the compact layout.
6. Change or delete an event, then refresh. The timetable and any open preview should update. Temporarily make the provider unavailable and refresh: cached events should remain visible with an alert.
7. Disconnect or change the calendar account. Events from the old connection must disappear. Sign-out clears the calendar cache. Restarting the app starts a new memory cache.
