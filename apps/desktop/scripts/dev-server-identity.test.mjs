import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { matchesDevCheckout } from './dev-server-identity.mjs';

const expected = resolve('fixture/mail/apps/app');
async function withServer(body, check) {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/__legalwork_dev_server_id');
    response.setHeader('Content-Type', 'application/json');
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await check(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('reuses only the matching checkout, including normalized paths', async () => {
  await withServer(JSON.stringify({ appRoot: resolve(expected, '..', 'app') }), async url => {
    assert.equal(await matchesDevCheckout(url, expected), true);
  });
});

test('rejects a different LegalWork checkout before Electron can attach', async () => {
  await withServer(JSON.stringify({ appRoot: resolve('fixture/dev/apps/app') }), async url => {
    await assert.rejects(matchesDevCheckout(url, expected), /belongs to .*dev.*Choose a free PORT/);
  });
});

test('rejects generic Vite HTML and missing identity rather than trusting an open port', async () => {
  for (const body of ['<html>Vite</html>', '{}']) {
    await withServer(body, async url => {
      await assert.rejects(matchesDevCheckout(url, expected), /unidentified server/);
    });
  }
});

test('an unavailable listener can be started by the launcher', async () => {
  assert.equal(await matchesDevCheckout('http://127.0.0.1:1', expected, async () => {
    throw new TypeError('fetch failed');
  }), false);
});
