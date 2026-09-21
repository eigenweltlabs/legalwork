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
