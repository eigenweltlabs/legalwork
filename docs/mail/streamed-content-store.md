# Streamed encrypted content (EIG-125)

`MailContentStore(database, ownerId)` stores original MIME, extracted bodies and attachment bytes as bounded BLOB chunks inside the already encrypted mail SQLite database. It accepts the reviewed `MailDatabase` and `MailRepository` contracts. It opens no files or connections and adds no cryptography, plaintext fallback, provider fetching or worker/network API.

```ts
const content = new MailContentStore(database, authenticatedOwnerId);
const reference = await content.writePart(accountId, locator, {
  kind: "raw", maxBytes: 50 * 1024 * 1024,
  expectedBytes: providerSize, // optional, when a reliable original-byte size is available
  expectedSha256: knownHash,  // optional lowercase SHA-256
}, boundedAsyncSource);
for (const chunk of content.read(accountId, reference.id)) {
  // Consume or forward this chunk before advancing.
}
```

`kind` is `raw`, `body` or `attachment`. Attachments require a nonempty `partId`; raw/body use the default empty part ID. `maxBytes` is mandatory and may be zero for an empty body. Optional expectations are checked before publication. A provider's encoded size estimate is not necessarily the byte size of the stream: callers should supply an expected size only when the semantics match.

## Streaming and publication

Sources must yield `Uint8Array` chunks no larger than 64 KiB. Empty chunks are permitted; oversized chunks fail rather than being accepted as eager provider downloads. Adapters/parsers must provide bounded generators. The writer owns one 64 KiB coalescing buffer and retains no full-body array. This bounds writer-owned buffering; it cannot bound memory already allocated by its caller or the native database cache. Empty content has no chunk rows and the standard SHA-256 of zero bytes.

Schema v2 adds account-local blob objects, ordinal BLOB chunks (1–65,536 bytes each), and content-reference publications. Each staged chunk and its byte/chunk counters commit together using the encrypted database's synchronous transaction. No network await occurs inside a transaction. A source iterator advances only after its prior full chunk has been staged. A final partial chunk is written only after the input size/hash expectations pass.

At EOF the final synchronous transaction reads staged bytes back incrementally and verifies the complete byte count and SHA-256. It publishes the canonical `sha256:<hex>` reference, object and repository part manifest atomically. A metadata observer therefore sees either the previous durable part or the new complete part. Staging is never attached to a `stored` manifest. The database adapter's encrypted WAL and FULL synchronization provide the commit boundary; this writer does not claim stronger power-loss guarantees than that adapter.

Deduplication is account-scoped. Same-account messages or labels can share a published reference, without collapsing their message identities; equal hashes in different accounts retain distinct objects. The existing dedup target is also read and verified before the new stage is discarded. A canonical reference already present with different size/hash fails through the repository's immutable-reference check.

Final verification reads are bounded but synchronous, so publishing a large object occupies the storage worker for its verification duration. Staging uses one transaction per full chunk; throughput, page-cache and WAL/disk-amplification budgets need measurement before large-history rollout. No performance or 100k-mailbox claim is made by the correctness tests.

## Reads, failure and recovery

`read(accountId, referenceId)` performs one indexed chunk query at a time and yields at most 64 KiB per iteration. Missing/invalid chunk lengths fail immediately; the aggregate hash is verified at EOF. A consumer stopping early has **not** verified the complete stream. Owners cannot read or write another owner's account. All subordinate storage lookups and publications use account-composite keys.

A source exception, declared-size violation, expected-hash mismatch, staged-write error or publication failure leaves the previous manifest untouched. The writer does not advance a sync cursor, attachment enumeration or account-wide completion. Ordinary failures attempt to remove only their own stage. Cleanup can itself fail under disk-full conditions; the original error is preserved and the remaining stage is available after recovery. A process killed midstream leaves encrypted staged chunks but no published replacement.

`listStaging(accountId, limit=100)` returns bounded stage metadata (maximum limit 1000). `discardStaging(accountId, stageId)` is explicit recovery for abandoned writes; quiesce writers before clearing their stages. Its deletion is conditional on staging state **and** absence of a publication. Cleanup of published blobs is deliberately not implemented: shared message references, memberships, drafts, future matter pins and even replaced-but-unreferenced published content are retained. There is no inferred reference count or destructive garbage collector.

Version 1 to 2 migration is additive, transactional and preserves accounts, messages, manifests, drafts and all previous metadata. Existing v1 references without chunk publications remain intact; this writer cannot manufacture their bytes, and `read` reports them unavailable. Migration does not retroactively prove content durability for an old metadata-only reference. `MailRepository.readMessage` exposes `bytesAvailable` per part, derived from its account-scoped publication and published object with matching byte/chunk counters. A `stored` manifest without that attestation produces `contentState: "attention"`, never `complete`, while preserving the legacy reference and manifest association. This metadata attestation does not replace the content reader's through-EOF hash verification; corruption discovered during streaming still requires reconciliation. Provider lifecycle/invalidation, MIME part extraction and reconciliation of unavailable content remain separate work.

## Validation

```sh
bun test apps/server/src/mail/storage/content-store.test.ts
pnpm --dir apps/server typecheck
```

The Bun test compiles production TypeScript into a temporary directory, links the installed server dependencies there, and executes `content-store.node-test.mjs` in actual Node against the encrypted native adapter. Temporary databases/build output are removed afterward. Its eight tests cover 4 MiB bounded generation/readback/reopen, staging invisibility, input coalescing, empty bodies, dedup/account isolation, failed refresh preservation, injected chunk/final-publication write errors, reference-aware cleanup, aggregate corruption detection, v1-to-v2 rollback/preservation and formerly-complete metadata without bytes, and SIGKILL after a committed staged chunk followed by reopen/cleanup/retry. The crash child receives its random test key only through stdin.

Injected write errors exercise rollback boundaries; they do not qualify actual operating-system ENOSPC, power loss or signed application packaging. Provider APIs may still eagerly fetch bodies elsewhere: this writer's streaming contract does not validate or repair those adapters.


## Atomic executor publication

`writePart` accepts an optional fifth argument, a trusted synchronous `onPublish(reference)` callback. It runs after verified publication metadata is staged but before the enclosing transaction commits. The executor can check credentials and complete its current journal lease there, so publication and job success either commit together or both roll back. A frozen copy of the content reference prevents accidental mutation of the returned receipt. Stale leases and callback errors preserve the previous original and remove the abandoned stage.

The callback cannot do network I/O or schedule deferred writes. Runtime thenable rejection rolls back synchronous changes, but cannot cancel deferred closures using externally captured repositories; this is an internal trusted-callsite contract, not a sandbox. Provider input cannot supply this callback. Added encrypted tests cover expired-lease publication rollback, atomic job completion, and callback rejection/rollback (ten content cases total).
