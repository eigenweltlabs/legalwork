import { expect, test } from 'bun:test';
import { mailRecipientParts, mailRecipientAddress, mailRecipientAddresses, mailRecipientsInvalid } from './recipients.js';
import { mailDraftContentSchema } from './local-view.js';
import { buildMailMime, buildDraftMailMime } from './mime/compose.js';

test('recipient lists preserve quoted commas, escaped names, separators and unfinished fragments', () => {
  const text = 'first@example.test; "Doe, Jane" <jane@example.test>, "A \\"quoted\\" name" <last@example.test>\r\nunfinished@';
  expect(mailRecipientParts(text)).toEqual(['first@example.test', ' "Doe, Jane" <jane@example.test>', ' "A \\"quoted\\" name" <last@example.test>', '', 'unfinished@']);
  expect(mailRecipientAddresses(text)).toEqual(['first@example.test', 'jane@example.test', 'last@example.test']);
  expect(mailRecipientsInvalid(text)).toBe(true);
  expect(mailRecipientsInvalid('"Doe, Jane" <jane@example.test>; last@example.test, ')).toBe(false);
});

test('malformed display names, group syntax, hidden controls and multiple mailboxes cannot become one token', () => {
  for (const value of ['"Unclosed <one@example.test>', 'one@example.test two@example.test', 'Team: <one@example.test>', '<one@example.test><two@example.test>', 'Name <one@example.test> trailing', 'Name\r\nBcc: hidden@example.test <one@example.test>', 'Name\u0000 <one@example.test>']) expect(mailRecipientAddress(value)).toBeNull();
  expect(mailRecipientAddress('   "Doe, Jane" <jane@example.test>  ')).toBe('jane@example.test');
  expect(mailRecipientAddress('Jane <JANE@example.test>')).toBe('JANE@example.test');
});

const draft = (to: string[], text: string) => mailDraftContentSchema.parse({ from: 'self@example.test', to, subject: 'Synthetic recipients', text: 'Synthetic body', editor: { from: 'self@example.test', to: text, cc: '', bcc: '' } });
const options = { authorizedSenders: ['self@example.test'], attachment: async () => new Uint8Array() };

test('the shared serializer agrees with editor recipients and preserves the exact intended envelope', async () => {
  const to = ['jane@example.test', 'second@example.test'];
  const result = await buildMailMime(draft(to, '"Doe, Jane" <jane@example.test>; second@example.test'), options);
  expect(result.envelope.to).toEqual(to);
  expect(new TextDecoder().decode(result.raw)).toContain('To: jane@example.test,\r\n second@example.test');
  await expect(buildMailMime(draft(['other@example.test'], '"Doe, Jane" <jane@example.test>'), options)).rejects.toThrow('Complete every recipient');
});

test('an unfinished or injected recipient stays local to provider drafts and blocks submission', async () => {
  for (const raw of ['good@example.test, unfinished@', 'good@example.test\r\nBcc: hidden@example.test', '"Unclosed <good@example.test>']) {
    const content = draft(mailRecipientAddresses(raw), raw);
    await expect(buildMailMime(content, options)).rejects.toThrow('Complete every recipient');
    const provider = await buildDraftMailMime(content, options), bytes = new TextDecoder().decode(provider.raw);
    expect(provider.recipientInputLocalOnly).toBe(true);
    expect(bytes).not.toContain('unfinished@'); expect(bytes).not.toContain('hidden@example.test');
  }
});
