# MCP readiness in OpenCode 2.1.4

Status: the approved source correction passes official-graph validation and the compiled macOS candidate passes the actual direct/Code Mode reconnect regression. The shipped official binary and pins have not been replaced. The later approved `.3` candidate preserves this MCP patch and has actual engine/Electron startup and native plugin/tool execution on Mac ARM64, Linux x64 and Windows x64. The latest normal final7 packages pass build/security on all three. The precise reconnect-fixture platform receipts are being audited separately; ordinary startup does not substitute for that test. Remaining real-agent regression and final distribution adoption stay open. See [current capability status](opencode-v2-capability-status.md).

## Released behavior

Evidence scope: this is a reproduced readiness race in our released-engine
fixture, not an upstream-maintainer-confirmed issue or an observed customer
incident. The exact reproduced sequence is: authenticate both connectors and
successfully execute their tools; reload the native location while the connector
endpoint is offline; restore the endpoint; reconnect through status refresh or
LegalWork prompt admission; immediately start a new task. Both connection
statuses become `connected`, but that task's first model request lacks both tool
definitions and executes neither. Credentials and authored configuration bytes
remain unchanged. A fresh rerun on 2026-10-24 reproduces both recovery paths.

An additional isolation phase now bypasses LegalWork admission and does not
reload the location: disconnect both connectors through the native client, await
observable removal of their tools, reconnect through the same native client,
check both native statuses are `connected`, and immediately create/prompt a
native session. Both tool definitions are absent and neither tool executes.
After the observer confirms actual native registry readiness, another otherwise
identical native task receives and executes both tools. No fixed sleep, prompt
retry, configuration change or new sign-in is used. This positive/negative pair
narrows the cause to catalog readiness rather than model choice, credentials,
LegalWork admission or the location-reload operation. The released regression
still fails deliberately on the three immediate-admission scenarios; the initial
and registry-ready controls pass. Its assertion remains intact.

The fixture uses actual released OpenCode 2.1.4 and real local OAuth/MCP
transports with a deterministic loopback model. It now executes both the direct
native tool path and Code Mode without paid
inference. In each mode, the initial and observable-registry-ready controls
receive and execute both connector tools. The immediate native reconnect,
status-refresh recovery and prompt-admission recovery cases all lack both tools
and execute neither. The unchanged assertions fail against the official binary
(two expected failing tests, 26 assertions, 6.02 seconds; evidence:
`/tmp/legalwork-mcp-both-modes-official-control.txt`). The test does not establish
a failure rate for ordinary transient disconnects, all startups, or live
production connectors.

After reconnecting an authenticated MCP server, `mcp.connect()` completes and `mcp.list()` reports `connected` before the native model tool registry incorporates that server's tools. An immediate next prompt can therefore omit the connector. The regression fixture retains this assertion and currently fails against the unmodified release: `apps/server/src/mcp.network-recovery.e2e.test.ts`.

This is a registration race, rather than a reason to prompt the user to sign in again. The engine still owns its OAuth identity, PKCE, tokens, refresh, transport, and tool calls.

The same fixture exposed a separate LegalWork admission gap: after an offline rebuild, sending immediately without first refreshing connector status did not attempt transport recovery. This is repaired in `workspace-mcp-recovery.ts`: typed native prompt/command admissions and the public scoped proxy now run the same recovery before entering lifecycle admission. The released fixture confirms both transports are connected after sending without polling. Its first-turn tool capability assertion still fails, isolating the remaining upstream registry race. Saved credentials and authored config bytes remain unchanged.

The admission repair retains native handshake ownership, the existing recovery cooldown and status-read deadline, connector mutation/OAuth locks, authored configuration order, tool-disable and firm gates. It resolves the saved session location and skips isolated review/LegalMemory sessions. Cancellation stops waiting and prevents prompt admission; a handshake already started continues holding its connector lock until the engine settles. It does not retry user tools or replay a prompt. Sixteen focused tests cover these contracts, including the durable queue and direct proxy, without model calls.

The exact upstream sequence is:

1. [`mcp/index.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/mcp/index.ts#L479) stores the connected server's already discovered tools, publishes `ToolsChanged`, then returns.
2. [`tool/mcp.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/mcp.ts#L118) debounces those events for 100 ms before copying the current MCP catalog into the native tool registry.
3. [`session/context.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/context.ts#L132) already calls `McpTool.flush` immediately before taking the immutable tool snapshot. However, released `flush` waits only for initial registration, ignoring later reconciliations.
4. The snapshot fixes both directly exposed tools and the Code Mode catalog for that job. Subsequent background reconciliation cannot repair an already admitted job's missing catalog.

## Supported adapter feasibility

There is no reliable public readiness barrier in this release:

- [`McpEvent.ToolsChanged`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/mcp-event.ts#L6) includes only the server name. It contains no authoritative tool names, catalog generation, or reconciliation completion marker.
- [`MCPDomain`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/mcp.ts) exposes server configuration transforms, server status listing, and reload. It does not expose the MCP tool catalog.
- [`ToolDomain`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/effect/tool.ts) exposes the effective registry and transforms. A reload or transform callback does not identify which MCP generation it contains. An unrelated reload can run before the native debounced reconciliation.
- The public native client exposes connection operations and server status, but no MCP `tools/list` or readiness operation. A client-hosted MCP attachment exports client-owned tools to OpenCode; it is not a read API for existing server-owned tools.

Waiting for a nonempty registry would reject legitimate empty connectors, miss removals, and confuse tools from unrelated reloads. Waiting 100 ms or requiring two matching polls is a timing heuristic. Private Effect services, duplicate MCP clients, or a new gateway would change the approved ownership boundary.

## Upstream correction under validation

[`patches/opencode-2.1.4-mcp-tool-readiness.patch`](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-tool-readiness.patch) changes only the native MCP tool adapter:

- Keep the existing eager initial registration and debounced background updates.
- Make the existing pre-snapshot `flush` also reconcile the authoritative, already cached MCP catalog under the adapter's existing lock.
- Avoid invalidating the registry when that catalog is unchanged. Empty catalogs and removals are real changes, without special casing.
- Commit the captured catalog and local registry invalidation together. Waiting for the lock/catalog remains cancellable; the short local commit cannot be interrupted halfway.
- Propagate an initial registration failure rather than silently taking an incomplete snapshot.

The authoritative read is local: [`Mcp.tools()`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/mcp/index.ts#L795) reads cached connected entries. This patch does not add an MCP network request, new timeout, output cap, or second owner of credentials or tool execution. Concurrent changes after that read belong to the next catalog revision; the ordinary background consumer remains active.

The patch includes upstream regression cases for direct tools, Code Mode, an unrelated reload, replacement/removal, an empty catalog, immutable earlier snapshots, and cancellation while catalog reconciliation is held. These exercise `flush` without advancing the debounce clock. The existing catalog-read-count test accounts for the extra pre-snapshot read while preserving its burst coalescing assertion.

The exact source is release tag `v2.1.4`, commit
`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`. The patch changes only one production module,
`packages/core/src/tool/mcp.ts`, plus its existing `packages/core/test/mcp.test.ts`
and a three-line isolated fixture adjustment in
`packages/core/test/session-generate.test.ts`. The latter already supplies a fake
tool registry; it now explicitly replaces MCP bootstrap as well, keeping its
existing generation assertions and deliberately failing unused registry methods.
Its SHA-256 is `2780a863a420cc52b19274990f46f5568baf56d6dd1918f8a9f94bb25088744b`.

Actual upstream tests ran with the release-pinned Bun 1.4.4 runtime, verified
against the npm package's SHA-512 and the executable's SHA-256. The user approved
using Bun install only in this isolated upstream build; LegalWork itself continues
using pnpm. The original upstream manifest, dependency patch files and `bun.lock`
remain byte-identical. The lock SHA-256 is
`47359ba0731b02d14b9a93a6b71b2db104cf9b9716ab0b6371fe96f02c6d71b2`.

The final dependency verification ran `bun install --frozen-lockfile
--ignore-scripts --os='*' --cpu='*' --libc='*'` and reported no changes. All 2,564
installed registry-package instances match official locked identities; there are
zero unexpected versions or manifest-version mismatches. The two Git/URL
packages retain their original locked entries. Native PTY, OpenTUI, parcel and
FFF dependencies are present for all shipped targets, including GNU and musl.
Unchanged upstream stale patch declarations are recorded in the receipt.

The test runner supplies isolated HOME/XDG/temp directories and filters inherited
provider credentials; no paid model calls were used. Final official-graph results:

- The MCP suite plus adjacent Code Mode, catalog, instructions, state and session
  request/generation-hook suites passed **151 tests across ten files, 667 assertions**.
- The seven readiness/coalescing cases passed **70 executions** with ten repeats
  and randomized order (seed `241026`), without advancing the debounce clock in
  the immediate-admission cases.
- An original-source negative control retained the new tests and restored the
  unmodified production module. All three selected cases fail: an immediate
  direct tool is absent, its Code Mode equivalent is absent, and an initial
  registration failure is swallowed. The patched source was restored.
- The full Core suite completed **6,807 tests across 272 files: 6,757 passed,
  43 inherited skips, seven failures, zero import errors**. Every failure name
  exactly matches the same-graph unmodified-source control: seven shell cases
  on this host's Bash 3.2.57. None were skipped or weakened.
- Canonical Core Bun and native TypeScript checks pass. The canonical repository
  `bun run check` passes all **34 tasks**, with zero lint errors. Its 1,225
  upstream warnings occur outside the three changed files; focused lint and
  formatting checks report zero warnings or errors.

The new coverage executes direct and Code Mode tools, exercises multiple servers
and notification bursts, additions/replacement/removal/empty catalogs, equal
catalog cache identity, unrelated registry reloads, later plugin transforms,
permission visibility and denied execution, cancellation while waiting for the
lock and during the catalog read, initial failure, and immutable earlier
snapshots. Existing real MCP transport tests remain intact. Equal catalogs keep
cached definitions while execution dynamically resolves the current connection
through `Mcp.callTool`; the adapter never retains an old client connection.

The short uninterruptible commit replays synchronous registry transforms and local
error logging. It contains no asynchronous plugin hook, connector handshake or
credential operation. A genuinely later concurrent catalog revision is handled by
the existing background consumer; this barrier does not promise that a remote
service stays online or wait for a service that is still connecting.

The immutable [verification receipt](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-tool-readiness.receipt.json)
records source, patch, lock, runtime, compiler, full dependency identities,
commands, log hashes, results and caveats. Its SHA-256 is
`90e271ea78663e147ab9be2731e3b120f89a762e54785e84342bd63f1a275c50`.
Earlier pnpm-converted provisional receipts are preserved separately; their
transitive dependency drift is not used as final validation.

The patch has not been accepted upstream. The separately identified macOS ARM64
candidate `2.1.4-legalwork.mcp-ready.1` compiled with the full native web UI,
upstream artifact verification and local ad-hoc signing. Its binary SHA-256 is
`0f6650351d7677ea083f2abe44b3f9673d3af330a4aa56f018717d48febec311`;
provenance SHA-256 is
`2698487bccee1b62d35890b62c261ae6101864f56b871083e5c09f4cc0d83823`.
The parent independently verified its provenance, source receipt, binary and
license before executing the unchanged network assertions. Both modes pass:
**two tests, 26 assertions, 6.07 seconds**, with no paid calls; log
`/tmp/legalwork-mcp-both-modes-patched-candidate.txt`. This closes the actual
reconnect defect gate, not the surrounding migration gates. The candidate's
distinct channel exposed a separate service-file naming mismatch under review;
authentication/version/PID checks are not relaxed. The official release binary
and pins remain preserved. macOS results do not establish Linux/Windows runtime
acceptance, notarization, paid model quality or byte-for-byte rebuild identity.

Before adoption, validation must cover immediate first-turn direct tools and Code Mode after reconnect, an empty server, dynamic addition and removal, bursts from multiple servers, an unrelated plugin reload, permission filtering, preserved custom tool transforms, cancellation while reconciliation is held, and unchanged OAuth/config bytes. The existing released-engine network fixture supplies the end-to-end regression.

## Approved validation path

Using the unmodified release retains the proven first-turn race. The approved path is a temporary source patch with a reproducible build and packaged validation. Pin the exact upstream source commit, reviewed patch, frozen dependency lock and build runtime, and record the resulting target binary hash under a distinct LegalWork candidate identity. Preserve the official release pins and binary until the candidate passes its acceptance checks. Return to a validated official release when it contains an equivalent correction. No private connector adapter, duplicate client or blind delay is introduced.
