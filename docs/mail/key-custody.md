# Local mail key custody

The desktop main process supplies `createMailKeyStore` with Electron `safeStorage` after application readiness and an application-controlled `userData/mail` directory. No renderer key API exists. The new store starts locked; explicit unlock invokes the OS wrapping backend. This is separate from existing Workspace OAuth credentials.

A fresh store gets a random 32-byte database key. Only its OS-wrapped ciphertext is persisted in `mail-key-v1.json`; Linux `basic_text`, unknown backends and unavailable encryption fail closed. On POSIX, the directory is private (0700), key file private (0600), and symlink/nonregular paths are refused. The preexisting app-data parent is required. File writes are fsynced before create-only hardlink publication. Every reader fsyncs the directory and parent before returning, including concurrent activation. A missing key alongside an existing database or sidecar never triggers key replacement.

The returned buffer belongs to the main-process caller, which clears it after encoding the worker's private-pipe initialization. The native adapter also clears its temporary copy. JavaScript strings used by Electron's synchronous API and JSON encoding cannot be reliably zeroed; process/native-memory erasure is not claimed. Keys never travel through renderer IPC, command arguments, environment variables, normal logs or support-bundle payloads.

Lock stops the storage worker and closes its decrypted database connection. Unlock obtains the same wrapped key again. Corrupt, missing or OS-inaccessible keys leave the database intact and produce fixed error codes. There is no automatic reset, rekey or data deletion. An OS-account/keychain reset can make this local key inaccessible; copying the wrapped file alone is not a portable backup. Use the authenticated recovery export below for portability; otherwise preserve the original OS keychain and encrypted database together.

The implementation uses APIs present in the pinned Electron 35 runtime. On macOS, safeStorage uses Keychain; Windows uses DPAPI, whose protections differ from macOS; Linux depends on the selected secret service. It does not promise isolation from all processes running as the same OS user. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Validation: eight filesystem/envelope tests plus two deterministic race regressions pass in Node. Tests use an injected fake OS vault, never a production fallback. Cross-review found and verified fixes for an unsynced-reader race and a concurrent activation false missing-key error. The additional rotation/recovery evidence and actual development-host vault check are recorded below. Signed-app Keychain prompts, Windows ACL/DPAPI and Linux secret services remain separate platform gates.

```sh
node --test apps/desktop/electron/mail-key-store.test.mjs apps/desktop/electron/mail-key-store.races.test.mjs
```

## Rotation and portable recovery (EIG-126)

The desktop service exposes host-token, loopback-only `POST /mail/v1/security/rotate`,
`/backup`, and `/restore`. Rotation has an empty body; backup/recovery accept only
`{"passphrase":"..."}` (16 characters minimum, 1024 UTF-8 bytes maximum). A native
folder chooser supplies filesystem paths; HTTP cannot supply them. These operations
stop the mail worker, reject unlock/new reads while maintenance is active, and leave
the service locked. Stop cancels outstanding maintenance. Explicit unlock is required
after success. Cancellation waits for the child close event; an unconfirmed child
termination keeps store access blocked even after the bounded reaping wait. No provider request or revocation occurs during these operations.

Rotation copies a consistent **ciphertext** database under an exclusive SQLite lock,
rekeys the copy using the native Buffer API, verifies SQLite integrity and all
published raw/body/attachment references, and checkpoints the copy. The new key is
wrapped by Electron safeStorage in a fresh private `store-<generation>` directory.
A fsynced `active-store-v1.json` rename publishes the new generation. Before the first candidate, an explicit null-generation selection is fsynced for
the legacy `mail.sqlite` location. A missing pointer is accepted only when no
generation artifacts exist; a lost or corrupt selection after rotation/recovery
fails closed. An aborted first rotation retains the explicit legacy selection. Previous stores and incomplete candidates
are retained; rotation is not deletion or secure erasure. Cancellation before the
pointer rename cannot publish the candidate. Failure after rename/directory fsync is
an uncertain acknowledgement: inspect the selected generation on next unlock.
The desktop's existing single-instance lock and service maintenance barrier are
required; this is not a multi-process shared-database rotation protocol.

Backup creates a new private directory with encrypted `mail.sqlite` and
`recovery.json`. The database key is wrapped using AES-256-GCM, a random 16-byte salt,
12-byte nonce, and scrypt (N=32768, r=8, p=1; 32-byte output). Authenticated associated
data includes the ciphertext database SHA-256. Use a unique strong passphrase and
keep it separately from the backup. There is no password reset or vendor recovery
key. The native package's generic backup API is deliberately not used: it does not
configure a destination cipher key before copying pages.

Recovery verifies the passphrase and ciphertext digest, copies rather than modifies
the backup, migrates and validates the copy, and wraps a fresh key in the current OS
vault before atomic promotion. It works in a clean profile with the same trusted
local owner identity. Original bytes, drafts, metadata and action records survive.
Credentials become disconnected and require explicit reconnect; pending submissions
and other pending actions become uncertain for manual reconciliation, never automatic
replay. Gmail and installed v9 Graph runs pause, Graph revisions advance, and obsolete running leases are cleared. Wrong passphrase,
corruption, unsupported schema or failed verification cannot replace the active
store. No automatic purge of the old store follows recovery.

### Qualification evidence and remaining release gates

Actual Node tests exercise native cipher rekey, SQLite/WAL plaintext-marker absence,
in-memory SQLite temporary storage, the actual schema-v8 MailSearchStore FTS index and dirty-queue retention, raw/attachment digest reads,
wrong keys, wrong backup digest, unchanged backup bytes, credential disconnection,
submission quarantine, generation promotion, cancellation and portable key unwrap.
The desktop integration additionally uses an actual Electron child to rotate and
reopen the selected generation; its deterministic vault seam is a lifecycle test,
not OS-vault qualification.

On this development host (macOS arm64, Electron 35.7.5), actual safeStorage reported
available and encrypted/decrypted a synthetic value successfully. No live mailbox or
provider tokens were used. POSIX store directories/files are checked for owner-only
0700/0600 permissions and symlink/hardlink rejection. An attempted noninteractive
second-UID qualification could not run (`sudo: a password is required`); mode checks
must not be represented as an executed cross-user test.

Still required for release: signed macOS arm64/x64 app identity/update and second-OS-
user tests; Windows x64 DPAPI plus inherited ACL/second-user checks; Linux x64 actual
supported secret-service backends and second-user checks. Windows POSIX mode bits
are not ACL evidence. This host cannot qualify those platforms, signing transitions,
OS crash dump policies or backup recovery on them. JS strings can remain in process
memory; this design does not promise protection against an administrator, malware
running as the same OS user, swap or an independently enabled OS memory dump.
Mail database/files are not support-bundle inputs and mail child stderr is discarded;
maintenance errors are fixed strings and keys travel only through private stdin.

Provider/runtime references: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
explains OS-specific protections and Linux `basic_text`; the pinned runtime uses its
supported synchronous methods. [SQLite Multiple Ciphers Node binding](https://github.com/m4heshd/better-sqlite3-multiple-ciphers)
provides Buffer-based key/rekey operations. This evidence does not close the external
platform matrix by itself.

## Required macOS and Windows qualification

Both macOS (arm64 and x64) and Windows x64 are required targets. The dedicated
`mail-platform-qualification.yml` workflow runs non-release checks on `macos-15`,
`macos-15-intel`, and `windows-2022`; it asserts the expected architecture. It runs
only the mail qualification probe, portable native acceptance, and isolated ASAR
checks. It has read-only repository permissions, publishes no application and
uploads no database, key, dump or backup artifact. A passing macOS development run
is not a substitute for the required Windows job.

On Windows, the storage opener now enforces and reads back a protected DACL granting
only the current user SID FullControl. Directories grant inheritable rights, so new
SQLite WAL/SHM/journal files are private when created. Keys and managed backup/
generation directories use the same gate before writing. A fixed Windows PowerShell
program invokes the .NET ACL APIs; Unicode paths are UTF-8 JSON on stdin, never
interpolated commands. Reparse points/nonregular files are rejected before ACL
mutation. Existing foreign-user ownership is refused; an elevated user's default
Administrators-owned entry may be narrowed to that user's SID. Windows ACL failure
has no POSIX-mode or plaintext fallback. Source portable backup ACLs are untouched.

`node scripts/mail/platform-qualification.mjs` runs the pinned actual Electron
safeStorage backend, encrypted SQLite/WAL, in-memory temporary storage, actual mail
FTS, key rotation and clean-profile recovery. It tests a path containing spaces,
Unicode, an apostrophe and `$`. macOS uses actual Keychain and Windows uses actual
DPAPI; the qualification probe supplies no fake vault. On ephemeral GitHub Actions
runners it additionally requires another OS user's read to fail, after that same
user successfully reads an accessible synthetic control file. Windows creates and
removes a temporary local account; that script refuses non-Actions invocation.
macOS uses `sudo -n -u nobody`. Missing privileges or an unavailable vault fail the
required job rather than silently skipping it. Signed installer/update identity
transitions remain a distinct check from this unsigned runtime qualification.

Local evidence: actual macOS arm64 Electron 35.7.5 vault/cipher/WAL/FTS/rotation/
recovery probe passes. Windows code is typechecked but has not yet executed on this
macOS host; the Windows runner result is required before declaring Windows ready.
Graph v9 encrypted recovery also preserves the original and direct attachment bytes,
names and search index, pauses/fences the run, disconnects credentials, and performs
no access acquisition or automatic sync.

Sources: [Node filesystem permission caveats](https://nodejs.org/api/fs.html) explain
why chmod is insufficient on Windows; [Microsoft DirectorySecurity](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity?view=netframework-4.8.1)
defines DACL protection and inheritance; [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
describes the default logon-user/computer DPAPI binding.
