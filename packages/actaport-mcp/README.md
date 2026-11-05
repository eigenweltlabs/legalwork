# Actaport MCP

LegalWork's first-party Actaport MCP server speaks MCP over stdio and calls the official Actaport REST API directly. It implements all 92 operations from the pinned OpenAPI 3.1 specification (54 reads and 38 writes), but exposes only 15 everyday read tools by default. Authentication is internal, never an agent tool.

## Connect in LegalWork

Open **Extensions → Actaport**, enter the Kanzlei-Alias (realm), Client ID, Client Secret, API username and API password, then select **Save and connect**. Actaport must have enabled the API add-on. LegalWork verifies the API user through `/v1/info/me` before saving the credentials.

Before a customer visit, confirm the API add-on is already activated and the customer has all five API credentials supplied by Actaport. An ordinary Actaport account alone is insufficient. See the official [authentication requirements](https://api.actaport.de/api-docs/rest-api/introduction/authentication). Actaport provides [no separate public sandbox](https://api.actaport.de/api-docs/code-example/testing), so a real account is required for live acceptance. Use the local desktop worker for the bundled connection.

Credentials and access settings use the local server's existing encrypted `storage-oauth.vault`, shared with cloud-storage OAuth grants and Nango connections. Actaport has a profile-specific entry; it uses the same encryption, key configuration (`LEGALWORK_ENCRYPTION_KEY` or the vault's private key file), validation and write lock as those connections. The server's configuration and `LEGALWORK_STORAGE_STORE` override determine the vault location.

On first access, previous `actaport-credentials.enc` files are decrypted with Electron safeStorage and imported into the shared vault. The old file is removed only after a successful vault write; failed unlocks or writes preserve it for retry. An existing vault entry takes precedence over a leftover old file. safeStorage is used only for this migration, never for new credential writes. New connections follow the shared vault's availability rules; importing an old Linux `basic_text` file is rejected.

The desktop exposes a capability-protected loopback token service; MCP configuration contains its private discovery-file path and a write-mode flag, never API credentials. The MCP process receives short-lived access tokens. Disconnect removes saved credentials and revokes token access. One Actaport connection belongs to each desktop profile and is shared across its local workspaces.

The 15 everyday tools find/read matters, search/read contacts, list/read deadlines and tasks, list follow-ups and notes, search/list/read documents, download files and check asynchronous download status. All are read-only. Select additional groups in the connection settings only when needed:

| Optional group | Additional read tools | Additional write tools, if permitted |
| --- | ---: | ---: |
| Additional matter tools (`records`) | 8 | 19 |
| Finance (`finance`) | 14 | 15 |
| Administration (`administration`) | 13 | 0 |
| Large-file uploads (`uploads`) | 4 | 4 |

The settings show the number of selected tools and reconnect MCP after changes. Every API operation is assigned once in `toolsets.json`; tests require complete, non-overlapping coverage and matching read/write classification. Unselected tools are absent from `tools/list` and unavailable to `tools/call`, so their schemas do not enter the model's normal tool context. The default function definitions measured approximately 2,900–3,100 tokens with the `o200k_base`/`cl100k_base` tokenizers, about 70% less than the previous 54-tool read-only default. Provider formatting and tool results add their own context costs.

Read-only is the default. **Allow changes in Actaport** adds writes only within selected groups. For everyday changes, select **Additional matter tools** as well. Revoking a group or write permission blocks its calls in an already-running process before an API request. MCP annotations describe each action; the client's normal approval rules govern individual calls. Existing saved connections without group settings migrate to the 15-tool default. Replacing credentials resets groups and write permission.

The bundled desktop connection targets the local worker. Remote/headless workers can run the standalone server with their own private credentials; desktop credentials are not transferred to a remote worker.

## Standalone / headless

Build with `pnpm --filter @legalwork/actaport-mcp build`. Use Node 22 or newer to run `packages/actaport-mcp/dist/index.mjs`. The bundle includes its dependencies and specification; it needs no runtime package download.

Set `ACTAPORT_CREDENTIALS_FILE` to a private JSON file outside the workspace:

```json
{
  "realm": "your-firm-alias",
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "username": "your-api-user",
  "password": "your-api-password"
}
```

On Unix, the file must be private (`chmod 600`). On Windows, restrict its ACL to the worker owner. The MCP server rejects credential files larger than 16 KB. Optional environment variables:

| Variable | Behavior |
| --- | --- |
| `ACTAPORT_TOOLSETS=records,finance` | Add selected groups to the 15 everyday tools. Supported groups: `records`, `finance`, `administration`, `uploads`. Omit for the minimal set; use `all` to explicitly select every group. Unknown/duplicate groups fail startup. |
| `ACTAPORT_ALLOW_WRITES=1` | Enable writes within selected groups; default is read-only. This alone does not add write tools to the everyday set. |
| `ACTAPORT_FILE_ROOT` | Allowed file root for document uploads/downloads; default is the process working directory. |
| `ACTAPORT_CONNECTION_FILE` | LegalWork desktop's private token-service descriptor, supplied automatically by the app. Takes precedence over a credentials file. |

For the full API catalog, set `ACTAPORT_TOOLSETS=all` and `ACTAPORT_ALLOW_WRITES=1` explicitly. Desktop connections take groups and write permission from the private bridge, overriding environment hints. These preferences are encrypted alongside credentials and also enforced when short-lived tokens are requested.

Tokens normally expire after five minutes. The server uses the documented `password` grant, caches tokens, coalesces concurrent authentication and reauthenticates before expiry. There is no refresh-token flow. Rejected authentication is retried once; failed/uncertain writes and rate-limited requests are not automatically repeated. Rate-limit errors include `Retry-After` when supplied.

## Tools and files

Tool names are `actaport_` plus the specification's operation ID in snake case, for example `actaport_get_akten`, `actaport_get_akte`, `actaport_get_fristen`, `actaport_get_kollisionspruefung`, and `actaport_upload_document`. Parameters retain the API's names and types. `bezugsJahr` uses Actaport's reference year, such as `26` for `42/26`. JSON request bodies are passed as `body`; filter/sort arrays become repeated query parameters. Only declared parameters and bodies are accepted. Schema defaults are descriptive; the adapter does not silently apply them.

- **Multipart uploads:** `body.file` is an existing file path within the file root, `body.ordner` is optional. The filename is preserved. Direct uploads are limited to 50 MB; larger files require the optional TUS tools.
- **Downloads:** `actaport_download_document` requires `id` and `saveTo`, a new file path inside the file root whose parent directory already exists. It never overwrites files. Downloaded files can be opened in LegalWork's document viewer.
- **Large downloads:** Actaport returns `201` with a download-status resource instead of file bytes. Call `actaport_get_document_download_status` to inspect its state and obtain the documented temporary external-storage link. This server returns that link; it does not fetch external storage or forward bearer tokens to it.
- **TUS:** tools cover OPTIONS, POST, GET, HEAD, PATCH, DELETE, assembly status and linking. PATCH takes a base64 `body` (at most 10 MB per chunk). Protocol headers retain their API names, such as `Tus-Resumable` and `Upload-Offset`. Returned protocol headers include upload offsets and location. Use the declared tool schema for required headers.
- **Responses:** JSON is returned as structured data and text; HEAD and empty responses return status and relevant headers. JSON/text responses are capped at 10 MB and direct file downloads at 60 MB. Provider error bodies are not returned to the agent. HTTP redirects are rejected.

The API user determines accessible records. The adapter exposes fixed specification endpoints; tools cannot provide an arbitrary URL or authorization header.

## Specification and maintenance

The upstream OpenAPI document (SHA-256: `2d485ea84af6cbe526fa3b98f3cd097db63566a6c5ce4be0e2baa367e59e59aa`) was retrieved on 2026-10-13 from [Actaport's official OpenAPI document](https://api.actaport.de/api-docs/public-api.json). Its source documentation is [the API reference](https://api.actaport.de/api-docs/rest-api/reference/public) and [authentication guide](https://api.actaport.de/api-docs/rest-api/introduction/authentication).

`contract.json` retains the 92 operation definitions and their 81 reachable input schemas. Unused response schemas and documentation are omitted. The source URL and upstream digest are recorded in the file; runtime startup never fetches a specification. Regenerate from the pinned original with `node packages/actaport-mcp/scripts/update-contract.mjs /path/to/public-api.json`. The generator verifies the source digest before writing. Updating the pin requires reviewing the upstream changes and rerunning the MCP tests. The adapter handles these quirks of the published document:

- Some JAX-RS path templates have regexes and missing parameter declarations. Their required path IDs are recovered from the template, with numeric/UUID validation where specified.
- Polymorphic request schemas inherit a base containing a union back to its subtypes. The adapter inherits base fields without that recursive union and applies the declared discriminator mappings as subtype tags.
- Path-level parameters are inherited by their operations.

Some write operations, such as `createKostenstelle`, declare no body. This implementation follows the published schema and does not invent undocumented fields. Live testing may reveal vendor specification omissions requiring confirmation from Actaport.

## Verification

```sh
pnpm --filter @legalwork/actaport-mcp typecheck
pnpm --filter @legalwork/actaport-mcp test
node apps/desktop/scripts/prepare-actaport-mcp.mjs
pnpm --filter legalwork-server build
node --test apps/desktop/electron/actaport.test.mjs
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/app test:i18n
```

The tests use fixtures and include an actual Node subprocess MCP handshake. They do not access a live Actaport account. For live acceptance, connect an API-enabled test account, find a matter, download/open a document, repeat after token expiry, and test approved writes in a disposable matter. The desktop build scripts compile and include both MCP and authentication bundles on all desktop platforms. At startup, they are copied into the desktop profile at stable paths so AppImage mounts and Windows updates do not invalidate saved MCP commands. The worker's Node search path includes LegalWork's bundled runtime, so a separate Node installation is not required.

On 2026-10-15, a fresh download of the official OpenAPI document matched the pinned SHA-256 above. All 92 operation definitions and all 81 retained input schemas matched the bundled contract. This verifies specification compatibility, not a successful login against a customer's tenant. Start live acceptance with the default 15 read tools and writes disabled: find a known matter, list its documents, download a small PDF into the workspace, and repeat a read after five minutes to check reauthentication.
