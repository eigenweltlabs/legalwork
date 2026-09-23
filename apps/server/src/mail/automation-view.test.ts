import { expect, test } from 'bun:test';
import {
  automationCommandSchema,
  automationInputSchema,
  automationResultSchema,
  localRuleDefinitionSchema,
  mailTimeSchema,
  validateMailTime,
} from './automation-view.js';
import { parseParentMessage } from './runtime/protocol.js';

const now = Date.UTC(2026, 8, 23, 12);
const rule = { name: 'Client updates', enabled: true, from: 'client@example.test', subject: '', action: 'flag' };

test('rule contracts require bounded conditions and cannot authorize send or arbitrary scripts', () => {
  expect(localRuleDefinitionSchema.parse(rule).action).toBe('flag');
  for (const definition of [
    { ...rule, from: '', subject: '  ' },
    { ...rule, action: 'send' },
    { ...rule, script: 'sendAll()' },
    { ...rule, subject: 'x'.repeat(161) },
    { ...rule, snoozeMinutes: 10081 },
  ]) expect(localRuleDefinitionSchema.safeParse(definition).success).toBe(false);
  expect(automationResultSchema.safeParse({ kind: 'rules', ready: true, items: Array(21).fill({}) }).success).toBe(false);
});

test('UTC instants remain fixed across display zones and reject invalid or expired schedules', () => {
  const at = now + 3600000;
  for (const timeZone of ['Europe/Berlin', 'America/New_York', 'UTC']) {
    const time = mailTimeSchema.parse({ at, timeZone });
    expect(time.at).toBe(at);
    expect(() => validateMailTime(time, now)).not.toThrow();
  }
  expect(mailTimeSchema.safeParse({ at, timeZone: 'Not/AZone' }).success).toBe(false);
  for (const instant of [now, now - 1, now + 367 * 86400000]) {
    expect(() => validateMailTime({ at: instant, timeZone: 'UTC' }, now)).toThrow('mail_automation_invalid_input');
  }
});

test('dormant operations retain account and version fences without enabling a worker route', () => {
  const command = automationCommandSchema.parse({
    operation: 'mail.automation', accountId: 'firm', input: { action: 'rules' },
  });
  expect(command.accountId).toBe('firm');
  expect(parseParentMessage(JSON.stringify({ kind: 'request', id: '1:1', command }))).toBeUndefined();
  expect(automationInputSchema.safeParse({ action: 'reschedule', actionId: 'send', time: { at: now + 1, timeZone: 'UTC' } }).success).toBe(false);
  expect(automationInputSchema.safeParse({ action: 'snooze-set', expected: null, time: null,
    locator: { provider: 'archive', namespace: 'local', entryId: 'one' } }).success).toBe(false);
});
