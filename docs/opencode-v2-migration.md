# OpenCode v2 migration

## Agreed target

On 28 October 2026 the user requested rebasing `codex/opencode-v2-migration`
onto current `dev` and integrating PR #329. The branch now includes `dev`
`15b52ba294b7034518b45af323065f8b5f439d1f` and PR #329's request-performance changes from
`c6616c77893b69c253bef22148565ba3436d56d8`. The engine target remains
OpenCode 2.1.4; this does not adopt a newer engine release.

The new dev integration includes recording/speaker changes, dashboard files,
technical support exports, mail/calendar organization, PDF reading/selective OCR
and chat math. Native PDF hooks and v2 support-history export are adapted as
part of the integration. Earlier comparison packages retain their exact frozen
sources and receipts; their passing results do not establish acceptance of this
new combined source. The original detached v1 baseline at
`4cd058941a96752ce7aca97ea71c97341f56a84b` and all historical evidence remain
unchanged. Existing user working copies are not migration inputs.

For current results and remaining gates, use the
[acceptance register](opencode-v2-capability-status.md). Historical test
checkpoints below retain their original failures and do not override that register.

- **D1, approved:** released local OpenCode v2 server with `@opencode/client`,
  following upstream's desktop/server integration. Target stable version 2.1.4.
  No custom embedded SDK engine host. No measured SDK performance advantage was
  established; native capability registration does not require embedding.
- **D2, approved:** one shared central capability library, explicit project
  selections and portable overrides, one resolver for engine and UI. Keep
  credential/access scope separate from where definitions are installed.
- **D3, approved:** native v2 adapters for first-party tools, organized as modular
  plugins; MCP for external connectors; typed plugin RPC for app/engine extension
  methods and events. LegalWork services retain domain ownership.
- **Queue, approved:** retain editing, reordering, pause and per-entry execution
  selections in durable LegalWork staging; native idempotent queue admission owns
  engine acceptance and execution.
- **Browser profile, approved:** keep the shared persistent profile as the default
  and preserve existing logins. Separate project profiles are not the default.
- **Remote agent workspaces, approved:** retire dormant add/load/routing/IPC
  support. Preserve cloud document folders, connectors, the active
  Electron terminal, and separately supported manual server selection.
  Latest dev `ab624cb2` separately retires unused messaging and sharing. That
  upstream change is retained; original tools and any generated native messaging
  plugins are archived, and external MCP connectors remain available.
- **Configuration boundary, approved:** use native connection/execution APIs and
  typed LegalWork managed-setting APIs. Remove the automatic standalone file-editing
  fallback. Standalone OpenCode-only connections own their settings externally.
- **One engine, revised 2026-10-28 (LW-287):** one released server for all local
  projects, following upstream's native configuration loader. The user selected
  native project files instead of a new private-configuration engine patch.
  Shared capabilities and secret strings stay in LegalWork's private library;
  generated selections live in `.opencode/opencode.json` or `.jsonc`. Preserve
  authored files and detect edits to generated files before overwriting them.
  This supersedes the 27 October shared-only reconstruction/discovery-disabled
  design. Normal UI skills and workflows still use the shared library.
- **Project admission, confirmed 2026-10-28:** remove the project-automation
  approval UI, approval endpoint and separate custom-plugin approval registry
  from the normal load path. Registered, available projects load their native
  configuration directly. Unknown engine locations and actual configuration
  conflicts remain blocked. Firm restrictions, chat approvals, project folder
  grants and sandbox policy remain enforced independently.
- **Permission preservation:** retain chat rules in their original chats and
  project/sandbox grants in their projects. Migrate identifiable old native
  saved approvals only while the engine is stopped; privately archive ambiguous
  records and ask again when that access is needed. Durable import receipts
  prevent a restart or interrupted migration from restoring a revoked grant.
- **Commands, approved:** preserve configured commands, routing executable expansion
  through normal permissions and sandboxes. Keep complete command output and the
  upstream absence of a default command execution deadline; Stop/revocation remain.
- **Legal product scope, approved:** exclude Git-worktree/repository-setup
  workflows from the agent and exposed engine API. Preserve shell/Python/document
  automation, file history and Undo internals. This resolves the worktree setup
  exception; no custom sandboxed worktree lifecycle is needed.
  The native `vcs.init` API is also denied while existing-repository status/diff
  stays available. Code Mode composes typed Office, browser and MCP tools and is
  retained. The pinned release has no active LSP/code-completion runtime to remove.
  Keep saved agent IDs and exact permission identities; any later adaptation of
  upstream planning/research instructions must preserve their useful legal roles.
  Coding skills inherited from a developer's personal global library are not
  treated as shipped LegalWork functionality or silently deleted from that library.
- **Reviews, approved:** isolated native review-submission tool with the exact worker
  schema, server-bound assignment and existing citation validation/retries.
- **History, approved:** retain an immutable private original backup; recover validated
  task links and original attachment references when displaying imported chats.
  Historical references never attest to current-file bytes. Detect unfinished Undo;
  restore only proved compatible native states and expose unresolved states explicitly.
- **Browser source, approved:** reuse the pinned MIT upstream desktop controller with
  LegalWork profile, policy and capability-preserving extensions.
- **Structured results, approved:** migrate JSON first-party results with precise
  authoritative schemas and lossless flexible schemas for dynamic payloads. Retain
  original text, files, and metadata, including full saved-output access.
- **Credentials, approved:** metadata-only listing and typed disconnect for connected
  LegalWork clients. Raw native vault access stays behind the trusted engine boundary.
- **External MCP ownership, approved:** retain direct native engine-to-connector
  connections and native OAuth/refresh ownership. The separate connector-manager
  gateway branch is not adopted. Preserve LegalMemory's six non-agent consumers
  through a supported, scoped native integration; never read native credential
  files or invent a second refresh owner.
- **Behavior:** preserve agent capabilities and user-visible contracts. All
  intentional behavior/default changes require an explicit decision. A test
  pass cannot guarantee identical stochastic model choices.
- **Context/performance:** measure and improve cache eligibility, repeated
  context, tool discovery, structured evidence and parallel independent work.
  Do not introduce token/output truncation or capability caps as an optimization.
  Explain every proposed limit by location, reason and consequence before adoption.
- **Patched-engine build, approved 2026-10-24:** use upstream's original frozen
  Bun install solely inside the isolated OpenCode source checkout. LegalWork
  remains on pnpm. The attempted lockfile conversion selected different
  dependencies; its test results remain provisional and are not build approval.
  Adoption requires tests on the official dependency graph and validation of
  the separately identified compiled candidate.

## Execution and review

For each subsystem, consult the pinned v2 documentation and implementation;
record whether its native mechanism replaces, simplifies or complements the
current LegalWork implementation. Do not preserve obsolete plumbing merely to
avoid investigating a native replacement. Do not delete LegalWork behavior
without checking equivalence.

1. Establish real Electron/v1-engine baseline and complete traces.
2. Retire remote agent workspace lifecycle without losing local capabilities.
3. Port local engine startup, distribution, clients, storage and event contracts.
4. Replace duplicate capability installation with native registries and a shared
   resolver. Port firm enforcement to the v2 policy model.
5. Migrate native plugins by domain, preserving permission, cancellation, Office
   draft and context/cache behavior.
6. Adopt the native durable prompt queue and execution lifecycle. Preserve
   existing editing, reordering, pause and per-entry execution selections through
   an explicitly designed pre-admission layer where necessary.
7. Integrate and complete the existing browser controller work against v2.1.4.
8. Run matched real-model tasks and artifact assertions, packaging/offline checks,
   and native platform tests. Remove superseded v1 dependencies and code only
   after their replacements pass the relevant contracts.

Subagents own distinct domains. Shared runtime/configuration/authentication and
cross-domain changes are coordinated by the parent. No release or publication
is authorized by this document.

## Benchmark and spending

The user authorized a reusable benchmark driven through the real LegalWork
Electron UI and engine, with Harvey public materials adapted to LegalWork
capabilities. Record provider/backend/model, settings, complete requests and
responses, engine events, all model turns and child sessions, tool arguments and
results, artifacts, timing, tokens/cache/reasoning and cost evidence.

Use Gemini 3.8 Flash initially and occasional Claude checks through the production
gateway. A dedicated restricted, expiring credential is stored outside Git; never
copy keys into traces. The initial durable **EUR 100 aggregate** reservation ledger
covers all runs, variants and judges. The user subsequently authorized up to
**EUR 250 for justified fixes and retests**, with VM spending accounted separately.
Preserve original records and reservations; do not reset the ledger per suite or
provider. Confirmed charges and conservative reservations are separate figures.
Notify on budget exhaustion or an accounting-related pause.
The ordinary gateway key budget alone is not a strict in-flight spending gate.

See [budget operation and every introduced accounting limit](https://github.com/eigenweltlabs/legalwork/blob/codex/v2-benchmark-tooling/scripts/benchmarks/budget.md).
The guard preserves natural model capacity, refuses an unaffordable whole request
before dispatch, and keeps unresolved costs reserved. It is conditional on audited
gateway tariffs and all test traffic crossing that guard; supplier invoices and
taxes are not falsely represented as the same accounting counter.

The initial faithful baseline records and locks the observed skill catalog,
including global libraries. It is not a clean-install or hermetic-catalog result.
Catalog/backend/fixture differences invalidate automatic parity unless explicitly
reviewed. Clean OS profiles belong in the platform matrix. The user authorized
`gcloud` VMs for later Linux/Windows testing; reserve their bounded cost and clean
them up after use. The first isolated Linux V1 VM has now been allocated under
the reviewed [isolation plan](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/opencode-v2-isolated-vm-plan.md), with a four-hour
automatic deletion lease and no attached cloud service account. Its source is
the exact frozen dev archive; Linux runtime assets are regenerated there. Paid
inference remains held until its filesystem/control/transport proof passes.

The later autonomous baseline passed source analysis and live Word tracked-change
editing. A Harvey board-minutes run accessed previous benchmark answers and
rubrics through the existing host shell. That run is invalid and was stopped;
the NDA report remains ungraded and nonhermetic. Further paid inference is held
until a clean guest filesystem makes prior answers/judge data inaccessible in
both baseline and candidate arms. This is a benchmark isolation requirement,
not a reduction in the agent's tools or outputs. At the phase checkpoint,
known gateway-reported costs total EUR 3.106061; the separate conservative
ledger commits EUR 31.646889, including an unresolved EUR 2.313421 hold, leaving
EUR 68.353111. These counters are not interchangeable or a final supplier bill.
The subsequent EUR 8 infrastructure reservation brings conservative committed
allowance to EUR 39.646889 and unreserved allowance to EUR 60.353111. No new
inference or judge charge is included in that change. Network charges remain
metered, and the reservation is not an unconditional cloud-invoice ceiling.

## Evidence so far

- Fresh current-dev dependency install and server/desktop preparation succeeded.
- First frozen v1/real Electron/Gemini 3.8 Flash trial: 11 requests, 9 tool calls,
  112.329 seconds including a manual external-directory denial. Gateway-reported
  EUR 0.42855669; conservative ledger EUR 1.908389, no outstanding holds. It is
  an interactive trial, not an autonomous quality pass. The substantive result
  was correct; an exact counterparty assertion rejected only Ltd/Ltd. punctuation.
- That trial advertised 181 tools per main step (213,356 bytes of schemas) and
  118,161 bytes of system content. Prefix hashes stayed stable. The title helper
  unnecessarily received the same 75,175-byte plugin context. Native progressive
  discovery and scoped auxiliary context need matched quality validation; no
  savings are claimed from this single trial.
- Real Electron, live Word rendering and built-in browser no-inference smoke
  succeeded. Paid agent-quality parity is not yet established.
- Harness and budget-control tests cover full output retention, protocol capture,
  aggregate accounting, process races and unknown-cost retention. These are not
  presented as model-quality test results.
- A pinned v2.1.4 released server and actual `@opencode/client` successfully
  created a session and loaded a synthetic native plugin/skill without inference.
  Catalog reads are initially nonblocking; clients must observe readiness rather
  than assume an initially empty catalog is final.
- Actual 2.1.4 location tests isolate models, agents, MCP definitions and skills
  across two projects, including a targeted refresh that leaves the other unchanged.
  `model.list` activates external plugins; `location.get`, `agent.get`, `plugin.list`
  and `session.create` alone do not establish readiness.
- Actual frozen 1.18.29 to released 2.1.4 migration fixture passes: immutable source
  copy, 252 KB complete tool output, tool metadata, tokens/cost, inline files, hidden
  model context, search and inbox. Upstream losses remain explicit: arbitrary
  message/text-part metadata, session revert state, non-inline attachment availability,
  malformed rows, and interrupted running tools. The original v1 database remains intact.
- Actual native import tests create complete 55-message template histories atomically,
  preserve long text and metadata, handle concurrent imports, and never overwrite an
  existing chat. Native cursor continuation must omit initial filters such as `order`.
- Released native scheduling/Code Mode tests verify project boundaries, complete
  transcript continuation, clock reminders, DST defaults and no foreground UI actions.
  These local fixture tests submit no paid model requests.

## Remaining implementation and decision gates

Historical implementation checkpoint: subsequent patched-engine builds,
cross-platform tests and runtime corrections are recorded in the
[current acceptance register](opencode-v2-capability-status.md).

- **Native MCP tool-readiness race:** the unmodified 2.1.4 engine can accept an
  immediate prompt after reconnection before the connector's tools enter that
  job's immutable catalog. LegalWork's transport-recovery gap is fixed; the
  native catalog gap remains reproduced, including direct native reconnection
  without LegalWork admission or location reload. The user approved implementing
  the source fix on 2026-10-24. Upstream tests and a reproducible, distinctly
  identified candidate build are in progress; adoption still requires validation. See
  [the complete boundary and patch proposal](opencode-v2-mcp-readiness.md).
- **Extra developer launcher, retired with approval:** normal desktop and independently deployed
  LegalWork-server flows use the approved managed engine lifecycle. The separate
  developer daemon/multi-engine registry was unused by those flows and is removed.
  Original records/configuration remain untouched; verified legacy status/stop
  compatibility remains available. Retirement contract tests and preserved actual
  historical plain-Node server/router startup tests pass. Latest dev retires the
  router; the current fixture preserves managed engine ownership without it.
  Firm self-hosting and manual
  LegalWork-server connections remain supported.
- **Private legacy CLI configuration folders, deferred by the user:** the normal
  settings UI does not write custom user definitions there. Historical contents
  are generated messaging files, explicit developer imports or manual/external
  changes. Generated messaging files and native plugins are now archived as part
  of the upstream retirement. Original files remain
  preserved; no speculative importer, startup block or migration UI is in scope.
- Real Electron/native-engine browser and isolated review fixtures pass. Paid
  cross-provider legal-task regression, live Office acceptance and Linux/Windows
  packaged acceptance remain required. The native browser API is experimental;
  its inherited presentation/transfer limits and LegalWork extensions are
  documented in [browser coverage](opencode-v2-browser.md).
- Managed native commands pass blocked-host-escape, complete-output, original
  child-identity, exact permission, attachment and Stop fixtures. Actual rebuilt
  macOS ARM64 sandbox tests cover document libraries, concurrency, network
  permissions, file conflicts and cancellation. This is not a Linux/Windows
  desktop acceptance result. Coding worktree startup is excluded by product
  scope, rather than an unresolved command execution path.
- Native history migration, immutable source provenance and compatible Undo have
  released-engine evidence. Unprovable historical file contents and incompatible
  staged Undo remain explicitly unresolved for affected installations.
- The complete server test set was exercised in fresh-process file batches:
  the unsharded Bun 1.3.14 runner terminates with macOS `EXC_GUARD` descriptor-close
  crash reports before its summary. A zero shell exit without a summary is not a
  passing suite. All 353 discovered files were covered; focused repairs close
  24 of the 26 initial failures. The remaining classifications are this engine
  readiness race and a baseline-reproduced wiki watcher failure. Retain the
  original counts, opt-in/platform skips, reruns and crash evidence.
- The full app suite has three unchanged Lexical initialization-cycle failures
  also reproduced at the frozen v1 base. They are not weakened or skipped.
- Any unavoidable upstream limit or unpriced benchmark capability must be
  disclosed with its location and consequence. No model-quality or cost-saving
  claim follows from synthetic wire fixtures alone.

## Known migration risks

- v1 plugin implementations do not run in v2; directory entrypoints and stable
  native plugin IDs are required. Arbitrary external executable plugins need
  their own compatibility check.
- Legacy history import can replace non-data attachment URLs with unavailable
  markers and skip malformed rows. Preserve attachments, backups and migration
  counts before replacing existing history.
- `OPENCODE_CONFIG_DIR` is not firm-policy enforcement in v2. Use native policies
  and execution-time LegalWork checks; retain sandbox/network/scope guarantees.
- Native events are live-only at the general subscription surface; reconnect and
  authoritative reconciliation remain application responsibilities.
  SDK limits include a 16 MiB SSE event and 4,096 queued subscriber events. Oversized
  or disconnected streams must recover via full HTTP snapshots; no agent output
  truncation is introduced to fit those transport limits.
- Native v2 has a durable message queue. Missing arbitrary payload editing,
  reordering or persistent whole-queue pause is not absence of a queue.
- Browser RPC remains experimental. Its native transfer/attachment limits must
  not silently reduce LegalWork's existing document and browser capabilities.
- Existing manual TerminalDock uses Electron/node-pty, independently of OpenCode
  PTY; engine terminal transport is not a desktop migration requirement.

## Primary upstream references

- [Supported integration approaches](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/index.mdx)
- [Network client](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/client/index.mdx)
- [Native plugins](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/plugins/index.mdx)
- [Plugin migration](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/plugins/migrate-v1.mdx)
- [Session and queue contract](https://github.com/anomalyco/opencode/blob/v2.1.4/specs/v2/session.md)
- [Browser contract](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin-browser/src/rpc.ts)
- [Configuration migration](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/migrate-v1.mdx)

## Native project automation admission proof

The earlier claim that an external plugin could not guard native MCP startup
was an implementation mistake in the migration probe. Native domain transforms
are synchronous; an async transform returned a Promise the host did not await.
The corrected guard synchronously reads the private canonical-folder approval
registry and fails closed. The native MCP configuration loader remains enabled;
the proposed duplicate connector configuration adapter was removed.

`native-project-admission.released.test.ts` verifies the released 2.1.4 binary:
unapproved project MCP commands never start, unknown plugin modules never
import, project directives cannot remove the mandatory guard, native file tools
are denied, and direct authenticated file writes do not invoke formatters.
The positive control approves the identical project configuration and reloads
the idle fixture: the same MCP command then starts. The native MCP loader is
explicitly checked as active. This is 16 assertions with no external model call.

Reproduce with `LEGALWORK_TEST_OPENCODE_BIN=/path/to/released/opencode pnpm
--filter legalwork-server exec bun test src/native-project-admission.released.test.ts`.
HTTP admission alone does not cover internally created locations or restart
recovery; those require destination guards and startup preflight as well.
Native plugin policy grants npm package identities rather than exact versions;
new package names and external paths require review, while an approved package's
version changes follow native semantics.
