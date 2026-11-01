# Optional semantic mail retrieval: processing and evaluation contract

MAIL-162, 1 November 2026. Email currently provides local lexical search. No mail embedding index, semantic query path, remote embedding consent or automatic cross-matter retrieval is enabled by this document. The approved private corpus and permitted account/matter scopes have been requested; retrieval gains have **not been measured**. Synthetic boundary tests cannot close that requirement.

## Reuse the existing Email authority

A future retrieval implementation must use the same Integrations identity, encrypted mail worker, provider message keys, source versions and account policies. Do not create another email account, inbox, credential store or duplicate MIME archive for embeddings. A matching address, RFC Message-ID, subject or legal identifier is not proof of account identity or matter access.

Current lexical boundaries establish the starting point:

- `MailSearchStore` checks account ownership and connection state before results, snippets, pagination and pending/incomplete counts. Local account-wide search is available to the authorized desktop user.
- Agent invocation binds search to the resolved grant account; the model cannot supply an account override inside its search input. Account policies and grant revisions are checked around execution.
- Matter-scoped search uses the selected workspace/backend/principal, committed filing receipts, matter/project identity and manifest hash. Its complete authorized scope is assembled before local search. The worker rejects stale source versions, changed connection generations and invalid scope bindings. Matter authorization cannot be inferred from the `matterIdentifier` text filter.
- Restoring a backup revokes old grants. Disconnect, account-policy changes and expired/revoked grants must not silently become a broader search.

Implementation references: [lexical store](../apps/server/src/mail/storage/search.ts), [agent coordinator](../apps/server/src/mail/agent-coordinator.ts), [filing coordinator](../apps/server/src/mail/filing-coordinator.ts), [filing store](../apps/server/src/mail/storage/filing-store.ts) and [grant custody](../apps/server/src/mail/storage/agent-grants.ts). These references describe the existing lexical path, not a verified semantic implementation.

## Processing modes and consent

Default any future semantic feature to **off**. Ordinary mailbox consent, an agent's search/read permission, a selected language model or an existing LegalMemory connection must not automatically authorize bulk embedding or remote reranking. Keep controls in the existing account/data-access surfaces if the feature is implemented; no new controls are added now.

| Mode | Processing boundary | Required recorded choice |
| --- | --- | --- |
| Off | Existing lexical search remains available under its current authority | No semantic index, background embedding job or query embedding. |
| Local | An approved local model runs in the user's chosen environment without transmitting corpus/query text | Exact accounts and named matters or explicitly approved account-wide scope; permitted metadata/body/attachment classes; model/version and preprocessing; initial and recurring resource limits. Model acquisition/installation is a separate action. |
| Remote | The approved service receives only currently authorized, consented material | The local choices above plus named endpoint/processor, deployment/region, retention/logging policy, permitted document/query/reranker data and a deliberate disclosure choice. Existing authentication may be reused through its normal integration, without copying tokens into an index. |

Document embeddings, query embeddings, reranking and generated answers are separate processing purposes. A query itself can contain a confidential case identifier or excerpt. Consent for document embeddings does not silently authorize sending queries/results to another model, and consent for an answer does not authorize a persistent account-wide index. Changing processor, model deployment, data classes or scope requires review of the affected choice.

A remote model configured in ordinary assistant settings does not make semantic processing local. Conversely, local embedding does not authorize remote reranking or answer generation. Source protection rights apply to every stage; exclude opaque/encrypted or Microsoft-protected content unless the applicable extraction/indexing/disclosure rights and revocation behavior are actually supported. A label, decrypted stream or mailbox token alone is insufficient.

## Scope before ranking and disclosure

Resolve the caller, current grant/policy revision, account identity/generation and live matter/filing authority before selecting candidates. Keep owner, account and provider identity distinct from workspace/backend/principal and matter identity. Any derivative needs its exact original/body/attachment reference, source version, preprocessing/model version and applicable consent generation.

Apply this authority to candidate selection, nearest-neighbor lookup, ranking, snippets, totals, pagination, incomplete/pending counts, reranker input, model context, caches and traces. Filtering a global top-k result only after retrieval is insufficient: it can disclose unauthorized material to the ranker and can crowd authorized results out of the candidate set. A vector backend must enforce the verified eligible set or isolated partitions before returning candidates. A model's returned IDs are untrusted and must be checked again before content is read or released.

Cross-matter retrieval requires a deliberate selection of authorized matters. Authorize each scope independently, then combine only eligible results. Preserve original account/message identity and source citations when deduplicating. Do not merge different accounts because their Message-IDs or MIME hashes match. Global LegalMemory semantic search or a file-picker result is not a substitute for an Email grant or a current filing receipt.

Recheck grant/policy/source/binding changes after asynchronous model work and before delivery. Revocation, account replacement, matter permission loss, expiry, source changes, cancellation or lock must fence pending results and caches. A distributed backend cannot promise instantaneous atomic revocation across independent services; qualify the actual freshness/race behavior before shipping. If authority cannot be established, deny the scoped operation. A model failure may use lexical results only under the same valid scope, never a broader account/matter fallback.

## Encryption, deletion and recovery

Treat vectors, chunks, snippets, query embeddings and ranking caches as confidential derivatives. Persist them only through reviewed encrypted storage bound to the same authorized owner. An ANN library's plaintext sidecar, mmap file or temporary cache must not become an unreviewed on-disk fallback. Use the existing OS-backed key custody and explicit rotation/recovery lifecycle; never place keys or provider tokens in vectors, prompts or logs.

Consent revocation must first stop new processing and make derivatives ineligible, fence in-flight work and invalidate result/query caches. Then remove the applicable vectors, chunks, caches and jobs. Source replacement invalidates derivatives before a replacement index can serve them. Index deletion must not delete provider messages or separately retained/filed records. Retaining a legal original does not automatically authorize continued semantic use of its derivatives.

Disconnect, grant/policy changes and matter permission loss must block semantic access even when an encrypted original is retained locally. Reconnect requires verified identity and fresh authority; an address match cannot carry an old consent into another principal. If remote deletion/retention cannot be established, report that limit and keep further disclosure disabled. Do not promise to recall exported files, provider logs or past assistant context.

Backups must keep any future index encrypted and record its derivation/version. Restore must disable semantic processing, revoke old grants and quarantine embedding/upload jobs; no background replay to a model may occur. Revalidate current identity, consent, source versions and matter rights before reuse or rebuild. A cache/schema downgrade must follow the same compatible-backup rules as the source store. These are future implementation gates, not claims that an embedding lifecycle already exists.

## Private evaluation protocol

The required input is an approved local corpus with declared owner/account/matter scopes and allowed processing. Do not harvest the user's live inbox or a firm's private records just because a connector is available. Select a model/backend only after its permitted processing mode is established. No corpus, embedding model, account credentials or private messages were fetched for this checkpoint.

Use the same eligible corpus, immutable source versions and relevance judgments for each run:

1. Current lexical search, including its literal/structured filters, is the mandatory baseline and remains available.
2. Evaluate the approved embedding backend and any hybrid method separately. Record model/artifact version, preprocessing, index/query settings, reranker and disclosure mode. Tuning and held-out evaluation sets must be separate; split related threads/matters to avoid duplicate-driven gains.
3. Include exact case/matter identifiers, statutes, dates, filenames and party names; semantic paraphrases; no-answer queries; near identifiers; duplicate Message-IDs across accounts; stale/changed sources; and denied/revoked scopes. For example, distinguish `II ZR 123/24` from `II ZR 123/25` and prefix collisions such as `II ZR 123/240`. The current literal filter is a substring search, not a legal-citation parser. Measure that behavior rather than claiming exact citation interpretation.
4. Report recall@5/10, nDCG@10, MRR@10, exact-identifier precision/top-hit failures and no-answer false positives. Count unauthorized candidates, snippets, counts, reranker/model inputs, cached results and traces separately. Any unauthorized disclosure fails the run; it cannot be traded for relevance gains.
5. Record local resource use and first/warm query latency within the agreed small evaluation budget. Do not substitute this for MAIL-141's deferred reference-machine/100,000-message qualification or start a large Mac benchmark automatically.
6. Keep raw queries, judgments, source identities and detailed traces in the approved private location. Share only reviewed aggregate results in the repository/ticket. A reproducibility fingerprint and query-category counts can still be sensitive. Errors must use fixed codes, without private paths, credentials or excerpts.

Before accepting a semantic implementation, test account/matter overlap, revoked/expired permissions, reconnect as another principal, source replacement, concurrent lock/revocation, stale model results, remote failure, cache reuse, deletion/backup/restore and denied content rights. Verify both returned text and every metadata/count surface. Synthetic negative cases establish contract behavior only; they do not measure gains on the required private evaluation set.

## Checkpoint and remaining work

The processing/consent/encryption/deletion contract above satisfies the definition work for MAIL-162. Existing lexical/search and source-grant tests are the baseline evidence. No embedding/model request or private retrieval evaluation has run, and no semantic quality, performance or isolation claim is made. The private-corpus and actual semantic-path criteria remain open, along with MAIL-156's release gates. Preserve the current lexical UI and source authority throughout any later experiment.
