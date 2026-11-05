# Migration test budget

The user authorized **EUR100 as the model-token planning target** and **EUR250
as the absolute maximum** for necessary migration fixes and retests. Record each
run's coverage rationale; this is not permission for arbitrary extra trials.
VM charges remain separate. One durable ledger covers v1/v2, providers,
sessions, compaction, subagents, judges and benchmark runs. Reopening it never
resets spending. EUR100 notifications remain anchored to that planning target.
The original numeric EUR100 guard remains active until the separately reviewed
ceiling transaction below is applied; it cannot raise its own allowance.
Keep one absolute ledger path outside the repository.
Root keeps the dedicated gateway credential outside Git with mode `0600` in a
`0700` directory; never put a gateway/master key in trace files.

`createBudgetGuard({ ledgerPath, totalEur: 100, auditAttestation })` implements process-safe durable
reservations. The proxy must reserve **before every network attempt**, including
retries. Its small filesystem transaction lock does not serialize inference or
parallel agent tools. A process crash leaves reservations intact. An abandoned
lock requires inspection and deliberate manual recovery, not a timer refund.
Ledger writes use an fsynced temporary file, atomic rename and directory fsync.
An initialized sibling marker also prevents an accidentally deleted ledger from
creating a fresh allowance. Keep both files when moving or backing up the ledger.

Before **each paid run**, refresh a receipt from actual authenticated production
model information with:

```sh
node scripts/benchmarks/budget-audit.mjs --output /absolute/private/budget-audit.json
```

This read-only helper uses `gcloud` Secret Manager in memory and performs only
`GET /model/info`. It never logs the master key or raw response, creates no key
and performs no inference. Its private receipt contains selected nonsecret
deployments, limits and all positive tariffs. Startup checks the complete facts,
snapshot hash, deployed-model identity and rate-envelope hash. The receipt must
be at most 15 minutes old when the run starts. This is an accounting preflight
freshness requirement, not an output or context limit. A run-start receipt is
not a cryptographic proof of future price stability: refresh again before the
next run, and stop/re-audit after any deployment change.

## Bounds without changing agent capacity

Production `/model/info` and the public LegalWork manifest were inspected on
2026-10-24. The complete price snapshot is represented by `budget-rates.mjs` and
its hash. The guard reserves the natural input and output maximum, even when a
request has a smaller `max_tokens`. It never inserts or reduces a token limit,
strips a tool, truncates a response, changes a prompt or forces serial tool calls.

| Alias suffix (Europe or US) | Natural input/output tokens | Conservative hold/request |
| --- | ---: | ---: |
| Gemini (3.8 Flash; 3.7/3.6 fallback) | 1,048,576 / 65,536 | EUR 2.313421 |
| Claude Sonnet (5.5; Bedrock/OpenRouter) | 1,000,000 / 128,000 | EUR 5.801600 |
| Claude Opus (5.5; Bedrock/OpenRouter) | 1,000,000 / 128,000 | EUR 11.571200 |

The Gemini bound includes the highest published output tariff plus separately
listed reasoning. Claude bounds include the more expensive one-hour cache-write
tariff. Cached input is not assumed free. Completion multiplicity increases the
reservation rather than reducing the request. Near the total ceiling, the guard
refuses a whole new request with an explicit budget error; it does not shrink
the model to fit the remaining balance.

Completed successful responses with complete usage settle at a conservative
upper bound computed from token counts. Cache and reasoning categories are
added even if already included by that transport. Reported gateway cost is
recorded separately and can increase this accounting amount. A missing final
usage event, cancellation, HTTP error or connection failure retains the full
hold. A reported cost above the reservation freezes further admissions.

The initial paid contract supports OpenAI-compatible chat completions and
ordinary function tools. Unknown models, routes, parameters or provider-hosted
billable tools (grounding/search/maps) fail closed before sending anything;
nothing is silently dropped. Native Messages/Responses, generated audio,
batch inference, audio/video input and recurring cache storage need their own audited contracts
before paid testing. This is a test-harness limitation, not a production agent
capability change. Its explicit errors identify coverage that remains to add.

## Shared infrastructure costs

Schemas1/2 conservatively include `reserveExternal({ requestId, label, maxEur })`
holds in the same counter. The reviewed schema3 scope event excludes only the
two exact fingerprinted cloud records authorized by the user's clarification.
Their original holds and all financial history remain intact. Unknown or new
unclassified external entries still count in the model counter until explicitly
reviewed. A scope event is not an invoice and never settles a VM cost as zero.
VM pricing, leases and actual transfers remain separately tracked.

For a schema3 excluded hold, `settleExternal(token, { actualEur, evidenceId })`
appends external billing evidence without rewriting the original record.
Higher later debits remain visible; a lower replay cannot create a credit.
An external invoice exceeding its hold is separately reported and does not
consume token budget. No VM is created by these helpers.

`health()` exposes `accountedUpperBoundEur`, `reportedSpendEur`, `reservedEur`,
`committedUpperBoundEur`, `remainingEur`, uncertain reservations and notification
thresholds. The first is conservative accounting; the second is observed cost
headers; it is only an observed subtotal when any header is missing. Neither should be
misrepresented as an authoritative supplier invoice. Notify the user at the EUR100 planning target and report budget pauses and
uncertain holds explicitly. Necessary, justified migration fixes/retests within
the approved EUR250 ceiling require no repeated human approval.

## Gateway backstop and practical limits

The production gateway meters configured sell prices in **EUR**, despite USD
names in LiteLLM's generic API. The dedicated migration key has a nonresetting
`max_budget: 100`, finite expiry, explicit model/route restrictions and no admin
owner. This is a secondary backstop: in deployed LiteLLM 1.105.1, default budget
reservation may shrink a hold to the remaining balance and allow a larger
request. Strict `fail_closed_budget_enforcement` is not enabled in the production
configuration. The member allowance callback also admits on positive settled
balance and can fail open. Neither is the benchmark's hard admission gate.

The local guarantee is conditional on the audited deployed model ceilings and
tariffs remaining valid, all paid model traffic traversing the guard, and
complete provider token usage being accurate. Price or model-limit changes
require re-audit and ledger reconciliation; an incompatible manifest never
silently starts a fresh allowance. Extra supplier charges for internal retries,
fallbacks, taxes, currency conversion and delayed promotional credits are not
the gateway EUR sell-price counter. External paid tool/API costs must have an
explicit separately reviewed accounting hold. Do not call the ledger an unconditional cap on a
cloud/provider invoice.

## Operational limits and their effects

Every bound introduced by this budget infrastructure is listed here. None
truncates agent prompts, tool outputs or model responses. Admission failures
are explicit test failures or coverage gaps and must be reported that way.

| Bound or restriction | Location | Reason and effect |
| --- | --- | --- |
| EUR100 planning target; reviewed EUR250 hard maximum; no automatic reset | `budget-guard.mjs`, persistent ledger; dedicated gateway key | All model work shares one counter across runs and processes, including uncertain holds. Schemas1/2 also include external holds; only reviewed exact cloud records move outside that counter in schema3. Keep EUR100 as the notification target; proceeding beyond it requires the existing reviewed authorization event and a justified per-run migration coverage plan, not repeated human approval. A whole new request is refused when its full reservation will not fit; no request or output limit is inserted. |
| Published model input/output maxima shown above | `budget-rates.mjs`, `requestBound()` | Used to reserve the entire natural model capacity. These are existing provider limits, not newly inserted engine caps. Lower user/request limits are not rewritten. Multiple completions increase the reservation. |
| Three EU aliases on the migration credential: `Eigenwelt Europe Gemini`, `Eigenwelt Europe Claude Sonnet`, `Eigenwelt Europe Claude Opus` | Root-provisioned test key; proxy model allowlist | Limits spending to the authorized Gemini/Claude tests. The rate module also describes US aliases, but the current key and live audit do not authorize US testing. Other models need an audited tariff and an explicit key update before paid testing. |
| Seven known EU deployment identities and exact published ceilings | `budget-audit.mjs`, `auditedGatewayDeployments` | Detects changed backends or routing before a run. A newly added deployment, changed model or changed capacity requires re-audit. Older Gemini fallbacks are recorded as different backends and cannot count as Gemini 3.8 evidence. |
| Chat completions only: `/chat/completions` and `/v1/chat/completions` | `budget-guard.mjs`, `routes` | These are the initially priced inference contracts. The key's additional native Messages/Responses permissions do not bypass this guard. Native protocols remain pending paid coverage until separately audited. |
| Explicit request-field allowlist; ordinary `type: function` tools | `budget-guard.mjs`, `fields` and `requestBound()` | Prevents unpriced routing overrides or hosted services from reaching the gateway. Unknown parameters and provider-hosted search/grounding/maps produce an explicit error; they are never stripped. A new provider feature needs a price contract before paid testing. |
| Text, image URL/data parts and native PDF file parts only | `budget-guard.mjs`, `checkModalities()` | Current deployed input tariffs cover these token-priced modalities. Data images accept PNG, JPEG, WebP and GIF. Audio/video, other file types and unaudited content forms remain explicit coverage gaps. The guard preserves admitted image/PDF bytes and resolution. |
| Positive tariff whitelist and conservative price envelopes | `budget-audit.mjs` | Every positive deployed price path is checked. An unknown surcharge or a tariff above the envelope stops startup. The known Maps query tariff is excluded only because hosted Maps tools are refused before dispatch. |
| Seven-day test-key lifetime; current expiry `2026-10-31T13:33:10.898Z` | Root-provisioned migration credential | Keeps an unattended test credential from remaining usable indefinitely. Expiry requires deliberate renewal/replacement; it does not reset the shared budget or alter production accounts. |
| Audit age at most 15 minutes at run startup; future clock tolerance at most 60 seconds | `budget-audit.mjs`, `verifyBudgetAudit()` | Requires a recent actual production snapshot and tolerates small clock differences. An older or implausibly future-dated receipt stops startup. This does not impose a 15-minute agent-task deadline. |
| Model-info audit HTTP timeout: 30 seconds | `budget-audit.mjs`, `refreshBudgetAuditReceipt()` | Bounds only the read-only accounting preflight when the gateway is unavailable. It does not limit inference streams or tool execution. |
| Secret Manager subprocess capture: 64 KiB | `budget-audit.mjs`, `execFile()` | A master-key response should be tiny. Unexpectedly large stdout/stderr fails the preflight instead of retaining arbitrary subprocess output. This never handles agent content. |
| Ledger lock wait: 10 seconds, retry every 10 milliseconds | `budget-guard.mjs`, `transaction()` | Bounds bookkeeping coordination. The lock covers only a small ledger transaction, not inference or agent tools. A lock timeout stops admission; abandoned locks are never automatically discarded. |
| Request and external evidence IDs: 1–160 characters; external labels: 1–120 characters, restricted nonsecret characters | `budget-guard.mjs`, `admit()`, `reserveExternal()`, `settleExternal()` | Validates harness identifiers and accounting labels only. Long prompts, document names inside messages and tool outputs are unaffected. A malformed harness ID is rejected before admission. |
| Finite nonnegative integer token counts and safe integer microeuro/multiplicity arithmetic | `budget-guard.mjs`, `integer()`, `micros()`, `tokenCost()` | Prevents corrupt usage or numeric overflow from understating reservations. Costs round upward to microeuros. Invalid completion usage retains the existing full hold; invalid new-request arithmetic refuses dispatch. |
| Cost-header parsing accepts finite nonnegative values up to EUR 1,000,000 | `budget-guard.mjs`, `reportedCost()` | Sanity validation of gateway-reported accounting metadata, far above any audited request envelope. Missing/invalid headers provide no price evidence; conservative token accounting still applies. It does not cap or edit responses. Any accepted reported cost above its reservation freezes admissions. |
| Settlement requires HTTP 200, a completed response and complete valid usage | `budget-guard.mjs`, `reconcile()` | Partial or ambiguous evidence cannot release budget. Errors, cancellation and missing terminal usage retain the full reservation without automatic expiry. The completed response itself is forwarded unchanged. |
| Notification marks at 50%, 80%, 95% and 100% of the EUR100 planning target | `budget-guard.mjs`, `health()` | Informational accounting thresholds, not additional execution caps. Conservative holds can refuse a complete request before actual reported spend reaches EUR250; reports must distinguish authoritative charges, conservative exposure and the EUR100 planning target. |

The price and backend proofs are empirical snapshots of the deployed service.
They establish the tested accounting contract at audit time; they do not turn
the local ledger into an unconditional supplier-invoice ceiling. All paid
traffic must traverse this guard, provider usage must remain accurate, and
prices/backends must remain within the audited contract during the run.

Primary references:

- [LiteLLM budget reservation and strict enforcement](https://docs.litellm.ai/docs/proxy/users#budget-reservation)
- [Pinned default over-budget policy](https://github.com/BerriAI/litellm/blob/v1.105.1/litellm/proxy/spend_tracking/budget_reservation.py#L165)
- [Pinned output-token reservation estimate](https://github.com/BerriAI/litellm/blob/v1.105.1/litellm/proxy/spend_tracking/budget_reservation.py#L1641)
- [Gateway production configuration](https://github.com/eigenweltlabs/model-api/blob/252c627/gateway/litellm-config.prod.yaml)
- [Gateway EUR price convention](https://github.com/eigenweltlabs/model-api/blob/252c627/apps/platform/scripts/gateway-prices.mjs)

Verify with `node --test scripts/benchmarks/budget-guard.test.mjs`. These are
budget-control tests and make no paid requests. They are separate from the real
Electron/engine capability benchmark.


## Reviewed historical gateway reconciliation

The user approved replacing conservative accounting for the **specific 139
historical calls** with their independently verified persisted gateway charges.
This is a fixed set of request IDs, not a time-only filter or the current key's
cumulative spend. Later requests keep their existing reservations and accounting.
The approved receipt and independent review hashes are compiled into
`budget-reconciliation.mjs`; the CLI has no caller-controlled trust override.

`budget-reconcile.mjs` defaults to a read-only dry-run. It verifies the frozen
receipt, all indexed files, every original trace and raw SSE response, exact
response-to-gateway-to-ledger identities, key filtering, complete pagination,
completed wire deployments, original financial tuples and upward-rounded charges.
The one cancelled request has a persisted charge and exact response-ID match;
its wire deployment field remains unknown. Original zero-spend creation and
historical key exclusivity were not independently proved. Those qualifications
remain in the reconciliation plan and receipts; no supplier invoice is inferred.

The separately reviewed follow-up covers exactly **188 additional completed
requests**, rounded individually upward to EUR3.945028. Its fixed approval
SHA256 is `1b03a8214aaa9e3986deec8f535a821011c65e5897bf65080c7ea9991ea9bf12`.
`budget-reconcile-followup.mjs` verifies the independently pinned join, approval
and draft, all327 raw response-ID mappings, original financial hashes, complete
two-read pagination, four stable key-spend reads, full raw response hashes and
each new call's completed wire/deployment/terminal cost. It constructs a verified
capability only after reconstructing the approved draft exactly. The original
139 requests are preserved and cannot be reconciled twice. The old cancelled
wire-backend qualification remains; no usage, role or backend field is invented.

The follow-up CLI accepts `--receipt`, `--review`, `--draft`, `--ledger` and
`--output`; it has no trust-pin override. It defaults to read-only. Application
uses the same exact-before-hash/quiescent transaction after a separate original
backup and root review. A schema3 ledger remains schema3. The frozen H83 guard
already reads the ordinary append-only batch shape; its source need not change.
Neither an unreviewed caller plan nor a time-only subset can enter accounting.

The proposed transaction preserves all original entries and appends one verified
batch, advancing the ledger to **schema v2**. Effective accounting then uses the
139 evidenced charges (EUR 4.322998 after rounding each request upward), while
historical accounting and the original uncertain cancellation remain available.
The external EUR 8 cloud hold stays unchanged. Unknown original cost headers
remain missing; evidenced prices are not fabricated headers.

Application requires `--apply` plus the exact ledger SHA256 reviewed in a fresh
dry-run, with the old capture proxy and all paid traffic stopped. The transaction
uses the same filesystem lock and atomic/fsynced persistence. It rejects changed
original records, missing or overlapping entries and unreviewed pending inference
reservations. Other later settled/uncertain entries are preserved at their
current full accounting. Exact replay is a byte-preserving no-op. Duplicate or
changed batches fail closed. **The frozen old v1 guard cannot read schema v2**;
restart subsequent capture processes with the new validated guard after applying.

## Reviewed token-only scope event (schema3)

`budget-scope.mjs` pins the immutable root decision SHA256
`3b214cbd0905d2789a75da30822b66554fe8579722549c7afb9e9c6fdaac1cc3`.
It binds the original ledger creation, pricing manifest, retained model limit
and two exact external-entry fingerprints. The CLI has no caller-supplied trust
override. Only the evidence-verification API accepts an explicit independent
trust pin for isolated fixtures, matching the reconciliation fixture pattern.

`budget-rescope.mjs` defaults to a read-only dry-run. The existing guard validates
all original entries, authoritative reconciliation batches and late model-cost
increases before the scope projection. Application requires a new receipt path,
`--apply`, the exact reviewed before-SHA and no active inference reservation,
under the existing lock, plus `--backup /private/new-original-ledger.json`.
The unchanged original bytes are exclusively created and fsynced at that path
before publishing the new ledger. Stop every old proxy/guard first. The atomic transaction
appends one scope event and advances to schema3, preserving every original
entry, reconciliation and initialized marker. Exact replay is a no-op. File and
directory fsync precede completion. No key, model request or cloud request is made.

```sh
node scripts/benchmarks/budget-rescope.mjs \
  --decision /private/token-only-scope-decision-20261025.json \
  --ledger /private/budget-ledger.json \
  --output /private/scope-dry-run.json
```

Only after independent review at a quiescent boundary, use a **new** output path
and add `--apply --expected-ledger-sha256 <reviewed-hash>`. Old schemas1/2 guards
reject schema3; never run a frozen H82 proxy after applying. Freeze and review a
new harness, then start new guards with a fresh production tariff audit.

In schema3, existing `accountedUpperBoundEur`, `reservedEur`,
`committedUpperBoundEur`, `remainingEur`, `exhausted` and notification thresholds
refer to the retained model-budget scope (including unclassified external
entries). `scope` and `modelBudgetScopeActive` identify that change. New
`externalAccountedEur`, `externalReservedEur`, `externalExposureEur`,
`externalInvoiceKnownForAllExcludedEntries` and `externalCostEvidenceEvents`
report the excluded finances separately. `allFinancialAccountedUpperBoundEur`,
`allFinancialReservedEur` and `allFinancialExposureEur` retain the combined view.
Historical fields retain the original counter before reconciliation/scope.
Reported cost-header subtotals and missing-header counts remain distinct.

Current consumers: capture-proxy forwards this health object; runner/admission
checks rely on `operational`, `frozen`, `remainingEur` and the ledger/audit pins.
They must bind a new snapshot after scope application. Controllers that formerly
tested a cloud hold by comparing aggregate `reservedEur` must instead verify its
exact original ledger entry and `externalReservedEur` after schema3. External
cost events never imply zero cost, alter model capacity, or reduce trace output.

Verify actual guard behavior with the budget guard, reconciliation and scope
test files together. They exercise admission to the unchanged numeric boundary,
unknown/cancelled holds, late gateway increases, scope/reconciliation replay,
external invoice increases, immutable original entries, forged scope authority,
quiescent exact-hash application and restart validation; no paid calls occur.

For example, with actual private absolute paths supplied by the controller:

```sh
node scripts/benchmarks/budget-reconcile.mjs \
  --receipt /private/frozen-readonly-accounting.receipt.json \
  --review /private/root-independent-review.json \
  --ledger /private/budget-ledger.json \
  --output /private/reconciliation-dry-run.json
```

After independent review and a quiescent boundary, use a **new** output path and
add `--apply --expected-ledger-sha256 <the-reviewed-hash>`. This helper reads no
credentials, calls no network service, creates no key and makes no inference
request. It never overwrites evidence or an existing output receipt.

An old reconciled token's late callback cannot rewrite the original record or
lower its evidenced charge. A valid larger gateway cost header appends an
absolute debit increase; a duplicate or lower callback cannot release allowance.
An increase beyond the original reservation or total allowance counts in full
and freezes further admission. This does not automatically approve a later
cost decrease or a new historical reconciliation.

`health()` keeps its admission totals effective and additionally exposes
`historicalAccountedUpperBoundEur`, `historicalReservedEur`,
`historicalCommittedUpperBoundEur`, `historicalUncertainReservations`,
`evidencedInferenceDebitEur`, `reconciledInferenceRequests`,
`reconciledInferenceCostHeadersMissing` and `lateInferenceCostHeaderIncreases`.
`reportedSpendEur` remains the original recorded cost-header/external-settlement
counter; zero there does not mean zero spending. None of this introduces an
agent context, output, tool or task limit.

Verify without paid requests:

```sh
node --test scripts/benchmarks/budget-guard.test.mjs scripts/benchmarks/budget-reconciliation.test.mjs
```


## Reviewed ceiling authorization, without resetting accounting

`budget-ceiling.mjs` pins authorization SHA256
`74e48a9f6bc052e69ebdb5daa53991606a643eac8cf07075e5fa78ed027c4e82`.
It binds the immutable root-recorded user authorization, original ledger creation
and pricing manifest, original token-only scope event, EUR100 planning target,
EUR250 hard maximum and justified-migration-only conditions. Neither CLI accepts
a caller-supplied authorization trust pin or arbitrary numeric ceiling.
The evidence API's explicit independent pin exists for isolated fixtures only.

`budget-authorize.mjs` defaults to a byte-preserving dry-run:

```sh
node scripts/benchmarks/budget-authorize.mjs \
  --authorization /private/reviewed-user-authorization-250.json \
  --ledger /private/budget-ledger.json \
  --output /private/ceiling-dry-run.json
```

After root independently reviews the exact source, authorization and dry-run,
stop every old proxy and use a new output path plus `--apply`,
`--expected-ledger-sha256 <reviewed-before-hash>` and
`--backup /private/new-immutable-original-ledger.json`. Application uses the same
ledger lock, checks no active inference reservations, exclusively creates and
fsyncs the exact-byte original backup with mode0400, then atomically saves the
ledger. It remains schema3. Only `limitMicros`, `updatedAt` and one append-only
`budgetAuthorizationEvents` event change. Every original entry, reconciliation,
external hold, scope event and initialized marker stays intact. Exact replay is
byte preserving. Uncertain costs remain charged at their existing full holds.
The original scope event stays bound to its original EUR100 decision; the
separately validated authorization event supplies the new admission ceiling.

Frozen H83 remains byte-immutable and deliberately rejects the new numeric
limit. Do not reuse its paid proxy after applying. Freeze/review the new harness
and refresh its ordinary production tariff audit. The dedicated gateway key's
current EUR100 backstop also needs a deliberate nonresetting limit adjustment
before it would block authorized testing beyond that amount; this local helper
does not change credentials, key spend, gateway settings or provider tariffs.

Each new250 paid-proxy config must pin `budgetCoveragePath` and
`budgetCoverageSha256` for a root-reviewed private plan with these fields:

```json
{
  "kind": "migration-test-run-coverage",
  "version": 1,
  "authorizationSha256": "74e48a9f6bc052e69ebdb5daa53991606a643eac8cf07075e5fa78ed027c4e82",
  "runId": "exact-repair-retest",
  "coverageRationale": "Which repaired capability this run must verify and why.",
  "necessaryMigrationFixOrRetest": true
}
```

Root creates/reviews that plan before proxy startup and binds the private config
and plan hash into the subsequent paid-admission packet. The local plan records
coverage; it is not a signature or independent new spending authority. No CLI
numeric override or rationale alone can create/raise/reset a ledger. The guard
requires the already applied fixed-pin ceiling event and an existing initialized
ledger. Full coverage metadata appears in proxy health and every newly admitted
inference entry. Its run ID uses the existing bookkeeping-only 1–160-character
format; the rationale has no content-length cap. No additional model, task,
context, output, tool, file or execution-time limit is introduced.

`health().limitEur` and `remainingEur` refer to the EUR250 hard boundary after
application. `planningTargetEur`, `planningTargetReached` and existing
`notificationThresholdsReached` stay anchored to EUR100. Crossing the planning
target does not refuse an otherwise fully fundable complete request. A request
whose entire unchanged natural-capacity reservation exceeds the remaining hard
allowance is refused before dispatch. All historical, authoritative, uncertain
and external accounting fields retain their previous meanings.

Verify without paid calls:

```sh
node --test scripts/benchmarks/budget-ceiling.test.mjs scripts/benchmarks/budget-guard.test.mjs scripts/benchmarks/budget-reconciliation.test.mjs scripts/benchmarks/budget-scope.test.mjs scripts/benchmarks/budget-followup.test.mjs
```
