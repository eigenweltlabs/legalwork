# Mail worker packaging readiness

Evidence date: 2026-09-09. This is a minimal ASAR fixture qualification, not a signed LegalWork release qualification.

## Resolution contract

Keep the current worker entrypoint inside the application archive:

```text
Resources/app.asar/server/dist/mail/runtime/worker.js
Resources/app.asar/node_modules/better-sqlite3-multiple-ciphers/...
Resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/...
```

The trusted parent starts its actual Electron executable with `ELECTRON_RUN_AS_NODE=1` and passes the absolute archived JavaScript entrypoint as the script argument. The working directory must be a real filesystem directory. Owner, key and database path remain private stdin initialization fields. The database lives in private application data, outside Resources and ASAR. No external worker bundle, ASAR extraction bootstrap, `NODE_PATH`, native path override or build-script change is needed for the tested layout.

`electron-build.mjs` already compiles the server and copies its dist and module package marker into desktop/server. `electron-builder.yml` includes server/**; desktop mirrors the pinned native dependency. The worker's `createRequire(import.meta.url)` resolves the archive's node_modules. The native loader resolves lib/binding.js and prebuilds relative to its own package. Unpack the **complete** better-sqlite3-multiple-ciphers package, preserving these siblings, and ship app.asar.unpacked alongside app.asar. Both flattened and pnpm-style paths have explicit unpack patterns.

The installed electron-builder/app-builder-lib 25.1.8 `computeNodeModuleFileSets` implementation maps each resolved dependency directory to destination/node_modules/dependency-name, including pnpm source directories. This is the flattened layout exercised by the fixture; the test does not invoke the entire builder. A separate exploratory ASAR preserving a raw pnpm directory symlink failed in Electron 35.7.5 with ENOENT during package resolution. Do not replace the builder's dependency collection with a raw pnpm node_modules archive. Checking unpack globs alone does not establish symlink-layout compatibility.

Electron documents [ASAR virtual filesystem and native unpacking](https://www.electronjs.org/docs/latest/tutorial/asar-archives). The executable's [RunAsNode fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode) must remain enabled; disabling it requires redesigning supervision (for example, a utility process), not a plaintext or Bun fallback. The current fixture exercises the installed binary's enabled fuse. It does not alter signing, fuses or entitlements.

## Executed evidence

Host: macOS 15.6.1 arm64; test launcher Node 24.11.0; Electron 35.7.5 with embedded Node 22.16.0; @electron/asar 3.4.1 from the installed builder dependency graph; better-sqlite3-multiple-ciphers **13.0.3**. No packages installed or downloaded by the test.

`apps/desktop/electron/mail-packaging.test.mjs` passed 2/2 tests, without skips:

- Compiles the actual production worker and imported storage modules with strict TypeScript settings into a temporary directory. Packs an ESM server layout with local copies of zod and the pinned native package; native loader siblings and binary are marked unpacked. Deletes fixture source before launching, so the source checkout cannot satisfy module resolution.
- Starts the built worker directly inside app.asar under the actual Electron executable, migrates encrypted storage, receives ready and encrypted storage status, shuts down and repeats successfully. No UI or browser process is launched.
- An isolated inspection entrypoint uses the production encrypted opener, confirms SQLite3 Multiple Ciphers 2.4.0, explicit sqlcipher and temp_store=MEMORY, stores a synthetic FTS row, then queries it in a fresh process. Resolved module/native paths point inside the fixture archive. The physical database lacks both a plaintext SQLite header and the synthetic marker.
- Removes the unpacked selected native binary. The production worker fails with only initialization_failed, never ready; existing encrypted database bytes remain unchanged. No workspace native fallback occurs.

The selected binary is prebuilds/darwin-arm64.node. `otool -L` lists only system libc++.1.dylib and libSystem.B.dylib: no separate package dylib is required on this tested target. node-addon-api is a build/header dependency, not a runtime require in this pinned prebuilt loader. Keeping all native package files together also retains any package-local loader assets. Windows/Linux sibling-library behavior has not been executed here.

## Reproduce and integrate

From an installed workspace root:

```sh
pnpm --dir apps/desktop exec node --test electron/mail-packaging.test.mjs
```

The test uses the installed Electron package by default. To select an explicit compatible Electron executable:

```sh
LEGALWORK_MAIL_TEST_ELECTRON=/absolute/path/to/Electron pnpm --dir apps/desktop exec node --test electron/mail-packaging.test.mjs
```

Add `electron/mail-packaging.test.mjs` to the desktop's existing node --test command. Package-script editing remains with the integration lead. The test needs the normal desktop/server development dependencies and actual Electron binary; it fails rather than reporting a skipped native qualification when these are missing.

## Remaining release qualification

Run the worker lifecycle and encrypted storage smoke against the **built application artifact**, verifying dependency collection, archive contents, selected native file, relative entrypoint, RunAsNode fuse, signing/notarization and installed-profile access. This fixture does not certify hardened-runtime library validation, ASAR integrity settings, updater behavior, full application launch or OS safeStorage. Run separately on macOS x64, Windows x64 and Linux x64; declared prebuilts or matching globs are not execution evidence. The fixture's Linux path currently assumes glibc. The existing encrypted database/worker tests cover wrong-key and WAL behavior more deeply; this packaging fixture does not replace those tests or provider certification.
