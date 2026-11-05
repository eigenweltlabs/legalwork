# Native runtime and standalone ownership

Desktop and the supported `legalwork start`/`serve` path each use one released
OpenCode 2.1.4 process through the existing LegalWork server lifecycle. The
standalone CLI starts its independently deployable server first, waits for
authenticated native identity and managed history readiness. Clients use the
LegalWork Bearer proxy; native Basic credentials remain private. Independent
server upgrades and direct
external native-server attachment remain supported.

The 2026-10-25 latest-dev integration includes `ab624cb2`: its unused messaging
bridge, share tokens and sharing controls are retired upstream. The migration
retains that removal. Old generated bot tools and native messaging plugin folders
are archived with local edits intact; no router process or dead messaging tool is
registered. The separate external MCP connector boundary remains supported.

The unused desktop MCP file-merging helper has been removed. Managed connection
changes use the typed LegalWork boundary; there is no remaining desktop caller
or fallback that patches `runtime-opencode-config.json` directly.

Launcher-owned engine configuration, service registration, v2 database,
generated manifest and history receipts have private engine storage. Shared
runtime settings, the capability library and canonical folder approvals retain
their existing shared storage. This is not a claim of new cross-process live
notification or read/update transactions. Desktop's protected execution mode
and standalone's existing host/Docker modes retain their different boundaries;
an ordinary CLI launch does not change the running desktop's engine ownership.

The managed public health envelope adds only engine `starting`/`ready` metadata.
Readiness requires the managed startup/history preparation, plus the caller's
authenticated native PID/version check. Health and scoped global events are
passive: they do not activate the default project's automation. Native catalog
and execution requests still require location admission. Existing authorized
root, internal-context and credential event filters stay in force.

## Retired extra developer launcher

The separate `daemon start`/`run`, workspace registration/switching and instance
disposal implementation has no active desktop or main `start`/`serve` caller.
Its only repository consumer was its own obsolete router test script. These
developer commands and the direct extra-engine startup path are removed. The
root orchestrator test command now runs focused retirement/compatibility tests.
The legal-product server, self-hosting, manual connections, file commands and
sandboxed document-processing tools remain.

Legacy `daemon status`/`stop` read the saved registry and require exact loopback
address, live PID, port and start-time agreement with that daemon's health
response. Shutdown goes only through its verified HTTP endpoint: there is no
PID kill, redirect following, engine startup or registry/config rewrite.
Original `legalwork-orchestrator-state.json` and private `opencode-config`
contents remain recoverable. Desktop's old-process cleanup remains compatible.

Source inspection found no normal UI route that writes user skills, connector
definitions or custom plugins into the launcher's private `opencode-config`
folder. The old launcher created that folder and generated its two messaging
tools there. Both those original files and any migration-generated native
messaging plugin directories are now archived by the retirement adapter.
Explicit development import environment variables, manual edits
or external tools can also have populated it. Ordinary UI settings use the
shared runtime database, user global library or selected project instead.
Windows' old APPDATA migration targets the user XDG library, not this launcher
folder. There is no evidence that normal legal users need a new import wizard;
unusual external customization is not silently reclassified as app-owned data.

## Verification

All these checks use synthetic local fixtures and zero paid inference:

- Historical pre-retirement `managed-runtime.released.test.ts`: actual plain Node compiled-JS orchestrator,
  copied independently compiled LegalWork server, released 2.1.4 engine and
  compiled messaging router; 2 tests / 38 assertions. Before project approval,
  scoped and unscoped Bearer status return the correct native identity without
  activating an authored plugin. Normal stop and cancellation during startup
  reap only the fixture's owned processes.
  The current fixture keeps the same engine ownership, project approval,
  permission and Stop assertions while checking that messaging plugins are
  absent; it no longer requires the removed router or share-token issuer.
- `developer-launcher-retirement.test.ts`: 3 tests / 78 assertions cover removed
  commands, preserved source/config bytes, supported help entries, verified
  legacy stop/status, identity mismatch, redirect/remote refusal and corrupt or
  missing registry handling. No PID from the registry is killed.
- `native-passive-events.released.test.ts`: 1 test / 13 assertions prove an
  unapproved default's valid plugin/MCP markers stay inactive during global
  event subscription, while another approved project's permitted events stream.
  Raw native activation provides the positive marker control.
- The config/provider/store/cold-catalog group passes 28 tests / 223 assertions,
  including native macro expansion only after approval, private-value omission,
  exact provider key/endpoint ownership and the first native model-catalog read.

These are Darwin ARM64 runtime proofs. They do not establish Windows/Linux
packaged behavior, paid legal-task parity or a fix for the separately documented
upstream first-turn MCP registry race. The unsharded Bun guarded-file-descriptor
test-runner crash is also separate from these passing isolated checks.

## Temporary recovery uses the native parent lease

Held recovery now uses upstream `serve --stdio`. This mode still serves the
same authenticated HTTP API and prints its URL as JSON; it does not enable the
native service's automatic interrupted-work sweep. LegalWork keeps the child's
stdin pipe open, parses that native JSON readiness, and retains the existing
exact Basic-auth/PID/version and history-migration checks. Native stdin EOF
closes its HTTP scope, including EOF received before startup finishes. Normal
Stop first closes that lease; bounded SIGTERM/SIGKILL remain cleanup fallbacks.
Normal durable `--service` startup and authenticated predecessor handling stay
unchanged.

This fixes temporary recovery orphans after Electron or server-host SIGKILL
without matching executable paths or killing arbitrary PIDs. It does not need a
new persistent owner registry, a custom launcher or an engine patch. The earlier
registry proposal and its passing tests were frozen as rejected-design evidence;
its production additions were removed. The lease also removes that proposal's
unavoidable spawn/file-write interval.

Actual Mac ARM64 `.3` checks include three host deaths before a new database's
listener starts, a ready authenticated host death, unchanged native context and
queued content across same-database restart, normal EOF Stop, and an interrupted
turn/inbox that remains held until approved service promotion. A separate Node
22 native prototype and production managed-client fixture cover the same HTTP
identity. No client message replay or paid model calls are used. Native Windows
and Linux lease execution remain separate platform gates. Existing pre-fix
orphans have no lease; cleanup still requires independent ownership evidence.
