# Final desktop qualification (EIG-152)

## Gate and non-release execution

Do not start this workflow or the broad local checks until the integration owner confirms the final feature/design changes are integrated. The matrix is macOS arm64, macOS x64 and Windows x64; Linux is not included in this qualification pass.

The workflow was initially PR-only and unregistered. `workflow_dispatch` alone is therefore insufficient to bootstrap it. The reviewed branch-only entry point is an exact `push` filter for `qualify/mail-eig-152-final`, plus a job guard requiring `[mail-platform-qualification]` in the pushed head commit message. Ordinary pushes to the integration branch, default branch or other branches cannot trigger it. On the dedicated branch, a push without that marker does not run qualification jobs. This follows GitHub's [push branch filters](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore); the initial [manual-dispatch prerequisite](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) explains why the additional trigger is needed.

After the integration owner opens the gate, the owner creates a reviewed empty trigger commit on the dedicated branch from the exact integrated source, containing that marker, and pushes only that branch. No merge to the default/development branch, release tag, release workflow modification, signing credential, publication or deployment is required. Subsequent fixes require another deliberate marked commit. Every platform builds with `--publish never` and signing/notarization discovery disabled. Do not use a release workflow as a substitute.

## Evidence collected

Each stage runs through `scripts/mail/qualification-step.mjs`, which tees bounded output and records the Git source SHA, tracked dirty state, exact command, host architecture/OS, Node version, RAM, CPU, timestamps and outcome. The workflow uploads only `mail-qualification-evidence/`, including when a stage fails, with a 14-day retention. Profiles, synthetic vault envelopes, keys, database files, build outputs and credentials are not artifact inputs. A killed/timed-out stage may leave only its partial log; absence of its successful JSON result is not a pass. Retain downloaded evidence with the final reviewed report before artifact expiry.

The stages cover:

- Actual Electron safeStorage on the host OS, encrypted SQLite/WAL/FTS, automatic durable key reopen, rotation and passphrase backup/recovery. The isolated profile uses nested Unicode/space/punctuation paths; an 8 MiB attachment is streamed, restored and saved to a path longer than 260 characters. Path success is a measured requirement, not inferred from another OS.
- Cross-user denial on hosted runners: Windows creates/removes a temporary user; macOS reads as `nobody`, first proving a public control file is readable. Local macOS does not change users or claim this check.
- All native mail acceptance suites, including real interrupted historical upgrades, retained original/attachment/draft/action records, schema29 replay repair, restore quarantine and uncertain sending. These are deterministic synthetic prior-version fixtures, not copies of a user's historical mailbox.
- The normal `pnpm --filter @legalwork/app test` and `pnpm --filter @legalwork/desktop test` commands, including shared Lexical/composer/shell/session regressions, plus desktop `mail-*.test.mjs` files omitted by the normal desktop script. The supplemental runner excludes already-listed suites to avoid duplicate execution. These cover power lifecycle, session/workspace storage, updater and packaged dependency checks. Mock power events prove handler behavior; they do not establish actual machine sleep/login behavior.
- Actual loopback HTTP API checks and a full unsigned application-directory build on each matrix runner. The built executable/ASAR probe exercises native dependencies, MIME, encrypted search, worker reopen/rotation and host-authorized HTTP routes.

The runner keeps the real OS HOME and vault environment for the vault probe, changes Electron userData only to its temporary profile, and removes that profile afterward. The packaged HTTP probe has a separately isolated synthetic application profile. It must not be run against the normal development app or any existing user's profile.

## Qualification status and limits

The first gate opened at `aa2dd5d8b`. The first full matrix ran at tree-identical marker `4a2077a80a7f6844d860d0552581688d14911518`: [run 34702156017](https://github.com/eigenweltlabs/legalwork/actions/runs/34702156017). All three jobs failed; this is **not a platform pass**. Product changes subsequently reopened, so broad requalification is paused until the next explicit integration gate.

Initial evidence, retained without overwriting failed runs:

| Scope | As-run outcome |
| --- | --- |
| Local normal app, missing Electron prerequisite | 433 pass, 28 fail |
| Local normal app after installing the locked Electron binary | 455 pass, 6 fail |
| Local normal desktop | 115 pass, 1 fail, 1 platform skip |
| Local supplemental desktop mail | 36 pass |
| macOS arm64 native mail | 444 pass, 1 fail |
| macOS x64 native mail | 443 pass, 2 fail |
| Both macOS vault and supplemental stages | Vault passed, supplemental 36 pass each |
| Both macOS directory builds | Vite exhausted its approximately 2 GiB heap; built-app probes consequently unavailable |
| Windows x64 | Directory build passed; vault/native/module, desktop fixture, app and packaged ACL checks failed |

Local fixture repairs were verified with focused tests: current HTML sandbox/CSP, retention copy and search selection; explicit Zod resolution; actual minimal ASAR dependency closure; fresh Electron native-window activation; checked-in historical HTML baseline (byte-identical to `a4118bcca`); current HTTP outbox prerequisites; actual platform ACL adapters and portable Node/TypeScript invocation. Intel's additional connection case observed the legitimate transient `syncing` state directly after reopen; it now awaits `waiting` and verifies the offline error, with a focused actual worker pass. Build heap adjustment remains unverified on CI. These focused passes do not replace the original full-command denominators or constitute a rerun of the complete integrated application.

Windows prerequisite diagnostics are isolated from the broad matrix and require a distinct `[mail-platform-diagnostics]` marker. [Run 34703086770](https://github.com/eigenweltlabs/legalwork/actions/runs/34703086770) reproduced missing package paths through temporary junctions and separately recorded production ACL-process noncompletion and inherited PowerShell module-autoload failure. The reviewed correction was then checked in [run 34703761883](https://github.com/eigenweltlabs/legalwork/actions/runs/34703761883), source marker `a2657462049d1469a72c4f183e6763af02a85a12`: repaired per-package imports passed and the actual exported production ACL helper secured a synthetic directory and file in 781 ms. The controlled PowerShell bootstrap preserves owner-only rights. This does not substitute for the pending full Electron/DPAPI/second-user stage. The diagnostic copied all native prebuilds successfully; its initial one-directory ASAR lookup passed both slash forms and did not reproduce the original deeper minimal-ASAR fixture failure. That actual fixture remains pending. A successful diagnostic job means its specified checks passed, not that all custody or packaging is certified. The Windows Office certificate assertion also fails on unchanged `origin/dev` source (`ed882fe84dbf8dc5f07abaa0ec0c0ee0f4d9e5b8`): its documented signature/expiry-only Node validator accepts the synthetic signed non-localhost leaf, while OpenSSL's constrained chain verifier rejects it. No Office production change or constraint-validation claim is made here.

Downloaded initial platform logs are retained at `/tmp/legalwork-eig152-ci-macos-arm64`, `/tmp/legalwork-eig152-ci-macos-intel` and `/tmp/legalwork-eig152-ci-windows`; local source-stamped stage logs/JSON remain in the qualification worktree's `mail-qualification-evidence`. Final durable evidence publication and qualification remain outstanding.

Unsigned directory builds do **not** establish signed installer/update/uninstall behavior, Gatekeeper/notarization, signature-dependent vault identity across application updates, or retention after an actual OS uninstall. Actual suspend/resume and login/background startup need controlled device/session testing; hosted/mock lifecycle results must be labeled separately. Reference 16 GiB performance remains distinct from arbitrary CI runner RAM. No installer, release or destructive OS-session operation may be substituted silently for these unavailable gates.

## Final run and end-of-day stop — 12 September 2026

The final integrated run [34705758095](https://github.com/eigenweltlabs/legalwork/actions/runs/34705758095) completed with failure at marker `9a6f3482007bad1ff24850d8311f2556d2f39353`, tree-identical to `ad06fba7b01966bdc00e432341fdcb21b48ea668`. This supersedes the earlier paused-gate status, not the retained failure evidence. Root independently read the stage records and key logs.

| Stage | macOS arm64 | macOS x64 | Windows x64 |
| --- | --- | --- | --- |
| Actual vault/cipher/recovery | PASS | PASS | FAIL: initial long-path database open, `SQLITE_CANTOPEN` |
| Native mail | PASS, 447 cases | PASS | FAIL: 300-second runner timeout; observed failures and incomplete tail |
| Loopback HTTP | PASS | PASS | PASS |
| Shared app | FAIL, 452 pass / 10 fail | FAIL | FAIL |
| Normal desktop | PASS | PASS | FAIL, 111 pass / 3 fail / 3 platform skips |
| Supplemental mail | PASS | PASS | PASS |
| Full unsigned application build | PASS | PASS | PASS |
| Built application probe | PASS | PASS | FAIL at rotation |

The repaired build heap and both actual macOS packaged probes now have passing evidence. Windows ordinary-path ACL prerequisites passed earlier; that result does not close its long-path, maintenance, startup or packaged gates. The Windows native timeout prevented complete final failure reporting. The unchanged Office certificate baseline failure remains separately identified above.

At the user's stop request, agent checkpoint `bba54ee72` contains only fixture/diagnostic changes: isolated Bun child builds for portability and HTML fixtures, an obsolete Settings warning assertion updated to current copy, and an **unexecuted** Windows fsync/long-path probe. Two bundles passed build-only checks; their Electron assertions and all Windows hypotheses remain unverified. No Windows product repair or further CI dispatch occurred. In particular, read-only-handle fsync is a hypothesis for maintenance failure, not an established cause.

All agents and remote watchers are stopped. Only the normal local dev app remains, using the existing profile/session. Stage records and failed-stage logs are retained in [final-run evidence](evidence/eig-152-final-2026-09-12/); complete original GitHub artifacts and local downloads `/tmp/eig-152-final-{macos-arm64,macos-intel,windows}` are also retained. EIG-152 and EIG-126 remain open. Resume only on a new user instruction, starting with failed checks narrowly rather than another full matrix.
