# Google Drive

In File storage, add Google Drive, optionally paste a folder link, save and sign in. An empty folder uses My Drive. Shared-drive folders use the same flow. Team setup shares the selected folder and access policy; each person authenticates separately.

Memory Drive lists folders on demand. Standard storage tools expose native filename and content search, filtered to the selected subtree. Stable file IDs distinguish duplicate names. Google Docs, Sheets, Slides and Drawings export as workspace copies; those exports can be edited locally or uploaded as new files. They cannot overwrite native Google documents.

Binary-file saves check the content revision, including immediately before an upload commits. Drive resumable uploads do not consistently enforce conditional headers, so this is not an atomic lock against edits in other applications. Drive retains its own revision history. Native exports remain subject to Google's export limits.

This branch is stacked on the file-storage branch and held pending provider confirmation.

Official desktop builds receive installed-app client metadata during packaging. Source builds can set `LEGALWORK_STORAGE_GOOGLE_CLIENT_ID` and `LEGALWORK_STORAGE_GOOGLE_CLIENT_SECRET` for their own **Desktop** OAuth client. Never use a confidential web-client secret. Access and refresh tokens are stored separately in an encrypted local vault.

Validation: real Google Drive tests covered folder creation, upload, list, read, edit, stale saves, download, native search, duplicate names, native exports, empty files and root boundaries. Reproduce with a private `LEGALWORK_OAUTH_TEST_DIR` using `bun scripts/storage-fixtures/oauth-live.ts google-drive`, followed by `bun scripts/storage-fixtures/google-drive-live.ts`. Tests leave clearly named synthetic review folders. OAuth/working-copy tests, typechecks and build also run on this branch.

References: [Drive API](https://developers.google.com/workspace/drive/api/reference/rest/v3), [scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads).
