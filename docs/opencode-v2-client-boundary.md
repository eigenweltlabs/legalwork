# Native client connection metadata

Managed LegalWork engines use shared application-generated configuration and
disable automatic native project/ancestor discovery. A registered project does
not need a folder-trust approval. Settings views include saved app-owned values;
public native catalogs remain the authority for effective providers, models,
agents and connectors after location-specific transforms. App-owned providers
retain editing without a project configuration document. Dormant authored files
are preserved and diagnostics mark those sources `not_loaded`, without expanding
private references. The authored-document provenance and approval behavior below
applies to the separate explicit native-project mode, not normal managed desktop
configuration.

LegalWork's public engine proxy exposes safe connection and model metadata to
viewer and collaborator clients. Native config reads and provider/model/agent
catalogs omit resolved API keys, endpoint URLs, authentication headers, OAuth
client secrets, environment values and arbitrary transport settings/body bags.
Internal engine/server/main clients keep the complete definitions. Raw authored
configuration file editing requires trusted host access.

Model IDs, canonical providers, capabilities, context/output limits, costs,
variant IDs and supported typed generation controls remain available. The
server derives the exact default variant from the complete settings before
removing private fields, so a header-only or custom-body variant does not silently
become a different default. Raw standalone native clients can still infer their
defaults directly. Arbitrary provider-specific request fields are deliberately
not echoed into the public UI; they remain effective inside the engine.

Settings snapshots carry a read-only marker and cannot be submitted as executable
configuration. Targeted app-owned provider edits retain omitted saved endpoints,
keys, headers and model transport options. Only supplied replacements or explicit
removals change them. Model discovery can use an authorized app-owned saved
endpoint without returning it to the client; a new endpoint cannot receive a
previous endpoint's saved key.

Connector settings return connection type, enablement, timeouts, OAuth presence,
field presence and header/environment/setup variable names. Saved values are
blank in forms with an explanation that omission keeps them. Explicit header or
environment removal, OAuth/cwd reset, executable/arguments edits and setup answers
are sent separately to the server. The server resolves stored templates; it does
not round-trip masked executable definitions. Authored native connectors remain
read-only in these forms, with native sign-in still available.

Provider forms use the same ownership boundary. Explicit display metadata makes
an app-owned provider editable only while its defining native document is the
receipt-owned LegalWork projection. Authored project, ancestor, global, or higher
priority definitions remain read-only, including a winning override of a saved
app-owned row. Models and native sign-in remain available; refresh/edit controls
cannot silently write a competing app-owned definition. A stale form rechecks
ownership before saving. Offline or unapproved reads inspect literal ownership
only and do not expand authored private variables or activate project plugins.
Without resolved native provenance, provider forms stay noneditable; firm-owned
provider IDs stay noneditable even if a saved member row uses the same ID.

`GET /workspace/:id/config` reads ordered native `config.get` documents only
after project admission is ready. The native loader expands file/environment
references and validates their resolved types. LegalWork sanitizes those
documents for a read-only settings display; it does not reimplement expansion
or claim that a flattened document view is the final transformed engine state.
Native provider/model/agent/MCP catalogs remain runtime authority. Before
approval or while offline, the view contains only typed LegalWork-owned saved
settings and explicit `authoredConfig.status` metadata. Its paths name actual
reviewed project/ancestor JSON/JSONC documents, excluding the generated selection
document, private host/firm files and private referenced-file paths.

Runtime diagnostics use the same source boundary. An authored source is
`resolved` only when the native engine actually returned that document; a
nonloaded source is marked `not_loaded`. Invalid raw enum placeholders therefore
do not cause unrelated settings/inventory reads to fail before native expansion.
The trusted host's raw configuration/export surfaces still preserve originals.
App-owned model discovery reuses a saved key only for an exact app-owned,
non-firm provider and its unchanged endpoint; authored-only keys are not reused.

LegalWork's explicit authorized-folder parser remains conservative: literal
saved folder rules grant access, while authored file/environment references in
those rules are not expanded into new application-level folder grants. Native
agent file permissions continue to be enforced separately. This change does
not reinterpret native configuration as writable LegalWork settings.

Native Firm Hub presets contain only provider/model choices and safe generation
metadata. A custom endpoint is marked as requiring recipient setup; copied models
remain disabled until that connection is configured. Existing recipient
connections retain their private values. Canonical builtin provider choices
remain usable. A private header-only/custom transport variant is effective
locally, but its confidential behavior is not a portable executable definition in
an ordinary metadata-only preset. The recipient must supply its own private
connection settings. The existing explicit encrypted MCP secret-sharing flow is
separate and unchanged. Hosted Hub acceptance has not been exercised against a
live account in the zero-inference migration fixtures.

Verification uses synthetic credentials only: the actual released 2.1.4 CLI and
real LegalWork proxy prove no synthetic values reach either public scope through
config/provider/model/agent reads; global credential SSE events contain an empty
metadata payload, and raw credential endpoints remain denied. Typed settings
tests prove private-value preservation and authorized endpoint discovery. UI
fixtures cover selected manual-server connector metadata, safe form submission,
header-only/custom variant defaults and preset setup. These checks use no paid
inference or real account credentials.

The additional released-engine regression uses an authored JSONC permission
whose effect is a private file reference: an invalid private enum stays
unexpanded before approval, then the valid effect resolves through the native loader
after approval. Keys, endpoint values and referenced private paths never reach
the public config or diagnostics, and authored bytes remain identical.

The retired `opencode-chrome-devtools` V1 adapter is no longer built or injected.
Only its exact package spec or former LegalWork managed path is retired during
app-owned config conversion. Saved rows and user files remain intact; unrelated
custom plugin specs are preserved. Native browser/controller and LegalWork
extensions supply its replacement, with the behavior and limits documented in
[the native browser contract](opencode-v2-browser.md).
