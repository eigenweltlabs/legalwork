# Encrypted SQLite runtime evaluation

2026-09-09 · EIG-126 · synthetic data only · no production dependencies changed.

## Recommendation

Integrate **`better-sqlite3-multiple-ciphers@13.0.3` in an explicit Node/Electron mail worker process**, with `cipher='sqlcipher'`, `legacy=0`, and memory-only temporary storage set on every connection before mail operations. Use the same engine in development and desktop: Bun can supervise a Node child, but **must not load this native module directly**. The tested Bun 1.3.9 native path crashes. Missing runtime/module, missing encryption capability or rejected key must stop mail initialization; never select stock SQLite as a fallback.

This is **SQLite3 Multiple Ciphers**, using its SQLCipher algorithm and native file format, not Zetetic SQLCipher. Do not market it as Zetetic SQLCipher or claim direct SQLCipher-file interchange. Its [cipher documentation](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/) distinguishes native format from legacy SQLCipher compatibility and discourages legacy mode for new databases. The evaluation explicitly selects the algorithm rather than accepting the package's default sqleet cipher. Export/restore must preserve the chosen format/version.

If genuine Zetetic SQLCipher is a hard requirement, this recommendation needs reconsideration: `@journeyapps/sqlcipher@6.0.0` passed locally but has an explicit Windows support gap. Do not install both as platform-dependent production engines.

## Minimal candidate comparison

| Candidate | Actual package evidence | Decision |
| --- | --- | --- |
| `better-sqlite3-multiple-ciphers@13.0.3` | MIT binding; SQLite3 Multiple Ciphers 2.4.0 / SQLite 3.53.4. Node-API v10. Installed tarball contains macOS, Windows, Linux and Linux-musl x64/arm64 native files. Host selected `prebuilds/darwin-arm64.node`. | Recommended, behind Node/Electron worker; direct Bun rejected. |
| `@journeyapps/sqlcipher@6.0.0` | BSD binding; compiled genuine SQLCipher **4.14.0 community**, SQLite 3.51.3, `TEMP_STORE=2`; Node-API v6. Source build succeeded on host with bundled CommonCrypto integration. | Genuine-SQLCipher reference; not the cross-platform default because upstream excludes Windows. |
| `@signalapp/sqlcipher@4.1.0` | Current Signal Node-API wrapper is AGPL-3.0-only, including Signal-specific FTS integration. Source/license review only, not installed. | Introduces a separate product licensing decision; not selected for the existing permissive foundation. Do not confuse it with old `@signalapp/better-sqlite3`. |
| Existing `node:sqlite` / `bun:sqlite` | Prior spike proves plaintext database/WAL; not encryption bindings. | Rejected for the encrypted mail store. |

Primary sources: [Multiple Ciphers 13.0.3 release and platform matrix](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.0.3), [pinned native build configuration](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/blob/v13.0.3/binding.gyp), [JourneyApps 6.0.0 README](https://github.com/journeyapps/node-sqlcipher/blob/v6.0.0/README.md), [Signal wrapper/license](https://github.com/signalapp/node-sqlcipher). Multiple Ciphers' upstream SQLite/encryption components also require their license notices; review the shipped dependency notices before distribution. Genuine SQLCipher has its own [attribution requirements](https://www.zetetic.net/sqlcipher/license/).

The Multiple Ciphers release claims Node 22+ and Electron 35+, Windows/macOS/Linux x64+arm64, and glibc 2.35+ for Linux prebuilts. Native file presence and upstream claims are **not Windows/Linux execution evidence**. Its install invoked node-gyp but the build configuration intentionally performs no native compilation when a matching prebuild exists. JourneyApps actually compiled native SQLCipher here; its upstream support is macOS/Linux source builds, without published prebuilts or Windows support.

## Executed results

Host: macOS 15.6.1 arm64. Standalone Node 24.11.0; Bun 1.3.9; repository's available Electron 35.7.5, embedded Node 22.16.0. Electron ran with `ELECTRON_RUN_AS_NODE=1`, which exercises that executable's native module/runtime compatibility; this does not prove signed application/ASAR packaging or Electron utility-process integration.

| Invocation | JourneyApps 6.0.0 | Multiple Ciphers 13.0.3 |
| --- | --- | --- |
| Node 24.11.0 | PASS | PASS |
| Electron 35.7.5 Node mode | PASS, same host-built addon | PASS, same bundled arm64 prebuild |
| Direct Bun 1.3.9 | PASS | **Native fatal crash**: `NAPI FATAL ERROR: Error::New napi_get_last_error_info` |
| Bun supervising explicit Node child | Not needed | PASS |

The committed `apps/server/src/mail/spike/encrypted-evaluation.mjs` creates a temporary synthetic database and proves:

- Real `PRAGMA cipher_version = '4.14.0 community'` for JourneyApps. Multiple Ciphers does not expose that pragma; its identity is checked through `sqlite3mc_version()` and explicit cipher selection, never a fabricated SQLCipher version.
- FTS5 search and binary attachment bytes work after a fresh-process restart; `integrity_check` returns `ok`.
- Missing and incorrect keys cannot read `sqlite_master`; the correct key can read/search content.
- Nonempty database and live WAL lack the plaintext SQLite header and synthetic body/attachment markers. This is an observable regression check, not an independent cryptographic audit.
- Temporary store is explicitly `MEMORY` (`2`). JourneyApps reports compile default `TEMP_STORE=2`; the Multiple Ciphers prebuild reports `TEMP_STORE=1`, so per-connection setup is mandatory and cannot be assumed from its build.

No real mail, tokens, credential stores or network transports are accessed. No cryptographic algorithm is invented. The fixture password is public synthetic data. The previous checkpoint spike tests transaction interruption; this follow-up tests normal fresh-process encrypted reopening, not encrypted power-loss recovery.

## Reproduce without modifying repository dependencies

Set `spike` to this repository's absolute fixture path. Install only in a new temporary directory; pnpm 11.16.0 performed the evaluated install. The allow-list enables these known native install steps locally.

```sh
spike=/absolute/checkout/apps/server/src/mail/spike/encrypted-evaluation.mjs
cipher_eval=$(mktemp -d /tmp/legalwork-cipher-eval.XXXXXX)
cd "$cipher_eval"
printf '{"name":"legalwork-cipher-eval","private":true,"type":"module"}\n' > package.json
printf 'allowBuilds:\n  "@journeyapps/sqlcipher": true\n  better-sqlite3-multiple-ciphers: true\n' > pnpm-workspace.yaml
pnpm add --save-exact @journeyapps/sqlcipher@6.0.0 better-sqlite3-multiple-ciphers@13.0.3
node "$spike" "$cipher_eval" journey
node "$spike" "$cipher_eval" multiple
bun "$spike" "$cipher_eval" journey
ELECTRON_RUN_AS_NODE=1 /absolute/Electron.app/Contents/MacOS/Electron "$spike" "$cipher_eval" journey
ELECTRON_RUN_AS_NODE=1 /absolute/Electron.app/Contents/MacOS/Electron "$spike" "$cipher_eval" multiple
bun -e 'const r=Bun.spawnSync(["node",...process.argv.slice(1)]);console.log(r.stdout.toString());process.exit(r.exitCode)' "$spike" "$cipher_eval" multiple
```

The deliberately unsupported reproduction is `bun "$spike" "$cipher_eval" multiple`; it crashes this Bun version. All native tests must run in disposable subprocesses. Actual isolated install was `/tmp/legalwork-cipher-eval.Ux43JO`; installed packages remain there for reviewer reproduction. The fixture removes only its own generated test databases.

Registry package integrity pins observed at installation:

```text
better-sqlite3-multiple-ciphers@13.0.3
sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==
@journeyapps/sqlcipher@6.0.0
sha512-YmWSQIR4cnv+5L38lYJoS/dIF/+bEZBaACATbeTyq4XKjMHcxdIlFnElBLiIqa9rwseOIimIYjudgOOCovud3Q==
```

## Integration boundary and open gates

The next dependency change should add only the selected package, retain its native prebuild outside ASAR, select the target architecture when packaging, and launch one supervised Node/Electron mail worker. In Bun development use an explicit compatible Node executable, never `process.execPath` (which would relaunch Bun). Test fail-closed runtime/cipher/key capability at startup. A worker keeps sync/FTS work out of Electron's main event loop; the subprocess probe demonstrates runtime feasibility, not a completed worker protocol.

Encryption covers FTS, metadata and BLOBs kept in this database plus journal pages. To protect the **complete** store, raw MIME and attachments must remain encrypted too; external blobs, extraction/OCR temporary outputs, exports, logs and backups are outside this fixture. Implement key custody and recovery before real mail; enforce memory-only temp storage on every connection. Still open: signed/ASAR packages on macOS and Windows, Windows native execution, worker lifecycle/IPC, key loss/rotation, crash/disk-full behavior, large-body storage, and disk inspection of extraction/backup paths. This evaluation resolves the proposed binding/runtime path; it does not declare the product encrypted or pilot-ready.
