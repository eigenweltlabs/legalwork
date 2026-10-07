# Built-in browser automation

`legalwork_browser_open_url` creates a browser tab and returns `browser_url` and
`target_id` for the `opencode-chrome-devtools` tools. The URL contains a random
256-bit capability for that tab. Treat it as a credential; do not log or share it.
It expires when the tab closes or the app exits.

The main process broker listens on an ephemeral loopback port. Both `/json/list`
and the page WebSocket require that capability. Discovery returns only the
authorized tab. Requests with an Origin header or an unexpected Host are refused.
The broker registers browser-panel web contents only; the app, detached session,
menu, and recorder windows are never registered. Commands use Electron's
`webContents.debugger`, without a Chromium remote-debugging listener underneath.

The browser plugin uses these commands, which define the broker's allowlist:

- `Accessibility.enable`, `Accessibility.getFullAXTree` for snapshots.
- `DOM.resolveNode`, `DOM.getBoxModel` for element targeting.
- `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` for click and fill.
- `Page.enable`, `Page.navigate`, `Page.captureScreenshot` for navigation and capture.
- `Runtime.evaluate`, `Runtime.callFunctionOn` for page evaluation and element actions.

`Target.*`, `Browser.*`, and client-supplied session IDs are rejected. A plugin
update needing another command must review its scope before adding it here.

For development, `LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT=9823 pnpm dev:electron`
enables full app debugging explicitly. An absent, invalid, or zero port disables
it. Packaged builds remove the remote-debugging switches, including ones passed
through launch arguments. The broker works independently of this setting.

Run `pnpm --filter @legalwork/desktop test` for broker authorization, connection
lifecycle, development-debugging configuration, and sandboxed preload checks.

## Project downloads

Every automation tab resolves its caller's execution directory against registered
local projects before navigation. Downloads remain bound to that project even
when the visible chat or project changes. Manual tabs bind to the selected local
project when they are created. Downloads are saved in the visible `Downloads/`
folder, with exclusive filename reservation to preserve existing files.
Unbound tabs report a download error instead of silently saving elsewhere.

The tab capability also exposes `GET /downloads`. Records include completion
state, received/total bytes, absolute path and project-relative path. The agent's
`legalwork_browser_downloads` tool can wait for completion and use a previous
record ID as a cursor. Failed or interrupted files must not be treated as complete.
The existing Project Files polling displays downloaded files without requiring a
new file-indexing system.

## Fewer browser round trips

The bridge lifts descendants of ignored, unnamed accessibility containers before
returning CDP snapshots. This prevents the upstream snapshot walker from dropping
an entire page under a layout container.

Opening a tab returns its initial snapshot. `POST /batch`, exposed to the agent as
`legalwork_browser_batch`, runs up to 20 observed-selector clicks, fills and
condition waits, then returns a fresh snapshot plus download records. An empty
batch only reads the page. Batches stop at the first failure and report completed
steps; callers must inspect state before deciding which actions to retry.

Both HTTP routes require the same per-tab capability, loopback Host and absent
Origin as CDP discovery. Batch execution shares the debugger attachment with
existing CDP clients. It does not grant access to other tabs, app renderers or
browser-wide commands. User decisions and required confirmations remain outside
batches. No fixed sleep is added to normal actions; waits poll a page condition
within the caller's bounded timeout.
