# ADR 001: TypeScript mail service, with encryption as an unresolved release gate

Date: 2026-09-09. Scope: EIG-122 initial architecture evidence at baseline `c4b338e85`.
Status: recommended for the production foundation; **not** completed live-provider or encryption validation.

## Decision

Build one mail engine in the existing TypeScript server. Use direct Graph HTTP first, Gmail API next, and ImapFlow/Nodemailer/MailParser for IMAP, SMTP and MIME. Keep transport, durable replica state and local read/search interfaces separate. Do not introduce a Rust replica daemon in parallel. The isolated `apps/server/src/mail/spike/` code demonstrates storage invariants, not a production provider adapter.

The reason is concrete: the existing runtime, API and account integration are TypeScript, while the reviewed Rust alternative still requires provider, search and packaging integration. TypeScript does not remove synchronization engineering; we explicitly own it.

## Local runtime evidence

`apps/server/package.json` runs development/tests with Bun and declares better-sqlite3 and Drizzle. Actual stores, including `eigenwelt-connection-store.ts`, use `bun:sqlite` under Bun and `node:sqlite` otherwise. `apps/desktop/scripts/prepare-sidecar.mjs` states that the server runs through direct library import inside Electron; it is no longer a compiled server sidecar. Desktop declares Electron `^35.0.0`. A Bun-only database solution therefore cannot establish desktop compatibility.

Use a supervised worker/process for sync, MIME parsing, extraction and indexing, with a single writer and bounded jobs. Synchronous SQLite work must not become long-running Electron main-process work. This worker boundary is recommended, not implemented by this spike. Validate the exact packaged Electron runtime on macOS and Windows, including SQLite/FTS and module loading. Local Node 24.11.0 tests are not packaged Electron tests. Node's [versioned SQLite API](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html) is synchronous; native-addon alternatives also require runtime/ABI-specific packaging.

## Alternative evaluated and stopping rule

Source review used these exact pins, not claims about old `core/email`:

| Source | Structural evidence | Consequence |
| --- | --- | --- |
| [io-pimdir `765554fad5eb9fed3762c9b590262eb54012fa73`](https://github.com/pimalaya/io-pimdir/blob/765554fad5eb9fed3762c9b590262eb54012fa73/README.md) | SQLite/content-addressed blobs, action queue, owner/reader/producer model; SEARCH reference implementation absent | Useful design reference, not a ready searchable mailbox engine |
| [Neverest `1d7db3382a6adebb5f97ee6205f956824cb097a1`](https://github.com/pimalaya/neverest/blob/1d7db3382a6adebb5f97ee6205f956824cb097a1/README.md) | Graph feature is non-default; Gmail/JMAP configurations have no backend; v1 not released | Does not satisfy a finished Graph/Gmail replica requirement |
| [Neverest pinned manifest](https://github.com/pimalaya/neverest/blob/1d7db3382a6adebb5f97ee6205f956824cb097a1/Cargo.toml) | MIT OR Apache-2.0, Rust 1.89; optional io-msgraph 0.3, io-pimdir 0.5 | Permissive license is compatible in principle; still another build/distribution surface |

Stopped after these structural failures. No Rust engine was compiled or run and no comparative performance result is claimed. API-client coverage alone does not prove durable replica coverage. Revisit only if a pinned release supplies the missing backends, searchable encrypted storage, Windows packaging and compelling recovery evidence. Pimalaya's SQLite/blob architecture alone gives no demonstrated complete-store encryption. A separate Tantivy index would add an encryption surface.

## Licensing

Reviewed upstream manifests declare [ImapFlow MIT](https://raw.githubusercontent.com/postalsys/imapflow/master/package.json), [Nodemailer MIT-0](https://raw.githubusercontent.com/nodemailer/nodemailer/master/package.json), and [MailParser MIT](https://raw.githubusercontent.com/nodemailer/mailparser/master/package.json). These are source snapshots reviewed on the date above, not package versions selected or installed by this change. Preserve required notices and audit resolved transitive licenses when adding dependencies. io-pimdir and Neverest offer MIT/Apache-2.0. SQLCipher Community uses a [BSD-style license with accessible attribution requirements](https://www.zetetic.net/sqlcipher/license/); commercial builds have separate terms. No package or lockfile changes are included.

## Encryption: current answer is no

The existing stock `node:sqlite` / `bun:sqlite` approach **does not protect the complete local mail store**. The executable fixture tests find no `PRAGMA cipher_version` result and locate synthetic plaintext in the database or WAL on both tested runtimes. Setting a key pragma is not evidence: SQLite [silently ignores unknown pragmas](https://sqlite.org/pragma.html). Encrypting MIME files alone would still expose metadata and FTS terms.

A SQLCipher-enabled database can protect metadata, FTS and inline BLOB pages plus WAL/journals, provided its documented [temporary-store requirements](https://www.zetetic.net/sqlcipher/design/) are followed. External attachments, exports, extraction files, logs and backups require their own protection. This is an architectural possibility, not implemented encryption. OS key custody, locked-state behavior, key recovery/rotation, crash cleanup and disk inspection still need tests.

Do not rely on swapping a shared library as a portable fix: Bun documents [`setCustomSQLite` as macOS-only and a no-op elsewhere](https://bun.com/docs/runtime/sqlite). Stock Node's database constructor is not a SQLCipher package. Production needs an explicitly packaged SQLCipher binding/build validated in both development and Electron, or a separate encrypted storage design. Keep the persistence interface replaceable, but select only one production implementation. Prefer SQLCipher with FTS in the same encrypted database plus authenticated encrypted large blobs; prove packaging before claiming encrypted mail storage. Fail closed if an encryption-required deployment lacks the validated backend. Device disk encryption is useful operational protection but is not application-store encryption.

## What the runnable spike proves

All HTTP responses are injected synthetic fixtures. It never obtains tokens, uses real mail, invokes default fetch or sends anything. The shape follows Microsoft's [per-folder delta pagination](https://learn.microsoft.com/en-us/graph/delta-query-messages), [message MIME `$value`](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) and [file attachment `$value`](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0) contracts. Actual Graph interoperability remains untested.

The tiny corpus has two provider IDs sharing identical Message-ID/MIME bytes, Unicode text and two binary file attachments per message across attachment-list pages. It verifies:

- Following opaque next links and persisting the terminal delta link; requesting immutable IDs.
- Byte/hash equality for provider-returned MIME and attachment bytes after close/reopen, without deriving identity from Message-ID or filesystem paths from filenames.
- Atomic page writes for content, FTS and checkpoint. HTTP failure or injected pre-commit failure exposes no partial page; reopening resumes from the last committed link.
- A separate child killed with SIGKILL before COMMIT leaves its checkpoint unapplied on fresh open. This checks process-crash recovery, not power-loss durability.
- Offline FTS queries and scope isolation, plus rejecting a foreign-origin continuation.

Small BLOBs are inline in SQLite so content and cursor share one transaction. This intentionally avoids pretending filesystem rename and SQLite commit form one atomic operation. A production large-attachment design needs bounded streaming, staged/fsynced encrypted blobs, atomic promotion before row/cursor commit, and orphan collection. The spike buffers each page and is unsuitable for real mailbox sizes. Its scope string is fixture storage separation, not authorization. Its initial URL is hardcoded to one inbox. It rejects removed items and unsupported attachment types rather than marking them complete. A delta round being complete is not account-wide archive completeness.

## Reproduction and remaining evidence

From repository root, with existing workspace dependencies available:

```sh
bun test apps/server/src/mail/spike/spike.test.ts
pnpm --dir apps/server exec tsc --outDir /tmp/legalwork-mail-spike-evaluation --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types bun-types,node src/mail/spike/store.ts src/mail/spike/spike.test.ts src/mail/spike/crash.ts
node --test /tmp/legalwork-mail-spike-evaluation/spike.test.js
```

Results: Bun 1.3.9, 5/5 passing; strict scoped TypeScript compile passing; Node 24.11.0, 5/5 passing on this macOS host. Node emits its experimental SQLite warning. No UI/screenshots are relevant to this headless fixture. No benchmark or whole-repository test claim.

Production foundation can now implement account/message/membership identities, provider interfaces, durable jobs and local read/search APIs using these invariants. Before pilot readiness, separately prove Graph consent in a tenant with IMAP disabled; folder discovery, shared mailboxes, moves/deletions, expired cursors, retry/backoff and revoked permissions; raw MIME plus inline/item/reference attachment completeness; bounded-memory large-history backfill; attachment extraction and search rebuilding; disk-full recovery; actual encrypted store packaging on macOS/Windows; and access control at the service boundary. Sending and its ambiguous-outcome journal need independent design and tests. The original research's large-mailbox/live-account acceptance matrix remains open.
