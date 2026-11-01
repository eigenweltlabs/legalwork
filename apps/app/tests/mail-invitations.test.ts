import { test, expect } from 'bun:test';
import { invitationDay, invitationRange, invitationTime } from '../src/react-app/domains/mail/mail-invitation-model';
import { calendarAnchor, calendarDay } from '../src/react-app/domains/calendar/calendar-format';
import type { MailInvitationTime } from '../../server/src/mail/invitation-view';

const date = (value: string): MailInvitationTime => ({ value, kind: 'date', instant: null, timeZone: null });

test('all-day invitation labels use inclusive last dates and navigation retains the original day', () => {
  const start = date('2026-11-03');
  expect(invitationRange({ start, end: date('2026-11-04') }, 'en-US')).toBe('November 3, 2026');
  expect(invitationRange({ start, end: date('2026-11-05') }, 'en-US')).toBe('November 3, 2026 – November 4, 2026');
  expect(invitationDay(start)).toBe('2026-11-03');
  expect(invitationDay(null)).toBeNull();
});

test('floating and ambiguous source times stay distinct from viewer-local instants', () => {
  const floating: MailInvitationTime = { value: '2026-11-03T10:00:00', kind: 'floating', instant: null, timeZone: null };
  expect(invitationTime(floating, 'en-US')).toBe('2026-11-03 10:00:00');
  expect(invitationTime({ ...floating, kind: 'zoned', timeZone: 'Europe/Berlin' }, 'en-US')).toContain('Europe/Berlin');
  const instant = '2026-11-03T23:30:00.000Z';
  expect(invitationDay({ ...floating, kind: 'utc', instant, timeZone: 'UTC' })).toBe(calendarDay(new Date(instant)));
});

test('Calendar accepts only a valid day from an invitation deep link', () => {
  expect(calendarAnchor('2026-11-03')?.getDate()).toBe(3);
  for (const value of [null, '', '2026-02-30', '2026-13-01', '2026-11-03T00:00:00Z', 'javascript:alert(1)']) expect(calendarAnchor(value)).toBeNull();
});
