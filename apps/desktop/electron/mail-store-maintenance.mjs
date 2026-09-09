import { createHash, createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createMailKeyStore } from './mail-key-store.mjs';
/** @param {string} passphrase @param {Buffer} salt @returns {Promise<Buffer>} */
function derive(passphrase, salt) { return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N:32768, r:8, p:1, maxmem:64*1024*1024 }, (error, key) => error ? reject(error) : resolve(key))); }
const fail = () => new Error('mail_maintenance_failed');
async function privateEntry(path, directory = false) {
  const info = await lstat(path);
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) throw fail();
  return info;
}
async function syncDirectory(path) { if (process.platform === 'win32') return; const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
async function writePrivate(path, value) { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(value); await file.sync(); } finally { await file.close(); } }
async function jsonFile(path) { const info = await privateEntry(path); if (!info.size || info.size > 16384) throw fail(); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const bytes = Buffer.alloc(16385); const read = await file.read(bytes, 0, bytes.length, 0); if (read.bytesRead !== info.size) throw fail(); return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')); } finally { await file.close(); } }
async function digest(path) { await privateEntry(path); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const hash = createHash('sha256'); for await (const chunk of file.createReadStream({autoClose:false})) hash.update(chunk); return hash.digest('hex'); } finally { await file.close(); } }
function decode(value, size) { if (typeof value !== 'string') throw fail(); const bytes = Buffer.from(value, 'base64'); if (bytes.length !== size || bytes.toString('base64') !== value) throw fail(); return bytes; }
function password(value) { if (typeof value !== 'string' || value.length < 16 || Buffer.byteLength(value) > 1024) throw fail(); }
/** Main-process only; caller must hold LocalMailService maintenance barrier and desktop single-instance lock.
 * All paths originate in app data or a trusted native file chooser, never renderer input.
 */
export function createMailStoreMaintenance({ directory, safeStorage, executable, entryPoint, windowsAcl, beforeAccess, ownerId = 'desktop-local' }) {
  if (!isAbsolute(directory) || !isAbsolute(entryPoint) || !isAbsolute(executable.path)) throw fail();
  const pointer = join(directory, 'active-store-v1.json'); let busy = false, physicalPending = false;
  async function acl(path, folder) { if (process.platform === "win32") { if (!windowsAcl) throw fail(); await windowsAcl(path, folder); } }
  async function selected() {
    let value;
    try { value = await jsonFile(pointer); } catch (error) {
      if (error?.code !== 'ENOENT') throw fail();
      let entries; try { entries = await readdir(directory); } catch (missing) { if (missing?.code === 'ENOENT') return null; throw fail(); }
      if (entries.some(name => name.startsWith('store-') || name.startsWith('.active-'))) throw fail();
      return null;
    }
    if (!value || Object.keys(value).sort().join(',') !== 'generation,version' || value.version !== 1 || (value.generation !== null && !/^[a-f0-9]{32}$/.test(value.generation))) throw fail();
    if (value.generation === null) return null;
    const folder = join(directory, `store-${value.generation}`); await privateEntry(folder, true); return { generation: value.generation, folder };
  }
  async function loadStore() {
    if (busy || physicalPending) throw fail(); const active = await selected(), folder = active?.folder ?? directory;
    const key = await createMailKeyStore({ directory: folder, safeStorage, windowsAcl, beforeAccess }).load({ allowCreate: !active });
    return { databasePath: join(folder, 'mail.sqlite'), key };
  }
  async function worker(input, signal) {
    if (signal?.aborted) throw fail();
    return new Promise((resolve, reject) => {
      /** @type {NodeJS.ProcessEnv} */
      const env = {}; for (const name of ['SystemRoot','WINDIR']) if (process.env[name]) env[name] = process.env[name];
      if (executable.kind === 'electron') env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
      physicalPending = true;
      const child = spawn(executable.path, [entryPoint], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let output = '', settled = false, failed = false;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let reapTimer;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(reapTimer); signal?.removeEventListener('abort', abort); if (error) reject(fail()); else resolve(value); };
      const abort = () => {
        if (failed || settled) return; failed = true; child.kill('SIGKILL');
        // Wait for physical termination. A lost close event must not reopen the store.
        reapTimer = setTimeout(() => finish(true), 5000);
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 120000);
      child.stdout.on('data', bytes => { if (failed) return; output += bytes.toString('utf8'); if (output.length > 4096) abort(); });
      child.stderr.resume(); // Never forward native errors or private data to app diagnostics.
      child.on('error', abort); child.stdin.on('error', abort);
      child.on('close', code => {
        physicalPending = false;
        try { const result = JSON.parse(output); if (failed || code !== 0 || result.ok !== true || Object.keys(result).sort().join(',') !== 'accounts,messages,ok,references,schemaVersion' || !['accounts','messages','references','schemaVersion'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)) throw fail(); finish(false, result); } catch { finish(true); }
      });
      child.stdin.end(JSON.stringify({ ...input, sourceKey: input.sourceKey.toString('base64'), destinationKey: input.destinationKey.toString('base64'), ownerId }));
    });
  }
  async function exclusive(action) {
    if (busy || physicalPending) throw fail(); busy = true;
    try { try { await mkdir(directory, {mode:0o700}); } catch (error) { if (error?.code !== 'EEXIST') throw error; } await privateEntry(directory, true); await acl(directory, true); return await action(); }
    catch { throw fail(); } finally { busy = false; }
  }
  async function candidate() {
    // Commit the initial legacy selection before creating any candidate. An aborted
    // first rotation can reopen legacy; a lost pointer after promotion cannot.
    await selected();
    try { await writePrivate(pointer, JSON.stringify({ version: 1, generation: null })); await syncDirectory(directory); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }

    const generation = randomBytes(16).toString('hex'), folder = join(directory, `store-${generation}`);
    await mkdir(folder, { mode: 0o700 }); const key = await createMailKeyStore({ directory: folder, safeStorage, windowsAcl, beforeAccess }).load({ allowCreate: true });
    return { generation, folder, key, databasePath: join(folder, 'mail.sqlite') };
  }
  async function promote(next, previous, signal) {
    if ((await selected())?.generation !== previous?.generation) throw fail();
    await syncDirectory(next.folder); const temporary = join(directory, `.active-${next.generation}.tmp`);
    await writePrivate(temporary, JSON.stringify({ version: 1, generation: next.generation }));
    if (signal?.aborted) throw fail();
    await rename(temporary, pointer); await syncDirectory(directory);
  }
  async function current() { const active = await selected(), folder = active?.folder ?? directory; return { active, databasePath: join(folder,'mail.sqlite'), key: await createMailKeyStore({ directory: folder, safeStorage, windowsAcl, beforeAccess }).load() }; }
  return {
    loadStore,
    rotate(signal) { return exclusive(async () => {
      const before = await current(); let next;
      try { next = await candidate(); const result = await worker({ sourcePath: before.databasePath, destinationPath: next.databasePath, sourceKey: before.key, destinationKey: next.key, restore: false, expectedSha256: null }, signal); await promote(next, before.active, signal); return { ...result, generation: next.generation }; }
      finally { before.key.fill(0); next?.key.fill(0); }
    }); },
    exportBackup(destination, passphrase, signal) { password(passphrase); return exclusive(async () => {
      if (!isAbsolute(destination)) throw fail(); await mkdir(destination, { mode: 0o700 }); await acl(destination, true);
      const before = await current(); let wrapping;
      try {
        const databasePath = join(destination, 'mail.sqlite'); const result = await worker({ sourcePath: before.databasePath, destinationPath: databasePath, sourceKey: before.key, destinationKey: before.key, restore: false, expectedSha256: null }, signal);
        const sha256 = await digest(databasePath), salt = randomBytes(16), nonce = randomBytes(12);
        wrapping = await derive(passphrase, salt);
        const cipher = createCipheriv('aes-256-gcm', wrapping, nonce); cipher.setAAD(Buffer.from(`legalwork-mail-recovery-v1:${sha256}`));
        const payload = Buffer.from(JSON.stringify({ key: before.key.toString('base64'), ownerId, schemaVersion: result.schemaVersion }));
        let encrypted; try { encrypted = Buffer.concat([cipher.update(payload), cipher.final()]); } finally { payload.fill(0); }
        if (signal?.aborted) throw fail();
        await writePrivate(join(destination, 'recovery.json'), JSON.stringify({ version: 1, sha256, salt: salt.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') }));
        await syncDirectory(destination); return { ...result, backupPath: destination };
      } finally { before.key.fill(0); wrapping?.fill(0); }
    }); },
    restoreBackup(source, passphrase, signal) { password(passphrase); return exclusive(async () => {
      if (!isAbsolute(source)) throw fail(); const envelope = await jsonFile(join(source, 'recovery.json'));
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'encrypted,nonce,salt,sha256,tag,version' || envelope.version !== 1 || !/^[a-f0-9]{64}$/.test(envelope.sha256) || typeof envelope.encrypted !== 'string' || envelope.encrypted.length > 8192) throw fail();
      if (await digest(join(source, 'mail.sqlite')) !== envelope.sha256) throw fail();
      let wrapping, key, payload, next;
      try {
        wrapping = await derive(passphrase, decode(envelope.salt,16));
        const decipher = createDecipheriv('aes-256-gcm', wrapping, decode(envelope.nonce,12)); decipher.setAAD(Buffer.from(`legalwork-mail-recovery-v1:${envelope.sha256}`)); decipher.setAuthTag(decode(envelope.tag,16));
        const encrypted = Buffer.from(envelope.encrypted, 'base64'); if (!encrypted.length || encrypted.toString('base64') !== envelope.encrypted) throw fail();
        payload = Buffer.concat([decipher.update(encrypted),decipher.final()]); const value = JSON.parse(payload.toString('utf8'));
        if (!value || Object.keys(value).sort().join(',') !== 'key,ownerId,schemaVersion' || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || value.ownerId !== ownerId) throw fail(); key = decode(value.key,32);
        const previous = await selected(); next = await candidate();
        const result = await worker({ sourcePath: join(source,'mail.sqlite'), destinationPath: next.databasePath, sourceKey:key,destinationKey:next.key,restore:true,expectedSha256:envelope.sha256 }, signal);
        await promote(next, previous, signal); return { ...result, generation:next.generation, credentials:'disconnected', submissions:'quarantined' };
      } finally { wrapping?.fill(0); key?.fill(0); payload?.fill(0); next?.key.fill(0); }
    }); },
  };
}
