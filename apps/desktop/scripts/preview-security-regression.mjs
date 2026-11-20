import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, protocol } from "electron";
import { createAppUrlMatcher, guardPreviewNavigation } from "../electron/app-url.mjs";
import { PDFDocument, PDFName } from "../../server/resources/core-opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs";

const securitySource = await readFile(new URL("../../app/src/react-app/domains/session/artifacts/html-preview-security.ts", import.meta.url), "utf8");
const { offlinePreviewDocument } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(securitySource)).toString("base64")}`);
const pdfUrlSource = await readFile(new URL("../../app/src/react-app/domains/session/artifacts/pdf-preview-url.ts", import.meta.url), "utf8");
const { pdfPreviewUrl } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(pdfUrlSource)).toString("base64")}`);
const userData = process.env.LEGALWORK_PREVIEW_TEST_USERDATA;
if (!userData) throw new Error("Run this test through run-preview-security.mjs");
app.setPath("userData", userData);
app.on("window-all-closed", () => {});
let window;
let exitCode = 0;
// Match the recording scheme's privileges in main.mjs: it must obey preview CSP.
protocol.registerSchemesAsPrivileged([{ scheme: "lw-recording", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const requests = [];
const server = createServer((request, response) => {
  if (request.url === "/viewer") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><html><body style="margin:0"></body></html>');
    return;
  }
  requests.push(request.url);
  response.end("unexpected network request");
});
app.whenReady().then(async () => {
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    protocol.handle("lw-recording", () => { requests.push("recording"); return new Response("private audio"); });
    window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true } });
    guardPreviewNavigation(window.webContents, { isAppUrl: createAppUrlMatcher({ devServerUrl: origin, appRoot: "/unused" }) });
    await window.loadURL("data:text/html,<html><body>Preview security regression</body></html>");
    const document = offlinePreviewDocument(`<html><body><button onclick="document.body.dataset.clicked='yes'">Local interaction</button>
      <script src="${origin}/remote-code"></script><img src="${origin}/image">
      <iframe src="${origin}/nested-frame"></iframe><audio autoplay src="lw-recording://audio/test"></audio>
      <script>
        fetch('${origin}/fetch').catch(() => {});
        fetch('lw-recording://audio/test').catch(() => {});
        navigator.sendBeacon('${origin}/beacon', 'secret');
        const worker = new Worker(URL.createObjectURL(new Blob(["postMessage('worker-ok')"], {type:'text/javascript'})));
        worker.onmessage = () => { parent.postMessage({type:'ready', bridge: typeof window.__LEGALWORK_ELECTRON__, clicked: document.body.dataset.clicked}, '*'); };
        document.querySelector('button').click();
        window.addEventListener('message', e => { if(e.data==='navigate') location.href='${origin}/navigation?secret=test'; });
      </script></body></html>`);
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Preview did not become ready')), 5000);
      const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
      window.addEventListener('message', function ready(event) {
        if(event.source !== frame.contentWindow || event.data?.type !== 'ready') return;
        clearTimeout(timeout); window.removeEventListener('message', ready);
        let isolated = false; try { frame.contentWindow.document; } catch { isolated = true; }
        frame.contentWindow.postMessage('navigate', '*');
        setTimeout(() => resolve({bridge:event.data.bridge, clicked:event.data.clicked, isolated}), 300);
      });
      frame.srcdoc = ${JSON.stringify(document)}; document.body.append(frame);
    })`);
    assert.deepEqual(result, { bridge: "undefined", clicked: "yes", isolated: true });
    assert.deepEqual(requests, [], "previews must not make network requests, including self-navigation");
    console.log("PASS: interactive scripts and blob workers run without desktop access or outbound requests");
    // Intercept HTTPS in this disposable Electron profile: no real Stripe
    // account, bank, payment, or external network request is involved.
    const paymentRequests = [];
    protocol.handle("https", (request) => {
      const url = new URL(request.url);
      paymentRequests.push(url.origin + url.pathname);
      let body;
      if (url.hostname === "js.stripe.com") body = `<iframe src="https://hooks.stripe.com/challenge"></iframe><script>
        addEventListener('message', e => parent.postMessage({...e.data, stripeBridge:typeof window.__LEGALWORK_ELECTRON__}, '*'));
      </script>`;
      else if (url.hostname === "hooks.stripe.com") body = `<iframe src="https://bank.example/challenge"></iframe><script>
        addEventListener('message', e => parent.postMessage(e.data, '*'));
      </script>`;
      else body = `<script>parent.postMessage({type:'synthetic-bank-ready', bankBridge:typeof window.__LEGALWORK_ELECTRON__}, '*')</script>`;
      return new Response(body, { headers: { "Content-Type": "text/html" } });
    });
    await window.loadURL(`${origin}/viewer`);
    const payment = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stripe payment frames were blocked')), 5000);
      const frame = document.createElement('iframe');
      addEventListener('message', function ready(e) {
        if(e.source !== frame.contentWindow || e.data?.type !== 'synthetic-bank-ready') return;
        clearTimeout(timeout); removeEventListener('message', ready); resolve(e.data);
      });
      frame.src = 'https://js.stripe.com/controller'; document.body.append(frame);
    })`);
    assert.deepEqual(payment, { type: "synthetic-bank-ready", bankBridge: "undefined", stripeBridge: "undefined" });
    assert.deepEqual(paymentRequests, ["https://js.stripe.com/controller", "https://hooks.stripe.com/challenge", "https://bank.example/challenge"]);
    await window.webContents.executeJavaScript(`{
      const preview = document.createElement('iframe'); preview.sandbox = 'allow-scripts';
      preview.srcdoc = '<script>location.replace("https://js.stripe.com/preview-must-stay-blocked")<\/script>';
      document.body.replaceChildren(preview);
    }`);
    await delay(300);
    assert.equal(paymentRequests.length, 3, "a preview must not reuse the Stripe payment exception");
    console.log("PASS: app-owned Stripe and nested bank frames load without desktop access; previews cannot use the exception");
    // A non-opaque parent origin lets PDFium read its persisted viewer settings,
    // matching the actual app's blob previews.
    await window.loadURL(`${origin}/viewer`);
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= 4; page++) pdf.addPage().drawText(`PDF viewer regression, page ${page}`);
    pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseThumbs"));
    const bytes = Buffer.from(await pdf.save()).toString("base64");
    const pdfUrl = await window.webContents.executeJavaScript(`(() => {
      const data = Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([data], {type:'application/pdf'}));
    })()`);
    const openPdf = async (url) => {
      await window.webContents.executeJavaScript(`{
        const frame = document.createElement('iframe');
        frame.style = 'width:100vw;height:100vh;border:0';
        frame.src = ${JSON.stringify(url)};
        document.body.replaceChildren(frame);
      }`);
      for (let attempt = 0; attempt < 100; attempt++) {
        const frame = window.webContents.mainFrame.framesInSubtree.find((entry) => entry.url === "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html");
        if (frame && await frame.executeJavaScript(`(() => {
          const viewer = document.querySelector('pdf-viewer');
          return viewer?.originalUrl === ${JSON.stringify(url)} && viewer.loadState_ === 'success';
        })()`)) return frame;
        await delay(100);
      }
      throw new Error("PDF viewer did not finish loading");
    };
    const sidebarState = (frame) => frame.executeJavaScript(`(async () => {
      const viewer = document.querySelector('pdf-viewer');
      await viewer.updateComplete;
      const toolbar = viewer.shadowRoot.querySelector('viewer-toolbar');
      await toolbar.updateComplete;
      return {
        collapsed: viewer.sidenavCollapsed_,
        closed: viewer.shadowRoot.querySelector('#sidenav-container').hasAttribute('closed'),
        toggleExpanded: toolbar.shadowRoot.querySelector('#sidenavToggle').getAttribute('aria-expanded'),
        page: viewer.pageNo_,
      };
    })()`);
    const previous = await openPdf(`${pdfUrl}#navpanes=1`);
    assert.equal((await sidebarState(previous)).collapsed, false);
    await previous.executeJavaScript("localStorage.setItem('sidenavCollapsed', 'false')");
    const viewer = await openPdf(pdfPreviewUrl(`${pdfUrl}#page=3&navpanes=1`));
    assert.equal(await viewer.executeJavaScript("localStorage.getItem('sidenavCollapsed')"), "false");
    assert.deepEqual(await sidebarState(viewer), { collapsed: true, closed: true, toggleExpanded: "false", page: 3 });
    console.log("PASS: PDF PageMode and remembered-open sidebar state cannot override the closed initial view; citation page preserved");
    await viewer.executeJavaScript("document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('#sidenavToggle').click()");
    assert.deepEqual(await sidebarState(viewer), { collapsed: false, closed: false, toggleExpanded: "true", page: 3 });
    const reopened = await openPdf(pdfPreviewUrl(pdfUrl, 2));
    assert.deepEqual(await sidebarState(reopened), { collapsed: true, closed: true, toggleExpanded: "false", page: 2 });
    console.log("PASS: manually opening thumbnails works; reopening and programmatic page navigation start closed again");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    await new Promise((resolve) => server.close(resolve));
    app.exit(exitCode);
  }
});
