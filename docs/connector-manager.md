# Server-owned MCP connections

LegalWork owns custom remote MCP connections and remote Firm Hub connectors.
Workspace engines consume an authenticated loopback MCP gateway. OpenCode itself
is unchanged; no engine fork or SDK patch is required.

## Ownership and data flow

```text
LegalWork app -- connect / callback / logout --> connector manager
                                                     |
workspace engine -- scoped gateway --> MCP client ---+--> provider
                                                     |
                                             encrypted credential vault
```

- The existing shared connector registry remains authoritative. A connection
  normally serves every workspace; an explicit workspace override has its own
  connection and grant. Connections are never merged just because URLs match.
- The manager owns OAuth discovery, client registration, PKCE, state validation,
  code exchange, refresh, upstream transports, and connection health.
- Engine MCP entries contain only a gateway URL, a workspace/connection bearer,
  and `oauth: false`. Provider headers, client secrets, access tokens, and refresh
  tokens stay in the server. The server's vault encryption key is removed from
  managed engine environments.
- The bundled `legalwork-mcp-gateway` plugin obtains each folder's effective
  entries at instance creation through a separate runtime capability. This keeps
  the correct workspace binding after rebuilds despite the shared bootstrap file.
  Its internal configuration endpoint cannot connect, log out, or edit accounts.
- Local command MCPs keep their execution path. Built-in Google/Microsoft
  integrations retain their existing server-owned provider adapters.

## Persistence and lifecycle

MCP configuration and credentials use the existing `OAuthVault` and its
`storage-oauth.vault` file, alongside built-in connector capabilities and
file-storage OAuth grants. A separate `managed-mcp` entry owns the MCP schema;
the shared vault serializes and merges writes without replacing other entries.
Registry rows hold public descriptors referencing stable connection IDs.

Encryption and key handling follow the existing vault policy: AES-256-GCM with
`LEGALWORK_ENCRYPTION_KEY`, or its existing adjacent `storage-oauth.vault.key`
file (mode 0600). No MCP-specific encryption code, key provider or key file is
created. `LEGALWORK_STORAGE_STORE` overrides the shared storage location for MCP
as well as the existing consumers.

A dedicated SQLite transaction in `storage-oauth.vault.mcp-owner.sqlite` admits
one MCP manager per shared credential store, across processes. Its lifetime lock
does not block built-in connectors writing through the shared vault. The OS
releases ownership on process exit; the application's main database is not held
locked.

Within that owner, each connection has a separate queue. Refresh rereads current
credentials inside the queue, performs the provider exchange, and saves the
rotated tokens before releasing it. Waiting requests reuse the replacement.
Unrelated connections and ordinary tool calls can run concurrently.

Disconnect first retires the connection generation and cancels its upstream
work. It then clears credentials through the same queue, before acknowledging
success. Late callbacks and refreshes cannot restore a disconnected connection.
Provider authorization-server identity is retained with a grant. Configuration
changes that change that identity invalidate the previous connection capability.
Changing enabled state or operation timeout preserves the grant.

Gateway bearers are process-local and rotate after server restart. Startup
configuration, live engine synchronization, and the folder plugin obtain current
bearers. An unreadable vault preserves its original contents and disables
remote engine entries until unlocked; it never falls back to engine-owned OAuth.

Firm Hub connection namespaces include platform, organization, and member.
Firm-provided headers/client secrets remain source-owned and memory-only; only
the member's OAuth grant and public configuration are persisted. Firm revocation
or sign-out retires the matching connection and clears its source configuration.

## Protocol and recovery

The gateway supports the current MCP 2026-07-28 wire protocol alongside
2025-era Streamable HTTP and legacy SSE. Modern per-request envelopes, MRTR
interactive rounds, Tasks extension requests, subscription streams, metadata and
other negotiated protocol methods pass through an authenticated HTTP hop. The
local gateway bearer, cookies and host headers never go to the provider; decoded
responses do not retain compressed encoding/length headers.

Older engines get a separate upstream SDK client for each gateway session. The
client auto-negotiates the upstream protocol and translates modern MRTR into the
engine's declared elicitation, sampling and roots handlers. Requests, progress,
cancellation, completions, resources, prompts and notifications retain their
workspace binding. OAuth credentials and refresh coordination remain shared.
The gateway preserves capabilities; it does not invent features an engine does
not offer. The protocol packages are pinned to official TypeScript SDK 2.3.1;
existing v1 consumers use its maintained 1.32.1 line.

Adding a connector also supports modern-only providers. Setup validates legacy
initialize results and, when necessary, sends a modern `server/discover` request
with its required method header and metadata. An HTTP 200 JSON-RPC error is not
mistaken for an anonymous successful connection.

OAuth callbacks preserve RFC 9207's issuer parameter from the desktop broker or
manual callback URL through the authenticated server callback. The SDK validates
that issuer before exchanging the code. Client registrations and tokens remain
bound to the discovered issuer. A 403 insufficient-scope challenge preserves the
existing grant and requests explicit consent for the union of existing and new
scopes; it never silently repeats the tool operation.

Only an explicit HTTP 401 can trigger refresh and one authenticated retry. An
ambiguous network failure or MCP tool failure is never automatically replayed.
Temporary refresh failures preserve credentials and apply a shared cooldown.
Rejected refresh credentials produce a shared reconnect-required status. Broken
provider transports are replaced on a subsequent request; existing recovery polls
consume the manager's status as well as the engine's transport status.

The existing sign-in dialog continues to bind the desktop callback before opening
the browser. Its completion request now carries the authorization state to the
server in `X-LegalWork-OAuth-State`. Server callbacks validate state, expiry,
connection generation, and PKCE. A pending sign-in survives engine rebuilds.

## Upgrade behavior

Managed desktop/server startup transfers existing custom OAuth MCP grants before
starting its new engine. The desktop first stops its previous managed runtime.
The importer compares other OpenCode processes’ credential-store paths with the
legacy source. Engines using another store do not block migration. If inspection
is denied or ownership is unclear, it leaves the old grant untouched. The connector reports that its saved sign-in
is waiting, rather than requesting a replacement login. Startup retries every
ten seconds, for at most six unsuccessful attempts per batch; only the exact new gateway engine
PID is excluded without inspection. macOS uses a bundled native helper, Linux
reads `/proc`, and Windows reads the process environment through Win32. Only
HOME/USERPROFILE and XDG_DATA_HOME path variables leave those readers; command
lines and other environment values are not returned. Recoverable transfer errors leave the
app usable and are retried within that batch. Externally attached engines are not automatically
taken over.

After repeated failures the connector reports **Sign-in transfer needs attention**
instead of spinning indefinitely. Its explanation distinguishes conflicting
engines, source-file access, encrypted-vault access, another transfer, changed
credentials and a grant already claimed by another profile. Arbitrary error
messages are not exposed. A cross-profile claim blocks immediately.
**Retry transfer** runs a fresh bounded batch and reconnects the engine without
requesting OAuth. **Sign in again** explicitly fences the old connection
generation and opens normal OAuth; it preserves the source or encrypted journal.
That action is unavailable while the encrypted vault cannot be opened. These
choices leave recovery available if saving the choice itself fails. These
controls apply to personal, plugin and Firm Hub connectors. Restart resumes the
durable handover with a new bounded batch; diagnostic retry counters are local
to the running server. Enabling/disabling a connector preserves a blocked state.
Transport recovery never replaces a migration error with a reconnecting status
or retries a transport whose saved-sign-in transfer is still blocked.

Different existing workspace configurations keep their separate bindings. Grants
are matched by connector name, provider URL and OAuth client; genuinely ambiguous
same-provider accounts are never assigned arbitrarily.

For an unambiguous matching connector, the importer preserves its access token,
refresh token, absolute expiry, scopes and OAuth client registration. No browser
sign-in or provider request is required during the transfer. Static API-key
configuration continues to migrate, and existing built-in connector grants stay
in their current vault entries. LegalMemory's app features obtain tokens through
the same manager and refresh queue as agent tools.

Recovery copies go into the existing OAuth vault under a migration entry. After
that write, a secret-free SQLite handoff registry beside `mcp-auth.json` records
the owning vault and connection. The destination grant is saved as staged in
the same encrypted vault before retiring any source entry. A staged grant cannot
authorize tools, refresh tokens or start another sign-in, including after restart.
Only then is the matching source entry removed with an atomic mode-0600
replacement; unrelated entries and the connector configuration are preserved.
Activation runs through the same connection queue, checking its generation so a
concurrent login, logout or configuration change wins. Vault file writes flush
before returning.

A failure before retirement leaves the source credentials in place. If retirement
has already succeeded but activation fails, the staged destination and encrypted
recovery copy resume the handover on retry; old credentials are not restored or
replayed. Migration and active transport recovery report a neutral connecting
state; a completed but unsuccessful reconnect still exposes its actual error.

An interrupted handover resumes from the encrypted recovery copy. A connection
marker prevents an old backup from replacing tokens already rotated by the new
manager, or resurrecting a logout. Cross-profile claims prevent a second
LegalWork profile from adopting the same rotating grant. Recovery copies are
not a mechanism for replaying old tokens after refresh or blindly downgrading.

URL/client mismatches, expired client secrets, malformed grants and ambiguous
old account names are preserved without automatic adoption. Such connections
may need a fresh sign-in; working, safely transferable connections retain theirs.
Workspace settings are committed to their shared destination before their old
rows are cleared, so interruption cannot lose those settings either.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm --filter legalwork-server build
pnpm --filter @legalwork/app typecheck
bun test --preload ./apps/server/test-preload.ts apps/server/src/mcp-manager.test.ts \
  apps/server/src/file-storage/oauth/session.test.ts apps/server/src/connectors/connectors.test.ts \
  apps/server/src/connectors/local-oauth.test.ts
OPENCODE_TEST_BINARY=/path/to/released/opencode bun test --preload ./apps/server/test-preload.ts apps/server/src/mcp-manager.engine.e2e.test.ts
```

The native-engine test signs in through an unmodified legacy engine, stops it,
and transfers its actual saved grant before starting two gateway-connected
engines. It verifies tool calls and rotating refresh without another sign-in,
folder-specific runtime bindings after rebuilds, login across an
engine rebuild, agent tool execution, simultaneous token expiry, disconnect
during refresh, shared reconnect status, fresh login, and an empty engine MCP
credential store. Runtime gateway credentials are also rejected by management
and internal configuration endpoints. CI runs this test with the shipped engine.

The current protocol and migration matrix, native-engine results, live-provider
checks, Windows VM coverage and limitations are recorded in
[`docs/reviews/connector-manager-live-qa.md`](reviews/connector-manager-live-qa.md).
The optional live Cloudflare test can be run without credentials or a paid model:

```sh
LEGALWORK_LIVE_MCP=1 bun test --preload ./apps/server/test-preload.ts \
  apps/server/src/mcp-gateway.live.e2e.test.ts
```

Protocol compatibility follows the official
[MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
and [TypeScript SDK 2.3.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1).
Downgrade migration is outside this change's scope.
