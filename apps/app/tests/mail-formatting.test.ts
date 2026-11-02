import { expect, test } from 'bun:test';
import { composeLinkUrl } from '../src/react-app/domains/mail/mail-formatting';
import { emptyCompose, initialComposeContent } from '../src/react-app/domains/mail/mail-compose-model';

test('compose links accept complete HTTP(S) URLs and preserve legal references and query punctuation', () => {
  expect(composeLinkUrl(' https://example.com/Änderung/AZ-12%2F34.5?x=1&y=2#section-3 ')).toBe('https://example.com/%C3%84nderung/AZ-12%2F34.5?x=1&y=2#section-3');
  expect(composeLinkUrl('http://example.test')).toBe('http://example.test/');
});

test('compose links reject scripts, local resources, relative URLs, credentials and embedded controls', () => {
  for (const value of ['', 'https://', 'javascript:alert(1)', 'data:text/html,test', 'file:///private/test', 'mailto:test@example.test', '//example.test', '/reference', 'https://user:password@example.test', 'https://user@example.test', 'https://example.test/\nsecret', 'https://example.test/\u0000']) {
    expect(composeLinkUrl(value)).toBeNull();
  }
});

test('new document composition preserves quoted text and signatures without interpreting HTML', () => {
  const original = { ...emptyCompose('self@example.test'), text: 'Review <draft> & terms\n\n-- \nPartner & Counsel', senderSignature: 'Partner & Counsel' };
  const document = initialComposeContent(original, false);
  expect(document.text).toBe(original.text);
  expect(document.html).toBe('Review &lt;draft&gt; &amp; terms<div data-mail-signature="true"><br><br>-- <br>Partner &amp; Counsel</div>');
  expect(original.html).toBeNull();
});

test('saved and recovered plain-text drafts retain their format and oversize conversion cannot invalidate a draft', () => {
  const plain = emptyCompose('self@example.test');
  expect(initialComposeContent(plain, true)).toBe(plain);
  const rich = { ...plain, html: '<p>Existing</p>' };
  expect(initialComposeContent(rich, false)).toBe(rich);
  const large = { ...plain, text: '&'.repeat(5000) };
  expect(initialComposeContent(large, false) === large).toBe(true);
});
