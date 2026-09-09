import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const MAX_KEY_FILE_BYTES = 16 * 1024;
const KEY_FILE = "mail-key-v1.json";
class MailKeyError extends Error {}
const failure = (code) => new MailKeyError(`mail_key_${code}`);
const hasCode = (error, code) => error !== null && typeof error === "object" && error.code === code;

/** Main-process only. Call after Electron app readiness; never expose to renderer IPC.
 * The caller controls the private app-data directory, never a request parameter.
 * @param {{directory:string, safeStorage: Pick<import("electron").SafeStorage,
 * "isEncryptionAvailable"|"encryptString"|"decryptString"|"getSelectedStorageBackend">,
 * platform?:NodeJS.Platform}} options
 */
export function createMailKeyStore({ directory, safeStorage, platform = process.platform }) {
  if (!isAbsolute(directory) || directory.includes("\0")) throw failure("path_invalid");
  const keyPath = join(directory, KEY_FILE);

  function requireBackend() {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw failure("backend_unavailable");
      if (platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(safeStorage.getSelectedStorageBackend())) {
        throw failure("backend_unavailable");
      }
    } catch { throw failure("backend_unavailable"); }
  }
  function requirePrivate(info, directoryEntry) {
    if (directoryEntry ? !info.isDirectory() : !info.isFile()) throw failure("path_unsafe");
    if (platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw failure("permissions_unsafe");
  }
  async function syncDirectory() {
    // Windows directory fsync/ACL qualification is a separate packaging gate.
    if (platform === "win32") return;
    for (const path of [directory, dirname(directory)]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  async function readExisting() {
    let handle;
    try { handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw failure("unreadable"); }
    try {
      const info = await handle.stat();
      requirePrivate(info, false);
      if (info.size === 0 || info.size > MAX_KEY_FILE_BYTES) throw failure("corrupt");
      const raw = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
      if (bytesRead !== info.size || bytesRead > MAX_KEY_FILE_BYTES) throw failure("corrupt");
      let envelope;
      try { envelope = JSON.parse(raw.subarray(0, bytesRead).toString("utf8")); } catch { throw failure("corrupt"); }
      if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || envelope.version !== 1 || typeof envelope.wrappedKey !== "string") throw failure("corrupt");
      const ciphertext = Buffer.from(envelope.wrappedKey, "base64");
      if (!ciphertext.length || ciphertext.toString("base64") !== envelope.wrappedKey) throw failure("corrupt");
      let text;
      try { text = safeStorage.decryptString(ciphertext); } catch { throw failure("locked"); }
      const key = Buffer.from(text, "base64");
      if (key.length !== 32 || key.toString("base64") !== text) { key.fill(0); throw failure("corrupt"); }
      return key;
    } finally { await handle.close(); }
  }
  async function readDurable() {
    const key = await readExisting();
    if (!key) return undefined;
    // A concurrent creator may have published the key but not yet fsynced its
    // directory. Every returning reader must make that publication durable.
    try { await syncDirectory(); return key; }
    catch (error) { key.fill(0); throw error; }
  }

  /** Returned key belongs to caller; clear it after private-pipe initialization.
     * A missing/corrupt/unwrappable key never causes automatic replacement.
     * allowCreate is only for explicit first-time activation of an empty store.
     * @param {{allowCreate?:boolean}} options
     */
  async function load({ allowCreate = false } = {}) {
      requireBackend();
      try { requirePrivate(await lstat(directory), true); }
      catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if (!allowCreate) throw failure("missing");
        // Parent app-data directory must already exist. Avoid an unbounded chain
        // of newly created ancestors whose directory entries are not yet durable.
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (creationError) { if (!hasCode(creationError, "EEXIST")) throw creationError; }
        requirePrivate(await lstat(directory), true);
      }
      const existing = await readDurable();
      if (existing) return existing;
      if (!allowCreate) throw failure("missing");
      // The production database uses this fixed name. Never create a replacement
      // key for existing data, even when a caller incorrectly requests creation.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { await lstat(join(directory, `mail.sqlite${suffix}`)); }
        catch (error) { if (hasCode(error, "ENOENT")) continue; throw failure("unreadable"); }
        // Another activation can publish a key and open its database between
        // our first key read and this guard. Use its winner; never replace it.
        const concurrent = await readDurable();
        if (concurrent) return concurrent;
        throw failure("missing_for_existing_store");
      }
      const key = randomBytes(32);
      const temporaryPath = join(directory, `.mail-key-${randomBytes(16).toString("hex")}.tmp`);
      let temporaryCreated = false;
      try {
        let ciphertext;
        try { ciphertext = safeStorage.encryptString(key.toString("base64")); } catch { throw failure("wrap_failed"); }
        if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw failure("wrap_failed");
        const content = JSON.stringify({ version: 1, wrappedKey: ciphertext.toString("base64") });
        if (Buffer.byteLength(content) > MAX_KEY_FILE_BYTES) throw failure("wrap_failed");
        const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryCreated = true;
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
        // Publish without replacing another concurrent creator's key. Readers may
        // see two hardlinks briefly; both contain only OS-wrapped ciphertext.
        try { await link(temporaryPath, keyPath); }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
        await unlink(temporaryPath);
        temporaryCreated = false;
        await syncDirectory();
        // Load the published winner, including verifying OS unwrap before use.
        const published = await readExisting();
        if (!published) throw failure("missing");
        return published;
      } finally {
        key.fill(0);
        if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
      }
  }
  return {
    async load(options = {}) {
      try { return await load(options); }
      catch (error) { if (error instanceof MailKeyError) throw error; throw failure("io_failed"); }
    },
  };
}
