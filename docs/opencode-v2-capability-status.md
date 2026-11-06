# Engine and capability acceptance status

Current debug follow-up, 28 October (LW-287): native project loading replaces
shared-only reconstruction, as agreed with the user. No project-automation
approval UI or endpoint remains. The shared capability library, native project
settings, firm restrictions, ordinary chat/folder permissions and sandbox policy
remain separate. PR #343 is integrated, and the OpenAI connection fix is published
in `5350c058`; a successful real OpenAI reply was observed in the dev profile.

The current local app suite passed 1,868 tests (one timezone skip), the full
server suite passed 3,003 tests (45 environment-dependent skips), and the
server build, app/server type checks and generated-help checks passed. Focused
real-engine checks cover native capability loading, firm plugin restrictions,
project isolation, recovery from actual configuration conflicts, remembered
permissions across restart and revocation, and MCP removal/OAuth recovery. The
first server sweep found eight obsolete approval expectations; after updating
those tests, the full rerun passed with zero failures and 29,654 assertions.
The final focused UI rerun passed all six checks. Fresh six-platform CI remains
required; older platform results do not certify these changes.

Windows CI at `5350c058` exposed marker publication flushing a read-only file
handle. A portable regression enforcing Windows' write-access requirement fails
before the fix and passes with flushing on the original writable handle. Native
Windows execution is still required to accept that correction. New early storage
checks run on all six hosts independently of the longer engine/package builds.
No release or binary publication is authorized.

The checkpoints below are historical and do not certify this latest source.

Rebase checkpoint, 28 October: the branch is rebased onto dev `15b52ba2`
and includes PR #329 at `c6616c77`. The final combined-source local checks pass:
2,883 server tests (45 environment-dependent skips), 1,862 app tests (one
host-timezone skip, separately covered by 13 passing Europe/Berlin calendar
checks), and 473 desktop tests (four skips). App/server builds, all three type
checks, translation/help checks, shared-module packaging and real Electron
request integration pass. The latter verifies 18-project batching, cancellation,
reconnect and calendar isolation from unrelated metadata events.

New dev PDF reading uses native v2 hooks. A narrowly tested post-authorization
fallback preserves the existing 64 MiB service boundary beyond v2's new 20 MiB
media gate; real 21 MiB denial, full-byte/hash delivery and extraction pass.
Technical support export now reads native v2 messages/events and awaits desktop
runtime diagnostics, preserving existing redaction and export limits. No new
content cap, dependency or engine patch was added for these adaptations.

Fresh combined-source six-platform CI remains required; the matrix below is
historical baseline evidence. The user also requested waiting for PR #343 to
include the updated migration branch and become mergeable with passing required
checks, then integrating it into this branch. PR #343 was not yet included at that checkpoint; it is now merged through `a5ebac83`.
No release or binary publication is authorized.

Direct debugging follow-up, 27 October: the user approved one shared managed
configuration with automatic project/ancestor discovery disabled. This replaces
the folder-approval flow in the candidate below without changing the pinned
engine. Local released-engine checks pass: two-project isolation, shared native
skills/agents/commands/plugins, custom provider variants and enablement, inactive
project/ancestor executables, registered-root admission, command delegation,
permission refusal, cancellation and lossless retirement of owned generated files
(initial focused run: 36 tests, 391 assertions). This follow-up still needs fresh cross-platform CI;
the six-platform results below describe the previously accepted source snapshot.

The bundled core now has one private central home. Its six skills, three helper
agents and five document commands are present in both the released-engine fixture
and the restarted real dev app. Managed projects no longer receive new core
copies; existing project and personal files remain untouched. Full helper assets
and generation settings are retained.

Managed MCP definitions have one location-scoped owner. Recovery reads that same
managed selection; unchanged status refreshes do not wait for a new connection.
The five real-engine recovery tests pass for disable/remove/disconnect barriers
and OAuth polling from either project. Startup/admission tests also pass. Their
cloud fixture now denies access to the actual case folder, rather than only an
unused per-project core stamp; its original 503 and retry requirements remain.
At that 27 October checkpoint, the local server suite passed: 2,814 tests,
27,078 assertions, zero failures
and 45 environment-dependent skips across 397 files. The server build/type check,
bundled-help verification and actual Mac dev app capability inventory pass. Fresh
cross-platform CI remains pending for this follow-up; the matrix below is baseline
evidence rather than a result for this new configuration change.

Baseline final acceptance: 27 October 2026. The engineering migration was complete on
`codex/opencode-v2-migration` for the user-frozen OpenCode 2.1.4/dev snapshot.
No app/engine release, tag or release assets have been published. Existing CI
test artifacts were retained under the user's branch/CI authorization.
The user explicitly separated inherited browser bugs from completion; no
regression from v1 remains required. See [the separate browser issues](opencode-v2-browser-known-issues.md).

| Configuration | Native source build and integration | Actual app, security, preview and startup |
|---|---|---|
| macOS Apple Silicon | PASS | PASS |
| macOS Intel | PASS | PASS; unchanged retry after dependency download failure |
| Linux x64 | PASS | PASS |
| Linux ARM64 | PASS | PASS |
| Windows x64 | PASS | PASS; unsigned installer and actual engine-to-VM tools also pass |
| Windows ARM64 | PASS | PASS; unsigned installer and actual engine-to-VM tools also pass |

All six protected-runtime suites and both full Linux/Mac unit jobs also pass.
The final Windows [run40517342408](https://github.com/eigenweltlabs/legalwork/actions/runs/40517342408)
is wholly successful; its last app job completed at 14:50:17 UTC. Original failed
runs remain preserved. This closes migration acceptance, not public release checks.

## Final target and normal-build acceptance

The user explicitly froze the migration target at OpenCode 2.1.4. The newly
released 2.2.0 was audited separately and is deferred; no 2.2.0 feature or test
result is claimed here. Public releases, tags and binary publication remain
forbidden; branch pushes and existing Actions acceptance artifacts are allowed.

Normal development/app builds now prepare the reviewed source engine, reuse
verified unchanged outputs, and bundle it. Developer preparation builds only the
host target. Production preparation compiles all twelve pinned targets from the
original frozen upstream graph, applies the approved patches, signs Mac outputs
before hashing, and hands the exact distribution to app builds. Generated runtime
selection is checked against the committed source policy and recipe. Cache and
installed-runtime directories use full manifest identities, preserving older
same-version outputs. Runtime startup never compiles source.

Latest source includes `dev` commit `15b52ba2`, fetched for the user's
28 October rebase request, plus PR #329's batching, safe read sharing,
metadata push and request cancellation changes. This supersedes the earlier
choice to stop at `14b76cc9`. The seven newer dev commits are now included;
recording, dashboard files and technical support export are no longer deferred.
The original tested snapshots and receipts remain distinct. Support export now
reads native v2 records, and the PDF plugin uses native v2 hooks. These
adaptations pass the local checks above; fresh platform CI remains separate.

The latest [integrated acceptance40498732383](https://github.com/eigenweltlabs/legalwork/actions/runs/40498732383)
at `5016c34d` reuses all twelve exact production-produced engine archives. Its
independent verifier runs on Linux, avoiding a Mac builder for a portable hash
check. Full archive/source/pin checks remain required. This run uses development
TEST preparation metadata, not another production producer. Since `ee67b1f7`, only
the packaged checker and CI verifier routing changed; actual app inputs are identical.

All six OS/CPU hosts now pass actual cold source compilation, seven native
integration tests and warm reuse on final source `5016c34d`. Each retains164
assertions and no failures. The Windows correction was first verified on
`ee67b1f7`. The corrected raw-HTTP fixture runs
its entire original body in a child process, then removes the profile only after
that process exits. Actual server stores retain process-lifetime SQLite handles;
a local open-file probe confirms that ownership. No production store APIs, retry,
assertion or time limit changed. The nested raw test has 112 assertions and the
outer suite 52, totaling the original 162 plus two parent-exit/removal assertions.

The final-source run passes all six protected runtimes and both full Linux/Mac
unit jobs. Actual app/package/startup passes are closed for both Macs and both
Linux architectures. The focused Windows successor closes both Windows app,
engine, package, security, protected-VM, native-module, preview and unsigned
installer checks against unchanged product inputs.

The focused [Windows diagnostic run40512370683](https://github.com/eigenweltlabs/legalwork/actions/runs/40512370683)
recovered the actual main-process error: Electron cannot resolve the Documents
known folder when `createRuntimeManager` starts, before engine boot. The synthetic
Windows profile did not create that standard directory. A two-line fixture
correction creates its own `home/Documents`; verification40517342408 passes the
original startup gate on both architectures. All 16 assertions, the 90-second
deadline and cleanup checks remain unchanged. No production code, registry or
profile-isolation boundary changes. Both Windows successors also pass actual
engine-to-protected-VM integration: each has 1 test, 33 assertions, zero skips
and full synthetic exchanges retained. ARM64's original native-window diagnostic
timed out; that limitation remains in the failed-run evidence.

A final source audit corrected comments that still described the old v1 output
ceiling as current. The compiled model-limit module is byte-identical before and
after. Production v2 callers preserve reported model limits; the final primary
requests retain the gateway's 65,536-token setting. The existing unknown-model
fallback remains 32,000, matching native 2.1.4; no lower v2 cap was introduced.

Intel Mac's initial final-source attempt failed while downloading dependencies,
before building the app. Its unchanged Intel-only retry passed the full app,
package, security, native-module, preview and original startup checks at 13:33:59 UTC. Earlier actual production app results on the
same `7e221edd…` engine remain useful evidence, but do not substitute for this
final-source run. All six required app configurations are now closed.

The merged app initially exposed a package-checker fixture issue: a data-URL import
could not resolve the new help module's relative import. Both exact modules are
present in the shipped ASAR. The checker now extracts both shipped modules into its
owned temporary directory and imports their file URL. The same unchanged merged
Mac app passes the original document, security and engine checks after that fix.

The Mac functional preflight exercised the actual app/engine and protected VM,
but also discovered three personal operating-system skills. No paid task was
sent with that catalog. The user selected an isolated Linux VM for the final
unchanged agent task. Its normal built package, exact production engine, 239-tool
catalog, canonical skills and root-private tracing have passed independent
pre-Send review. The final unchanged task completed two genuine delegated reviews and both output
files. Independent replay retains the strict 8/9: three controlling-citation fields
use `Section` instead of `section`; the remaining values and both exact quotations
match. All five inputs remain unchanged. Full 72 observer records/36 tool returns
and 40 complete provider exchanges are retained and verified. No outside-folder
Ask occurred, so this run does not prove the scripted Deny interaction. All
potential main-agent wires match Gemini 3.8 Flash/medium, but native request roles
remain unattributed; no controlled performance comparison is claimed. The memo
also contains source-unsupported legal/business statements, tracked under the
user-approved separate quality work. Strict grading is not changed or labelled 9/9.

A fresh read-only gateway audit confirms **€17.95788453 across 678 unique calls**.
All 40 final-run SSE response IDs match persisted charges totalling €0.83413422;
complete request and response bytes are rehashed. The guard stopped normally
with no active requests. Conservative ledger exposure remains separate from
confirmed charges; no historical hold or accounting record was removed. The
original €100 key budget and authorized €250 session ceiling remain unchanged.

The existing native response defaults, connector-import compatibility rules,
explicit read-only Office boundary and tracing qualifications remain documented;
no new agent/tool-output cap was added to pass acceptance. The final legal task
retains its strict 8/9 and unsupported memo claims; no perfect legal-quality parity
or controlled performance improvement is claimed. The user accepted treating
broader quality findings separately.

Public Windows release acceptance still needs updater delivery and the agreed
physical Windows 11 check. Windows signing is not currently available; the
installer tests are unsigned. Earlier actual installer upgrade/history retention
and licensed Word add-in checks retain their stated scope. The user deferred
inherited browser bugs, chose this tested dev snapshot over three newer commits,
and prohibited release publication. None is silently counted as completed work.

The private final acceptance receipt is
`closed-final-six-platform-migration-acceptance.receipt.json`, SHA256
`a8d93da5aa5c304b5f81d43d4c5836f75da2377a88f414ac2d81fcd9b3fa42dc`.
It verifies 32 evidence references, all six actual app jobs, all six native source
hosts, all six protected runtimes, both full unit jobs and exact engine identity.
An additive qualification links the independent final agent review, literal strict
result, billing reconciliation and complete private cloud trace backups.

## Earlier checkpoints

The paragraphs below retain prior checkpoints and their exact scopes. Their
pending items and dated balances do not override the current checkpoint above.

The final [production source run40486260728](https://github.com/eigenweltlabs/legalwork/actions/runs/40486260728)
has built all twelve engine targets, including the three production-signed Mac
variants, and passed all six protected runtime configurations. Its independently
verified distribution manifest is
`7e221edd90abed59a0659393a5eaa9a960000263240e6094cbb7a6f07825e558`.
The six actual app/package/startup jobs have started; their results remain required.

Both Windows native integration fixtures execute all 162 semantic assertions but
fail while removing their temporary directory after shutdown. Matching the
production parent-process lifetime alone did not resolve it. The diagnostic
[follow-up40492613469](https://github.com/eigenweltlabs/legalwork/actions/runs/40492613469)
retains process state and remaining path names after the original removal failure;
no cleanup retry, test waiver or timing increase is introduced. Other four native
source hosts have passed actual compilation, integration and warm reuse.

The Windows x64 app build also found that Git's automatic CRLF conversion makes
the browser generator's exact-byte check reject its tracked output before app
build. A real Git checkout reproduces the failure. Scoped LF attributes retain
all 31 reviewed browser files byte-for-byte and preserve rejection of genuinely
stale output. Actual Windows package re-execution is still required.

The corrected full Linux/Mac unit [follow-up40492117543](https://github.com/eigenweltlabs/legalwork/actions/runs/40492117543)
uses the exact production-produced engine bytes, under development test
preparation metadata. This is a unit acceptance run, not another production
producer or six-platform app result. The changes correct two test expectations
and use an ordinary newly compiled Mac signing fixture, without changing product
signing behavior. Engine build inputs remain unchanged from the final producer.

The user accepted tracking broader legal-quality findings separately while
requiring final migration checks. Existing NDA and delegation grades remain exact;
this does not establish universal quality parity. A final actual-model Electron
check will use the same final engine distribution on Mac. The user accepted that
its full traces belong to the Mac user, protected by normal app permissions and a
process-bound recorder, rather than the Linux benchmark's root-owned filesystem
boundary. The original Linux benchmark remains unchanged. An actual outside-folder
permission refusal and independent recorder/transport review precede inference.

The older candidate40475853243 passes full Linux x64/ARM64 and Mac ARM64 app
acceptance plus both full unit jobs. Both Windows app jobs stop at two fixture
comparisons of 8.3 versus long Windows paths; c54ec087 canonicalizes the physical
paths on both sides while retaining negative checks. Intel passes its corrected
network probe, then fails final app startup because no server-state file appears.
The original assertion remains required; failure diagnostics are being added to
preserve the cause from the ephemeral runner. Historical results remain under
their original identities, rather than counted as final adopted-build evidence.

The user approved retiring bare standalone downloads. Automatic URL/mirror
fallbacks and raw-sidecar release assets are removed; preserved routes are desktop, Node development,
manual URL/token connections and complete NPM platform bundles. Desktop's embedded
server and packaged sandbox do not depend on this downloader. No new standalone
archive delivery format or runtime dependency is introduced.

The following platform notes retain earlier functional evidence and its scope;
they do not supersede the final normal-build acceptance above.

## Historical functional platform scenarios

| Configuration tested | Verified | Still running or remaining |
|---|---|---|
| macOS ARM64 | Normal final7 Electron startup, patched v2 engine, retained project/document, native tool calls and original visible-browser scenario; full build/package/security. Subsequent final8 private-auth package acceptance also passes. | Normal-build/default adoption and final integrated acceptance. |
| Linux x64 | Normal final7 engine/Electron startup and live native registry; prior final6 PowerPoint4/4. Final7 actual Excel, NDA, delegation and large-MCP tasks completed; root independently verifies their files, complete wires and exact trace qualifications. | Excel strict3/4 matches v1's style XML CRLF→LF change. NDA55/56 versus v1 53/56 retains the frozen rubric/source conflict and additional legal-quality concerns. Delegation strict8/9 versus v1 9/9 differs in three citation capitalizations. Large MCP3/3 preserves the full2,024,587-byte result. Queue recovery, native-API context, useful scheduling and ordinary UI /compact are functionally accepted under the exact qualifications below; final integrated normal-build adoption remains. |
| Windows x64 Server VM | Final7 normal build/package/security/unsigned installer and installed upgrade pass. All2620 installed package files match; all15 chats/75 messages and empty queue remain exact in SQL and accessible through public APIs. Actual licensed Word read/tracked edit/comment/save/reopen passed on final6. Actual final7 engine MCP recovery component passes2 tests/26 original assertions. Actual final7 Claude in-app DOCX editing qualifies4/4 after root verifies the saved tracked30→45 edit, full wires and exact zero-argument tool traces. | Original Claude controller-path failure remains unchanged; read-only recovery adds separate evidence without a model rerun. In-app DOCX, external Microsoft Word and controller-hosted MCP component evidence retain their separate scopes. |

These are the actual tested configurations, not a claim that every CPU/OS
combination was executed. All twelve upstream engine target artifacts were
built and statically verified. Linux ARM64 has now passed actual packaged-app
execution. Intel Mac and Windows ARM64 app execution remain open. The user explicitly requires all six app/engine
configurations before migration completion. The first migration checkpoint was pushed at `d35228ebb9c44d2827e3d1b8c7bf7f925917d253`.
The [six-platform CI acceptance](https://github.com/eigenweltlabs/legalwork/actions/runs/40359354246)
started at16:27:48UTC. Its reviewed twelve-target engine producer passed; all six
sandbox jobs stopped because CI had not prepared the Node worker runtime.
Commit43f80e46 adds the existing checksum-pinned runtime preparation. It also
temporarily used Bun 1.3.14; that rollback is superseded below.
Thirteen CI controls pass. An explicit run ID plus independently verified manifest
allows reuse of the unchanged producer rather than recompiling twelve targets.
No successful six-platform app execution is claimed yet. The workflows build the reviewed
engine from its original frozen upstream dependency graph and transfer it through
Actions artifacts, without publishing it or granting access to private traces.
Windows11 hardware
performance and automatic update delivery retain the user's separate release checks.

The second run, [40365700557](https://github.com/eigenweltlabs/legalwork/actions/runs/40365700557),
verified the reused twelve-target producer. Sandbox tests passed Linux x64,
Linux ARM64 and Mac ARM64. The old Bun host panicked on both Windows targets;
Mac Intel retained filesystem-capacity, guest-execution and proxy-test failures.
The unit jobs found old-host UI initialization failures. Desktop package jobs
therefore did not run; the three additional app configurations remain unverified.

The current correction restores Bun 1.4.4. The TLS failure was traced to an
unconditional optional socket-QoS call in the existing Undici 7 dependency;
upstream Undici 8.12.3 fixes it through its supported implementation. Both existing
aliases, their exact lock entries and the generated worker are updated. The
unchanged proxy suite passes 2 tests/128 assertions, and Node/raw transport passes
33/191. No HTTP result cap, policy bypass or test timeout change was added.
The proxy suite took 27.6s against its existing 30s test budget, so CI timing remains
a caveat. TMP diagnostics now retain Node/Bun filesystem capacity before the
platform tests; the original Mac Intel failures alone do not prove a full disk.

Clean-checkout fixtures now create their scratch parent and actual fake-engine
database, use prepared Node/native image resources, and settle stream cancellation
before abort. Scheduler tests wait for actual HTTP dispatch rather than queue
admission. A real startup race is fixed: managed requests remain held until the
engine's database binding has finished. Its focused 10/35 and real-engine 1/33
tests pass. A worker-death diagnostic now preserves both the original transport
error and actual process exit status. These fixes are committed for the next run.

The third run, [40389826731](https://github.com/eigenweltlabs/legalwork/actions/runs/40389826731),
passed five sandbox configurations. Intel Mac failed only the proxy test's aggregate
30s budget; actual capacity was approximately100.8GiB free. The transport modes now
have independent tests, each retaining its original30s allowance and all128 original
checks (4pass/134 assertions including fresh-fixture setup). This is test isolation,
not a production timeout or output change. Linux desktop tests exposed a fixture
that assumed the official engine's old resource layout; Mac server tests had not
built native plugin directories. Both CI prerequisites/fixtures are corrected.
The desktop package jobs remained skipped.

Run[40395337521](https://github.com/eigenweltlabs/legalwork/actions/runs/40395337521)
has closed. Intel Mac now passes its real isolation suite (248 tests/1189 assertions);
Windows exposed a test-preload file-URL error, corrected at28ce3c2e. Its package jobs
were skipped. Current normal run[40399014261](https://github.com/eigenweltlabs/legalwork/actions/runs/40399014261)
at7ad46c80 now has all six sandbox configurations passing. Actual normal app packages,
renderers and .3 engine startup pass on Linux x64, Linux ARM64 and Mac ARM64;
each platform also passes seven native engine/tool tests with162 assertions.
Intel Mac passes its normal build, seven engine/tool checks, packaging and package
security, then its protected-network probe receives HTTP503 from example.com.
The broker forwards that actual remote status; this is not an established VM or
permission failure. Probe-only correction1c4be3b5 uses an existing immutable
repository LICENSE and verifies the full response digest in Python and Node.
It passes the actual Mac ARM packaged-Node/VM probe and rejects wrong expected
digests; current-source Intel app startup still requires a passing CI run.
Both Windows package jobs failed before app build because Git's GNU tar treats
an absolute drive letter as a remote hostname. Commit732ddbf2 selects the existing
Windows system tar for official and derivative extraction, preserving all integrity
checks. Native[40406372783](https://github.com/eigenweltlabs/legalwork/actions/runs/40406372783)
installs and executes the engine, then fails a CI assertion that omitted the CLI's
`opencode v` prefix. The corrected[40473801099](https://github.com/eigenweltlabs/legalwork/actions/runs/40473801099)
passes on both Windows x64 and ARM64: complete derivative integrity/provenance,
actual .3 execution, missing-system-tool rejection and official pinned archive
extraction. Full Windows app packaging/startup remains separate and pending.
No successful Windows ARM64 or Intel Mac package execution is claimed yet.

Both full Linux/Mac unit jobs passed their preceding suites, real engine checks and
Electron typecheck, then found the same final E2E helper still looking in the old
sidecar directory. Commit4014f65a resolves the reviewed engine path and preserves
the original health allowances and assertions. The unchanged full app E2E chain
passes locally on the signed .3 engine; seven focused controls pass on both Node22
and Bun1.4.4. Independent run[40402814154](https://github.com/eigenweltlabs/legalwork/actions/runs/40402814154)
has closed: Mac passes the full job, including2791 server tests/26637 assertions;
Linux fails the real scheduling fixture's project-agent boundary assertion.
That check passes on the actual signed Mac engine and isolated Linux x64 component,
so no deterministic production permissions regression is established. Diagnostic
4e3ac8aa retains the exact returned policy on future failure. Combined-source
[40406377008](https://github.com/eigenweltlabs/legalwork/actions/runs/40406377008)
passes both complete Linux/Mac jobs, including original E2E. The fixture had
primed agent metadata, which does not await native plugin activation. Production
already reads the model catalog first, whose native handler awaits activation.
Fixture-onlyf1097948 now matches that supported order; both signed Mac and
isolated Linux components pass all76 assertions without changing guards/timeouts.
The original failed agent snapshot was not captured, so exact failure state is
not retrospectively invented. Explicit unit-only mode is not platform coverage.

Native queue functional acceptance now includes paused restart recovery and Resume,
exact retained sessions/messages/entries, exactly-once native admission and two
source-verified saved outputs. The exact continuation has closed full traces and
archives, with original strict controller/recorder failures kept failed. Initial
Send was never replayed; source/capture epoch changes and the exact two credential
reference updates are recorded. The synthetic provider means this is functional
queue evidence, not a legal-quality or model-performance result.

Context testing exposed a real /compact dispatch regression: the configured-command
catalog does not contain OpenCode's separate native compaction operation. The shared
queued server path is corrected atfaa2e322 (37 controls/177 assertions). A fresh normal
Linux package has now completed ordinary UI /compact in the same preserved chat,
with one manual native compaction, start/end events, a drained queue and one
complete controlled-provider request. Root independently verifies330 retained
references/57,889,342 bytes, all18 prior rows unchanged, exactly one completed
compaction plus native idle, the joined durable queue ID, empty final queue and
one start/end pair. Functional ordinary UI acceptance is complete; no model
quality or performance claim follows from the controlled provider.
The separate native-API context scenario completes compaction in the same chat,
then reads the changed document/project and saves the source-verified new result.
Root accepts only its exact empty-input trace qualification; original strict
recorder failures remain unchanged. It is functional evidence with a synthetic provider,
not a legal-quality or performance comparison, and does not replace ordinary UI acceptance.
The frozen scheduler case asks for MCP/shell access that unchanged v1/v2 scheduled
policy forbids. It remains a permission-negative case. The separate allowed-tool
task now completes exactly once: it lists/reads the actual project source and
saves the correct2026-11-14 result. Root independently verifies its task/run/native
admission IDs, full tool outputs, saved bytes and provider wires. The remaining
VM's last verified deletion lease was26October23:55UTC. Complete local functional
traces and prior cloud-preserved state remain available. Two additional post-UI
whole-guest/package archives were verified on the guest but were not offloaded
before interruption. Their recoverability is unconfirmed; cloud inspection needs
interactive reauthentication. No durable post-UI whole-archive claim is made.

Mac signing run40395265646 now passes exact identity import and both codesign
preflights after correcting only the owned temporary keychain's search-list lifecycle.
All three Mac binaries compile/sign successfully. Independent native ARM, Intel
and Intel-baseline engine/restart/auth/Code Mode/JIT/native-module checks pass:
nine tests/135 assertions, actual optimizing JIT execution and native pixel checks.
The complete twelve-target distribution combines these three signed Mac archives
with nine unchanged non-Mac archives. All14 proposed release files have independent
root hash/size checks. The user has explicitly declined public engine publication
and authorized migration source pushes/CI only. No release, tag or public binary
assets will be published. Final adoption is being prepared through the existing
local/archive-directory and CI-artifact paths, with exact distribution pins;
the old proposed public download URL will not be adopted. Old f754 artifacts are
immutable; no default flip has occurred.

Canonical Bun1.4.4 web/calendar bundles reproduce exactly with their license headers.
Exact reviewed prior deadline calculator bundles remain usable at the same rule
version; all88 rule tests pass against each of the three actual bundles. Edited
code and incompatible rule versions remain refused; real HTTP receipts retain the
executed digest. No deadline rule or agent output cap changes.

## Tool registration

A source-backed audit compares every explicit tool dictionary entry in the
frozen v1 plugin source with the actual final7 Linux native registry:

- **145 of145 domain-tool registrations remain present under their exact names**
  (or their native namespace); the live project registry has239 total tools.
- This covers Word7, Excel9, PowerPoint8, in-app/extension/UI41, calendar7, drafts6,
  scheduled tasks9, skills4, storage9, reviews18, wiki/views22, sandbox3,
  complete-output reader1 and the existing benchmark feature1.
- One additional old declaration only returned the literal version string
  `opencode-chrome-devtools@1.0.4`. That plugin was replaced by the approved
  native browser integration; it was not a document/browser action.
- The normal build packages31 native plugin directories.

This verifies availability, not successful execution or reasoning quality. It
counts explicit baseline dictionaries only; factory-generated/native tools and
the retired external browser plugin's dynamically imported tools have separate
contracts and acceptance. Tools remain subject to their actual project
configuration and permissions. No new tool/output cap is introduced.

Private audit: `~/.codex/benchmarks/legalwork-capability-source-parity-20261026/`
`live-registration-comparison.json`, SHA256
`c4937e781a2d6766a72e8a5e7df8ed121ad6ed45bac920c6bc4da2cec6c713cb`.
The full mapping retains exact source files/lines and observed native IDs.

## Historical acceptance checklist — 27 October, 08:46 UTC

At this earlier checkpoint, candidate run [40475853243](https://github.com/eigenweltlabs/legalwork/actions/runs/40475853243) started27October08:46UTC atf10979482b1aeb719288c84247fb2d325c3799ef. It used the existing six-runtime/six-package matrix and independently pinned producer40359354246/f754. These historical pending items do not override the completed final acceptance above.

1. Complete actual current-source app/package/startup checks on Intel Mac and
   Windows ARM64, and recheck Windows x64 after its extraction fix. All six sandbox
   suites pass; native Windows engine installation now passes on both architectures.
   These successes do not replace whole-app execution. The Intel probe-only fix
   requires a successful actual Intel run.
2. Implement a coherent normal-build/default adoption path without a separate
   public engine release. A URL-less static distribution alone cannot bootstrap a
   clean checkout. Both independent reviewers recommend building the approved
   patched source during app preparation, generating the exact selector after
   signing, then bundling those outputs. This is proposed, not implemented: the
   existing canonical source builder only qualifies Mac ARM and its manifest
   requires all twelve targets. Fresh developer-host support, generated-input
   ordering and cold-build cost must be handled explicitly. A material build-policy
   question has been presented to the user. Preserve all integrity/provenance and
   production-signing checks; no public publication, nonexistent URL or silent
   official fallback is authorized.
3. Run final integrated six-platform acceptance against the actual adopted normal
   build inputs. Ordinary UI /compact now has independently root-verified functional
   acceptance, including all18 original full message rows and exactly one native
   compaction. Queue/restart/Resume, native-API context and useful scheduling remain
   functionally accepted under their recorded qualifications. Both full Linux/Mac
   unit jobs pass; f1097948 additionally makes the scheduled-agent fixture await the
   existing native plugin barrier, with actual Mac/Linux component controls. Public workspace/status metadata now
   omits both flat and nested native engine credentials. The desktop reads the
   live embedded-server config privately, matches the exact selected project and
   follows credential rotation. Real HTTP tests pass13 cases/98 assertions;
   desktop tests pass435 with4 platform skips; app/server typechecks pass. These
   source checks are now supplemented by an actual final8 Mac normal build/package/security and real engine startup. It verifies the exact native version and credential-free workspace metadata; browser connection acceptance remains separate.

The desktop manual-server connection UI has a separately recorded inherited
routing problem: its current resolver prefers the embedded server. The relevant
source predates this migration. The working Node22 development-server route is
separate; this finding is not silently counted as a tested manual desktop connection.

Latest dev3b214a80c is merged at80d34a95, including checkout/sign-in expiry and
Mac updater shutdown fixes. Migration-specific import integration is corrected
at43969414. All437 desktop tests pass with4 platform skips;29 affected sign-in
tests and app/server typechecks pass. Earlier real task results retain their
sealed9c278ff0/final7 identities rather than claiming execution of this newer source.

The final7 NDA run completed18 real EU Gemini requests and saved its report;
both original mechanical assertions pass. Root independently accepts the full
56-criterion coverage assessment:55/56 versus v1 53/56, including354 exact cited
source/report passages and all retained evidence. The
unchanged C045 rubric/source conflict and six additional quality concerns remain
recorded, including compelled-disclosure severity and unsupported factual claims.
This is not a blind quality estimate. The original trace-incomplete result is
retained; its one internal-search gap has a root-accepted exact qualification,
not a general tracing waiver. Complete closed-state archives are verified in
private EU cloud storage. Delegation completed with two distinct actual
parent-linked reviewers and complete22-pair tool traces. Literal v2 strict8/9
versus v1 strict9/9 remains: exactly three citation labels use source-identical
capitalized Section. Root accepts the exact additive functional qualification;
both memos retain external-statute/fixed48h-buffer claims outside the supplied
sources. Large MCP passes all3 original assertions, matching v1's parsed decision.
All4 native connector calls contain the complete2,024,587-byte text and ordered
structured result; the actual digest tool consumes the entire source. Root
accepts its exact two-search qualification and verifies all11 full GeminiEU/medium
wires. Native search has no separate child event/timing; originals remain
trace-incomplete. Request roles and controlled cost/speed comparisons are not claimed.

The first final7 Excel attempt stopped before inference because the fresh UI had
no selected model. That zero-call failure and original workbook are retained.
Ordinary UI selection and a new empty chat corrected setup; the separately
admitted real run completed18 requests with no provider/engine error. Its original
`trace-incomplete` result remains unchanged. Root independently verifies all2704
retained files,62 raw trace records,18 complete provider wires, four full internal
search returns/outer timings and three exact empty-object document-list pairs.
The saved workbook preserves all7 checked formula/value cells,32 original cell
styles,18 row attribute sets,28 untouched non-formula cells and the original
theme. Only the previously observed XML line ending differs. Exact additive
qualification is accepted; no general trace waiver, request-role attribution,
controlled speed/cost claim, model rerun or assertion relaxation has occurred.

Full request/response and tool evidence is retained, including failures. Native
internal search lacks its own separate timing span under the user's accepted
exception; full search results and outer-call timings remain. Do not claim
controlled speed/cost improvements when request roles, source baselines or
provider cache state differ.

The migration branch is pushed for CI; no release or default derivative selection has occurred.
