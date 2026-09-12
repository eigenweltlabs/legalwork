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

Preparation only: syntax and diff checks have passed; the final integration gate has not yet opened, and no broad platform/app execution is claimed in this document. Populate exact workflow/run/artifact links and local results after execution; record any failure and correction against its source SHA rather than replacing old evidence.

Unsigned directory builds do **not** establish signed installer/update/uninstall behavior, Gatekeeper/notarization, signature-dependent vault identity across application updates, or retention after an actual OS uninstall. Actual suspend/resume and login/background startup need controlled device/session testing; hosted/mock lifecycle results must be labeled separately. Reference 16 GiB performance remains distinct from arbitrary CI runner RAM. No installer, release or destructive OS-session operation may be substituted silently for these unavailable gates.
