# Real LegalWork regression benchmark

This harness runs the actual Electron application and its actual managed OpenCode engine. Tasks enter through the visible composer using LegalWork's existing authenticated UI control bridge. It preserves ordinary agent selection, tools and permissions. Synthetic HTTP/MCP fixtures test transport integration; they are never presented as live-account/provider results.

The initial suite has saved-source extraction and a live Word negotiation with saved, reviewable redlines. A pinned Harvey suite adds ten legal drafting, research, review and analysis tasks across ten practice areas. The leniency-comparison case is explicitly **non-blind**: its grading guide already ships as a LegalWork feature, and the user elected to retain the case with that label. Suite generation, run results, judging and comparisons retain this classification. **This is an extensible benchmark under construction, not evidence that the v2 migration is complete.** Every suite records implemented and pending coverage, and the comparator refuses a complete parity claim while coverage is pending.

## Reproducible source and isolation

Use a dedicated v1 checkout at the latest fetched dev commit. Keep it frozen while v2 is implemented elsewhere; Vite HMR otherwise changes the running baseline. The harness can live in another checkout via `--repo`.

```sh
pnpm install --frozen-lockfile
node /absolute/path/to/migration/scripts/benchmarks/cli.mjs init --root /private/benchmark --repo /absolute/path/to/v1-baseline
node /absolute/path/to/migration/scripts/benchmarks/launch.mjs --root /private/benchmark --repo /absolute/path/to/v1-baseline
```

The launcher prepares the real server, sidecars, plugin SDK and Electron native dependencies. `--prepared` is an explicit operator assertion that these are already freshly prepared; build identities are still recorded. It launches the unchanged real main module through a small benchmark entry that sets Electron's discovery home/documents to private fixture directories. **This does not make current v1 skill discovery hermetic:** LegalWork can still inject host `os.homedir()` skill paths into the managed config. Preflight records those locations/content hashes, and paid runs refuse them unless the suite explicitly chooses `catalogPolicy: "record-and-lock-observed"`. That policy preserves the user's actual setup and checks the catalog before/after every task and at completion. A clean OS-user/VM installation remains a separate required profile. A private empty environment store and removal of inherited provider credentials prevent bypassing the capture gateway. Microsoft Office add-in sideloading is disabled for this instance; the in-app Office editors remain real. Testing the external Microsoft application/add-in remains a separate required scenario.

`init`, `preflight`, public fixture download and `smoke` make no model calls. Preflight may create an empty chat to mount the actual composer. Source HEAD, fetched origin/dev, branch, working changes, compiled server identity, engine version, platform and UI surfaces are recorded. It refuses source checkouts that do not include the fetched dev HEAD. Fetch before baseline creation; a local remote-tracking ref is not proof of an online freshness check.

```sh
node /absolute/path/to/migration/scripts/benchmarks/cli.mjs preflight --root /private/benchmark --repo /absolute/path/to/v1-baseline --expected-base <verified-dev-sha>
node /absolute/path/to/migration/scripts/benchmarks/smoke.mjs --root /private/benchmark --repo /absolute/path/to/v1-baseline --expected-base <verified-dev-sha>
node /absolute/path/to/migration/scripts/benchmarks/prepare-harvey.mjs --root /private/benchmark
```

The smoke opens an actual Word document, reads its live draft and rendered page count, and navigates the actual built-in browser to a synthetic page. It verifies readiness and integration contracts, not model behavior. Harvey downloads are pinned to `81d6a31b22d7c9f661cda4770cffcc12a5735dc2`; each file's Git blob SHA and SHA256 are verified and retained. Rubric answers never enter task-agent prompts. A sample selection is coverage design, not a benchmark task count ceiling; supply another pinned selection to expand it.

Prompt separation does not provide filesystem isolation. An observed v1 Harvey
run used the host shell to read earlier benchmark answers/rubrics; that result
was stopped and invalidated. Further paid runs require a fresh guest filesystem
per arm, with controller suites, expectations, judge data, previous outputs and
test-source code inaccessible to the agent. The controller drives the actual
guest app over scoped forwarded services. Preserve the full selected skill
library and product tools rather than limiting agent capabilities to hide the
leak. Copy only declared source inputs into each fresh task workspace.

Prepare the large chronological-amendment scenario once on the controller:

```sh
node scripts/benchmarks/prepare-long-source.mjs --output /private/new-long-source-fixture
```

This creates a source larger than 1 MiB and a suite checking the controlling
notice period, superseded terms, exact quotation/document/clause, end-record
and unchanged source bytes. Reuse that frozen suite in both arms. Its only
agent input is `source-only/agreement-archive.txt`; keep `suite.json`, provenance
and generator code on the controller. Preparation and assertion tests make no
model calls; real-agent execution remains a separate gate.

## Paid runs and the EUR 100 aggregate guard

See [budget.md](budget.md) for the complete cost contract and disclosed pricing restrictions. The private proxy configuration contains `baseURL`, `apiKey`, `models`, `localToken`, one shared `budgetLedgerPath`, and a fresh `budgetAuditPath`. After the separately reviewed EUR250 authorization event is applied, it also pins `budgetCoveragePath` and `budgetCoverageSha256` for the root-reviewed per-run migration coverage rationale; EUR100 remains the planning/notification target. Keep it outside the repository with owner-only permissions. The actual provider credential exists only in the proxy. The application receives only the proxy's local token and `/v1` base URL. All normal, subagent, title, summary, compaction and judge requests must use this route. The same ledger must be reused across profiles, runs and machines that share the allowance; creating a new ledger is not a reset authorization.

The proxy requires the actual reservation guard; metadata that merely claims a limit is insufficient. It reserves intact natural model capacity before every network attempt. Missing/failed/cancelled usage retains the reservation. Unknown billable routes/modalities are rejected and reported, without trimming requests. Native Anthropic `/messages` and Responses are captured by protocol tests but are not admitted for paid use until their pricing contracts are audited. This is a limitation of the temporary budget guard, not a proposed production capability restriction. Ordinary function/MCP tools, complete output and concurrency remain unchanged.

```sh
node /absolute/path/to/migration/scripts/benchmarks/cli.mjs proxy --root /private/benchmark --config /private/migration-gateway.json
node /absolute/path/to/migration/scripts/benchmarks/setup-provider.mjs --root /private/benchmark --repo /absolute/path/to/v1-baseline
node /absolute/path/to/migration/scripts/benchmarks/cli.mjs run --root /private/benchmark --repo /absolute/path/to/v1-baseline --suite /private/benchmark/harvey-suite.json --expected-base <verified-dev-sha>
```

Pin provider, gateway alias, actual backend model, variant and cache conditions in the suite. `setup-provider` uses the frozen application's production manifest mapper, preserving its model options/natural limits; only base URL and credential point to the guarded proxy. Select the intended model/behavior through the actual UI before running. The driver waits for the real Send action to become enabled; it never bypasses a disabled control. Actual deployments are mapped from audited `x-litellm-model-id`, not assumed from a friendly alias. Older Flash fallbacks, unknown deployments or a different UI model produce inconclusive results. No routing or retry policy is silently changed to force a pass.

## Evidence and evaluation

Each run preserves exact application-level request bytes and streamed response bytes; credential-free diagnostic headers; first-byte and total latency; model/settings/tool-catalog/system-prefix identities; complete usage including cache and reasoning fields when exposed; gateway reported cost separately from conservative budget accounting; raw engine events with byte-offset/timing indexes; complete root and child session messages; tool arguments/results/errors; UI states; full deliverables and full-text/source-XML extraction. Source and artifacts are owner-only files in private directories. Raw traces may contain opaque signed state and legal text: do not publish them. Provider-internal hidden reasoning and unreported billing fields are unavailable and must remain marked missing.

Tool-trace contract 2 separates `completeAsExposed` from `fullRawReturnCoverage`. Successful calls require their complete private `execute.after` value. Pinned V1.18.29 (`16747470f976aca3d362ad730bcd3fe82ecc2c9a`) does not guarantee an after hook for thrown, denied or cancelled executions. An exact owned before record plus the full API-reported terminal error/state/input can therefore prove that failure's exposed lifecycle while its raw return remains unavailable. The failure stage, unexposed stack and duration stay unknown; no after event or result is invented. V1 command subtasks preserve their source-backed `part.id` versus `callID` distinction, and an actual undefined after value stays unavailable. Native after requirements are unchanged. Missing successful values, running calls, absent before evidence, identity/status conflicts, and journal IO/hash/flush failures remain incomplete. Raw journal pending counts are retained and only exact qualifying failures are reconciled after the task settles. Other sessions are explicitly disclosed and excluded from the owned task scope. Older receipts are not reinterpreted in place.

The offline context report separates observed token/cost subtotals from complete totals. A complete total is `null` if any included request lacks that measurement; the report lists those request identities. Explicit measured zero remains zero. Cancelled requests with missing usage therefore cannot appear to consume nothing, and cache reads remain a separate provider-reported category rather than being added to input again. This reporting change does not modify engine requests or budget reservations.

The gateway may report billed EUR in `usage.cost` while omitting its cost header. Those are separate recorded sources; an absent header is not a zero bill. `analyze-context.mjs --root /private/benchmark --run /private/benchmark/runs/<run>` computes an offline context/cost summary from that run's exact captured request identities, including auxiliary requests. Omitting `--run` summarizes the entire trace directory and is labeled accordingly. Known cached-token sums and missing request fields remain separate. Serialized byte sizes are not mislabeled as section token counts.

All model requests are the authoritative total for costs/tokens, including background requests that do not belong to the root session. Root/subtree message summaries are labeled separately to prevent double counting. HTTP first-byte time includes provider/network and observer overhead; it is not a claim of model-only thinking time. Local capture adds disk/HTTP overhead consistently across arms. Preserve transport/runtime labels when comparing a future embedded host.

Prepare complete Harvey judge inputs without inference, then optionally judge through the same guarded proxy after paid-run approval:

```sh
node /absolute/path/to/migration/scripts/benchmarks/judge.mjs --run /private/run
node /absolute/path/to/migration/scripts/benchmarks/judge.mjs --run /private/run --root /private/benchmark --execute
node /absolute/path/to/migration/scripts/benchmarks/cli.mjs compare --baseline /private/baseline/result-judged.json --candidate /private/candidate/result-judged.json
```

Judging uses complete retained source documents, deliverables and rubrics; the frozen v1 benchmark's 80,000-character preview extractor is not used, and that cap has also been removed from the migrated server benchmark. New runs snapshot every input byte before prompt admission and verify its full tree hash before extraction. Older tasks require an explicitly labeled archive of verified pinned originals; this is never mislabeled as a pre-prompt agent-filesystem snapshot. Unsupported extraction fails explicitly. Source artifacts/XML remain authoritative for formatting, formulas and citations. No visual-quality claim follows from plain-text extraction. Judge output must contain exactly one unique known verdict per criterion; malformed output is retained and rejected without answer repair. Scores are stored separately from immutable task-run records. A gained rubric pass cannot hide another lost pass. Repeated matched trials, blind grading and source-backed legal checks are needed before making a reliability claim.

## Limits and unfinished coverage

| Setting or boundary | Location | Reason and consequence |
| --- | --- | --- |
| EUR100 planning target; reviewed EUR250 hard maximum | `budget-guard.mjs`, `budget-ceiling.mjs` | The existing EUR100 guard changes only through the exact-hash, backed-up reviewed authorization transaction. New250 runs require a pinned coverage rationale. A whole request is refused only when its complete reservation cannot fit the active hard maximum; no request is shrunk. |
| Fresh pricing audit | `budget-audit.mjs` | Audits current prices/deployments before paid mode; a stale audit stops new startup until refreshed. |
| 60s UI startup watchdog, 100ms readiness polling | `launch.mjs` | Configurable with `LEGALWORK_BENCH_UI_READY_TIMEOUT_MS`; bounds pre-inference UI startup only. |
| 30s composer readiness watchdog, 100ms polling | `electron-runner.mjs` preflight | Configurable `uiReadyTimeoutMs`; bounds mounting an empty chat before inference. |
| 30s provider reload readiness watchdog, 100ms polling | `setup-provider.mjs` | Configurable `--provider-ready-timeout-ms`; only waits for the configured model and guarded transport before inference. It never limits an agent task. |
| 1s agent status polling | CLI `--poll-ms` | Configurable observation frequency; does not constrain engine execution. |
| No default task deadline | CLI `--task-timeout-ms none` | An operator can set a watchdog; expiry explicitly cancels and fails the task while preserving full partial evidence. |
| Zero injected recovery attempts | `electron-runner.mjs` | Keeps observed agent behavior visible. Native provider/engine retries are captured and funded individually. |
| Loopback/synthetic profiles and model allowlist | Driver/proxy | Prevents running against personal accounts or unintended paid models; expand explicitly for an approved integration scenario. |
| Current paid protocol/modality pricing contract | Guard | Unsupported billable capabilities are listed as untested, not disabled in LegalWork production. |

No tool output, task response, event, document extraction or context size cap is introduced. Existing engine/model/tool limits still apply and appear in actual requests/results. The frozen v1 server benchmark uses automatic all-permission allowances, two cutoff-recovery prompts and capped extraction; this Electron driver uses normal policy, no injected recovery and full extraction. The migrated server benchmark retains explicit configurable unattended/recovery scenarios but removes capped extraction. New autonomous suites declare `interactionPolicy: {mode:"autonomous",expectedPermissions:[],expectedForms:[]}`. Any unexpected pending request in the actual session tree is retained, the owned session is stopped without approving/rejecting/answering it, and remaining tasks are held as `intervention-required`. Assisted denial/approval scenarios need their own exact declared UI replies; blanket allowance is never substituted.

The benchmark entry includes an owner-only loopback focus action that clicks the exact visible chat tab button. Opening a live document selects its pane, so the ordinary composer action is intentionally out of scope until its chat is focused. This driver action changes only UI focus; actual `documents.open`, `composer.set_text` and `composer.send` remain the product actions. Its request/result are captured. Task creation waits for a distinct real session route, using the existing UI readiness watchdog. The Vite renderer's actual source identity is mandatory; unused `apps/app/dist` is optional because this launcher does not serve it. Complete planned coverage and substantive assertions are listed in [the acceptance plan](../../docs/opencode-v2-acceptance-plan.md).

Pending scenarios are explicitly listed in each suite: live XLSX/PPTX; complete long-source retrieval; browser interaction/downloads; skills/workflows/resources; real MCP wire behavior and forms/media/OAuth; denials; subagents; queue/cancellation/restart; compaction/cache stability; scheduling; external Office add-ins; provider and packaged Windows/Linux matrix. The no-inference smoke and transport tests do not satisfy these model-driven gates.

## Harness checks

```sh
node --test scripts/benchmarks/evidence.test.mjs scripts/benchmarks/capture-proxy.test.mjs scripts/benchmarks/budget-guard.test.mjs
```

These tests verify retention, accounting and comparison mechanics with synthetic transports. Actual regression claims come only from separately recorded real Electron/engine/model runs.

Research: [Harvey public benchmark](https://github.com/harveyai/harvey-labs), [OpenCode v2 SDK architecture](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/sdk/index.mdx), [OpenCode v2 network client](https://github.com/anomalyco/opencode/blob/v2.1.4/services/www/src/docs/content/build/client/index.mdx). V2 event/endpoint adaptation must follow the selected public client contract; a v1 trace driver is not assumed v2-compatible.

## Native v2 evidence and read-only observation

`engine-evidence.mjs` deliberately separates released v1 and native v2 wire contracts. Native reads use `/api`, bracket-encoded `location[directory]`, flat typed history, all pages and live `event.data/location`. A v1 fallback is allowed only for an absent native-info endpoint, never authentication or protocol errors. Native compaction records contribute auxiliary usage; source message records remain intact. The model catalog is primed before dependent catalogs, because fresh v2 locations activate external plugins during model discovery. No prompt is injected to initialize a location.

Native public HTTP has no registered-tool-schema endpoint. For the isolated candidate, install the explicitly visible read-only observer before preflight:

```sh
node /absolute/path/to/migration/scripts/benchmarks/setup-observer.mjs --root /private/v2-candidate --repo /absolute/path/to/migration
```

This adds an absolute local plugin directory in a separate standard native authored config inside that private profile, preserving its JSONC and leaving LegalWork's generated selection file intact. It uses normal LegalWork project approval/reload APIs and approves only the previously authorized exact observer identity; other pending plugins stop setup. It registers only `legalwork-benchmark-observer/catalog` RPC: zero model tools, hooks, prompts, transforms or policy edits. Zod is bundled and the released engine supplies Effect, matching real plugin packaging. Its source/bundle/config hashes and the actual plugin inventory are retained. Full Effect JSON Schema definitions, standard JSON Schema and Zod input/output schemas are retained without simplification. These registered schema hashes are distinct from actual provider-wire schema hashes. The registry is location scoped; its public `ctx.tool.list()` has no agent/session selector. Session agent/permissions and actual request tools remain separate evidence. Skill/tool/plugin inventory changes within a run invalidate comparison; architecture/catalog changes between versions require an explicit reviewed comparison policy.

The observer has passed a zero-inference startup/catalog check against the actual released 2.1.4 executable. That is a host contract check, not an Electron or legal task parity result. `setup-provider.mjs` supports native candidate preparation through LegalWork's typed configuration API. It uses the current production manifest mapper and production `nativeProvider` conversion, preserving complete modalities, natural capacity, generation settings and variants; only the local capture proxy transport changes. It records the sanitized native model catalog after configuration and verifies its effective transport through host-only `GET /workspace/:id/benchmarks/observer/model-transport?modelID=...`. That route fixes the provider to `benchmark`, enforces project scope/trust, and returns only a domain-separated SHA256 fingerprint of private base URL and API key. The public model API remains sanitized; setup never needs plaintext secrets from it. Missing readiness/approval fails explicitly without inference. Setup itself admits no task and does not bypass the actual UI model selection or shared paid-run guard.

The native source/build manifest also hashes app/server/types source and the executable harness, including new untracked files, alongside compiled app/server/desktop trees. Raw SSE is retained without the public client's 16 MiB parser boundary; the native frontend separately reconciles complete HTTP history after a client stream reconnect. A dropped raw observer stream or malformed indexed event explicitly fails evidence completeness.

```sh
node --test scripts/benchmarks/engine-evidence.test.mjs scripts/benchmarks/catalog-observer.test.mjs
LEGALWORK_TEST_OPENCODE_BIN=/absolute/path/to/released/opencode node --test scripts/benchmarks/catalog-observer.test.mjs
```

The host test's 30s startup/catalog watchdog, 100ms catalog polling and 45s test-run watchdog apply to a credential-free startup test with zero admitted tasks. They do not constrain live agent execution or tool output. Source: [native client query serialization](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/client/src/promise/generated/client.ts), [tool schema conversion](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/runtime.ts), [native permission-filtered tool catalog](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool.ts), [local plugin loading](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/module.ts).

Wire model settings and request-role attribution are separate evidence. Matching all captured potential-main requests to the pinned backend/reasoning settings does not identify primary, title, or auxiliary roles. Those runs can retain legal-outcome evidence, while `controlledPerformance.state` stays `inconclusive-role-attribution`. A positive primary label requires an independently attributed primary request. The collector retains both native `x-opencode-session-id` and pinned V1 `x-session-id`/`x-session-affinity` header families; conflicting identities remain unknown. Earlier captures that omitted V1 diagnostic header names cannot recover those identities retrospectively. Original results remain unchanged; any corrected classification is a separate follow-up receipt.


For a separately declared permission scenario, `interactionPolicy.mode: "scripted-external-directory-decline"` requires empty initial permission/form sets, `outsideTaskFolder: "reject"`, and `otherRequests: "hold"`. The isolated packaged adapter uses the ordinary visible Deny button through X11, retaining the screenshot, controller OCR, exact unchanged request, click, and native rejection event. Only known owned-session `external_directory` requests outside that task folder qualify. Uncertain, multiple, unrelated or inside-folder requests hold; the harness never grants access or adds text hints. These runs are assisted permission scenarios and are not counted as autonomous success. The configured OCR confidence threshold prevents unsafe UI clicks; it does not limit model output or agent execution.

New run timing starts before preflight and records `preflightElapsedMs` plus full `elapsedMs`. Task send-to-terminal wall time, setup/staging, collection, and observed permission wait remain separately reported; permission wait stays included in task wall time. Earlier receipts retain their original timing scope and are never rewritten.

Remote paid admission also checks the fixed controller-only `admissionSuitePath` before setup and immediately before each Send. Root approval binds `suiteSha256` to the exact original file bytes, `suiteCanonicalSha256` to `JSON.stringify(parsedSuite)` (the runtime result identity), and the complete exact `taskIDs` set. Formatting is part of the reviewed file identity; parsed content must independently match what is actually executed. These are test authorization boundaries and do not alter agent permissions or capabilities.

## Browser register fixture

```sh
node scripts/benchmarks/prepare-browser-register.mjs --output /private/new-browser-register
node scripts/benchmarks/browser-register-fixture.mjs --fixture /private/new-browser-register
node --test scripts/benchmarks/browser-register.test.mjs
```

Keep the entire prepared directory, server/generator, suite, expected answers and raw HTTP receipts controller-only. Forward only the website's loopback port 39183 to the isolated app; expose ordinary pages and PDF attachments, never a shared folder. The five PDFs use fixed metadata and complete document hashes. The case requires the correct entity, executed status and effective date, distinguishing a prior amendment, future amendment, unsigned draft and similarly named company.

Run a separate fixture server, trace directory and host loopback port for each engine arm; forward each isolated guest's port 39183 to its own server. For this task the runner requires `environment.browserRegisterRequests({task,stage,runId,ownedSessionIDs})` and `environment.browserDownloads({task,candidates,evidence})` before Send. The request callback returns `{instanceID,requests}` from that arm's live server `snapshot()`. It waits for complete receipts and fails on trace IO errors. Before/after snapshots must retain the same server identity and all earlier request identities; only new requests count toward the task. Preserve complete response and receipt files privately.

The packaged Linux CLI wires both callbacks with `run --browser-fixture-config /private/arm/browser-fixture.json`. That private JSON contains `kind: "controller-browser-register"`, the prepared `fixtureDirectory`, a new `evidence` directory, this arm's unused `hostPort`, `guestPort: 39183`, the already running owned SSH `tunnelPID`, the exact packaged environment's `cloud` identity (including `instanceID`), actual `appUID`, project `workspaceDownloads`, and observed `nativeTempRoot`. Establish its SSH reverse as `-R 127.0.0.1:39183:127.0.0.1:<hostPort>` before running. The CLI starts its own live loopback server, verifies the cloud and reverse mapping, and proves an actual guest request reached that server using complete matching response bytes and a unique probe. It repeats that proof at the admit stage after staging and model admission, immediately before composer Send. Both probes and all setup requests are retained separately and excluded from task evidence. The server closes after the run. Each arm needs its own configuration, server port, trace directory and root-reviewed admission for this exact suite; an earlier unrelated task's paid approval does not authorize the browser task. This wiring is implemented and locally tested; both real engine/model runs remain required.

Native grading requires owned full AFTER results, the actual catalog's tool-name mapping, the same observed tab through filtered/selected pages, and a completed file listing plus transfer. LegalWork's extension path requires its exact attached capability and a completed, fully saved download. The download callback reads the original service-returned file, rather than relying on the agent's separate saved copy. `createSshBrowserDownloadCollector` in `browser-download-collection.mjs` supports POSIX guests: pin the actual app UID, project Downloads path and native temporary root. It reads full bytes as that ordinary UID through no-follow file descriptors, checks stable file identity, and retains complete bytes and hashes bound to the exact owned tool call. These file-acquisition restrictions protect benchmark evidence; they do not restrict agent tools. The receipt describes post-task saved-file bytes, not an unobserved historical download-time hash. Windows acquisition remains to be implemented. Generated code or child metadata alone cannot pass. Separate assertions verify the saved PDF and substantive answer.

This fixture and its synthetic grading tests are preparation. They do not establish real-agent browser parity. Actual both-engine Electron/model execution and the separately declared blocked-navigation policy scenario remain pending. No output, schema, tool-call, token or agent-task cap is added.
