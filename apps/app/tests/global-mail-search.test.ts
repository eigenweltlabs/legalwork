import { expect, test } from 'bun:test';
import { MailClient } from '../src/react-app/domains/mail/mail-client';
import { searchGlobalMail } from '../src/react-app/shell/global-mail-search';

const hit = { accountId: 'a', locator: { provider: 'gmail', messageId: 'same-id' }, subject: 'Änderung AZ-12/34.5', sender: 'Sender <sender@example.test>', snippet: 'Matching downloaded text', date: '2026-11-01T10:00:00.000Z', hasAttachment: true };
const empty = { items: [], total: 0, pending: 0, incomplete: 0, nextOffset: null };
const account = (id: string) => ({ id, provider: 'gmail', displayName: `Account ${id}` });
const signal = () => new AbortController().signal;

test('global mail search leaves a locked store locked and never enumerates accounts or bodies', async () => {
  const paths: string[] = [];
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async url => {
    paths.push(String(url)); return Response.json({ state: 'locked' });
  });
  expect(await searchGlobalMail(client, 'contract', '', signal())).toBeNull();
  expect(paths).toEqual(['http://127.0.0.1:8787/mail/v1/status']);
});

test('global mail search uses authenticated local POST, exact punctuation, paged accounts and exact message locators', async () => {
  let searches = 0;
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async (url, init) => {
    expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'synthetic' });
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/status')) return Response.json({ state: 'ready', accountRevision: 4 });
    if (path.endsWith('/accounts')) return Response.json(new URL(String(url)).searchParams.has('after')
      ? { items: [account('b')], nextCursor: null } : { items: [account('a')], nextCursor: 'next' });
    expect(path).toBe('/mail/v1/search'); searches++;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ literal: 'Änderung AZ-12/34.5', limit: 25 });
    return Response.json({ ...empty, items: [hit, { ...hit, accountId: 'b' }], total: 30, nextOffset: 25, pending: 1 });
  });
  const page = await searchGlobalMail(client, 'Änderung AZ-12/34.5', '', signal());
  expect(searches).toBe(1); expect(page?.accounts).toHaveLength(2);
  expect(page?.items.map(item => item.id)[0]).not.toBe(page?.items[1].id);
  expect(page?.items[1]).toMatchObject({ account: 'Account b', serverOrigin: 'http://127.0.0.1:8787', locator: hit.locator });
  expect(page).toMatchObject({ limited: true, incomplete: true, accountRevision: 4 });
});

test('selected account scope is sent to the existing search and foreign account results fail closed', async () => {
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async (url, init) => {
    if (String(url).endsWith('/status')) return Response.json({ state: 'ready' });
    if (String(url).includes('/accounts?')) return Response.json({ items: [account('a'), account('b')], nextCursor: null });
    expect(JSON.parse(String(init?.body)).accountIds).toEqual(['a']);
    return Response.json({ ...empty, items: [{ ...hit, accountId: 'b' }], total: 1 });
  });
  await expect(searchGlobalMail(client, 'contract', 'a', signal())).rejects.toMatchObject({ status: 409 });
  await expect(searchGlobalMail(client, 'contract', 'foreign', signal())).rejects.toMatchObject({ status: 404 });
});

test('lock or changed account binding during a query cannot publish old mail results', async () => {
  for (const final of [{ state: 'locked', accountRevision: 1 }, { state: 'ready', accountRevision: 2 }]) {
    let statuses = 0;
    const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async url => {
      if (String(url).endsWith('/status')) return Response.json(++statuses === 1 ? { state: 'ready', accountRevision: 1 } : final);
      if (String(url).includes('/accounts?')) return Response.json({ items: [account('a')], nextCursor: null });
      return Response.json({ ...empty, items: [hit], total: 1 });
    });
    if (final.state === 'locked') expect(await searchGlobalMail(client, 'contract', '', signal())).toBeNull();
    else await expect(searchGlobalMail(client, 'contract', '', signal())).rejects.toMatchObject({ status: 409 });
  }
});

test('an ignored cancellation cannot restore a late result and empty input does not run a mailbox query', async () => {
  const abort = new AbortController(); let searches = 0;
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async url => {
    if (String(url).endsWith('/status')) return Response.json({ state: 'ready' });
    if (String(url).includes('/accounts?')) return Response.json({ items: [account('a')], nextCursor: null });
    searches++; abort.abort(); return Response.json({ ...empty, items: [hit], total: 1 });
  });
  expect((await searchGlobalMail(client, '', '', signal()))?.items).toEqual([]); expect(searches).toBe(0);
  await expect(searchGlobalMail(client, 'contract', '', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
