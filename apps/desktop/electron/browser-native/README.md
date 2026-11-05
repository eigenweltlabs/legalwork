# OpenCode browser controller

The `upstream` directory contains the MIT-licensed desktop browser driver from
[`anomalyco/opencode` v2.1.4](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/gui-extensions/src/browser).
The published `@opencode/plugin-browser` package provides the matching native server/RPC
contract; the complete Electron driver is currently part of the private GUI package.

`node apps/desktop/scripts/build-browser-controller.mjs` strips TypeScript and writes
the checked-in `runtime` modules. LegalWork's own IPC and panel UI replace the upstream
GUI SDK. The generator deliberately preserves upstream behavior and comments.
Keep the upstream license with redistributed source and generated modules.

Host-specific adaptations and capability-preserving extensions are recorded here as
they are integrated. Tests must exercise the released RPC v4 protocol and actual
Electron/CDP, including cancellation, session replacement, and shared-profile behavior.

Run `node apps/desktop/scripts/build-browser-controller.mjs --check` to reject stale
generated modules. Source and generated modules are both checked in; shipping does
not require a TypeScript compiler at runtime. Runtime `ipc.mjs` replaces only the
upstream GUI IPC constant (`MAX_ICON_URL=24576`).

Adapted source:

- `pane.ts`: inject LegalWork's shared partition, desktop network, per-binding
  authority/download/page callbacks and panel embeds; guard shared-profile file
  URLs against their owning WebContents; return native UI command results; forward
  the optional host screenshot queue into each page.
- `chromium.ts`: reserve the existing project-bound download destination; preserve
  complete locally retained downloads above the native RPC transfer limit;
  expose completed owned files to the capability-preserving adapter; let the host
  serialize the inner screenshot operation, including its existing visibility check,
  element scrolling, layout metrics and actual native completion. The outer native
  Stop response remains immediate; an optional close callback stops capture admission
  before asynchronous page disposal. Plain viewport screenshots disable CDP's
  beyond-viewport capture, which otherwise removes the scrollbar, changes page
  layout and loses right-edge pixels. Full-page and element capture keep the
  upstream setting. Screenshot limits remain unchanged.
  The compositor capture used after element scrolling acquires the same queue;
  a screenshot already holding it reuses that lease instead of nesting acquisition.
- `files.ts`: expose retained local file metadata to the adapter without changing
  the native RPC file schemas or their 5 MiB transfer limit.

All other vendored modules retain pinned upstream behavior. The adapter lives in
`../browser-native-host.mjs`; additional transport/file functionality lives outside
the vendored controller. See [the integration contract and limits](../../../../docs/opencode-v2-browser.md).

The screenshot callback is a maintained LegalWork integration seam. The same queue
also owns LegalWork captures, previews, brokered CDP screenshots and native embed
captures. It has no queue limit or new deadline. Stop rejects the caller immediately;
an already dispatched Chromium screenshot may continue until its native promise
settles. Later captures on that page wait for that settlement. This does not repair
an underlying native capture that never settles; closing the page is the existing
way to release such native work.
Queue admission and asynchronous authorization both verify the exact current owner;
disposal aborts the queue's signal even for embed captures without a caller signal.

Hidden-window capture remains a known platform limitation under investigation.
Exact pre-migration modules reproduced a Linux hidden-preview stall, while visible
tabs passed the same pixel checks. This source integration must not be described
as complete background-capture acceptance. The API remains available; no forced
window visibility or platform flags are introduced.
