import { spawnSync } from 'node:child_process';
import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Evaluation-only PKI. Never reads OS trust, user keys, credentials or provider accounts. */
export async function protectedMailFixture(directory) {
  const executable = process.env.LEGALWORK_MAIL_OPENSSL ?? 'openssl';
  function command(args, input, expectSuccess = true) {
    const result = spawnSync(executable, args, { input, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (expectSuccess && (result.error || result.status !== 0)) throw Error('Synthetic OpenSSL operation failed: ' + args[0] + '. OpenSSL 3 is required.');
    return result;
  }
  const version = command(['version']).stdout.toString('utf8').trim();
  if (!/^OpenSSL 3\./.test(version)) throw Error('Protected-mail evaluation requires OpenSSL 3.');
  const path = name => join(directory, name);
  async function file(name, content) { await writeFile(path(name), content, { mode: 0o600 }); return path(name); }
  const subject = name => '/O=LegalWork Synthetic Firm/CN=' + name;
  command(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '30', '-keyout', path('root.key'), '-out', path('root.pem'), '-subj', subject('Evaluation Root'), '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  command(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', path('intermediate.key'), '-out', path('intermediate.csr'), '-subj', subject('Firm Mail CA')]);
  await file('intermediate.ext', 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
  command(['x509', '-req', '-in', path('intermediate.csr'), '-CA', path('root.pem'), '-CAkey', path('root.key'), '-CAcreateserial', '-days', '14', '-extfile', path('intermediate.ext'), '-out', path('intermediate.pem')]);
  for (const name of ['root.key', 'intermediate.key']) await chmod(path(name), 0o600);
  for (const name of ['sender', 'recipient', 'other', 'revoked', 'server-only']) {
    command(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', path(name + '.key'), '-out', path(name + '.csr'), '-subj', subject(name)]);
    const email = name === 'revoked' || name === 'server-only' ? 'sender' : name;
    await file(name + '.ext', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' + (name === 'server-only' ? 'serverAuth' : 'emailProtection') + '\nsubjectAltName=email:' + email + '@synthetic.example\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
    command(['x509', '-req', '-in', path(name + '.csr'), '-CA', path('intermediate.pem'), '-CAkey', path('intermediate.key'), '-CAcreateserial', '-days', '7', '-extfile', path(name + '.ext'), '-out', path(name + '.pem')]);
    await chmod(path(name + '.key'), 0o600);
  }
  const marker = 'PRIVILEGED_CASE_2026_0042';
  const entity = Buffer.from('Content-Type: multipart/mixed; boundary="firm-payload"\r\n\r\n--firm-payload\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' + marker + ' Prüfung des Vertrags.\r\n--firm-payload\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="evidence.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQIDBA==\r\n--firm-payload--\r\n');
  await file('payload.mime', entity);
  const outer = (label, bytes, from = 'sender@synthetic.example') => Buffer.concat([Buffer.from('From: Synthetic Lawyer <' + from + '>\r\nTo: recipient@synthetic.example\r\nSubject: ' + label + '\r\nMessage-ID: <' + label.replaceAll(' ', '-') + '@synthetic.example>\r\n'), bytes]);
  const sign = (source, target, opaque = false, signer = 'sender') => command(['cms', '-sign', '-binary', '-crlfeol', '-md', 'sha256', '-in', path(source), '-signer', path(signer + '.pem'), '-inkey', path(signer + '.key'), '-certfile', path('intermediate.pem'), '-out', path(target), ...(opaque ? ['-nodetach'] : [])]);
  sign('payload.mime', 'detached.cms'); sign('payload.mime', 'opaque.cms', true);
  sign('payload.mime', 'revoked.cms', false, 'revoked');
  const encrypt = (source, target, cipher) => command(['cms', '-encrypt', '-binary', '-crlfeol', cipher, '-in', path(source), '-out', path(target), path('recipient.pem')]);
  encrypt('payload.mime', 'encrypted.cms', '-aes-256-cbc');
  encrypt('payload.mime', 'authenticated.cms', '-aes-256-gcm');
  encrypt('detached.cms', 'signed-encrypted.cms', '-aes-256-cbc');
  const detached = outer('Detached signed', await readFile(path('detached.cms')));
  const tampered = Buffer.from(detached.toString('utf8').replace(marker, 'TAMPERED_CASE_2026_0042'));
  // Structural boundary fixture only. This is not a licensed or valid MIP/RPMSG package.
  const microsoftWrapper = outer('Microsoft wrapper', Buffer.from('MIME-Version: 1.0\r\nMSIP_Labels: synthetic-untrusted-label\r\nContent-Type: multipart/mixed; boundary="mip-boundary"\r\n\r\n--mip-boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPROVIDER_WRAPPER_ONLY\r\n--mip-boundary\r\nContent-Type: application/x-microsoft-rpmsg-message\r\nContent-Disposition: attachment; filename="message.rpmsg"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA/7/\r\n--mip-boundary--\r\n'));
  const cases = [
    { name: 'detached', raw: detached, readable: true, marker },
    { name: 'revoked', raw: outer('Revoked signed', await readFile(path('revoked.cms'))), readable: true, marker },
    { name: 'tampered', raw: tampered, readable: true, marker: 'TAMPERED_CASE_2026_0042' },
    { name: 'opaque', raw: outer('Opaque signed', await readFile(path('opaque.cms'))), readable: false, marker },
    { name: 'encrypted', raw: outer('Encrypted', await readFile(path('encrypted.cms'))), readable: false, marker },
    { name: 'authenticated', raw: outer('Authenticated encrypted', await readFile(path('authenticated.cms'))), readable: false, marker },
    { name: 'signed-encrypted', raw: outer('Signed then encrypted', await readFile(path('signed-encrypted.cms'))), readable: false, marker },
    { name: 'microsoft-wrapper', raw: microsoftWrapper, readable: true, marker: 'PROVIDER_WRAPPER_ONLY', syntheticWrapper: true },
  ];
  for (const value of cases) await file(value.name + '.eml', value.raw);
  const wrongHeader = outer('Different outer sender', await readFile(path('detached.cms')), 'other@synthetic.example');
  await file('wrong-header.eml', wrongHeader);
  const passphrase = Buffer.from('synthetic-evaluation-password\n');
  command(['pkcs12', '-export', '-inkey', path('sender.key'), '-in', path('sender.pem'), '-certfile', path('intermediate.pem'), '-out', path('sender.p12'), '-passout', 'stdin'], passphrase);
  await chmod(path('sender.p12'), 0o600);
  await mkdir(path('ca'), { mode: 0o700 }); await file('ca/index', ''); await file('ca/crlnumber', '1000\n');
  await file('ca/config', '[ ca ]\ndefault_ca=firm\n[ firm ]\ndatabase=' + path('ca/index') + '\nnew_certs_dir=' + path('ca') + '\ncertificate=' + path('intermediate.pem') + '\nprivate_key=' + path('intermediate.key') + '\ncrlnumber=' + path('ca/crlnumber') + '\ndefault_md=sha256\ndefault_crl_days=1\n');
  command(['ca', '-config', path('ca/config'), '-revoke', path('revoked.pem'), '-batch']);
  command(['ca', '-config', path('ca/config'), '-gencrl', '-out', path('intermediate.crl'), '-batch']);
  await file('trust-with-crl.pem', Buffer.concat([await readFile(path('root.pem')), await readFile(path('intermediate.crl'))]));
  const verify = (name, extra = []) => command(['cms', '-verify', '-in', path(name), '-CAfile', path('root.pem'), '-no-CApath', '-no-CAstore', '-purpose', 'smimesign', '-verify_email', 'sender@synthetic.example', '-out', path('verified.mime'), ...extra], undefined, false);
  const decrypt = (name, key = 'recipient.key') => command(['cms', '-decrypt', '-binary', '-in', path(name), '-recip', path('recipient.pem'), '-inkey', path(key), '-out', path('decrypted.mime')], undefined, false);
  return { version, path, command, cases, marker, entity, verify, decrypt, passphrase };
}
