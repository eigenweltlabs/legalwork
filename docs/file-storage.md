# Connected file storage

Settings → Integrations → **File storage** manages workspace-specific storage
connections. Each enabled connection appears as a named root in Memory Drive.
The settings page provides provider cards, add/edit forms, a read-only connection
test, read/write access, pause/resume, and disconnect. Disconnecting removes the
configuration only; it does not delete source files.

## Providers

| Type | Configuration and authentication | Directory behavior |
| --- | --- | --- |
| Network share (SMB) | Network address, share name, optional folder prefix/domain, port (445 default), username/password. SMB 2.1/3 with required signing and optional required encryption. | Direct directory listing and native filename matching. |
| WebDAV | HTTP(S) endpoint, optional username/password. Works with standards-compliant WebDAV file servers. | Depth-one PROPFIND for browsing; explicit filename search walks descendants. |
| S3-compatible | Bucket, region, optional endpoint/prefix/path-style, access key + secret and optional session token; alternatively server AWS credentials. | ListObjectsV2 with `/` delimiter and continuation tokens. Covers AWS S3 and compatible APIs such as MinIO. |
| Azure Blob Storage | Account, container, optional endpoint/prefix, account key or container SAS. | Hierarchical blob listing with continuation tokens. |
| Google Cloud Storage | Bucket, project, prefix, optional service-account JSON; otherwise server application-default credentials. Custom endpoint for emulators. | Objects list with delimiter and page tokens. |
| SFTP | Host, port, username, absolute root, mandatory SHA256 host fingerprint; password or SSH private key with optional passphrase. | Direct children over SSH. Existing-file replacement uses the OpenSSH POSIX rename extension. |
| FTP / FTPS | Host, port, login, root, explicit TLS (default), implicit TLS, or plain FTP. | Direct FTP directory listing. Certificate validation remains enabled for FTPS. |

Cloud roots target existing buckets/containers. Folder creation uses zero-byte
directory markers. Account-based Drive/Dropbox/OneDrive connectors remain in the
existing Connectors tab. SMB connects directly without mounting the share. Local folders and NFS are not providers in this tab. Older local-folder connection records are ignored and
removed on the next settings write; their source files are untouched.

When using Bun, FTPS requires a server built/run with **Bun 1.4.2+**. The desktop's
Node runtime is also supported. Bun 1.3.9 intermittently
truncated successful TLS directory transfers in reference-service tests. The
same client passed 2,000 consecutive listings on Bun 1.4.2; release builds now
use that version, and older servers return an explicit FTPS runtime error.

## Memory Drive behavior

Root metadata comes from the local configuration store without touching any
provider. Expanding a folder fetches that folder only. S3, Azure and GCS use
provider pagination; SMB, WebDAV, SFTP and FTP return a direct-directory
listing and paginate it into 100-item UI pages. A provider failure is shown on
the affected folder with Retry, and does not block other roots.

Select a writable folder to upload multiple files, drop files onto it, or create
a child folder. New uploads reject existing names. Opening a file downloads a working
copy under `.legalwork/storage-downloads/` in the workspace and opens it in the
existing document sidebar, with the usual live editing tools and external-app
controls. Text, DOCX, XLSX and PPTX use the existing editors; PDF, image, audio
and video have previews. Office-format fidelity follows those editors.

Edits and editor/agent automatic saves update the working copy. **Save…** offers
**Save to [connection]** to publish it back, or **Save local copy…** to keep a
separate named file in the workspace. Local save never changes the connected
file; existing local names are protected. Read-only sources can still be edited
as local copies when the workspace permits writing. Working copies are retained
so drafts survive closing the viewer. **Open latest from [connection]** saves the current working copy locally and opens a fresh copy of the source, allowing recovery after a conflict.

Uploads and downloads stream through disk with bounded buffers; the artificial
50 MiB transfer limit is removed. Provider limits still apply (S3 currently uses
single PUT, with the provider's 5 GB limit). The legacy base64 API alone retains
a 50 MiB inline-response limit. The UI and agent use streaming/working-copy
endpoints. Preview/editor capabilities remain those of the existing viewers;
large text is paged by the agent without buffering the entire text in memory.
These connections are not automatically indexed in LegalMemory.

Every edit includes the version read when opening the file. S3/Azure use ETags,
GCS uses generations, and WebDAV requires a strong ETag for editing and also
checks a content hash to catch implementations that reuse ETags for rapid edits. A WebDAV
server without one remains browsable and supports new-file uploads.
SMB, SFTP and FTP saves compare content hashes before replacement. SMB/SFTP/FTP
stage replacements before renaming, and this server serializes mutations of
each connected path. SFTP servers lacking POSIX rename preserve the original
and reject replacement rather than truncating it. File-server protocols cannot
provide atomic compare-and-swap against external writers; an external change
between the final hash check and rename can still race. Cloud preconditions
provide stronger concurrency guarantees. Conflicts retain the editor's draft,
which remains in the workspace copy. Closing or reloading a dirty editor
requires an explicit discard.

## SMB and RA-MICRO shares

For a path like `\\OFFICE-PC\RA-MICRO\Documents`, enter address `OFFICE-PC`,
share `RA-MICRO`, prefix `Documents`, and the account that can access that share.
Enter the Windows domain separately when required. Signing is always required;
SMB 3 encryption can be required in Settings. NTLMv2 accounts are supported;
Kerberos-only authentication, DFS referrals and SMB 1 are not implemented.
Use the actual share address rather than a DFS namespace.

The agent's native `name` search uses SMB QUERY_DIRECTORY and reports
`search.scope: "folder"`. It matches names in the selected directory, with
100-result pages; it does not claim recursive or full-text search. The agent can
search multiple configured connections and must identify each folder searched.
SMB junctions/reparse points are excluded, and Windows traversal, device names,
alternate data streams and wildcard file paths are rejected.

This provides file access to shared RA-MICRO folders. It does not interpret
RA-MICRO databases, matter metadata or application-level permissions, and does
not register new files in E-Akte. Actual RA-MICRO/Windows installations were not
available for testing. Use share/account permissions appropriate to the files.
Staged replacements require directory rename/delete permissions and inherit
that directory's ACL, like a new uploaded file; external writers can still race
the final content check. Busy/locked files fail without truncating the original.

The pinned `smb3-client` dependency is alpha software. The checked-in pnpm patch
adds native search patterns, no-follow metadata, exclusive staging and replace
rename, fixes Samba directory continuation and no-match handling, and corrects
stream backpressure and initial credit accounting. It also applies idle timeouts
and releases cancelled streams/credit waiters. Both server and Electron package
include the patched dependency. Reference tests use real Samba 4.17.12 with
required SMB 3 encryption; a separate SMB 2.1 share verified required signing.

## Ownership and credentials

Only a host/owner can list or manage connection settings. Workspace viewers can
browse/download; collaborators can upload/edit when both the server and the
connection permit writes. Provider permissions also apply. Configuration is
workspace-scoped and kept outside the workspace in `file-storage.json` next to
the server configuration, or at `LEGALWORK_STORAGE_STORE` when set.

The store uses atomic writes and mode `0600`. Credentials are stored on the
server as plaintext protected by filesystem permissions, not in browser
storage or workspace exports. API responses expose only the names of configured
secret fields; omitted secrets are preserved on edit, and explicit empty strings
clear them. Provider errors are sanitized to avoid returning credentials or
signed URLs. Protect the server account and use narrowly scoped provider
credentials. Connection testing lists a root and never writes a probe file;
success confirms read access, not write permission.

## API

All routes are under `/workspace/:id/storage` and use the existing LegalWork
authentication and role model.

| Method/path | Purpose |
| --- | --- |
| `GET /` | Owner: redacted connection settings |
| `POST /`, `PUT /:storageId` | Owner: add/update a connection |
| `POST /test?connectionId=…` | Owner: test submitted settings, retaining existing secrets when omitted |
| `DELETE /:storageId` | Owner: disconnect |
| `GET /roots` | Enabled root metadata, no provider access |
| `GET /:storageId/capabilities` | Read/write access and supported native search modes |
| `GET /:storageId/search?mode=…&query=…&path=…&cursor=…` | Scoped native search with provider pagination or truncation |
| `POST /:storageId/filename-search` | Literal, case-insensitive filename search across descendants: `{query, path?, cursor?}`; returns matches, `scanned`, and `nextCursor` while unfinished |
| `GET /:storageId/children?path=…&cursor=…` | One folder page, optional continuation cursor |
| `POST /:storageId/checkout` | Stream a source into a workspace working copy: `{path}`; returns local path, version, size and write capabilities |
| `POST/PUT /:storageId/content?path=…&version=…` | Raw streaming upload/create or versioned replacement |
| `POST /:storageId/from-workspace` | Publish `{path, localPath, mode, version?, contentType?}` from a workspace file |
| `POST /:storageId/local-copy` | Keep `{localPath, targetPath}` exclusively inside the workspace; does not write the source |
| `GET /:storageId/file?path=…` | Base64 content, content type, version and writable flag |
| `POST /:storageId/file` | New upload: `{path, dataBase64, contentType}` |
| `PUT /:storageId/file` | Edit: same body plus required `version` |
| `POST /:storageId/folders` | Create a folder: `{path}` |

Paths are relative to the connection root; empty path denotes the root for
listing only. Absolute paths, traversal, empty segments, backslashes and control
characters are rejected. Upload/edit operations are audited using the existing
workspace audit system.

## Agent access

The bundled agent uses one tool set across all providers and multiple connections:

| Tool | Purpose |
| --- | --- |
| `storage_list_connections` | Discover enabled connections in the task's workspace; returns `connection_id`, name, type and write access without scanning files |
| `storage_get_capabilities` | Discover a connection's supported operations and native search modes |
| `storage_list_folder` | Read one folder page; pass its cursor to continue |
| `storage_search` | Search selected `connection_ids`; each source returns its own results, cursor or error |
| `storage_search_filenames` | Find filename text across descendants on any provider, using metadata listings; separate continuation cursor per connection |
| `storage_read_file` | Read bounded UTF-8 text or download a document into the workspace for existing document tools |
| `storage_write_file` | Create from text/a workspace file, or replace using the version returned by a read |
| `storage_create_folder` | Create a folder within a writable connection |

Every file result retains its connection ID and root-relative path. Identical
filenames in different connections remain distinct. Binary files are downloaded
to `.legalwork/storage-downloads/`; editing this copy does not update the source
until `storage_write_file` succeeds. Read-only connections and viewer permissions
apply to agent writes just as they do to the sidebar. Provider credentials are
never included in tool results.

| Provider | Native search exposed |
| --- | --- |
| S3-compatible, Azure Blob | `path_prefix`: case-sensitive start of a relative object path, with continuation pages |
| Google Cloud Storage | `path_prefix`, plus literal filename `name` matching via `matchGlob`, with continuation pages |
| WebDAV | `name` and/or `content` when discovered through RFC 5323; optional operators are probed if schema discovery is unavailable |
| SMB | `name`: native literal filename matching in immediate children of the supplied folder, with 100-result pages |
| SFTP, FTP/FTPS | No standard search; browse folders |

Native search respects the configured connection root and optional folder scope. It
does not build a LegalMemory index, extract matter/entity metadata, perform RAG,
or silently crawl folders. WebDAV content search follows the connected system's
semantics. WebDAV has no standard continuation cursor: partial or capped results
are marked `truncated`, and the agent must narrow the query. An unavailable or
unsupported source is an explicit per-connection error, never an empty success.

Memory Drive's **Search filenames** searches LegalMemory and every enabled
storage connection, including unopened folders. Results are grouped by connection
and show their relative path; opening a match uses the same workspace-copy viewer
as browsing. Search remains available when only external storage is connected.

The sidebar and `storage_search_filenames` use literal, case-insensitive substring
matching. S3, Azure and GCS enumerate flat metadata pages; directory protocols
walk folder listings. No file contents are downloaded or indexed. Each request
checks at most ten listing pages and returns at most 100 matches. An empty page
with `nextCursor` is unfinished. The sidebar continues until a display page is
ready or the source is exhausted; **Load more** continues longer result sets.
Changing the query stops the previous scan. Ordinary browsing remains lazy.
Large or distant connections can take longer; failures remain visible per source.
Listings are live, so concurrent external changes can affect pagination; refresh
to rerun the search. These filename scans are distinct from provider-native
content search and LegalMemory's indexed search.

Filename-search regression checks (2026-09-10):

- `pnpm --filter legalwork-server test`: 601 passed, 17 skipped.
- `pnpm --filter @legalwork/app test`: 413 passed.
- With the reference services running, `LEGALWORK_STORAGE_INTEGRATION=1 NODE_EXTRA_CA_CERTS=/tmp/legalwork-storage-fixtures/ftps-cert.pem pnpm --filter legalwork-server exec bun test src/file-storage.e2e.test.ts src/file-storage/filename-search.test.ts src/opencode-plugins/legalwork-storage-tools.test.ts`: 28 passed on Bun 1.4.2.
- Server build, app typecheck, `test:i18n`, and `pnpm build:ui` passed.
- Native Electron verification: mixed-source filename results, S3 result opening
  in the existing sidebar, spreadsheet rendering, and local/remote save choices.

## References and verification

The adapters follow the providers' reference APIs and use their maintained SDKs:

- [SMB QUERY_DIRECTORY](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/10906442-294c-46d3-8515-c277efe1f752) and [smb3-client](https://github.com/euricojardim/smb3-client)
- [S3 ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
- [Azure Blob hierarchical listing](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-list-javascript)
- [GCS objects.list](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list)
- [WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html) and [webdav-client](https://github.com/perry-mitchell/webdav-client)
- [WebDAV SEARCH RFC 5323](https://www.rfc-editor.org/rfc/rfc5323.html)
- [ssh2-sftp-client](https://github.com/theophilusx/ssh2-sftp-client)
- [basic-ftp](https://github.com/patrickjuchli/basic-ftp)

See [reference fixture setup](../scripts/storage-fixtures/README.md) for MinIO,
Azurite, fake-gcs-server, Samba, WsgiDAV, AsyncSSH and FTP/FTPS services, integration
tests, an isolated dev app with seeded documents, and their backing data locations.
The dev app makes actual protocol requests to running reference services: MinIO,
WsgiDAV, AsyncSSH, and pyftpdlib. Azure and GCS tests use Azurite and
fake-gcs-server emulators, not live cloud accounts. This verifies protocol behavior
against those implementations; live-cloud credentials, IAM policies, and deployment
behavior still require testing with the target account. The normal API test suite
also uses controlled HTTP fixtures for edge cases such as weak ETags and oversized
files. WebDAV SEARCH discovery, native query construction and partial results
use HTTP contract fixtures; WsgiDAV does not implement SEARCH. Agent tests cover
multiple sources, per-source failures/cursors and workspace path confinement.
The live reference tests also run agent create/read/edit/download/save-back flows
over all eight protocol variants, including 51 MiB transfers, explicit local/remote saves and conflict retention. These test fixtures are separate from the dev
app connections.

Validation on Bun 1.4.2 (September 9–10, 2026):

| Check | Result |
| --- | --- |
| `pnpm --filter legalwork-server test` | 595 passed; 17 optional tests skipped |
| `pnpm --filter @legalwork/app test` | 410 passed |
| `pnpm --filter @legalwork/desktop test` | 101 passed; 1 skipped |
| Reference fixtures with `LEGALWORK_STORAGE_INTEGRATION=1` | 18 passed, covering seven provider types and both FTP/FTPS |
| Working-copy/path tests | 3 passed; workspace escape, interrupted downloads, existing-file protection, Windows names |
| WebDAV SEARCH and agent contract tests | 10 passed; multiple sources, partial failures, cursors, scoped queries and document save-back |
| Server/app typechecks, app `test:i18n`, and `node scripts/i18n-audit.mjs --ci` | Passed |
| `pnpm test:e2e` | Passed with an isolated workspace and OpenCode sidecar |
| Server `build`, `build:bin`, and `pnpm build:ui` | Passed; existing UI chunk-size warnings remain |
| Built Node modules with TypeScript stripping disabled | Imported successfully; seven adapters verified, including encrypted SMB with a 51 MiB hash check and versioned writes |
| Built storage plugin + running OpenCode engine | All seven tools registered with argument schemas; packaged Node plugin searched SMB and GCS together and read the SMB working copy |
| Compiled server HTTP smoke test | All six roots listed/read successfully |

Browser verification covered adding/testing/editing settings while retaining
hidden credentials, lazy nested folder requests, sidebar upload and folder
creation, text and DOCX saves verified in the source files, stale-write
conflicts retaining drafts, unsaved-change confirmation, and read-only FTPS. Sidebar regression checks cover opening storage tabs outside
a chat, source isolation, tab deduplication, transcript refreshes, and cancellation
of tab close/switch with an unsaved draft. The September 10 follow-up also verified a 51 MiB upload through the browser file picker, SMB text local-save/source-unchanged followed by explicit publish, a CSV cell edit published through the shared Save menu, a DOCX edit verified in the Samba source, and opening the latest source into a fresh working copy.
