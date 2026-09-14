# OneDrive and SharePoint

Both connections use one Microsoft public desktop OAuth application with PKCE. Each person signs in separately. Team settings share the folder and access policy; personal tokens stay encrypted on the device.

Choose OneDrive for the signed-in person's drive, or paste a folder sharing link. For SharePoint, paste a site, document library, or folder URL. The account must already have access to that location. Microsoft 365 tenant policies may require an administrator to approve the application.

Memory Drive uses on-demand folder pages, native filename/content search, local working copies, uploads, and version-aware saves. Transfers use upload sessions with bounded chunks and the provider's file-size limits. Microsoft-specific items without downloadable file content must be opened in their original app.

For a custom application, set `LEGALWORK_STORAGE_MICROSOFT_CLIENT_ID`. Register a public desktop client with `http://localhost/callback`; Microsoft ignores the loopback port. Delegated scopes are `User.Read`, `Files.Read.All` for read-only connections or `Files.ReadWrite.All` for writable ones, `Sites.Read.All` for SharePoint discovery, and `offline_access`. No client secret or application permission is required.

Run the opt-in synthetic live test with `LEGALWORK_OAUTH_TEST_DIR=/private/test-directory bun scripts/storage-fixtures/oauth-live.ts onedrive`. Set `LEGALWORK_OAUTH_TEST_ROOT` to a SharePoint folder URL and use `sharepoint` to test a licensed tenant. The script leaves its clearly named synthetic folder for inspection.

References: [Microsoft OAuth PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Drive search](https://learn.microsoft.com/en-us/graph/api/driveitem-search?view=graph-rest-1.0), [Upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0), [Site discovery](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0).
