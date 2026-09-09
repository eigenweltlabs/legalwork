# Local mail key custody

The desktop main process supplies `createMailKeyStore` with Electron `safeStorage` after application readiness and an application-controlled `userData/mail` directory. No renderer key API exists. The new store starts locked; explicit unlock invokes the OS wrapping backend. This is separate from existing Workspace OAuth credentials.

A fresh store gets a random 32-byte database key. Only its OS-wrapped ciphertext is persisted in `mail-key-v1.json`; Linux `basic_text`, unknown backends and unavailable encryption fail closed. On POSIX, the directory is private (0700), key file private (0600), and symlink/nonregular paths are refused. The preexisting app-data parent is required. File writes are fsynced before create-only hardlink publication. Every reader fsyncs the directory and parent before returning, including concurrent activation. A missing key alongside an existing database or sidecar never triggers key replacement.

The returned buffer belongs to the main-process caller, which clears it after encoding the worker's private-pipe initialization. The native adapter also clears its temporary copy. JavaScript strings used by Electron's synchronous API and JSON encoding cannot be reliably zeroed; process/native-memory erasure is not claimed. Keys never travel through renderer IPC, command arguments, environment variables, normal logs or support-bundle payloads.

Lock stops the storage worker and closes its decrypted database connection. Unlock obtains the same wrapped key again. Corrupt, missing or OS-inaccessible keys leave the database intact and produce fixed error codes. There is no automatic reset, rekey or data deletion. An OS-account/keychain reset can make this local key inaccessible; copying the wrapped file alone is not a portable backup. A separate authenticated recovery export, key rotation and restore workflow remains required before release (EIG-126/EIG-151). Until implemented, preserve the original OS keychain and encrypted database together.

The implementation uses APIs present in the pinned Electron 35 runtime. On macOS, safeStorage uses Keychain; Windows uses DPAPI, whose protections differ from macOS; Linux depends on the selected secret service. It does not promise isolation from all processes running as the same OS user. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Validation: eight filesystem/envelope tests plus two deterministic race regressions pass in Node. Tests use an injected fake OS vault, never a production fallback. Cross-review found and verified fixes for an unsynced-reader race and a concurrent activation false missing-key error. Actual signed-app Keychain prompts, Windows ACL/DPAPI, Linux secret services and portable recovery remain separate platform gates. No live OS-vault test has yet been claimed.

```sh
node --test apps/desktop/electron/mail-key-store.test.mjs apps/desktop/electron/mail-key-store.races.test.mjs
```
