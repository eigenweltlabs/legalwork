# Google Drive folder latency — 2 November 2026

The reported symptom was slow folder expansion in Memory Drive, with transfers also feeling slow. Read-only requests to the running desktop server reproduced it: account expansion took 2.72 seconds, My Drive took 5.22 seconds, and a nested folder took 4.36 seconds. These are individual observations, not latency guarantees.

## Confirmed causes

`nativeDriveAdapter.resolve()` fetches each identity in the requested path and checks its membership in its parent. Google's `contains()` then fetched both identities again. `children()` fetched the final folder once more before listing it. Account-root expansion also fetched My Drive again immediately after initialization. These serial requests accumulate with folder depth. The Google adapter is recreated for each storage operation, so they recur across expansions, reads, and transfer setup.

Instrumenting the existing connector transport against the connected account showed Google metadata requests taking approximately 240–730 ms each. Separately, each operation obtains a credential from the broker: observed token calls took 740–1,155 ms, with an additional status check on the first operation. The metadata fix does not change credential or account checks.

## Change and measurements

The Google tree now checks membership using the items already obtained during path resolution and reuses the just-resolved folder for listing. It also reuses the initial My Drive metadata when returning virtual account locations. `get()` remains uncached, preserving fresh file versions, moved-out-folder checks, and before/after-download conflict detection. No cache is shared between accounts or storage requests.

Read-only probes used the source adapter and the same live account before and after the change:

| Operation | Google calls before → after | Google-request portion before → after |
| --- | --- | --- |
| Account locations, including initialization | 2 metadata → 1 metadata | Redundant account-list metadata request removed |
| My Drive expansion, excluding initialization | 3 metadata + 1 listing → 1 metadata + 1 listing | 1,616 ms → 532 ms |
| Nested folder expansion, excluding initialization | 6 metadata + 1 listing → 2 metadata + 1 listing | 1,928 ms → 795 ms |

The complete My Drive source-adapter operation, including credential retrieval and initialization, measured 3,034 ms before and 1,574 ms after. Network conditions vary. The installed app was not replaced; the improved measurements came from the branch's source adapter using the live account.

## Transfers

Memory Drive drag-and-drop explicitly requests `mode: "copy"`. Cross-connection copies download to the LegalWork server, upload, and read back the destination to verify the bytes. Moves across connections additionally verify originals before deleting them. This costs more than a provider-native operation, especially for many files. A same-connection move through the new `storage_transfer` agent tool uses the backend's native rename path when supported. The metadata improvement also reduces redundant calls during transfer path resolution; live transfer timings were not measured.

## Validation

- The new folder-expansion request-count regression failed on the original implementation and passed after the fix.
- Tests cover fresh versions on subsequent operations, parent membership after a file moves, changes during download, shortcuts, scoped folders, and virtual locations.
- `pnpm exec bun test apps/server/src/file-storage/google-drive-tree.test.ts apps/server/src/file-storage/native-drive.test.ts apps/server/src/file-storage/cloud-drives.test.ts apps/server/src/file-storage/transfer.test.ts apps/server/src/opencode-plugins/legalwork-storage-tools.test.ts`: 45 passed, 0 failed.
- `pnpm --filter legalwork-server typecheck`, `pnpm --filter legalwork-server build:plugins`, `pnpm docs:generate`, and `pnpm docs:check`: passed.
- `pnpm --filter legalwork-server test` did not produce a clean full-suite result: its log contains `webidl.util.markAsUncloneable is not a function` in installed Undici under Bun 1.3.14, plus engine derivative-installation validation failures. These prevent claiming full server-suite verification.

Status: **DONE_WITH_CONCERNS**. The duplicate-request cause is reproduced and fixed, with live read-only measurements. Credential-broker latency and transfer byte verification remain separate costs; the branch is not installed in the desktop app.

## Follow-up: credential reuse

After reviewing the diagnosis, the user authorized token reuse with independent authorization checks. Managed personal connector tokens now stay in process memory until one minute before their actual expiry. Account/permission changes invalidate credentials and reject old request objects or late credential responses. Concurrent retrievals share one request. The existing broker status endpoint remains the authority: browsing renews its authorization check every 30 seconds; each connector operation forces a fresh check before its first write and renews it during long writes. Virtual account listings explicitly recheck authorization even when they require no Google HTTP request. Tokens and file permissions remain separate.

The same read-only probe, account, folder paths and Bun 1.3.14 runtime were used before and after this follow-up. Every measured operation created a new connector and Google adapter, including initialization, so the results include the work repeated by sidebar expansions. Each repeat median uses three samples; network latency varies.

| Complete operation | Before token reuse | After token reuse | Observed reduction |
| --- | --- | --- | --- |
| My Drive expansion, repeat median | 1,547 ms | 779 ms | 49.6% |
| Nested folder expansion, repeat median | 1,830 ms | 1,144 ms | 37.5% |

Across the initial eight operations, token retrievals fell from eight to one. The six repeat expansions made zero broker requests. A further live request after a 31-second pause made one authorization-status request and zero token requests, confirming that authorization renewal is independent of credential reuse. That expansion took 1,587 ms, including an 801 ms status request. The cold account expansion still requires status and token retrieval; caching chiefly improves subsequent navigation. Live writes or transfers were not performed for this measurement.

Validation used the CI-pinned Bun 1.4.4 through `pnpm dlx bun@1.4.4 test`, leaving the installed runtime and dependencies unchanged. The credential cache/reuse, existing connector/own-OAuth/storage-account, Eigenwelt connection/refresh, storage transition, Google tree/native driver/cloud adapter/transfer, and agent storage-tool suites passed: **217 tests, 0 failures, 1,518 assertions across 13 files**. Tests exercise expiry, concurrent retrievals, authorization renewal, write checks, local permission changes, cross-tenant isolation, repeated 401 refresh, broker outages, disconnect races and same-user re-sign-in races. Server typecheck, plugin build, documentation generation/check and diff whitespace checks passed. This is targeted regression verification, not a successful full-server-suite claim.

The follow-up is implemented on `codex/storage-transfer-gdrive-sidebar`. Measurements use the branch source with the live account; the installed desktop application has not been replaced.

## Follow-up: native sidebar copies

Sidebar dragging already requested a copy, but same-connection copies still used the generic download, upload and destination-content verification path. The transfer endpoint now uses provider-side file copies within a Google Drive, OneDrive or SharePoint connection. Folder copies create the folder structure and copy each file, including native Google documents without exporting them. Originals remain in place. Cross-connection transfers retain their existing streaming behavior.

Provider completion and returned destination metadata are verified without reading file contents. Microsoft job monitors receive no OAuth token, use validated HTTPS provider URLs and do not follow redirects. Failed native operations report incomplete progress and never automatically retry through a byte transfer, because the provider may already have created or queued a copy.

The regression fixture represents a 4 GiB file and a paginated folder tree with an empty child folder. It rejects any content request: the old transfer implementation fails this test, while the native-copy implementation passes with one copy RPC and zero content transfers. A separate test exercises the actual sidebar HTTP/SSE endpoint and checks successful progress, one provider copy and zero content requests. The storage/credential/OAuth/tool regression run passed **262 tests, 0 failures**; the sidebar drag/progress suites passed **7 tests, 0 failures**. A subsequent Microsoft completion-redirect test also passed. Server typecheck, server build and bundled documentation checks passed. These are fixture and local HTTP tests; no live cloud write or transfer-speed measurement was performed.
