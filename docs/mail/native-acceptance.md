# Native mail acceptance

During ticket work, run only the affected feature suites. From the repository root after installing the pinned dependencies (including the native cipher addon), for example:

```sh
node apps/server/scripts/mail-acceptance.mjs --suite providers/graph-backfill
```

Reserve the full native acceptance run and full Electron app tests/builds for the final integration pass after all mail tickets are complete. The final platform qualification workflow is manual and covers macOS arm64, macOS x64 and Windows x64. The full native command for that final pass is:

```sh
node apps/server/scripts/mail-acceptance.mjs
```

Use Node 24 and keep Bun on PATH for the one test proving the adapter refuses the actual Bun runtime. Native SQLite always runs in Node. `--concurrency 1` through `--concurrency 8` select the maximum number of simultaneous suite processes; the default is 2.

The runner invokes the resolved TypeScript CLI with the current Node executable, once, without a shell or a platform-specific pnpm wrapper. An OS-temporary JSON project avoids Windows command-line length limits. It copies native test files, checked-in fixture data and the main-process recovery modules into the compiled layout, links installed dependencies (a junction on Windows), and discovers every `mail/**/*.node-test.mjs` suite. Compilation and test execution have finite timeouts; failure exits nonzero and the temporary tree is removed.

These are real encrypted SQLite tests: Gmail history/backfill, Graph pagination/immutable identities, streamed MIME and attachments, account isolation, credentials, journal leases, interrupted transactions, reopen, search, key rotation and backup recovery. Synthetic transports avoid live provider traffic. The Graph suite includes the actual service→Node worker→encrypted store lifecycle and offline content reads. The separate Bun HTTP route suites and Electron OS-vault/packaging qualification remain separate checks; this command does not claim to replace them.

Crash fixtures verify a synchronous marker at the intended boundary and the recovered durable state. POSIX reports SIGKILL; Windows reports the abrupt TerminateProcess exit status. The reparse-point rejection test uses a Windows directory junction, which needs no file-symlink privilege, and a POSIX file symlink. Unix mode bits are asserted only on Unix; Windows ACL and OS vault qualification must run their actual platform checks, not simulated permission bits. A passing macOS run is not Windows qualification.

For an isolated regression, `--suite storage/database` selects the exact native fixture by its path below `src/mail` (without `.node-test.mjs`). It still compiles production mail once, then runs only that fixture. The existing Bun database launcher uses this path so runtime `.js` imports, including the Windows ACL helper, always resolve to compiled modules. Windows crash children retain only `SystemRoot`/`WINDIR` for the trusted ACL executable; account tokens and mail keys are never passed through their environment.
