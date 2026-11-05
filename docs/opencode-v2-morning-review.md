# Review when you return

The engineering migration is complete on `codex/opencode-v2-migration` for the
user-frozen OpenCode 2.1.4/dev snapshot. No release is published.
Confirmed model charges are **€17.96 across 678 calls**,
confirmed again by two read-only gateway balance reads and the complete charge
list on 27 October after the final task. All 40 final-run calls match complete
SSE response IDs and persisted charges totalling €0.83. The separate conservative ledger retains settled estimates and two
uncertain historical holds; its exposure is not the gateway's confirmed charge.
The existing settlement API cannot replace those settled estimates. Original
records are preserved, and a fresh per-case budget guard precedes another task.
The €250 ceiling is reserved for justified fixes and retests; VM costs are separate.
Migration source pushes and existing CI test artifacts remain authorized.
No app/engine release, tag or release assets have been published.

## Final acceptance — 27 October, 14:50 UTC

All six native engine configurations and all six protected runtimes pass. Both
full Linux and Mac unit suites pass. Final-source actual app/package/startup
passes are closed for both Macs, both Linux architectures and both Windows
architectures. Both Windows unsigned installers and actual engine-to-VM tool
integrations pass. The final [Windows run40517342408](https://github.com/eigenweltlabs/legalwork/actions/runs/40517342408)
is wholly successful, with its last app job completed at 14:50:17 UTC.

Windows startup diagnostics now identify a native Documents-folder lookup error
in the synthetic test profile, before engine boot. The fixture now creates that
owned directory; verification40517342408 passes startup on both architectures.
The original 90-second deadline and
all 16 startup assertions remain. Both Windows architectures separately pass the
actual engine-to-protected-VM tool check, each with all 33 assertions and no skips.
ARM64's native-window diagnostic timed out; the exact Documents error was
recovered on x64. The failed runs and their diagnostic qualifications remain
preserved; no product or registry change was needed.

Intel Mac's initial final-source attempt failed during dependency downloads.
Its unchanged Intel-only retry passed the full app/package/security/native/preview/startup checks at 13:33:59 UTC. Earlier
production app passes remain retained under their exact source identities.

The adopted `dev` help/navigation snapshot is merged. Final
[run40498732383](https://github.com/eigenweltlabs/legalwork/actions/runs/40498732383)
uses exact production-produced engine bytes under development TEST metadata;
it is not another production producer or an app release.

The user subsequently chose to finish this tested dev snapshot. Three newer dev
commits (meeting/audio fixes, dashboard files and detailed support exports,
ending at `7d4f2bcc`) stay outside this candidate. Their uncommitted merge was
cancelled. A future integration needs to adapt the new support exporter's v1
database queries for v2; no new support-export feature is claimed here.

The final actual-model task completed two delegated reviews and both outputs. The user-selected isolated Linux VM
has passed normal package/security and independent pre-Send catalog, protected
execution and root-private tracing checks. Independent offline replay retains strict 8/9: three citation-capitalization
mismatches. All 36 tool returns and 40 provider exchanges are complete and
verified. Unsupported legal/business memo statements remain separate quality
findings. No outside-folder Ask occurred, so no Deny interaction is claimed.
Native request roles are not fully attributed; performance comparisons remain
inconclusive. The task cost €0.83 and was not retried. The VM has no service account and automatically
deletes at 15:48 UTC. Consistent database backups and full traces are preserved
locally and in verified private EU cloud storage. The earlier Mac skill
contamination remains recorded, with no paid task sent there.

The user reports sufficient free disk space. No further cleanup batches are
planned. The previously running private evidence backups are complete.

The agreed separate work remains: inherited browser capture bugs, broader legal
quality findings, Windows updater delivery and the physical Windows 11 check
before public release. Windows signing is unavailable; tested installers are
unsigned. The native internal tool-search timing gap and final benchmark's
incomplete request-role attribution remain explicit; no performance superiority
or perfect legal-quality parity is claimed. The final acceptance matrix and
evidence identities are in [capability status](opencode-v2-capability-status.md).

## Previous checkpoint — 27 October, 11:06 UTC

All twelve final engine targets are built; all six protected runtimes pass. The
actual six-platform app jobs have started in
[40486260728](https://github.com/eigenweltlabs/legalwork/actions/runs/40486260728).
Final completion still needs those package/startup results, the corrected full
Linux/Mac unit run, and one actual-model check using the final compiled engine.

Two Windows follow-ups remain. A native engine test completes all 162 semantic
assertions, then cannot remove its temporary directory; the production lifetime
alignment alone did not fix that cleanup. The next run retains the exact remaining
paths and process state to identify the open resource. Separately, Windows app
build rejects generated browser output after Git changes its line endings. A
scoped checkout rule passes the real Git reproduction while still rejecting stale
output; actual Windows app acceptance must consume the correction.

The user accepted keeping broader legal-quality findings separate, retaining the
exact NDA55/56 versus53/56 and delegation8/9 versus9/9 findings and their caveats.
Any established new migration regression still needs correction. The final Mac
functional check is authorized with full traces and ordinary outside-folder
permission denial; the user explicitly accepted that its trace files are owned by
the Mac user rather than Linux root. This is not equivalent OS-level isolation.
Original Linux evidence is retained. No new content limit or production behavior
change is introduced by these test and checkout corrections.

## Previous checkpoint — 27 October, 09:55 UTC

The user chose to finish and freeze OpenCode 2.1.4. Stable 2.2.0 appeared today;
its source audit is retained for a later upgrade. It needs a real patch/build
adaptation and fresh acceptance, so its release notes are not counted as
improvements in this migration.

The approved normal source-build route is implemented: developer builds prepare
only their host engine, verify and reuse unchanged outputs, and bundle the engine
with the app. Production builds use the pinned upstream source, official frozen
Bun dependency graph and exact compiler, sign before generating immutable file
pins, and supply the complete verified distribution to each app build. The normal
entry points share this preparation; runtime startup does not compile source.
No separate public engine release or new runtime dependency is needed.

Fresh [source-build acceptance40482058927](https://github.com/eigenweltlabs/legalwork/actions/runs/40482058927)
at09bea36f has passed cold native compilation and seven actual engine/tool tests
(162 assertions) on Mac ARM64, Mac Intel, Linux x64 and Linux ARM64. Each also
passes unchanged-output cache reuse. Both Windows native-source jobs failed before
compilation because Git changed pinned patch bytes to CRLF. The bounded correction
preserves LF in reviewed build inputs and both upstream clones; all original pins
remain unchanged. It requires an actual Windows successor run. These four source
checks do not replace final app/package/startup acceptance on all six platforms.

The preceding candidate run40475853243 passed complete Linux x64/ARM64 and Mac
ARM64 app checks. Its Windows app jobs stopped at two test comparisons between
short and long spellings of the same physical path; the tests now canonicalize
both sides while retaining escape/missing-file checks. Intel Mac passes its
corrected network probe, then fails final startup without a server-state file.
The next probe will retain redacted synthetic failure diagnostics; its original
startup allowance and assertions stay required. Both full unit jobs passed. Earlier results
retain their exact source/distribution identities; they cannot be relabelled as
the final normal source build.

The user approved retiring bare standalone executable downloads. CLI URL/download
fallbacks and the separate raw-sidecar release route are being removed. Desktop,
Node development, manual server URL/token connections and complete existing NPM
platform packages remain. Desktop agent tools use the embedded server and local
packaged sandbox, independently of the retired downloader. No new standalone
archive delivery format is being introduced.

Ordinary UI /compact, native context, useful scheduling and queue restart/Resume
remain functionally accepted with the detailed qualifications below. The complete
local compact evidence is retained; two later guest-only whole-state backups were
not confirmed offloaded before interruption. The last confirmed model charge
above is a dated receipt, not a fresh balance. No new paid model calls were needed
for this source-build work. Final migration completion still requires the final
integrated six-platform acceptance; percentages and unsupported finish times are
not being used.

## Previous checkpoint — 26 October, 21:46 UTC

The migration remains unfinished. Public engine publication was explicitly
declined; migration source pushes and CI remain authorized. No release, tag or
public binary assets will be published. Final consumption is being prepared
through existing local archives and CI artifacts, with all exact pins retained.

All six sandbox runtime suites pass. Complete normal app-package, renderer and
actual .3 startup checks now pass on Linux x64, Linux ARM64 and Mac ARM64; each
also passes seven native engine/tool tests with162 assertions. Intel Mac has
finished building and is running its engine/tool checks. Both Windows package
jobs found the same drive-letter archive bug before app build. The small native
Windows tar fix is committed; both architecture retests are running separately.

Ordinary UI /compact now passes on the fresh normal Linux package in the same
retained chat. Its closed evidence is awaiting root review. Native-API context,
useful once-only scheduling and queue restart/Resume remain functionally accepted.
The full Mac unit job also passes. Linux's independent scheduled-agent boundary
assertion remains unresolved: local Mac and isolated Linux controls pass, and the
next CI run retains the exact returned policy on failure. No guard was weakened.

The old sandbox-engine test fixture is now ported to native v2 APIs and passes
the actual protected Mac VM check (33 assertions); successor CI still needs to
consume it. An inherited diagnostic-export password leak is also fixed with a
one-line serializer change and a focused regression; live engine credentials
and all useful diagnostics remain intact.

## Previous checkpoint — 26 October, 21:18 UTC

Three subagents and the orchestrator are active, the session's maximum. Platform
acceptance, fresh normal-app context acceptance and independent final integration
review have separate owners. The full Linux/Mac unit retest runs independently
of the slower six-platform builds; neither run cancels the other.

The remaining gates are:

1. Actual package/startup execution on all six OS/CPU configurations. Current
   [run40399014261](https://github.com/eigenweltlabs/legalwork/actions/runs/40399014261)
   has five sandbox configurations passing; Intel isolation and then all six
   package jobs remain pending. Sandbox success alone is not app execution.
2. Ordinary UI /compact in the fresh normal Linux package. Its server dispatch
   fix passes37 controls/177 assertions. The separate native-API context scenario,
   useful scheduled task, and queue restart/Resume now have independently reviewed
   functional outcomes. Their synthetic provider does not measure legal quality
   or performance; original failures and exact trace qualifications are retained.
3. Final engine distribution/default adoption. All three signed Mac engine
   variants now pass actual native startup/restart/auth/Code Mode/JIT/native-module
   checks, nine tests/135 assertions. The exact14-file distribution and prepared
   selection change are reviewed. The specific engine-only prerelease publication
   question is pending; no publication or default switch has occurred. Actual
   published downloads must be verified before adoption. The release event also
   triggers existing alpha-feed maintenance, as disclosed in that question.

The current full Linux/Mac jobs passed their preceding suites and failed only
the final app E2E helper's old sidecar path. Commit4014f65a fixes engine resolution
without changing assertions or timeouts. The complete unchanged app E2E chain
passes locally on the signed engine; seven controls pass on Node22 and Bun1.4.4.
[Run40402814154](https://github.com/eigenweltlabs/legalwork/actions/runs/40402814154)
now repeats both complete Linux/Mac jobs in explicit unit-only mode.

The remaining VM has a finite23:55UTC deletion lease. About9GB was reclaimed
from ignored dependency directories in three obsolete compiler checkouts; their
sources, locks, binaries and all traces remain. Closed evidence is also fully
verified in the approved private EU bucket.

One inherited issue is separately recorded: the current desktop manual-server
connection resolver prefers its embedded server. This predates migration;
the working Node22 development-server route is a separate tested flow.

## Previous checkpoint — 26 October, 20:35 UTC

Repeated percentage estimates have been retired: they did not communicate the
remaining work reliably. The concrete gates are actual app/engine execution on
all six configurations, context and scheduled execution, and signed derivative
adoption. Three autonomous subagents own platform CI, Mac signing/distribution,
and context/scheduling; the orchestrator handles integration and final review.

The third run40389826731 passed five sandbox configurations. Intel Mac failed
only the proxy test's aggregate30s allowance; capacity diagnostics showed about
100.8GiB free. Its original per-mode checks are now separate tests with the same
30s allowance each (4pass/134 assertions; all128 original checks retained).
Linux unit tests exposed a selected-engine layout assumption in a desktop fixture;
Mac unit tests lacked the normal server/plugin build. Both are corrected. Actual
packaged-app jobs were skipped, so the additional three configurations remain open.

The next [six-platform run40395337521](https://github.com/eigenweltlabs/legalwork/actions/runs/40395337521)
uses the unchanged verified12-target producer. A Windows test preload used a raw
filesystem path instead of a file URL; the narrow correction is committed while
the other jobs continue. Original failed runs remain retained. Diagnostic packaging is being decoupled
from sandbox-test success, while failed sandbox tests still fail the overall run.
No successful six-platform packaged-app execution is claimed yet.

The native queue has completed pause, enqueue, edit, remove, reorder, Stop,
restart and Resume with exact history/paused-queue recovery, exactly-once native
admission and saved task outputs. The original controller/recorder failures remain
failed; the separately labelled continuation uses the same chat/profile and never
replays initial Send. It used a recorded synthetic provider and proves functional
queue behavior, not legal reasoning quality or model performance.

Context testing found ordinary /compact was rejected before queue admission:
OpenCode exposes it through a separate native API. The server dispatch correction
and real UI retest are in progress. The originally frozen scheduler task requests
capabilities that both v1 and v2 scheduled profiles forbid; it stays a negative
permission case. A separate useful task using ordinary scheduled permissions is
required. One remaining VM has a finite21:55UTC deletion lease.

The [Mac signing run40395265646](https://github.com/eigenweltlabs/legalwork/actions/runs/40395265646)
now passes exact identity import and both signing-context preflights after its
owned temporary keychain was added to the CI user's search list. Earlier failures
are retained. All three Mac binaries have compiled and signed; independent ARM
engine/restart/auth/Code Mode/JIT/native-module runtime checks pass. Intel runtime
checks and complete distribution pins still await results. No artifact/default selection was
mutated, and nothing has been published.

Canonical Bun1.4.4 bundle generation also exposed an installed deadline-skill
compatibility issue. Exact reviewed earlier compiler outputs remain accepted only
for their unchanged rule version; edited files remain refused and receipts record
the actual executed code hash. Both earlier bundles and the new bundle pass all88
existing legal-rule tests. No rules, dependencies or agent output limits change.

Read-only PostHog inspection at 19:43 UTC found 1,626 SG app openings in the previous
24h: 1,613 version 0.2.9 and 13 version 0.2.17, all Linux x86_64 with distinct IDs.
These do not match our private 0.2.19 migration renderers; the traffic source is
unconfirmed and distinct IDs do not prove distinct real people. No analytics
data or settings were changed.

## Previous checkpoint — 26 October, 17:05 UTC

The matched Office/legal/delegation/large-MCP cases have completed with exact
functional review; original strict failures and legal-quality limitations remain.
Large MCP matches all3 assertions with complete2MB tool results. NDA coverage is
55/56 versus v1 53/56, with a frozen source/rubric conflict and six additional
quality concerns. Delegation strict8/9 versus v1 9/9 reflects three citation
capitalizations; both versions retain external-law sourcing concerns. Windows
Claude tracked editing qualifies4/4 after read-only recovery from a collector
path error. No model reruns, shortened outputs or changed task assertions.

Queue recovery, context, scheduling and actual execution on all six platforms
remain the main gates. The first CI producer successfully built all12 engine
targets. Its six sandbox jobs found the same missing Node worker preparation;
the fix is pushed, with13 CI controls passing. The corrected run can reuse the
exact verified engine artifact. That checkpoint temporarily used Bun1.3.14;
the current checkpoint supersedes that test-host choice.

Latest dev3b214a80c is merged, preserving the new checkout/sign-in and Mac updater
fixes. Affected sign-in tests29pass; desktop437pass/4platform skips; both
typechecks pass. Earlier actual task runs keep their sealed final7 identity.
The newer final8 Mac build/package/security/engine startup also pass with the
private credential boundary. No public release or default-engine switch.
See [the acceptance register](opencode-v2-capability-status.md).

## Previous checkpoint — 26 October, 16:32 UTC

Approximately **80% complete** remains an engineering estimate, not a completed-test percentage.
The user requires actual execution on all six shipped OS/CPU configurations.
The [six-platform CI run](https://github.com/eigenweltlabs/legalwork/actions/runs/40359354246)
started at16:27:48UTC from the pushed migration checkpoint. Its reviewed engine
producer and sandbox prerequisites are running; the three additional configurations
have no completed result yet.

The newer final8 Mac package passes its normal build, packaging, security and
actual-engine startup. Workspace metadata exposes no engine credentials. Its
source tests pass13 HTTP cases/98 assertions and435 desktop tests with4 platform
skips; exact runtime selection/rotation checks pass29 tests. No new output cap.

Delegation completed with two actual completed reviewers; strict8/9 differs from
v1 strict9/9 only in three Section/section citation labels. An additive exact
functional qualification remains under review. Both memos introduce claims beyond
the supplied files; this inherited quality issue stays explicit. Windows Claude
completed its in-app DOCX task; subsequent collector-path failure is preserved
while the unchanged document/wires are recovered. No model rerun or new hints.
Native queue/restart, context, scheduling and the large connector task remain open.
See [the acceptance register](opencode-v2-capability-status.md).

The prior confirmed model-spend snapshot below is **not current**: newer real
calls await charge reconciliation. VM costs remain separate, with finite deletion
leases at17:55UTC. No release or default engine switch has occurred.

## Previous checkpoint — 26 October, 14:53 UTC

Approximately **80% complete**, an engineering estimate. The user's priority is
working engines, complete migration and preserved agent/tool behavior. Inherited
browser bugs are separate work and will not hold up migration completion.
[Current capability status](opencode-v2-capability-status.md) is the concise
acceptance register.

- Latest final7 builds, packaging and security pass on macOS ARM64, Linux x64
  and Windows x64. Actual engine/Electron execution passes on all three.
- Final7 Windows unsigned installation/upgrade passes: all2620 installed files
  match and15 chats/75 messages remain exact, with public reads verified. The
  app and engine then quit normally. Licensed Word read/edit/comment/save/reopen
  was already verified on final6; a real-model provider test is being prepared.
- All145 explicitly registered v1 domain tools are present in the actual native
  catalog. This proves registration, not execution of every tool.
- Real final7 Excel completes reading, editing and recalculation with18 requests
  and no provider/engine error. Strict3/4 matches v1: one XML style line ending
  changes. Original results remain immutable; seven exact trace representation/
  internal-search gaps are under review. No favorable model rerun.
- Native-v2 queue/restart, context and scheduling now take priority over another
  v1 harness rerun. Legal, delegation and large-connector comparisons remain.
- The original Mac packaged browser scenario passes. The two inherited capture
  defects are documented separately under the user's accepted scope.

The latest v1 lifecycle control restored its chat and paused queue correctly,
then a normal feature announcement covered the Deny button. No Deny was clicked;
the safe Stop completed and all evidence was preserved. This is a setup failure,
not evidence that the engine's permission check failed. All five older closed
v1 guest archives are fully verified in private EU storage; the sixth remains
fully guest-verified for follow-up offload.

No default derivative switch, push or public release has occurred. Latest model
charges have not yet been reconciled into the confirmed€15.01/558-call snapshot;
the conservative guard remains below the authorized token ceiling. VM costs
remain separate, with finite deletion leases at17:55UTC.

## Previous checkpoint — 26 October, 14:26 UTC

Approximately **80% complete**, an engineering estimate. [Platform and tool acceptance status](opencode-v2-capability-status.md) distinguishes implemented/registered capabilities from completed real-agent tests. No default-engine switch,
push or release has occurred. The branch is on latest dev `9c278ff0`, including
the reviewed dictation update;192 affected existing tests pass. The independently verified new common final7 source includes latest dev and the
browser readiness correction:3060 source files, unchanged dependency versions and
locks. Mac and Linux normal build/package/security pass; Windows normal unpacked packaging, security and unsigned installer also pass; ordinary installed-upgrade acceptance on this latest build is next.

Real Windows Word acceptance is complete and independently reviewed: native reading,
tracked edit, anchored comment, normal save/close and an independent Word reopen.
The unrelated original comment survives; replacing a commented test anchor removes
that anchor's comment under unchanged V1/F6 Word replacement code. Normal unsigned
installer, upgrade and existing chat history checks also pass. This proves the
Windows Server VM functionality; Windows11 performance and release update delivery
remain the user's accepted later checks. Full closed Windows guest evidence has been verified in the existing private EU bucket; guest originals remain.

The real final6 PowerPoint task passes all4 original checks, including saved edits,
slide layout/addition and original notes. Its original `trace-incomplete` result
is retained. An independently reviewed additive qualification covers exactly seven
internal searches under the accepted tracing exception and one source-proven empty
argument representation. All12 requests retain backend/medium settings. Request
roles remain unproven, so no controlled role-specific performance claim is made.
No paid rerun occurred.

The requested Mac dev-server investigation found the screenshot race: the first
thumbnail could enter capture before its tab's initial load settled, holding the
shared physical screenshot queue. Waiting for existing initial readiness passes
both fast and500ms-delayed page tests. Root applied the two-line product fix plus
tests;15 browser-panel tests and the full desktop suite (432 pass,4 platform skips,
0 failures;20 Actaport tests pass) pass. A closed-tab identity check prevents a
late thumbnail after normal close. No capture API, serialization, output limit,
dependency or permission change.

The original visible-browser scenario now also passes in the normal final7 Mac
package, with no dev renderer or diagnostic observer:11 synthetic provider requests,
full native snapshot/evaluate/screenshot/click, exact before/after geometry. Its
21,233-byte864x1300 PNG is identical to both pixel-verified dev controls; both edge
markers remain. The original failed packaged runs are retained. Normal provider
cleanup/reload and app/engine Quit pass. The user chose to track inherited full-page/hidden capture bugs separately; migration still requires no regression from v1. Natural paid browser behavior remains an open check. See [the separate issue record](opencode-v2-browser-known-issues.md).

One Mac setup conflict was preserved and resolved: the independent dev profile had
rewritten the same test folder's generated settings. The packaged app correctly
rejected the different ownership digest. Root normally closed it, verified the exact
dev-owned file against its private receipt, preserved that complete file outside the
project, and let normal startup regenerate its own settings. Authored files and the
guard were not changed. This is not evidence that copying private profiles and
sharing their generated selection file is a supported concurrent workflow.

The exact-entry queue/restart control completed Send, edit/remove/reorder, Stop,
normal Quit/cold restart, distinct Resume and both actual queued tasks with eight
synthetic responses. Its original postterminal assessment failure remains alongside
a reviewed strict four-public-field correction; deployment intent is checked
separately rather than invented in public messages. Thirteen focused controls pass.

The next genuine v1 run preserved history/queue and completed normal cold restart,
but its continuation stopped at a benchmark-driver navigation issue: restart opens
Home and the driver only focuses an already-mounted chat tab. Consequently it could
not click the declared outside-folder Deny response. Root reopened the exact chat
through the public action and used one normal Stop; all failure evidence is retained.
Root reviewed and approved the minimal private host correction that opens the owned chat before the restart checkpoint, with unchanged history, paused queue and freshly read request counts. All13 focused controls pass. An actual deterministic outside-Ask/Deny control is still required before another paid admission. No model-quality or native-v2 lifecycle verdict is claimed.
Native v2 lifecycle/context/scheduling and remaining legal/Office/provider cases
remain open. No changed prompts, hints, favorable reruns or output caps.

Linux's completed PowerPoint app has now closed through Cua's normal File→Close
shortcut after its ordinary Save. The original paid PPTX and reserialized Save
version are both retained; ordered slide text and notes are identical. Exact app/
engine exit and52/52 observer ACKs are verified. Temporary loopback remote-viewer
tools were removed, restoring the full809-package OS baseline byte-for-byte before
fresh Excel preparation. Complete closed PowerPoint state is now generation-pinned and fully verified in private cloud storage (four objects,782,365,363 bytes). Guest originals remain. The first unchanged final7 Excel dispatch stopped before inference because the actual fresh renderer had no model selected; the composer remained disabled. The zero-call failure and unchanged workbook are retained. Ordinary UI model-picker setup is being corrected before a separately admitted run; the native catalog/default equivalence proof does not by itself make the renderer ready.

Disk recording is unblocked. Complete cloud copies were verified before removing
only closed package duplicates. All3 existing VMs have deletion leases to
**17:55 UTC /18:55 Berlin**, preserving original identity and security.

Confirmed gateway spend is **€15.00515449 across558 calls**, stable across two reads.
Twenty-five newly completed calls join exactly to full SSE and gateway charges.
One cancelled call lacks an exact response identifier, so its full€2.313421 safety
hold remains. Proposed exact-charge ledger reconciliation has not been applied;
conservative exposure was€45.671776 before the newly admitted v1 trial. Its final
charges are not yet reconciled. The€250 ceiling and€100
planning target remain unchanged; VM costs are separate. Mac dev diagnostics and
queue controls used deterministic local providers with no paid inference.

## Decisions made overnight

- Include the approved read-only Office fix: ten built-in reading/search tools
  remain available, while writes and arbitrary Office code are refused only
  when the server is deliberately read-only. Advanced code-based reads are
  unavailable in that mode; the user accepted this boundary. Normal desktop
  tools remain unchanged.
- Keep the native engine's response capacity. V2 normally permits more output
  than v1; we add no lower token cap to reduce cost. Actual usage remains traced.
- Add native tools for retrieving a stored older image after it leaves active
  context. Real-engine checks now pass after default compaction and after the
  native large-chat image limit removes an older image from the next request.
  Retrieved bytes match stored images exactly; cross-chat reads are rejected.
  It recovers the stored version, including OpenCode's prior resizing;
  it cannot recreate pixels already discarded or show every old image at once.
- Preserve full originals of images returned by tools, using a private store
  and supported native hooks. This adapter now passes a real compiled-engine
  component test, including cropping detailed regions and exporting originals.
  Each crop uses a short-lived helper from LegalWork's existing Node runtime;
  there is still one OpenCode engine and no new runtime or package dependency.
  The image becomes available after its producing tool call has been saved,
  so it cannot be captured and cropped within that same running Code Mode batch.
  Image lists use 100 records per page with unlimited explicit continuation;
  this limits each metadata response, not retained images or export size.
  Crop coordinates follow the decoded pixels. JPEG rotation is handled;
  PNG/WebP rotation metadata is not universally applied. Unsupported formats
  remain exportable as exact original bytes. These limitations remain visible.
  Crop components now pass 18 tests. An actual compiled-engine startup/recovery
  test also passes with the new managed-history identity. Root independently
  checked exact original bytes, actual provider requests and crop pixels.
  Installed-app coverage remains open. Native deletion-stream cleanup now
  passes deletion, isolation and physical shutdown. The first shutdown failure
  came from the test relay; controlled comparisons established the cause, and
  the real-engine retry passes without a product or engine patch.
  Review also found and fixed a deletion edge case involving copied history
  from another engine; all five targeted server regression tests now pass.
- Fix a verified permission-routing bug in the complete saved-output reader.
  The actual compiled-engine checks now pass through normal chat dispatch,
  including permitted reads and denied reads; full original results remain saved.
- Use the Node runtime already shipped with LegalWork for policy-controlled
  HTTP connections. This fixes a verified Electron certificate failure while
  keeping certificate verification on. No new runtime/dependency or extra
  certificate-file reader. Actual installed Windows trusted/untrusted HTTPS acceptance passes; all bytes and traces are retained.
- Preserve all failed tests and complete traces. Private cloud copies are
  verified before duplicate removal. The previously pending four archives and
  complete old-run ZIP are now verified in private cloud storage.

## Questions to discuss

The browser scope question is answered: track the two inherited bugs separately;
require no regression from v1 for migration completion. The Mac race is fixed.

1. **Manual standalone connections:** automatic original-image cleanup is
   restricted to the managed engine whose history LegalWork owns. Normal app
   deletion also removes exact images verified in a manually connected engine.
   If a manual engine disappears outside LegalWork, private originals remain;
   a different server's missing-chat response cannot safely authorize removal.
   Recommendation: retain this conservative boundary for occasional development
   use. Is automatic cleanup for independently managed engines needed?

## Verified progress and remaining tests

The independently reviewed common final6 archive is
`ab22c58f824d8136daab2c94a8e471fc3b231ea3a8217cc14b887712aa924bf9`.
It changes eight focused files from final5, with unchanged dependencies, lockfile
and engine derivative. Actual Mac ASAR bytes include all three fixes. Linux
affected runtime tests pass; Windows is rebuilding the same source. Existing
plugin imports, Node22 development-server, package security and normal signing
checks remain available as evidence. These checks do not establish real-model
quality, queue continuation, context compaction or scheduled execution.

A diagnostic included disposable Linux test-profile client, host and owner
credentials in private tool output. No production/provider, Google or SSH key
was included. The exposed managed-owner record has been revoked and now returns
401; the exact old test tunnel is closed. Static test client/host credentials
were regenerated through fresh normal source-only startup. Guest history,
case files, engine and provider key were preserved. This incident and cleanup
are recorded for review; no token values are repeated here.

The large v2 connector task passes its functional checks but took48minutes.
A general native checksum tool is now packaged to avoid expensive interpreted
hashing; a fresh real-model run must prove it helps. Matched v2 legal/Office,
delegation/browser, complete queue continuation, compaction/context and scheduled
execution remain. The lifecycle verifier now passes 42 local controls, including
configured model settings; no missing generation header was identified in the
frozen v1 configuration. Local controls are preparation, not substitutes for
those real engine/Electron runs.

Detailed evidence and qualifications are in
[regression readiness](opencode-v2-regression-readiness.md).
