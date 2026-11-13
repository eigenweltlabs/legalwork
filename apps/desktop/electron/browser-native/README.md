# OpenCode browser controller

The `upstream` directory contains the MIT-licensed desktop browser driver from
[`anomalyco/opencode` v2.1.4](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/gui-extensions/src/browser).
The published `@opencode/plugin-browser` package provides the matching native server/RPC
contract; the complete Electron driver is currently part of the private GUI package.

`node apps/desktop/scripts/build-browser-controller.mjs` strips TypeScript and writes
the ignored `runtime` modules. LegalWork's own IPC and panel UI replace the upstream
GUI SDK. The generator deliberately preserves upstream behavior and comments.
Keep the upstream license with redistributed source and generated modules.

Host-specific adaptations and capability-preserving extensions are recorded here as
they are integrated. Tests must exercise the released RPC v4 protocol and actual
Electron/CDP, including cancellation, session replacement, and shared-profile behavior.

Development, packaging, desktop tests and type checks generate these modules before
using them. Packaged apps include the generated JavaScript and need no TypeScript
compiler at runtime. Only the source, license and hand-written `runtime/ipc.mjs`
are tracked; the latter replaces the upstream GUI IPC constant (`MAX_ICON_URL=24576`).
Before invoking a browser fixture directly with Electron, run
`pnpm --filter @legalwork/desktop build:browser`. The generator's `--check` option
can then verify that every generated module matches its source.

Adapted source:

- `pane.ts`: inject LegalWork's shared partition, desktop network, per-binding
  authority/download/page callbacks and panel embeds; guard shared-profile file
  URLs against their owning WebContents; return native UI command results; forward
  the optional host screenshot queue into each page. A host callback retains live
  pages during trusted app reloads; other host navigation still closes the pane.
- `chromium.ts`: reserve the existing project-bound download destination; preserve
  complete locally retained downloads above the native RPC transfer limit;
  read the complete frame accessibility tree, omit empty layout wrappers and
  duplicate inline text, and count explicit depth by meaningful observations;
  search the complete tree before bounding matching results to 500 lines,
  retaining the existing 100,000-character output limit;
  expose completed owned files to the capability-preserving adapter; let the host
  serialize the inner screenshot operation, including its existing visibility check,
  element scrolling, layout metrics and actual native completion. The outer native
  Stop response remains immediate; an optional close callback stops capture admission
  before asynchronous page disposal. Plain viewport screenshots disable CDP's
  beyond-viewport capture, which otherwise removes the scrollbar, changes page
  layout and loses right-edge pixels. Full-page and element capture keep the
  upstream setting. Screenshot limits remain unchanged.
  Native pointer operations retain that lease through mouse dispatch. Their post-scroll
  compositor update uses a viewport CDP screenshot, reusing its pixels for the host's
  cached preview; screenshots and other successful captures also publish existing pixels.
  Default accessibility observations traverse nested controls without an AX depth
  cutoff, omit unnamed layout wrappers and retain the existing rendered output
  limits. Explicit depth bounds the displayed tree. Focused find filters during
  traversal; editor values are included unless protected. Condition waits follow
  navigation generations while stale mutations continue to fail.
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

On Windows, background captures temporarily attach the existing browser view to
a shown, fully transparent host window that cannot take focus or appear in the
taskbar. Fully hidden or offscreen Windows views can stall captures. The host is
destroyed when the physical operation finishes. Other platforms attach the view
outside the app's visible bounds; Electron does not support window opacity on Linux.
A user-opened tab keeps its current parent and bounds. The card only displays the
last successful capture; reading its preview never starts another screenshot.
No independent preview page, screenshot polling or platform flags are used.
