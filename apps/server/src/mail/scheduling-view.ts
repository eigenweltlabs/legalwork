import { z } from 'zod';

export const mailTimeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Choose a valid time zone.');

export const mailTimeSchema = z.object({
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timeZone: mailTimeZoneSchema,
}).strict();
export type MailTime = z.infer<typeof mailTimeSchema>;

export function validFutureMailTime(time: MailTime, now: number): boolean {
  return mailTimeSchema.safeParse(time).success && time.at > now && time.at <= now + 366 * 86400000;
}
