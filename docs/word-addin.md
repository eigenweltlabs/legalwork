# LegalWork Word Add-in

The Word add-in shows the LegalWork agent UI (the session view from the app)
in a task pane inside Microsoft Word. Everything else — settings, providers,
workspace management — stays in the LegalWork app.

## How it works

A Word task pane is a webview that loads an HTTPS page. The add-in reuses the
existing session UI as a third Vite entry point (`apps/app/taskpane.html` →
`src/word-addin/`), built with `base: /word-addin/` and served by
legalwork-server itself:

```
Word task pane (WebView2 / WKWebView)
  └─ https://localhost:47443/word-addin/taskpane.html   ← HTTPS add-in listener
       ├─ /word-addin/bootstrap   same-origin pairing (returns client token)
       ├─ /workspaces, /sessions… regular LegalWork server API (same origin)
       └─ /opencode/*             existing OpenCode proxy (same origin)
```

Key properties:

- **One origin for everything.** The HTTPS listener started by the server
  shares the exact same fetch handler as the main HTTP listener, so the page,
  the API, and the OpenCode proxy are all same-origin. No CORS, no mixed
  content (which WKWebView on macOS would block).
- **Pairing without secrets in URLs.** The pane fetches
  `/word-addin/bootstrap` (same-origin only; the response is deliberately
  never CORS-wrapped) and stores the current client token in its own
  origin-scoped localStorage. Token rotation across server restarts is
  handled automatically on the next pane load.
- **Word integration.** Office.js is loaded in `taskpane.html`. A floating
  dock (only rendered inside Word) offers: add the current selection or the
  whole document as chat context (`composer.set_text` control action), and
  insert the last assistant reply at the cursor (`session.latest_message` +
  `Range.insertText`).
- **Slim shell.** The pane seeds a shell-config profile (no status bar, no
  welcome page, no browser panel, no workspace management) and only mounts
  the session routes; unknown routes bounce back to `/session`.

## Development: just `pnpm dev`

On this branch, `pnpm dev` sets up everything automatically:

1. Installs the localhost dev certificates on first run (one-time keychain
   trust prompt, via `office-addin-dev-certs`).
2. Sideloads the multi-host manifest into every installed Office app
   (Word, Excel, PowerPoint on macOS) — idempotent, only rewrites on change.
3. Starts a watch build of the task pane bundle alongside the app UI.
4. The dev desktop app's embedded server hosts the pane and starts the
   HTTPS add-in listener on port 47443.

Then open Word/Excel/PowerPoint → Home → Add-ins → Developer Add-ins →
LegalWork. (Restart the Office app once after the very first sideload.)

Opt out with `LEGALWORK_WORD_ADDIN=0 pnpm dev`; re-run just the sideload
with `pnpm office:sideload`. Windows sideloading is not automated yet.

## Manual setup (standalone CLI server)

1. Install the localhost dev certificates (adds a trusted CA to your keychain):

   ```sh
   npx office-addin-dev-certs install
   ```

   The server picks up `~/.office-addin-dev-certs/localhost.crt|key`
   automatically; use `--word-addin-cert/--word-addin-key` to override.

2. Build the task pane bundle:

   ```sh
   pnpm --filter @legalwork/app build:word-addin      # or dev:word-addin for watch mode
   ```

3. Start the server with the add-in enabled:

   ```sh
   bun apps/server/src/cli.ts --workspace <path> --word-addin
   ```

   You should see:
   `Word add-in listening on https://localhost:47443/word-addin/ (manifest: …/manifest.xml)`

4. Download the manifest:

   ```sh
   curl -k https://localhost:47443/word-addin/manifest.xml -o legalwork-word-addin.manifest.xml
   ```

## Sideloading

**Word on Mac** — copy the manifest into Word's sideload folder and restart Word:

```sh
cp legalwork-word-addin.manifest.xml \
  ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Then in Word: **Home → Add-ins ▾ (or Insert → My Add-ins) → Developer Add-ins → LegalWork**.

**Word on Windows** — use the Office toolchain:

```powershell
npx office-addin-debugging start legalwork-word-addin.manifest.xml desktop --app word
```

(or configure a network share catalog and drop the manifest there).

The ribbon gets an **Open LegalWork** button (Home tab) that opens the pane.

## Configuration reference

| Option | Env | `server.json` | Default |
| --- | --- | --- | --- |
| `--word-addin` | `LEGALWORK_WORD_ADDIN=1` | `wordAddin.enabled` | `false` |
| `--word-addin-port` | `LEGALWORK_WORD_ADDIN_PORT` | `wordAddin.port` | `47443` |
| `--word-addin-cert` | `LEGALWORK_WORD_ADDIN_CERT` | `wordAddin.certPath` | `~/.office-addin-dev-certs/localhost.crt` |
| `--word-addin-key` | `LEGALWORK_WORD_ADDIN_KEY` | `wordAddin.keyPath` | `~/.office-addin-dev-certs/localhost.key` |
| `--word-addin-dist` | `LEGALWORK_WORD_ADDIN_DIST` | `wordAddin.distPath` | `apps/app/dist-word-addin` (monorepo layout) |

## PowerPoint

The manifest also declares PowerPoint (`Presentation`): sideload into
`~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/`. The
pane registers `ppt_*` tools (`legalwork-powerpoint-tools` plugin):
`ppt_read_presentation`, `ppt_read_slide`, `ppt_read_selection`,
`ppt_set_shape_text`, `ppt_replace_text`, `ppt_add_slide`,
`ppt_add_text_box`, `ppt_run_code`. PowerPoint's add-in API has neither
tracked changes nor comments, so safety is behavioral: `set_shape_text`
returns the previous text, ambiguous replacements are rejected with
locations, and the agent must report every slide/shape it changed (undo
via Cmd+Z). `ppt_run_code` runs raw Office.js for styling/shape work the
typed tools do not cover (the PowerPointApi remains the most limited of
the three). The dock offers "add current slide" and "add presentation
outline" to chat.

## Excel

The same manifest declares Excel (`Workbook`) as a host: sideload it into
`~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` and the same
task pane opens in Excel (Home → Add-ins → LegalWork). The pane detects the
host via Office.js and registers `excel_*` tools instead of `word_*`:
`excel_read_workbook`, `excel_read_range`, `excel_read_selection`,
`excel_write_cells`, `excel_highlight_range`, `excel_add_worksheet`,
`excel_search`, `excel_add_comment`, `excel_run_code` (via the
`legalwork-excel-tools` plugin). Excel has no tracked-changes API, so the safety pattern differs:
agent writes highlight the touched cells (amber fill), rationale goes into
cell comments, and the agent is instructed to put derived analysis on new
worksheets rather than overwrite data. The dock offers "add selection"
(as TSV) and "add workbook overview" to chat.

## Agent document tools

When the pane is open inside Word, the agent gets `word_*` tools (via the
`legalwork-word-tools` OpenCode plugin) to read and edit the open document:
`word_read_document`, `word_read_selection`, `word_search`,
`word_replace_text`, `word_insert_text`, `word_add_comment`,
`word_run_code`.

Each host also has a `*_run_code` escape hatch: the agent writes the body
of a `Word.run`/`Excel.run`/`PowerPoint.run` batch and the pane executes
it (`office-run-code.ts`), giving full Office.js coverage (formatting,
styles, tables, charts, shapes) without a typed tool per capability. Pane
globals like `fetch`/`localStorage` are shadowed inside the snippet as an
accident guard, results are JSON-serialized with size caps, and Office.js
errors return their `debugInfo` so the model can fix its own snippet. In
Word the batch runs with change tracking forced on, so code-driven edits
are still native redlines.

Flow: tool call → `POST /workspace/:id/word-tools/execute` on
legalwork-server → the pane (long-polling `/word-tools/poll`) executes it
through Office.js and posts the result back. Edits are anchor-based (exact
text snippets, not offsets) and run with Word change tracking forced to
`TrackAll`, so every agent edit is a native redline the user accepts or
rejects in Word. On Word versions without WordApi 1.4 (change-tracking
control), edits are refused rather than applied silently. When no pane is
connected the tools return a clear error and the agent tells the user to
open the pane.

## Security notes

- The bootstrap endpoint returns the collaborator-scoped client token. It is
  same-origin readable only: `/word-addin/*` responses are never CORS-wrapped,
  so a malicious website cannot read it from a victim's browser. Any process
  on the machine could call it — the same trust boundary as the config file
  on disk that already contains the token.
- The listener binds to the configured host (default `127.0.0.1`); the
  manifest references `https://localhost`, so nothing is exposed on the LAN.
- Because the manifest points at localhost, this add-in is distributed by
  sideloading (or your own catalog), not AppSource.

## Production: the "Office Add-ins" settings tab

In a packaged desktop build, users install the add-in from **Settings →
Office Add-ins** (a desktop-only global tab). Install/uninstall runs in the
Electron main process (`apps/desktop/electron/office-addin-manager.mjs`):

- **Certificate.** Generates a per-install CA that is *name-constrained to
  localhost/loopback* (`office-addin-cert.mjs`) — unlike the dev flow's
  unconstrained `office-addin-dev-certs`. Even if the CA key is stolen from
  the machine it cannot sign for real domains; the constraint is proven by
  `office-addin-cert.test.mjs` (a CA-signed cert for `evil.example.com`
  fails validation). The CA key never leaves the machine and is never
  shared between installs.
- **Trust.** Adds the CA to the login keychain via one native auth prompt
  (macOS). No sudo, no shared key. The constraint is enforced by the OS:
  with the CA trusted, `security verify-cert` accepts the localhost leaf but
  rejects a cert for any real domain signed by the same CA.
- **Manifests.** Written per app: each of Word/Excel/PowerPoint is installed
  and uninstalled individually from the settings tab; the certificate and
  listener are shared and are torn down with the last uninstall.
- **Listener.** Persists an enabled flag (`office-addins.json` in userData);
  `startLegalworkServer` reads it and passes the cert/key/dist to the
  embedded server so the HTTPS listener comes up on every launch. Uninstall
  removes manifests, untrusts + deletes the CA, and stops the listener.

The packaged task pane bundle ships via electron-builder `extraResources`
(`../app/dist-word-addin` → `word-addin-dist`). Currently macOS only;
Windows install is stubbed (status reports `supported: false`).

Dev note: the `pnpm dev` flow still enables the listener via
`LEGALWORK_WORD_ADDIN=1` and the dev certificate, independently of the
settings tab. In dev the tab may therefore show "Not installed" while the
pane already works from the env path; in production (no env var) the tab is
the sole control and its status is authoritative.

## Production / desktop distribution (future work)

- The desktop app can enable `wordAddin` on its embedded server and ship the
  built bundle; the installer should install a trusted localhost certificate
  (what `office-addin-dev-certs` does for dev) and drop the manifest into the
  Word sideload location.
- Settings navigation inside the pane is intentionally disabled; flows that
  need it (e.g. connecting a model provider) must be done in the LegalWork app.
