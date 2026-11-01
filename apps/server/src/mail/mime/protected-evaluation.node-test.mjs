import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { protectedMailFixture } from '../testing/protected-fixture.mjs';
import { projectMime } from './project.js';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema } from '../storage/schema.js';
import { MailPortabilityStore } from '../storage/portability.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { MailReadStore } from '../storage/read-store.js';
import { MailSearchStore } from '../storage/search.js';
import { MailCredentialRepository } from '../storage/credentials.js';

let directory, fixture;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'mail-protected-evaluation-')); fixture = await protectedMailFixture(directory); });
after(async () => { fixture?.passphrase.fill(0); if (directory) await rm(directory, { recursive: true, force: true }); });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function project(raw) {
  const attachments = [];
  const value = await projectMime({ source: [raw], originalSha256: digest(raw), onAttachment: async (metadata, source) => { const chunks = []; for await (const chunk of source) chunks.push(chunk); attachments.push({ metadata, bytes: Buffer.concat(chunks) }); } });
  return { value, attachments };
}
test('real detached and opaque CMS signatures validate against the isolated firm chain and signer email', async () => {
  assert.equal(fixture.verify('detached.eml').status, 0); assert.equal(fixture.verify('opaque.eml').status, 0);
  assert.deepEqual(await readFile(fixture.path('verified.mime')), fixture.entity);
  assert.notEqual(fixture.verify('tampered.eml').status, 0);
  assert.notEqual(fixture.verify('detached.eml', ['-verify_email', 'other@synthetic.example']).status, 0);
  assert.notEqual(fixture.verify('detached.eml', ['-CAfile', fixture.path('recipient.pem')]).status, 0);
});
test('certificate expiry, revocation and missing revocation evidence are separate reference failures', () => {
  assert.notEqual(fixture.verify('detached.eml', ['-attime', String(Math.floor(Date.now() / 1000) + 9 * 86400)]).status, 0);
  assert.notEqual(fixture.verify('detached.eml', ['-crl_check']).status, 0);
  const args = ['verify', '-CAfile', fixture.path('root.pem'), '-no-CApath', '-no-CAstore', '-untrusted', fixture.path('intermediate.pem'), '-purpose', 'smimesign', '-verify_email', 'sender@synthetic.example', '-CRLfile', fixture.path('intermediate.crl'), '-crl_check'];
  assert.equal(fixture.command([...args, fixture.path('sender.pem')], undefined, false).status, 0);
  const result = fixture.command([...args, fixture.path('revoked.pem')], undefined, false);
  assert.notEqual(result.status, 0); assert.match(result.stderr.toString('utf8'), /revoked/i);
  const trust = ['-CAfile', fixture.path('trust-with-crl.pem'), '-crl_check'];
  assert.equal(fixture.verify('detached.eml', trust).status, 0);
  const revokedMessage = fixture.verify('revoked.eml', trust);
  assert.notEqual(revokedMessage.status, 0); assert.match(revokedMessage.stderr.toString('utf8'), /revoked/i);
  const purpose = fixture.command([...args.slice(0, -3), fixture.path('server-only.pem')], undefined, false);
  assert.notEqual(purpose.status, 0); assert.match(purpose.stderr.toString('utf8'), /purpose/i);
});
test('a valid CMS payload does not authenticate an unsigned outer From header', () => {
  assert.equal(fixture.verify('wrong-header.eml').status, 0);
  assert.equal(fixture.verify('wrong-header.eml', ['-verify_email', 'other@synthetic.example']).status === 0, false);
});
test('real CBC and authenticated GCM envelopes require the recipient key and preserve the exact MIME after decryption', async () => {
  for (const name of ['encrypted.eml', 'authenticated.eml']) {
    assert.equal(fixture.decrypt(name).status, 0); assert.deepEqual(await readFile(fixture.path('decrypted.mime')), fixture.entity);
    assert.notEqual(fixture.decrypt(name, 'other.key').status, 0);
    assert.notEqual(fixture.decrypt(name, 'missing.key').status, 0);
  }
  assert.equal(fixture.decrypt('signed-encrypted.eml').status, 0);
  assert.equal(fixture.verify('decrypted.mime').status, 0);
});
test('password-protected PKCS12 import fails without the correct password and never installs a system key', () => {
  const args = ['pkcs12', '-in', fixture.path('sender.p12'), '-nokeys', '-passin', 'stdin'];
  assert.equal(fixture.command(args, fixture.passphrase, false).status, 0);
  assert.notEqual(fixture.command(args, Buffer.from('wrong\n'), false).status, 0);
});
test('current projection reads detached signed text without verifying it and cannot decode opaque or encrypted content', async () => {
  for (const item of fixture.cases) {
    const original = Buffer.from(item.raw), parsed = await project(item.raw);
    assert.deepEqual(item.raw, original); assert.equal(parsed.value.originalSha256, digest(original));
    if (item.readable) assert.ok(parsed.value.bodies.some(body => body.text.includes(item.marker)));
    else { assert.equal(parsed.value.bodies.length, 0); assert.ok(parsed.attachments.some(part => /pkcs7-mime/.test(part.metadata.contentType))); }
    assert.equal(Object.hasOwn(parsed.value.metadata, 'signatureVerified'), false);
  }
});
test('an untrusted Microsoft wrapper label is not a content license, signature result or decrypted protected body', async () => {
  const item = fixture.cases.find(item => item.syntheticWrapper), parsed = await project(item.raw);
  assert.equal(parsed.value.bodies.length, 1); assert.match(parsed.value.bodies[0].text, /PROVIDER_WRAPPER_ONLY/);
  assert.equal(parsed.attachments.length, 1); assert.equal(parsed.attachments[0].metadata.contentType, 'application/x-microsoft-rpmsg-message');
  assert.deepEqual(parsed.attachments[0].bytes, Buffer.from([0, 1, 2, 3, 254, 255]));
  assert.equal(Object.hasOwn(parsed.value.metadata, 'rights'), false); assert.equal(Object.hasOwn(parsed.value.metadata, 'label'), false);
});
for (const format of ['eml', 'mboxrd']) test(`encrypted storage, lexical search and ${format} export preserve actual signed/encrypted originals without inventing plaintext`, async () => {
  const root = await mkdtemp(join(directory, 'store-')), input = join(root, 'input'); await mkdir(input);
  for (const item of fixture.cases) await writeFile(join(input, item.name + '.eml'), item.raw, { mode: 0o600 });
  const key = randomBytes(32), path = join(root, 'mail.sqlite'), db = await openEncryptedMailDatabase({ path, key }); migrateMailSchema(db);
  const store = new MailPortabilityStore(db, 'owner');
  try {
    await store.startImport(input, 'eml', 'Protected evaluation'); await store.settled();
    const imported = store.list()[0]; assert.equal(imported.state, 'complete'); assert.equal(imported.completed, fixture.cases.length);
    const accountId = imported.accountId, reader = new MailReadStore(db, 'owner'), search = new MailSearchStore(db, 'owner');
    assert.equal(new MailCredentialRepository(db, 'owner').status(accountId).state, 'unconfigured');
    search.rebuild({ accountId, limit: 25 });
    const hits = search.search({ accountIds: [accountId], keywords: [fixture.marker] }).items;
    assert.deepEqual(hits.map(item => item.subject).sort(), ['Detached signed', 'Revoked signed']);
    assert.equal(search.search({ accountIds: [accountId], keywords: ['TAMPERED_CASE_2026_0042'] }).items.length, 1);
    const messages = reader.list(accountId, { limit: 25 }).items;
    const hashes = new Set(fixture.cases.map(item => digest(item.raw)));
    for (const item of messages) {
      const message = new MailRepository(db, 'owner').readMessage(accountId, item.locator), ref = message.content.find(part => part.kind === 'raw').ref_id;
      const raw = Buffer.concat([...new MailContentStore(db, 'owner').read(accountId, ref)]); assert.ok(hashes.has(digest(raw)));
    }
    assert.equal((await readFile(path)).includes(Buffer.from(fixture.marker)), false);
    await store.startExport(root, accountId, format); await store.settled(); const exported = store.list()[0]; assert.equal(exported.state, 'complete');
    await store.startImport(join(root, exported.label), 'bundle', 'Roundtrip'); await store.settled(); const roundtrip = store.list()[0];
    assert.equal(roundtrip.state, 'complete'); assert.equal(roundtrip.completed, fixture.cases.length);
    for (const row of db.all('SELECT locator_json FROM mail_messages WHERE account_id=?', [roundtrip.accountId])) {
      const message = new MailRepository(db, 'owner').readMessage(roundtrip.accountId, JSON.parse(row.locator_json));
      const ref = message.content.find(part => part.kind === 'raw').ref_id;
      const raw = Buffer.concat([...new MailContentStore(db, 'owner').read(roundtrip.accountId, ref)]); assert.ok(hashes.delete(digest(raw)));
    }
    assert.equal(hashes.size, 0);
  } finally { await store.close(); db.close(); key.fill(0); }
});
test('unavailable original bytes cannot be exported as a fabricated readable message', async () => {
  const root = await mkdtemp(join(directory, 'unavailable-')), key = randomBytes(32), db = await openEncryptedMailDatabase({ path: join(root, 'mail.sqlite'), key }); migrateMailSchema(db);
  const repo = new MailRepository(db, 'owner'); repo.createAccount({ id: 'a', provider: 'archive', displayName: 'Unavailable original' });
  repo.ingestMessage('a', { locator: { provider: 'archive', namespace: randomUUID(), entryId: 'one' }, subject: 'Protected original unavailable', rfcMessageId: null, memberships: [] });
  const store = new MailPortabilityStore(db, 'owner');
  try {
    await store.startExport(root, 'a', 'eml'); await store.settled(); const result = store.list()[0];
    assert.equal(result.state, 'attention'); assert.equal(result.failed, 1); assert.equal(result.completed, 0);
    assert.deepEqual(await readdir(join(root, result.label, 'messages')), []);
  } finally { await store.close(); db.close(); key.fill(0); }
});
