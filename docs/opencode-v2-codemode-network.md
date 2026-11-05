# Code Mode network boundary

Status: the user approved this additional engine adaptation on 2026-10-25.
The actual Mac ARM64 `.3` engine and production LegalWork HTTP integration pass
the focused acceptance gate below. Production distribution adoption and other-platform execution remain separate
gates. Certificate handling follows the user’s normal-store decision below. Earlier patches, recipes, artifacts and failed runs remain historical
evidence.

## What fails

Code Mode lets the agent combine tools in JavaScript. Its built-in `fetch` helper
currently sends HTTP directly from the engine process. In six actual candidate
engine cases, LegalWork's normal web tool obeyed the chat's network setting, but
Code Mode `fetch` reached the test endpoint under both Block and Approve without
an approval. This bypass must be closed before v2 adoption or paid v2 evaluation.

The fixture used the production LegalWork plugin and server policy, a loopback
HTTP sentinel and a programmed local provider: zero paid calls. It proves this
execution path, not real-model frequency, general HTTP compatibility or quality.
The normal tool's Approve case rejected the private address before transport but
reported an internal-error response; that error presentation remains a separate
limitation. The root independently verified all eleven evidence-file hashes and
five production-source hashes in the retained assessment receipt, SHA256
`1e479f13e6d2febf114e297bd8b211e96f2ceaf6933fd69dff08d181e53f5814`.

## Proposed boundary

Keep one engine and native Code Mode. Route each built-in HTTP request through
the native tool executor, where LegalWork's mandatory integration supplies raw
HTTP transport governed by the existing chat/session policy. Local calculations
and local tool composition remain available when network access is blocked.
If the managed transport is missing, fail that network operation before I/O.

This requires a second narrow, separately identified engine source adaptation.
The existing client/plugin SDK version remains 2.1.4. The earlier MCP readiness
patch, receipts and artifacts remain immutable historical evidence; a combined
candidate must receive new provenance, artifacts and acceptance results.

The adaptation must preserve the agent-facing `fetch` API: request methods,
headers, supported body types, status/headers/final URL, redirects and complete
text/JSON/byte results. Ordinary tool-result formatting must not silently truncate
or convert the raw result returned to the running JavaScript. Keep the native
inventory cache and existing session/tool context.

Before DNS or connection, resolve the exact session policy and authorize the
frozen request. Recheck each redirect and apply Fetch's method/body/header and
cross-origin credential rules. Bind resolution and connection so DNS changes
cannot bypass address policy. Stop, policy revocation and body-read cancellation
must propagate. Preserve local, non-network behavior supported by the existing
helper without introducing a new route to filesystem access.

## Limits and trace handling

- Add no request/response content caps, tool-output caps or agent-task deadline.
  LegalWork's existing page-reading broker has 4 MiB request and 16 MiB response
  limits plus a 16,000-character approval-review ceiling. Reusing that broker
  unchanged would reduce raw `fetch` capability, so the implementation must share
  policy while providing a complete raw transport and reviewable full request.
- Upstream already gives this helper a 30-second HTTP timeout and buffers its
  complete response. Preserve and explicitly document that existing timeout;
  waiting for a person's approval must not consume it. This is not a new limit
  on the agent's overall work.
- Public progress keeps the existing method/URL display. Full headers, request
  bodies and response bytes belong to the trusted private trace observer, rather
  than being copied into public progress or repeatedly into model context.
  The observer must report missing or failed capture rather than claim coverage.
- A source patch adds upgrade maintenance and requires rebuilt platform artifacts.
  It is not an upstream fix or an officially supported plugin-only interception.

## Required acceptance before adoption

Repeat the current fail-before/fix-after test against an actual compiled engine
and production plugin. Prove no DNS/transport before authorization; Block,
Approve/deny/allow, per-session isolation, redirect/address policy, missing
adapter, Stop and policy revocation. Exercise concurrent requests, full binary
and large request/response round trips beyond the existing broker limits,
headers/method/body semantics, local Code Mode with network blocked, and complete
private trace records without sensitive full payloads in public progress.
Re-run native tools, MCP, Code Mode and packaged startup acceptance on the newly
identified candidate. Broader platform and real-model acceptance remain separate.

## LegalWork service implementation and current evidence

The mandatory sandbox plugin registers the reserved `legalwork_raw_http` adapter.
It forwards the actual native chat, agent and cancellation signal to the typed
LegalWork `/workspace/:id/sandbox/http` route. The route checks actor scope,
workspace/chat ownership and the agent's permissions, then shares the existing
sandbox service's firm/member policy, approvals and settings-revocation handling.
It does not call the page-reading broker or inherit its content limits.

The raw transport uses per-request public Undici `Client`/`ProxyAgent` instances,
without replacing global fetch or the global dispatcher. It validates all DNS
answers after approval and binds connections to those answers. Direct connections
can fall back between the validated IPv6/IPv4 answers. Proxy requests use a
validated IP target while retaining the original HTTP Host and TLS server name.
Configured proxies are never silently bypassed. A proxy whose ACL requires a
hostname instead of an IP target may reject this stricter connection form; proxy
connections currently select the first validated destination address and do not
replay a non-idempotent forwarded request against other addresses.

The inherited 30-second budget covers DNS, connection, redirects and complete
body reads together, excluding every human approval wait. Gzip, Brotli, zlib and
legacy raw-deflate bodies are decoded completely. The transport preserves custom
methods rather than reproducing Bun's observed coercion of a long method to GET.
It adds no application request/response byte or header-count/length ceiling.
The old Bun listener's separate 256 MiB global request ceiling is removed; other
routes retain their existing explicit body limits. Responses remain buffered, as
in the original helper, and remain subject to available memory/runtime capacity.

Approvals expose the complete normalized request and SHA-256 through an
authenticated request download. The default dialog does not eagerly parse or
render a giant body. This is not a truncated preview or a request-content limit.
Successful/error raw tool inputs and outputs are available to the private native
tool observer. Native Stop interrupts the generic executor before its
`execute.after` hook: evidence must record that terminal result as unavailable,
alongside the before record, authoritative cancellation and actual socket close.
It must not invent an after record or duration.

The exact dependency is the maintained Undici 7.30.1 branch, localized under the
`undici-transport` alias in server and desktop. Undici 8.12.3 requires a
`worker_threads.markAsUncloneable` API absent in LegalWork's Bun 1.3.14. The alias
preserves the providers' existing optional Undici 8 dependency. The initially
tested Node HTTP/proxy-agent draft was rejected because Bun ignored its custom
agent and connected directly. It is not the implementation being accepted.
The final dependency diff adds only the two alias entries and the exact 7.30.1
package/snapshot, preserving the release-age policy and original SheetJS SRI.
[Undici's maintained-version policy](https://github.com/nodejs/undici#long-term-support)
supports the compatibility choice; it does not constitute platform execution
evidence.

Current zero-paid source evidence: 81 server tests/475 assertions, four approval
display tests, and app/server typechecks pass. Actual Node 22.23.4 and Bun 1.3.14
transport tests exercise independent proxy/origin sentinels, proxy authentication,
HTTPS forwarding/CONNECT, original TLS identity, extra CAs, validated-address
fallback, large headers/methods and Stop during CONNECT/body reads. A separate
26-case wire comparison against exact Bun 1.4.4 found no proxy-selection
differences for the tested NO_PROXY domain/apex/subdomain/port/IPv6/CIDR rules,
lowercase precedence and ALL_PROXY fallback.

Actual `.2` engine plus freshly bundled production sandbox plugin reached 106
assertions through block/deny/allow, chat-isolated approvals, redirect rechecks,
local data URLs while offline, concurrent requests, missing-adapter failure,
Stop/revocation socket closure and complete >5 MiB upload/>17 MiB response/private
trace evidence. Its strict final form Content-Type assertion still failed.
That real regression caused the separately reviewed `.3` header-order correction.
The `.2` failures and large private traces are preserved, not relabeled as a
passing adoption gate.

The unchanged focused fixture now passes against actual
`2.1.4-legalwork.http-policy.3`: one test, 112 assertions, zero failures and zero
paid model calls, repeated successfully. It uses the freshly bundled production
sandbox plugin and real LegalWork server/policy, not a mock transport. The final
evidence retains the exact plugin bytes, provider requests, native private trace,
target hits and results under
`.legalwork/scratch/raw-http-production-acceptance-20261025/http-policy3-final`.
The actual binary SHA-256 is
`b746c6bb9c424c75fdeefd476de4215dc3021ab8140a5aaa6dc41d3ec154a56b`;
its independently pinned provenance SHA-256 is
`6428a86c5f14aa8285e08f3d41b83aeb6f8df3fe9b0f77fb7a2e8a0a35e99093`.
Tests include the corrected form Content-Type, hidden tool catalogs, public
method/URL-only progress, full returned bytes, actual Stop/revocation socket
closure and missing-adapter failure before network access. Native cancellation's
missing terminal hook is recorded explicitly. The full-request download has
source/display tests; a physical approval-dialog download remains a separate UI
execution check.

Pinned proxy destinations preserve DNS policy and TLS identity. A proxy must
accept an IP destination with the original Host/SNI; hostname-only proxy ACLs
may reject it. Proxy transport selects the first validated destination address
and does not replay a potentially non-idempotent request against alternative
addresses. Direct validated multi-address connection fallback is tested. These
constraints are recorded rather than claiming identical behavior on every
enterprise network.

## Normal certificate store: final user decision

The user rejected custom certificate-file/folder loading on 2026-10-25.
LegalWork therefore does not read `SSL_CERT_FILE`, scan `SSL_CERT_DIR`, parse
X509 certificates or add certificate-path settings. The earlier directory/hash
and alternate-loader prototypes remain historical evidence and are not imported.

Raw HTTP uses the runtime’s public `tls.getCACertificates("default")` and
`tls.getCACertificates("system")` APIs on Node and Bun. This retains normal
bundled/default roots and includes the OS-trusted store. Both origin and proxy
TLS explicitly set `rejectUnauthorized: true`, so an inherited
`NODE_TLS_REJECT_UNAUTHORIZED=0` cannot disable this transport’s verification.
The runtime itself may honor its standard startup environment, including
`NODE_EXTRA_CA_CERTS`; LegalWork adds no file loader or certificate manager.
Tests use isolated native extra-root files solely as TLS fixture controls.

Managed OpenCode receives the supported `NODE_USE_SYSTEM_CA=1` flag so its own
native provider/MCP TLS also includes the OS store. This is necessary because
Bun’s untouched defaults do not automatically include system anchors. Existing
upstream per-provider TLS behavior is otherwise unchanged; the raw transport’s
explicit-verification guarantee must not be generalized to every upstream
setting. Certificate stores and runtime caches are platform-specific; this does
not promise custom directory/hash-lookup emulation or immediate live refresh.

A controlled empty `HOME` yields zero system anchors on this Mac in Node
22.23.4, Bun 1.3.14 and Bun 1.4.4. Normal OS `HOME` yields 61/35/35 respectively;
with the system-store flag their default stores include those anchors. The
actual engine test therefore separates isolated OpenCode discovery/data paths
from the OS keychain context. Counts are recorded without certificate contents.
Native Linux/Windows store execution remains a platform acceptance gate.

After this decision, the source group passes 92 tests/520 assertions and the
actual `.3` group passes seven tests/202 assertions, including the unchanged
112-assertion production HTTP gate and native service/recovery/storage checks.
Node 22 and dev Bun reject untrusted direct/proxied origin TLS and HTTPS-proxy
TLS even with the fixture's disable-verification environment switch. Two
independent fixture CAs work through the runtime's complete native extra-root
bundle; single-root and private-key-only negative controls remain rejected.
The actual compiled Bun 1.4.4 engine reports system/default/bundled counts of
35/153/118 under normal OS HOME, with every system root present in defaults.
No OS trust store was modified to perform these checks. The earlier empty-HOME
failure and overly short fake-startup watchdog failures are retained separately;
only fixture watchdogs changed, not product HTTP or migration deadlines.

Primary references:
[Node 22 public TLS root APIs](https://nodejs.org/download/release/latest-v22.x/docs/api/tls.html),
[Bun’s runtime environment settings](https://bun.com/docs/runtime/environment-variables),
and [the exact Bun 1.4.4 native root-store implementation](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/bun.js/bindings/RootCerts.cpp).

## Why this needs engine support

Pinned upstream source at commit
`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`:

- [Built-in fetch](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/codemode/web.ts)
  calls `globalThis.fetch` directly, with its own 30-second timeout.
- [Code Mode runtime](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/codemode/tool.ts)
  installs that extension directly in its cached runtime.
- [Public tool hooks](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/promise/tool.ts)
  cover ordinary tool execution, not this built-in HTTP extension.
- [Session HTTP hooks](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/model-request.ts)
  govern provider/model requests, not agent HTTP.
- [Extension execution](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/codemode/src/interpreter/extensions.ts)
  eagerly invokes the host function before `extension.before` completes. Merely
  exposing that existing callback cannot enforce pre-I/O authorization; the
  request boundary itself must defer transport until authorization succeeds.

A plugin could instead replace the whole Code Mode runtime, but that would
duplicate upstream tool catalogs, caching and execution behavior. The proposed
request-only adaptation is smaller. Disabling Code Mode, scanning generated JS
for URLs, or monkey-patching process-global fetch would not meet the approved
capability and architecture goals.
