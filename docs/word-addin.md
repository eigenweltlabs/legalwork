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

## One-time setup (development)

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

## Production / desktop distribution (future work)

- The desktop app can enable `wordAddin` on its embedded server and ship the
  built bundle; the installer should install a trusted localhost certificate
  (what `office-addin-dev-certs` does for dev) and drop the manifest into the
  Word sideload location.
- Settings navigation inside the pane is intentionally disabled; flows that
  need it (e.g. connecting a model provider) must be done in the LegalWork app.
