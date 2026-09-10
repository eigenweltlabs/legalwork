# Team file storage

Admins can add a connection for the firm in Settings → Integrations → File storage, promote an existing personal connection with **Make available to team**, or manage the same catalog in the platform's File storage page. Members receive the connections automatically; no installation is required. All seven providers use the same catalog and existing agent tools.

The platform owns configuration, credentials, permissions and revisions. LegalWork holds team credentials in memory, renews authorization on a 30-second lease and discards them after a failed sync, sign-out or firm switch. Enabled roots refresh every 30 seconds while the view is open. Credential updates, pauses, read-only changes and removals propagate through the same feed. Previously downloaded workspace copies remain local.

Files travel directly between the member's app and the connected storage. Internal network shares still require the member's device to have network/VPN access. Personal connections remain local and independent.

## Rollout

Deploy the platform storage API and database migration first. It requires the platform's existing versioned `HUB_SECRET_ENC_KEY` key ring. Team storage is gated by the `admin_hub` entitlement, and only current firm admins can change the catalog. Team synchronization ships with the file storage integrations.

## Verification

- `pnpm --filter legalwork-server test`: 607 passed, 17 optional tests skipped.
- `pnpm --filter @legalwork/app test`: 413 passed.
- Server/app type checks and builds, and `pnpm --filter @legalwork/app test:i18n`: passed.
- Platform integration suite plus `scripts/storage-fixtures/team-sync-check.ts`: real PostgreSQL migrations, encrypted storage, desktop tokens, two LegalWork workspace identities and a disposable MinIO bucket. Verified admin configuration, member auto-sync, agent list/search/read/write, read-only propagation and removal. Clerk's external membership service is substituted in this isolated test.

Run the cross-project test from the platform checkout with `TEST_DATABASE_URL`, `LEGALWORK_TEAM_SYNC_CHECK` pointing to this checkout's `scripts/storage-fixtures/team-sync-check.ts`, and optionally `LEGALWORK_BUN_BIN`; then `pnpm --filter platform test:integration`. MinIO defaults to the storage fixture on port 19290. Override it using `STORAGE_TEST_S3_ENDPOINT`, `STORAGE_TEST_S3_ACCESS_KEY` and `STORAGE_TEST_S3_SECRET_KEY`.

UI checks use synthetic catalog responses; the cross-project test exercises the actual APIs. Visual evidence is kept outside the source changes.
