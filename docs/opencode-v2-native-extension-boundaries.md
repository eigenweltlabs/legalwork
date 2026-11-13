# Native command and worktree extension boundaries

Source review of pinned released OpenCode 2.1.4, followed by released-engine regression fixtures. No paid inference was used for these checks.

## Explicit command delegation to primary agents

The initial `legalwork-commands.ts` prototype cloned a primary agent under `legalwork-command-<originalID>` so the native subagent executor accepted it. The audit found that copying its system/model/permissions still changed identity:

- The native subagent permission uses the selected agent ID as its resource. A saved deny/ask for the original target does not automatically describe the new alias.
- Scheduled project/all tools and the UI-control denial check exact agent IDs. A clone may lose allowed scheduled tools or fail to receive the intended role guard.
- The review worker predicate requires exact `document-extractor` plus an actual server-issued worker claim. A renamed clone fails that isolation test and can receive ordinary app context. The child created by a command has no review inference claim, so it must never be presented as a genuine claimed worker merely by copying an agent definition.
- The desktop browser guard also uses exact scheduled/review identities, with metadata as an additional review signal.

The implementation now uses one managed **agent transform that keeps exact identity**, changing only `mode: primary` to `mode: all` for primary agents explicitly referenced by configured `subagent`/`subtask` commands. An unqualified delegated command can target whichever primary agent the current session uses, so its presence requires those possible primaries to be eligible. It preserves `id`, visibility, system, model and all permissions. Reload recomputes the transform rather than accumulating per-invocation aliases.

This keeps existing resource policies and role guards intact without an alias registry spread across server/renderer/desktop. The tradeoff is explicit: visible converted primaries are also available through normal native subagent selection. It preserves v1's ability to explicitly target a primary, but changes the effective native catalog from a strict primary-only interpretation. Do not silently suppress this consequence.

The released command fixture now verifies original `build` child identity, absence of aliases, exact-original-ID deny/ask/reject and wildcard denial, full output, attachments and Stop cancellation. Scheduling/review suites separately cover role guards. Additional acceptance still includes command-definition reload and restart. The rebuilt packaged macOS ARM64 sandbox has separately passed actual document-processing, network-permission, concurrency, cancellation and file-conflict tests; a mocked command transport alone does not prove that boundary.

## Worktree startup command bypasses shell hooks

Pinned [`packages/core/src/worktree.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/worktree.ts) performs:

1. Resolve the project and registered strategy.
2. Run strategy `create`, then record the worktree inventory.
3. Read persisted `Project.commands.start` and execute it through `AppProcess.run(ChildProcess.make(...))` in the new directory.

The startup execution is after the strategy and outside `ctx.shell.hook`. The public [`WorktreeDomain`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/worktree.ts) exposes a transform to add create/remove/list strategies; there is no startup-command callback. The public plugin Context has no project or process hook/domain. A custom strategy therefore cannot replace that final execution. This is a source-confirmed boundary, not a newly executed exploit fixture.

`Project.update` publicly supports `commands.start`, so private SQL is unnecessary. Temporarily clearing it around create and restoring afterward would race with native/internal/direct callers and could lose edits after a crash. It is not a safe preservation strategy.

The legal-product decision resolves this boundary: LegalWork excludes Git worktree creation/list/removal from agent tools and the exposed engine API. The native product-scope plugin also rejects direct internal worktree strategy calls before the startup script can run. The released fixture `native-worktree-boundary.released.test.ts` checks the same unsafe authored startup script both with and without the guard: native creation executes it outside the shell hook; LegalWork creation is rejected before either the script or shell marker appears. Existing repository files, document comparison, file history and Undo remain available.

No sandboxed Git-worktree lifecycle is needed for the legal product. The following alternatives document the upstream integration boundary rather than outstanding LegalWork decisions:

- Treat reviewed startup scripts as **trusted project automation**, equivalent to other explicitly approved executable project configuration, and clearly state they execute outside the agent shell sandbox. The canonical trust/plugin review and every public/native create path must enforce that policy. Project command edits need the same ownership/approval meaning. This must be a deliberate policy decision, not an implied exemption.
- If all startup commands must use the LegalWork sandbox, an app-owned lifecycle must durably transfer startup ownership through the public project API, run it through the normal sandbox executor, and guard all create entry points against double execution or bypass. That is a larger adapter with crash/restart and project-edit reconciliation requirements. An upstream pre-start/execute hook would be a cleaner supported extension; whole-engine OS containment could also enforce the boundary but has broad runtime implications.

Do not silently clear or ignore startup commands, claim a strategy transform intercepts them, or use private database writes. The released public API currently has no narrow hook that preserves the exact native lifecycle while replacing only startup execution.

Pinned references: [native subagent executor](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/plugin/subagent.ts), [agent editor](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/agent.ts), [public plugin Context](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/plugin.ts), [public project update schema](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/project.ts).


## Code Mode data and computation boundaries

Pinned 2.1.4 supplies deep host JSON through `Data.fromJson`; its 32-level
restriction applies when values leave the interpreter or are stringified.
Zero-paid checks using the compiled engine and actual remote MCP confirm that
an original 50-level result remains traversable to its exact leaf, while
returning the whole value or forwarding it to another tool fails visibly.
Native per-connector `codemode: false` delivers that complete original text in
the next provider request. This offers a supported direct route at a context
cost; it is not automatic fallback or a reason to disable Code Mode globally.
App settings exposure and real-model behavior remain distinct checks.

Upstream also guards strings constructed by builtins/operators at 16,777,216
UTF-16 code units, constructed arrays at ten million entries and pending
promises at 10,000. These are native resource guards, not new LegalWork caps.
A compiled native first-party digest test separately processes an incoming
18,874,406-byte tool value without source echo in any provider request. The
new digest tool uses native SHA-256/384/512 on exact UTF-8 or canonical base64,
ordinary permissions and complete tracing, without file/network I/O or a data
size cap. Pure Code Mode bulk hashing is materially slow in the real benchmark;
fixed general guidance now directs checksums and other heavy computation to
native capabilities. This adds no engine patch or dependency. The same real
model task still requires a fresh final-package retest.

Private full provenance is retained under
`legalwork-codemode-data-boundaries-20261026` and
`legalwork-codemode-digest-diagnostic-20261026`; synthetic-provider integration
checks do not establish real-agent behavior. The separate native inline-image
resend budget (25MiB trigger, 15MiB target) now has exact stored-image
retrieval proof after default compaction and actual aggregate eviction. Native ingestion normalizes image dimensions
and encoded size before storage. Retaining stored history alone does not prove
the agent can retrieve that stored version or see every image simultaneously.
A narrow permission-controlled history-image adapter passes compiled checks;
it does not recover pixels discarded before storage. Pinned v1 already used
the same default2,000×2,000 /5MiB encoded normalization for user images; that
user-upload default is inherited. Subsequent pinned-source comparison found
that v1 completed-tool attachments were forwarded unchanged, whereas v2
normalizes inline tool images before saving them. This newly affects tool-result
fidelity. Separate original files can preserve source pixels, but an ephemeral
Office preview need not have one. The history adapter alone does not close
that gap. A supported public Effect hook plus private original store and native
list/crop/export tools is approved and being implemented. It retains exact
pre-normalization bytes, requires actual persisted tool provenance and live chat
authority, and cleans up explicit chat deletion. No image-policy change or new
engine patch is adopted. Originals become available after the outer tool call
commits, so capture and crop cannot occur in the same running Code Mode batch.
Metadata is paged at 100 records with unlimited continuation, without a total
retention/image/export limit. Crops run in a separate cancellable instance of
the existing Node runtime using existing physical image dependencies. Rectangle
coordinates follow decoded pixels; JPEG EXIF is applied by the decoder, while
PNG/WebP rotation metadata is not universally handled. Unsupported formats
remain exportable byte-for-byte. This adapter's acceptance remains pending.

Original deletion is scoped to the actual managed history database identity,
with a separate current connection capability invalidated at restart. Manual
URLs/authentication are never treated as a stable engine identity. Automatic
native deletion/404 cleanup affects only the verified managed namespace;
ordinary app deletion verifies exact persisted UUIDs before removing manual
records. Durable exact-reference deletion intents can be retried without native
access. Ambiguous manual-engine disappearance preserves originals. This prevents
another engine's same-session-ID404 or deletion event from purging unrelated data.


## Native response-token defaults

Pinned native1.18.29 normally chose the lesser of the catalog output limit and
32,000 tokens, falling back to32,000 when unspecified. Native2.1.4 uses the
catalog limit with a256,000-token maximum, retains the32,000 fallback, and fits
the primary/compaction response allowance to available context. Its fit includes
a15% margin on estimated input and a1,024-token floor. Title/generate requests
retain provider defaults. Public context hooks may change or remove the default;
configured model/agent settings and final provider serialization still need to
be checked on the actual wire. These are upstream defaults, not new LegalWork
caps. The larger native allowance can permit longer answers and higher cost;
LegalWork adds no lower cap to conceal that tradeoff.

Source comparison: [v1 provider transform](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/transform.ts),
[v2 request preparation](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/model-request.ts).

## Finite model selections remain a parked migration limitation

The pinned released engine has no native per-model `model.use` policy action.
A legacy `whitelist` placed inside a native `providers` definition is ignored:
the native model list still contains the excluded model, and a stateless
`generate.text` call can use it. A model transform plus a session request hook
also does not cover every native generation entry point. These mechanisms must
not be presented as universal firm-policy enforcement.

LegalWork therefore refuses to upgrade an existing finite legacy provider
allowlist or publish a broadened replacement configuration. It preserves the
exact original settings and private upgrade backup, continues to refuse a blank
replacement write, and retains that behavior after reopening storage and
restarting the actual engine. Firm catalog selections with a finite model list
likewise remain held. This is a preserved restriction with an explicit recovery
requirement, not support for executing those configurations on v2. The user
parked the broader model-policy implementation; no model-policy engine or SDK
schema patch is included.

`managed-model-filters.released.test.ts` records both boundaries with the real
released engine and a synthetic local provider: the standalone native negative
control demonstrates that forwarding the unsupported field is unsafe; the app
upgrade/publication checks retain the original restriction and make zero
provider calls. These are configuration-boundary tests, not paid legal-quality
or full-platform acceptance evidence.

## Native configuration and permission storage after LW-287/LW-291

LegalWork's ordinary producers and settings APIs use the pinned native v2
configuration schema. Startup explicitly imports older records once into
`native_runtime_configs`; normal reads and writes do not translate or consult
`runtime_opencode_configs`. Exact originals and upgrade notices remain private.
An independent profile marker, current scope inventory and atomic writes
distinguish a new project from missing established settings. Missing or invalid
expected data blocks the affected operation rather than resetting restrictions.
The same profile marker records completion of connector and historical-chat
imports so deleting their current files cannot silently repeat an old import.

OpenCode loads the generated global and hidden project documents through its
native configuration loader. Identical shared declarations may use the central
library; project permission rules are never promoted into that shared layer.
Generated documents reference private values rather than copying credentials
into the project. Exact app-owned automation is admitted automatically; authored
automation retains the project approval boundary.

Historical session policies remain on their original session IDs, with native
restore receipts preventing later explicit edits from being overwritten on
restart. New remembered approvals belong to the selected LegalWork project;
temporary approvals stay temporary. Sandbox approvals persist through the
app-owned project store and are invalidated when their effective restrictions
change. Existing stricter session, agent and firm denials remain effective.

The separate legacy engine Saved-approval migration helper is tested but is not
activated during startup. Unlike session policies, those old records can lack
both an originating session ID and a unique LegalWork project. Resolution of
that ownership ambiguity is still an open migration decision; retaining the
original history archive alone does not prove these approvals were carried over.
