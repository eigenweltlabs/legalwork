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
 * forwards). When the shell itself changes, bump SHELL_VERSION — every
 * successful pane load re-fetches the shell with cache:"reload", so the
 * new version is active from the next pane open.
 *
 * Keep this file dependency-free and the HTML self-contained: it must
 * render offline with nothing but itself.
 */

export const WORD_ADDIN_SHELL_VERSION = "1";

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
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #fff; color: #1f2430;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    text-align: center;
  }
  .box { max-width: 300px; padding: 24px; }
  .title { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
  .body { font-size: 12px; line-height: 1.5; color: #6b7280; margin: 0 0 16px; }
  .row { display: flex; gap: 8px; justify-content: center; }
  button {
    font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
    border-radius: 999px; padding: 7px 16px; transition: background-color 120ms;
  }
  .primary { background: #011627; color: #fff; border: 1px solid #011627; }
  .primary:hover { background: #1f2937; }
  .ghost { background: #fff; color: #6b7280; border: 1px solid #e5e7eb; }
  .ghost:hover { background: #f3f4f6; color: #1f2430; }
  .spinner {
    width: 18px; height: 18px; margin: 0 auto 12px;
    border: 2px solid #e5e7eb; border-top-color: #011627; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hidden { display: none; }
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
  </div>
<script>
(function () {
  "use strict";
  var de = (navigator.language || "").toLowerCase().indexOf("de") === 0;
  if (de) {
    document.getElementById("connecting-text").textContent = "Verbindung zu LegalWork...";
    document.getElementById("offline-title").textContent = "LegalWork ist nicht geöffnet";
    document.getElementById("offline-body").textContent =
      "Starte die LegalWork-App, um das Add-in zu verwenden. Diese Ansicht verbindet sich automatisch, sobald die App läuft.";
    document.getElementById("open-btn").textContent = "LegalWork öffnen";
    document.getElementById("retry-btn").textContent = "Erneut versuchen";
  }

  var handedOff = false;

  function checkServer() {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
    return fetch("bootstrap", { cache: "no-store", signal: controller ? controller.signal : undefined })
      .then(function (response) { return response.ok; })
      .catch(function () { return false; })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function handOff() {
    if (handedOff) return;
    handedOff = true;
    // Refresh this shell's cache entry so shell updates propagate, then
    // load the real pane (served no-store, always current).
    fetch("taskpane.html", { cache: "reload" })
      .catch(function () { /* ignore */ })
      .finally(function () { location.replace("app.html"); });
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
    checkServer().then(function (ok) { if (ok) handOff(); });
  });

  checkServer().then(function (ok) {
    if (ok) { handOff(); return; }
    showOffline();
    var poll = setInterval(function () {
      checkServer().then(function (ok2) {
        if (ok2) { clearInterval(poll); handOff(); }
      });
    }, 2500);
  });
})();
</script>
</body>
</html>
`;
}
