import { afterEach, expect, test } from 'bun:test';
import { registerMailComposeShutdown, type MailComposeShutdownState } from '../src/react-app/domains/mail/mail-compose-shutdown';
import { getUnsavedDocuments, settleUnsavedDocuments } from '../src/react-app/domains/session/artifacts/docx-document-state';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
function composer(initial: Partial<MailComposeShutdownState> = {}, key = 'mail:test-account:draft') {
  const state: MailComposeShutdownState = { saving: false, pending: false, saveError: false, recovered: false, invalid: false, uploading: false, sending: false, switching: false, ...initial };
  let saves = 0, closes = 0;
  let save = async () => { saves++; state.pending = false; state.saveError = false; };
  const binding = registerMailComposeShutdown({ key, name: 'Test email', read: () => state, save: () => save(), close: () => { closes++; } });
  cleanups.push(binding.dispose);
  return { state, binding, saves: () => saves, closes: () => closes, setSave: (action: () => Promise<void>) => { save = action; } };
}

test('saved mail never prompts or writes during shared shutdown', async () => {
  const mail = composer();
  expect(getUnsavedDocuments()).toHaveLength(0);
  expect(await settleUnsavedDocuments('save')).toBe(true);
  expect(mail.saves()).toBe(0);
});

test('shared shutdown protects an in-flight save, then observes its completion', async () => {
  const mail = composer({ saving: true });
  expect(getUnsavedDocuments().map(item => item.name)).toEqual(['Test email']);
  expect(await settleUnsavedDocuments('save')).toBe(false);
  expect(await settleUnsavedDocuments('discard')).toBe(false);
  expect(mail.saves()).toBe(0); expect(mail.closes()).toBe(0);
  mail.state.saving = false;
  expect(await settleUnsavedDocuments('save')).toBe(true);
});

test('retry Save keeps the composer until its local draft is durable', async () => {
  const mail = composer({ pending: true, saveError: true });
  expect(await settleUnsavedDocuments('save')).toBe(true);
  expect(mail.saves()).toBe(1); expect(mail.closes()).toBe(0);
  expect(mail.binding.isDirty()).toBe(false);
});

test('an encrypted recovery copy permits shutdown without retrying a failed local save', async () => {
  const mail = composer({ pending: true, saveError: true, recovered: true });
  expect(await settleUnsavedDocuments('save')).toBe(true);
  expect(mail.saves()).toBe(0);
  expect(mail.binding.isDirty()).toBe(false);
});

test('invalid live text requires correction or an explicit discard', async () => {
  const mail = composer({ invalid: true });
  expect(await settleUnsavedDocuments('save')).toBe(false);
  expect(mail.saves()).toBe(0); expect(mail.closes()).toBe(0);
  expect(await settleUnsavedDocuments('discard')).toBe(true);
  expect(mail.closes()).toBe(1); expect(mail.binding.isDirty()).toBe(false);
});

for (const operation of ['uploading', 'sending', 'switching']) {
  test(`${operation} cannot be discarded or restarted halfway through`, async () => {
    const mail = composer();
    if (operation === 'uploading') mail.state.uploading = true;
    if (operation === 'sending') mail.state.sending = true;
    if (operation === 'switching') mail.state.switching = true;
    expect(await settleUnsavedDocuments('save')).toBe(false);
    expect(await settleUnsavedDocuments('discard')).toBe(false);
    expect(mail.saves()).toBe(0); expect(mail.closes()).toBe(0);
  });
}

test('edits arriving during Save keep shutdown blocked', async () => {
  const mail = composer({ pending: true });
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  mail.setSave(async () => { mail.state.pending = false; mail.state.saving = true; await pending; mail.state.saving = false; });
  const settling = settleUnsavedDocuments('save');
  mail.state.pending = true; release();
  expect(await settling).toBe(false);
  expect(mail.closes()).toBe(0);
});

test('registration cleanup preserves another account draft', () => {
  const first = composer({ pending: true }, 'mail:first:draft');
  composer({ pending: true }, 'mail:second:draft');
  first.binding.dispose();
  expect(getUnsavedDocuments().map(item => item.key)).toEqual(['mail:second:draft']);
});
