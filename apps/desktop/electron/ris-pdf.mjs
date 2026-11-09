import { randomUUID } from "node:crypto";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function officialResource(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["ogd.ris.bka.gv.at", "www.ris.bka.gv.at", "ris.bka.gv.at"].includes(url.hostname)
      && url.pathname.startsWith("/Dokumente/");
  } catch { return false; }
}

/** Print the fetched source in a disposable renderer, outside task browser tabs. */
export async function renderRisHtmlPdf(document, callerSignal) {
  if (!officialResource(document.sourceUrl)) throw new Error("RIS PDF rendering requires an official RIS document URL.");
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(45_000)]);
  signal.throwIfAborted();
  const { BrowserWindow, session } = await import("electron");
  const isolated = session.fromPartition(`ris-pdf-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (_event, item) => item.cancel());
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(
    details.resourceType === "mainFrame" && details.url.startsWith("data:text/html;base64,")
    || ["image", "stylesheet", "font"].includes(details.resourceType) && (details.url.startsWith("data:") || officialResource(details.url))
  ) }));
  const window = new BrowserWindow({
    show: false, skipTaskbar: true, focusable: false,
    webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-redirect", event => event.preventDefault());
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://ogd.ris.bka.gv.at https://www.ris.bka.gv.at https://ris.bka.gv.at; img-src data: https://ogd.ris.bka.gv.at https://www.ris.bka.gv.at https://ris.bka.gv.at; font-src data: https://ogd.ris.bka.gv.at https://www.ris.bka.gv.at https://ris.bka.gv.at"><base href="${escapeHtml(document.sourceUrl)}">`;
  const printStyle = `<style>@page { size: A4; margin: 18mm 16mm 24mm; }
    body { height: auto !important; margin: 0 !important; }
    .paperw, .paperw100, .margins { width: auto !important; max-width: 100% !important; margin: 0 !important; }
    .sr-only { display: none !important; } img, table { max-width: 100%; }
    .contentBlock > div:has(> .num) { margin-left: 0 !important; grid-template-columns: 35px minmax(0, 1fr) !important; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }</style>`;
  // Preserve the original body, tables, links and styles. Only print geometry
  // and screen-reader duplicates are adjusted; source scripts never execute.
  const html = /<head(?:\s[^>]*)?>/i.test(document.html)
    ? document.html.replace(/<head(?:\s[^>]*)?>/i, match => match + head).replace(/<\/head>/i, printStyle + "</head>")
    : `<!doctype html><html><head>${head}${printStyle}</head><body>${document.html}</body></html>`;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, (async () => {
      await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
      signal.throwIfAborted();
      return window.webContents.printToPDF({
        pageSize: "A4", preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true,
        displayHeaderFooter: true, headerTemplate: "<span></span>",
        footerTemplate: `<div style="width:100%;padding:0 16mm;font-size:7px;color:#555;font-family:Arial;overflow-wrap:anywhere"><div>${escapeHtml(document.title)}. RIS, Bundeskanzleramt, Republik Österreich (CC BY 4.0).</div><div>Generated from original RIS HTML, retrieved ${new Date().toISOString()}. ${escapeHtml(document.sourceUrl)}</div><div><span class="pageNumber"></span> / <span class="totalPages"></span></div></div>`,
      });
    })()]);
  } finally {
    signal.removeEventListener("abort", abort);
    if (!window.isDestroyed()) window.destroy();
    await isolated.clearStorageData();
  }
}
