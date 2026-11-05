# Built-in browser automation

LegalWork uses the released OpenCode 2.1.4 browser plugin with the matching full
RPC controller vendored from the upstream desktop GUI. Native browser tools
provide navigation, stable element refs, snapshots, evaluation, diagnostics,
profiling and analysis. The controller source and MIT license live in
`browser-native/upstream`; generated JavaScript is checked by
`scripts/build-browser-controller.mjs --check`.

`legalwork_browser_open_url` creates an owned native tab and returns its initial
snapshot and an opaque `browser_url` extension capability.
`legalwork_browser_connect` adds these extensions to an existing owned native
tab. The capability is a credential: do not log, share or reconstruct it.
Paged snapshots, action batches, background captures and complete large-file
upload/download transfers preserve the existing LegalWork capabilities beyond
the native transfer and snapshot limits.

Each attachment belongs to its actual server, project, chat and trusted app
window. Main/server retain native engine credentials. Manual LegalWork server
connections use a typed browser-only gateway with their existing client token;
arbitrary native RPC is unavailable. Project approval and sandbox network
policy are checked before operations and continuously while attached. Missing
or unavailable authority denies automation. A cancelled delivered mutation may
have completed: inspect the page before retrying. Mutations are not replayed on
reconnection.

The default `persist:legalwork-browser` partition retains shared site cookies
and storage. Tabs keep separate control authority and project download roots.
It uses desktop networking/proxy settings even when the selected LegalWork
server is remote. Per-attachment tunnels do not overwrite that shared proxy.

See [the full native browser contract](../../../docs/opencode-v2-browser.md) for
all operations, inherited limits, permission/ownership checks, large-file
extensions and actual released-engine/Electron verification. Run
`pnpm --filter @legalwork/desktop exec electron scripts/browser-native-regression.mjs`
for that isolated zero-inference regression fixture. It needs the built server,
released engine and matching generated controller; it uses no account secrets
or global browser profile.
