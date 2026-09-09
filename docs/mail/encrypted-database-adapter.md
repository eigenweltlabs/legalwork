# Encrypted mail database adapter

EIG-126 implementation, 2026-09-09. `apps/server/src/mail/storage/database.ts` implements the existing synchronous `MailDatabase` interface; initialization is asynchronous:

```ts
const database = await openEncryptedMailDatabase({ path: absoluteDatabasePath, key: keyBytes });
```

The caller supplies a 32-byte `Uint8Array` obtained from the separately managed key store. The adapter copies it before its first await, uses the native binary `key(Buffer)` method, and clears the temporary copy in `finally`. The caller still owns and must clear its original buffer. No key is placed in SQL, argv, environment variables or logs. Native memory wiping/OS key custody are not implemented here.

The only engine is pinned `better-sqlite3-multiple-ciphers@13.0.3`. Startup rejects Bun before loading native code and requires Node-API 10+. A private in-memory capability probe rejects an unknown/plaintext module before touching the target path. Every file connection checks Multiple Ciphers 2.4.0 / SQLite 3.53.4, explicitly selects the SQLCipher algorithm with native format (`legacy=0`), verifies memory-only temporary storage, and authenticates the database before changing journal mode. The adapter uses WAL and FULL synchronous writes. Updating the package or engine version requires updating and rerunning these checks, not relaxing validation to accept arbitrary SQLite.

The package's NodeNext exports map hides its shipped TypeScript declarations. A small typed `createRequire` boundary avoids package patches, ambient declarations and `any`/casts in this adapter. Engine/configuration checks remain runtime checks. Row values are checked; 64-bit integers outside JavaScript's safe integer range are rejected instead of silently rounded. Bindings support the interface's strings, numbers, null and `Uint8Array` bytes.

New directories are requested with mode 0700; a new target file is created exclusively with mode 0600 before SQLite opens it. Existing target/sidecar symlinks, nonregular files and hardlinks are refused. On POSIX, files must be privately owned with no group/other permissions, and their containing directory must be owned and not writable by other users. The adapter does not silently change ownership or relax modes. Existing plaintext and wrong-key files fail without rekeying, truncating or migrating them. A failed creation can leave an empty private file; it is not an unlocked database. The parent path must be application-controlled; this is not a general defense against a malicious process running as the same OS user. Windows ACL behavior remains a platform-validation requirement; POSIX mode checks are not represented as a Windows ACL implementation.

`transaction` uses the native immediate transaction/savepoint wrapper, rolling back on errors. Known async callbacks are rejected before invocation; returned thenables cause rollback. Internal callers must keep all database work synchronous inside the callback. Raw SQL is an internal trusted interface, never exposed to users or agents; transaction-control/cipher-changing statements are not a supported caller escape hatch.

## Tests

The Bun test is only a launcher for actual Node subprocess tests. Keys in the fresh-process reopen test travel through stdin, not command arguments or environment variables. With the installed workspace dependencies:

```sh
bun test apps/server/src/mail/storage/database.test.ts
node --experimental-strip-types --test apps/server/src/mail/storage/database.node-test.mjs
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types bun-types,node apps/server/src/mail/storage/database.ts apps/server/src/mail/storage/database-interface.ts apps/server/src/mail/storage/database.test.ts
ELECTRON_RUN_AS_NODE=1 /absolute/Electron.app/Contents/MacOS/Electron --experimental-strip-types --test apps/server/src/mail/storage/database.node-test.mjs
```

Validation on macOS arm64: Node 24.11.0 contract suite 9/9; Bun 1.3.9 launcher passing; strict scoped TypeScript passing; Electron 35.7.5 / Node 22.16.0 contract suite 9/9. Coverage includes invalid key/path, FTS and binary reopen, DB/WAL marker scans, private DB/WAL/SHM files, byte-identical wrong-key and plaintext rejection, transaction rollback/nested savepoints/thenables, unsafe integer reads, symlink/private-mode refusal, simulated and actual Bun refusal, and unknown/plaintext backend rejection before file creation.

This does not implement schemas, migration policy, worker IPC, OS key storage, recovery/rotation, encrypted external blobs or signed application packaging. Windows/Linux execution, encrypted crash/disk-full recovery and whole-store artifact coverage remain open. The adapter does not make external extraction files, exports or backups encrypted by itself.
