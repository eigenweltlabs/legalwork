import { mailTimeZoneSchema, type MailTime } from '../../../../../server/src/mail/scheduling-view';

function wallParts(at: number, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
  return { wall: `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`, scalar: Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute)) };
}

export function mailScheduleWall(time: MailTime): string {
  return wallParts(time.at, time.timeZone).wall;
}

export function mailScheduleCandidates(wall: string, timeZone: string): { at: number; offset: string }[] {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(wall) || !mailTimeZoneSchema.safeParse(timeZone).success) return [];
  const naive = Date.parse(wall + ':00Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== wall) return [];
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const probe = naive + hours * 3600000;
    offsets.add(wallParts(probe, timeZone).scalar - probe);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(at => wallParts(at, timeZone).wall === wall).sort((a, b) => a - b);
  return candidates.map(at => ({ at, offset: new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? 'UTC' }));
}

export function formatMailSchedule(time: MailTime): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: time.timeZone, dateStyle: 'medium', timeStyle: 'long' }).format(time.at);
}
