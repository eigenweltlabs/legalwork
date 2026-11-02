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
