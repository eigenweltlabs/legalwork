# Dropbox

Connect Dropbox in Settings → Integrations → File storage. Save a connection, then choose **Sign in**. An optional folder path limits browsing and search to that folder. Team connections share configuration; each person signs in separately on their own device.

Files open through the existing Memory Drive workspace-copy flow. Uploads use upload sessions, and remote saves use Dropbox revisions to reject stale edits. The standard storage tools expose native filename and content search. Search availability and indexing follow Dropbox's account and plan capabilities.

This provider branch is stacked on the file-storage integration branch and is held pending provider confirmation.

Validation: `bun test apps/server/src/file-storage/oauth/session.test.ts`, app tests, i18n and server/app typechecks. Real-provider smoke testing covers folder creation, listing, upload, read, edit, stale-save conflicts, download and native search, using synthetic files only. Reproduce with `LEGALWORK_OAUTH_TEST_DIR=/private/path bun scripts/storage-fixtures/oauth-live.ts dropbox` and complete the browser sign-in. The smoke test leaves its clearly named review folder in the account.

References: [OAuth](https://developers.dropbox.com/oauth-guide), [HTTP API](https://www.dropbox.com/developers/documentation/http/documentation), [team root handling](https://www.dropbox.com/developers/reference/path-root-header-modes).
