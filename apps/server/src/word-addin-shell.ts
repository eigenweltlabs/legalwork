/**
 * Long-cacheable bootstrap shell for the Office task pane.
 *
 * Word's SourceLocation URL (taskpane.html) serves THIS page with a
 * one-year max-age, so the Office webview can render it from its HTTP
 * cache even while the LegalWork server is down — instead of Office's
 * uncustomizable "Add-in Error" page. The shell has exactly two jobs:
 *
 *   1. Server reachable  -> refresh its own cache entry, then hand off to
 *      /word-addin/app.html (the real pane, served no-store as always).
 *   2. Server down       -> show "LegalWork is not running" with an
 *      Open LegalWork button (legalwork:// deep link) and poll until the
 *      server appears, then hand off automatically.
 *
 * Updates: app updates never require a shell change (the shell only
 * forwards). Shell updates use immutable versioned URLs, because that is
 * the only mechanism navigation caches honor reliably (verified in
 * Chromium: neither subresource fetches with cache:"reload" nor
 * location.reload() dependably replace the entry a future navigation
 * renders):
 *
 *   - taskpane.html (the manifest URL) serves a tiny FROZEN redirector,
 *     cached for a year. It never changes — it only navigates to the
 *     shell version recorded in localStorage (falling back to the
 *     version embedded at serve time).
 *   - shell-v<N>.html serves the actual shell, cached immutable. When a
 *     running shell learns from the bootstrap response that a newer
 *     version exists, it records it and NAVIGATES to the new URL while
 *     online — seeding the navigation cache for future offline opens.
 *
 * Keep this file dependency-free and the HTML self-contained: it must
 * render offline with nothing but itself.
 */

/**
 * BUMP THIS whenever anything in the shell HTML below changes (markup,
 * styles, copy, or script). Each version is served at its own immutable
 * URL (shell-v<N>.html); running shells learn the current version from
 * the bootstrap response and navigate to the new URL while online.
 * Without a bump, existing installs keep rendering the old shell for up
 * to a year. Increment the number.
 */
export const WORD_ADDIN_SHELL_VERSION = "5";

export function buildWordAddinShellHtml(): string {
  return `<!doctype html>
<!-- LegalWork task pane shell v${WORD_ADDIN_SHELL_VERSION} -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LegalWork</title>
<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" defer onerror="this.remove()"></script>
<style>
  /* Colors are the pane theme's computed dls tokens (deployment "web"),
     baked in so the offline screen matches the app's connect screen:
     surface #fffffff7, text #0e0a07, secondary #0e0a078c, border
     #0e0a0714, hover #0e0a070a, accent #18498b / hover #2352de. */
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #fffffff7; color: #0e0a07;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    text-align: center;
  }
  .box { max-width: 300px; padding: 24px; }
  .title { font-size: 14px; font-weight: 500; margin: 0 0 12px; color: #0e0a07; }
  .body { font-size: 12px; line-height: 1.6; color: #0e0a078c; margin: 0 0 16px; }
  .row { display: flex; gap: 8px; justify-content: center; }
  button {
    font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
    border-radius: 999px; padding: 6px 16px; transition: background-color 120ms, color 120ms;
  }
  .primary { background: #18498b; color: #fefefe; border: 1px solid #18498b; }
  .primary:hover { background: #2352de; border-color: #2352de; }
  .ghost { background: #fffffff7; color: #0e0a07; border: 1px solid #0e0a0714; }
  .ghost:hover { background: #0e0a070a; }
  .spinner {
    width: 18px; height: 18px; margin: 0 auto 12px;
    border: 2px solid #0e0a0714; border-top-color: #18498b; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hidden { display: none; }
  .ver { font-size: 10px; color: #0e0a0740; margin: 14px 0 0; }
</style>
</head>
<body>
  <div class="box" id="connecting">
    <div class="spinner"></div>
    <p class="body" id="connecting-text">Connecting to LegalWork...</p>
  </div>
  <div class="box hidden" id="offline">
    <p class="title" id="offline-title">LegalWork is not running</p>
    <p class="body" id="offline-body">Start the LegalWork app to use the add-in. This pane connects automatically as soon as it is running.</p>
    <div class="row">
      <button type="button" class="primary" id="open-btn">Open LegalWork</button>
      <button type="button" class="ghost" id="retry-btn">Try again</button>
    </div>
    <p class="ver">v${WORD_ADDIN_SHELL_VERSION}</p>
  </div>
<script>
(function () {
  "use strict";
  // Match the app's locale behavior: English unless the user chose German
  // in LegalWork (same-origin localStorage, readable offline). The OS
  // language is deliberately ignored, like the app does.
  var lang = "";
  try { lang = localStorage.getItem("legalwork.language") || ""; } catch (e) { /* ignore */ }
  if (lang === "de") {
    document.getElementById("connecting-text").textContent = "Verbindung zu LegalWork...";
    document.getElementById("offline-title").textContent = "LegalWork ist nicht geöffnet";
    document.getElementById("offline-body").textContent =
      "Starte die LegalWork-App, um das Add-in zu verwenden. Diese Ansicht verbindet sich automatisch, sobald die App läuft.";
    document.getElementById("open-btn").textContent = "LegalWork öffnen";
    document.getElementById("retry-btn").textContent = "Erneut versuchen";
  }

  var SHELL_VERSION = "${WORD_ADDIN_SHELL_VERSION}";
  var handedOff = false;

  function checkServer() {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
    return fetch("bootstrap", { cache: "no-store", signal: controller ? controller.signal : undefined })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) { return data && typeof data === "object" ? data : null; })
      .catch(function () { return null; })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function rememberVersion(version) {
    try { localStorage.setItem("legalwork.shellVersion", version); } catch (e) { /* ignore */ }
  }

  function handOff(bootstrap) {
    if (handedOff) return;
    handedOff = true;
    var current = bootstrap && bootstrap.shellVersion;
    if (typeof current === "string" && current && current !== SHELL_VERSION) {
      // Newer shell available: record it and navigate to its immutable
      // URL while the server is reachable, seeding the navigation cache
      // for future offline opens. The new shell hands off to the app.
      rememberVersion(current);
      location.replace("shell-v" + encodeURIComponent(current) + ".html");
      return;
    }
    rememberVersion(SHELL_VERSION);
    location.replace("app.html");
  }

  function showOffline() {
    document.getElementById("connecting").classList.add("hidden");
    document.getElementById("offline").classList.remove("hidden");
  }

  function openLegalwork() {
    var url = "legalwork://open";
    try {
      var office = window.Office;
      if (office && office.context && office.context.ui && office.context.ui.openBrowserWindow) {
        office.context.ui.openBrowserWindow(url);
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      var opened = window.open(url, "_blank");
      if (opened) return;
    } catch (e) { /* fall through */ }
    location.href = url;
  }

  document.getElementById("open-btn").addEventListener("click", openLegalwork);
  document.getElementById("retry-btn").addEventListener("click", function () {
    checkServer().then(function (data) { if (data) handOff(data); });
  });

  checkServer().then(function (data) {
    if (data) { handOff(data); return; }
    showOffline();
    var poll = setInterval(function () {
      checkServer().then(function (next) {
        if (next) { clearInterval(poll); handOff(next); }
      });
    }, 2500);
  });
})();
</script>
</body>
</html>
`;
}

/**
 * The FROZEN redirector served at taskpane.html (the manifest URL). It
 * must never change in any meaningful way: it is cached for a year with
 * no update path of its own. All it does is navigate to the recorded
 * shell version's immutable URL (falling back to the version embedded
 * when it was cached).
 */
export function buildWordAddinRedirectorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>LegalWork</title>
</head>
<body>
<script>
(function () {
  "use strict";
  var version = "${WORD_ADDIN_SHELL_VERSION}";
  try {
    var stored = localStorage.getItem("legalwork.shellVersion");
    if (stored) version = stored;
  } catch (e) { /* ignore */ }
  location.replace("shell-v" + encodeURIComponent(version) + ".html");
})();
</script>
</body>
</html>
`;
}
