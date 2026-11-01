import { test, expect } from 'bun:test';
import { mailScheduleCandidates, mailScheduleWall } from '../src/react-app/domains/mail/mail-scheduling-model';
import { validFutureMailTime } from '../../server/src/mail/scheduling-view';

test('a repeated daylight-saving wall time requires two distinct explicit instants', () => {
  expect(mailScheduleCandidates('2026-10-25T02:30', 'Europe/Berlin').map(item => new Date(item.at).toISOString())).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
  expect(mailScheduleCandidates('2026-11-01T01:30', 'America/New_York').map(item => new Date(item.at).toISOString())).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  const halfHour = mailScheduleCandidates('2026-04-05T01:45', 'Australia/Lord_Howe');
  expect(halfHour).toHaveLength(2); expect(halfHour[1].at - halfHour[0].at).toBe(1800000);
});

test('missing wall times, invalid dates and invalid zones never silently select another time', () => {
  for (const [wall, zone] of [['2026-03-29T02:30', 'Europe/Berlin'], ['2026-10-04T02:15', 'Australia/Lord_Howe'], ['2011-12-30T12:00', 'Pacific/Apia'], ['2026-02-30T12:00', 'UTC'], ['2026-11-02T09:00', 'Invalid/Zone']]) {
    expect(mailScheduleCandidates(wall, zone)).toEqual([]);
  }
});

test('fixed UTC instants retain their selected zone, including fractional-hour offsets', () => {
  const [choice] = mailScheduleCandidates('2026-11-02T09:00', 'Asia/Kathmandu');
  expect(new Date(choice.at).toISOString()).toBe('2026-11-02T03:15:00.000Z');
  expect(choice.offset).toBe('GMT+05:45');
  expect(mailScheduleWall({ at: choice.at, timeZone: 'Asia/Kathmandu' })).toBe('2026-11-02T09:00');
  expect(mailScheduleWall({ at: choice.at, timeZone: 'UTC' })).toBe('2026-11-02T03:15');
});

test('new schedules require a valid zone and a future instant within the declared horizon', () => {
  const now = Date.parse('2026-11-01T12:00Z'), time = { at: now + 60000, timeZone: 'Europe/Berlin' };
  expect(validFutureMailTime(time, now)).toBe(true);
  expect(validFutureMailTime({ ...time, at: now }, now)).toBe(false);
  expect(validFutureMailTime({ ...time, at: now + 367 * 86400000 }, now)).toBe(false);
  expect(validFutureMailTime({ ...time, timeZone: 'Invalid' }, now)).toBe(false);
});
