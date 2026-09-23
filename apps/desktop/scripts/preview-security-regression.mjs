import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, protocol } from "electron";
import { guardPreviewNavigation } from "../electron/app-url.mjs";
import { PDFDocument } from "../../server/resources/core-opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs";

const securitySource = await readFile(new URL("../../app/src/react-app/domains/session/artifacts/html-preview-security.ts", import.meta.url), "utf8");
const { offlinePreviewDocument } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(securitySource)).toString("base64")}`);
const userData = await mkdtemp(path.join(tmpdir(), "legalwork-preview-security-"));
app.setPath("userData", userData);
app.on("window-all-closed", () => {});
let window;
let exitCode = 0;
// Match the recording scheme's privileges in main.mjs: it must obey preview CSP.
protocol.registerSchemesAsPrivileged([{ scheme: "lw-recording", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const requests = [];
const server = createServer((request, response) => { requests.push(request.url); response.end("unexpected network request"); });
app.whenReady().then(async () => {
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    protocol.handle("lw-recording", () => { requests.push("recording"); return new Response("private audio"); });
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    guardPreviewNavigation(window.webContents);
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
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("PDF viewer regression");
    const bytes = Buffer.from(await pdf.save()).toString("base64");
    await window.webContents.executeJavaScript(`{
      const data = Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0));
      const frame = document.createElement('iframe');
      frame.src = URL.createObjectURL(new Blob([data], {type:'application/pdf'}));
      document.body.append(frame);
    }`);
    const pdfStream = () => window.webContents.mainFrame.framesInSubtree.some((frame) =>
      frame.parent?.url === "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html" && frame.url.startsWith("blob:"));
    for (let attempt = 0; attempt < 50 && !pdfStream(); attempt++) await delay(100);
    assert.ok(pdfStream(), "The built-in PDF viewer must load its internal stream");
    console.log("PASS: the normal PDF viewer remains functional under the navigation guard");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(userData, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
