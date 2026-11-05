// Embedded browser panel: tab state, BrowserView lifecycle, menu overlay,
// proxy configuration, and browser IPC registrations. Extracted from
// main.mjs as a factory so the main process only owns window creation.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserAutomationBroker } from "./browser-automation-broker.mjs";
import { createNativeBrowserHost } from "./browser-native-host.mjs";
import { createBrowserCaptureQueue } from "./browser-capture-queue.mjs";
import { installBrowserDownloads } from "./browser-downloads.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SESSION_PARTITION = "persist:legalwork-browser";
const BROWSER_DEFAULT_URL = "about:blank";
// URL a user-initiated new tab (the "+" button / opening the browser panel)
// lands on. The agent's programmatic path keeps BROWSER_DEFAULT_URL.
const BROWSER_NEW_TAB_URL = "https://www.google.com";
const MENU_OVERLAY_HTML = "overlay.html";
const MENU_OVERLAY_WIDTH = 196;
const MENU_OVERLAY_HEIGHT = 176;
const MENU_OVERLAY_READY_TIMEOUT_MS = 2000;

// Cookies and proxy settings belong to the app; tabs, bounds and selection
// belong to one app window. A detached window must never adopt another's tabs.
let browserTabCounter = 0;
export function createBrowserPanel(options) {
  const { app, getWindow, getWindowForEvent } = options;
  const authorizeBrowserAutomation = context => nativeHost?.authorize(context) ?? options.authorizeBrowserAutomation(context);
  const capture = createBrowserCaptureQueue();
  const automationBroker = createBrowserAutomationBroker({ authorize: authorizeBrowserAutomation, capture });
  const proxyState = { current: null };
  const panels = new Map();
  const nativeHost = options.resolveEngine ? createNativeBrowserHost({ ...options, capture, partition: BROWSER_SESSION_PARTITION,
    adoptPage: (owner, page, context, directory) => panelFor(owner).panel.adoptNativePage(page, context, directory),
    focusPage: (owner, tabID) => panelFor(owner).panel.focusNativePage(tabID),
    sessionError: (owner, context, error) => owner.webContents.send("legalwork:browser:error", { sessionId: context.sessionId, error }),
  }) : null;
  app.once("will-quit", () => { destroy(); void automationBroker.close(); void nativeHost?.dispose(); });
  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy || !proxyState.current?.username) return;
    event.preventDefault();
    callback(proxyState.current.username, proxyState.current.password);
  });

  function panelFor(owner) {
    if (!owner || owner.isDestroyed()) throw new Error("Browser window is unavailable.");
    let entry = panels.get(owner);
    if (entry) return entry;
    const handlers = new Map(), listeners = new Map();
    const panel = createWindowBrowserPanel({ ...options, getWindow: () => owner, authorizeBrowserAutomation, automationBroker, proxyState, nativeHost, capture });
    panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: (name, listener) => listeners.set(name, listener) });
    const closed = () => destroy(owner);
    entry = { panel, handlers, listeners, closed };
    panels.set(owner, entry);
    owner.once("closed", closed);
    return entry;
  }

  function destroy(owner) {
    void nativeHost?.destroy(owner);
    for (const [host, entry] of panels) {
      if (owner && host !== owner) continue;
      host.removeListener("closed", entry.closed);
      entry.panel.destroy();
      panels.delete(host);
    }
  }

  function registerIpc(ipcMain) {
    // Register the existing IPC contract once, resolving the owning window at
    // invocation time. The definition has no views or window lifecycle hooks.
    const definition = createWindowBrowserPanel({ ...options, authorizeBrowserAutomation, automationBroker, proxyState, nativeHost, capture });
    definition.registerIpc({
      handle: (channel) => ipcMain.handle(channel, (event, ...args) => {
        const entry = panelFor(getWindowForEvent ? getWindowForEvent(event) : getWindow?.());
        return entry.handlers.get(channel)(event, ...args);
      }),
      on: (channel) => ipcMain.on(channel, (event, ...args) => {
        // Menu overlays have their own webContents. Each owner validates the
        // sender against its overlay before accepting an action.
        for (const entry of panels.values()) entry.listeners.get(channel)?.(event, ...args);
      }),
    });
  }

  return {
    destroy,
    registerIpc,
    isMainWindowAllowedNavigation: url => !url || url === "about:blank" || options.isAllowedAppNavigation(url),
    routeBlockedMainWindowNavigation: (url, owner = getWindow?.()) => panelFor(owner).panel.routeBlockedMainWindowNavigation(url),
  };
}

function createWindowBrowserPanel({ app, BaseWindow, WebContentsView, clipboard, session, getWindow, isAllowedAppNavigation, safeOpen, resolveDownloadDirectory, authorizeBrowserAutomation, automationBroker, proxyState, nativeHost, capture }) {
  const browserTabs = new Map();
  let browserTabOrder = [];
  let activeBrowserTabId = null;
  let browserViewVisible = false;
  // Last browser panel bounds reported by the renderer, in renderer CSS pixels.
  // Converted to window device-independent pixels at every setBounds call.
  let lastBrowserBounds = null;
  const paneBounds = new Map();
  let menuOverlayView = null;
  let menuOverlayRequest = null;
  let menuOverlayReady = false;
  let menuOverlayReadyResolvers = [];
  let menuOverlayShowSerial = 0;
  let removeDownloadHandler = null;
  let previewWindow = null;

  function ensureDownloadHandler() {
    removeDownloadHandler ??= installBrowserDownloads(session.fromPartition(BROWSER_SESSION_PARTITION),
      (contents) => [...browserTabs.values()].find((tab) => !tab.nativePage && tab.view.webContents === contents));
  }

  function window() { return getWindow?.() ?? null; }

  function resolveTabDownloadDirectory(context = {}) {
    return resolveDownloadDirectory(context, window()?.webContents.getURL?.() ?? "");
  }

  function resetMenuOverlayReady({ resolvePending = false } = {}) {
    menuOverlayReady = false;
    if (resolvePending) {
      const resolvers = menuOverlayReadyResolvers.splice(0);
      for (const resolve of resolvers) resolve(false);
    }
  }

  function markMenuOverlayReady(view) {
    if (!view || view.webContents.isDestroyed()) return;
    menuOverlayReady = true;
    const resolvers = menuOverlayReadyResolvers.splice(0);
    for (const resolve of resolvers) resolve(true);
  }

  function waitForMenuOverlayReady(view) {
    if (menuOverlayReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (ready) => {
        if (timer) clearTimeout(timer);
        menuOverlayReadyResolvers = menuOverlayReadyResolvers.filter((candidate) => candidate !== done);
        resolve(ready);
      };
      timer = setTimeout(() => done(false), MENU_OVERLAY_READY_TIMEOUT_MS);
      menuOverlayReadyResolvers.push(done);
      if (!view || view.webContents.isDestroyed()) done(false);
    });
  }

  /** Send an IPC message to the main renderer, guarding against disposed frames. */
  function sendToRenderer(channel, payload) {
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch { /* window closing */ }
  }

  function createBrowserTabId() {
    browserTabCounter += 1;
    return `tab_${Date.now().toString(36)}_${browserTabCounter.toString(36)}`;
  }

  function normalizeBrowserUrl(url, fallback = BROWSER_DEFAULT_URL) {
    const target = typeof url === "string" && url.trim() ? url.trim() : fallback;
    if (!target || target === "about:blank") return "about:blank";
    return /^https?:\/\//i.test(target) ? target : `https://${target}`;
  }

  // App windows carry the desktop bridge, so they may only show LegalWork's
  // own pages. Everything else is blocked (web links open in a browser tab).
  function isMainWindowAllowedNavigation(url) {
    return !url || url === "about:blank" || isAllowedAppNavigation(url);
  }

  function routeBlockedMainWindowNavigation(url) {
    if (!/^https?:\/\//i.test(String(url ?? ""))) return;
    // A link clicked by the user does not grant an agent an automation handle.
    void resolveTabDownloadDirectory().then(downloadDirectory => createBrowserTab(normalizeBrowserUrl(url), { downloadDirectory })).catch((error) => {
      console.warn("[browser] failed to route blocked main-window navigation", error);
    });
  }

  async function openBrowserUrlForAutomation(rawUrl, provider = "auto", context = {}) {
    await authorizeBrowserAutomation(context);
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "builtin") {
      throw new Error(`Browser provider is not available yet: ${requestedProvider}`);
    }
    const url = normalizeBrowserUrl(rawUrl);
    if (nativeHost) {
      const { result } = await nativeHost.open(window(), url, context);
      const tab = getBrowserTab(result.value.id);
      if (!tab) throw new Error("The native browser did not publish its new tab.");
      return browserConnection(tab, context);
    }
    const downloadDirectory = await resolveTabDownloadDirectory(context);
    const tab = createBrowserTab("about:blank", { select: false, downloadDirectory, taskSessionId: context.sessionId, workspaceId: context.workspaceId });
    let connection;
    try {
      connection = await automationBroker.grant(tab.view.webContents, () => tab.downloads, context, () => {
        if (!tab.taskSessionId || (tab.taskActive && !tab.dismissed)) return;
        tab.taskActive = true;
        tab.dismissed = false;
        sendBrowserState();
      }, () => prepareBrowserCapture(tab));
    } catch (error) {
      closeBrowserTab(tab.tabId);
      throw error;
    }
    tab.connection = connection;
    // Electron's loadURL promise can settle on an earlier navigation's load.
    // Finish the initial blank page before awaiting the requested destination.
    await tab.initialLoad;
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    let downloadStarted;
    const download = new Promise((resolve) => { downloadStarted = resolve; });
    const onDownload = (_event, _item, contents) => {
      if (contents === tab.view.webContents) downloadStarted();
    };
    browserSession.on("will-download", onDownload);
    let downloadTimer;
    try {
      await authorizeBrowserAutomation(context);
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      // Chromium can reject navigation before announcing a direct file download.
      if (!["ERR_ABORTED", "ERR_FAILED"].includes(error.code)) throw error;
      if (tab.downloads.length === 0) {
        await Promise.race([download, new Promise((resolve) => {
          downloadTimer = setTimeout(resolve, 5000);
        })]);
      }
      if (tab.downloads.length === 0) throw error;
    } finally {
      clearTimeout(downloadTimer);
      browserSession.removeListener("will-download", onDownload);
    }
    const snapshot = await automationBroker.snapshot(tab.view.webContents).catch((error) => ({ error: error.message }));
    return {
      provider: "builtin",
      ...connection,
      tab_id: tab.tabId,
      url,
      download_directory: downloadDirectory ? path.join(downloadDirectory, "Downloads") : null,
      downloads: tab.downloads,
      snapshot,
    };
  }

  async function browserConnection(tab, context) {
    if (!tab || (tab.nativeSessionId || tab.taskSessionId) !== context.sessionId || tab.workspaceId !== context.workspaceId || tab.nativeContext?.connectionId !== context.connectionId)
      throw new Error("This browser tab does not belong to the calling project and chat.");
    await authorizeBrowserAutomation(context);
    tab.connection ??= await automationBroker.grant(tab.view.webContents, () => tab.downloads, context, () => {
      tab.taskActive = true; tab.dismissed = false; sendBrowserState();
    }, () => prepareBrowserCapture(tab));
    const browser_url = tab.nativePage ? await nativeHost.extensionConnection(window(), tab.nativeContext, tab.tabId, tab.connection.browser_url) : tab.connection.browser_url;
    return { provider: "builtin", ...tab.connection, browser_url, tab_id: tab.tabId, url: tab.view.webContents.getURL(),
      download_directory: tab.nativeContext?.remote ? null : tab.downloadDirectory ? path.join(tab.downloadDirectory, "Downloads") : null,
      downloads: tab.nativeContext?.remote ? tab.downloads.map(file => ({ ...file, path: null, relativePath: null, transferRequired: file.state === "completed" })) : tab.downloads, snapshot: await automationBroker.snapshot(tab.view.webContents) };
  }

  function adoptNativePage(page, context, downloadDirectory) {
    const tab = createBrowserTab("about:blank", { select: false, downloadDirectory, taskSessionId: context.sessionId, workspaceId: context.workspaceId, nativePage: page });
    tab.nativeSessionId = context.sessionId;
    tab.nativeContext = context;
    Object.defineProperty(tab, "downloads", { get: () => page.localFiles().map(file => ({ id: file.id, name: file.name,
      state: file.state === "pending" ? "progressing" : file.state, receivedBytes: file.bytes, totalBytes: file.bytes,
      path: file.path, relativePath: path.relative(downloadDirectory, file.path).split(path.sep).join("/"),
      error: file.state === "failed" ? "Download failed; inspect the page before retrying." : null })) });
    return tab;
  }

  function focusNativePage(tabID) {
    const tab = selectBrowserTab(tabID);
    sendToRenderer("legalwork:browser:state", { ...browserStatePayload(), focusedTabId: tab.tabId });
  }

  function prepareBrowserCapture(tab) {
    if (!window()?.contentView.children.includes(tab.view)) {
      previewWindow ??= new BaseWindow({ show: false, focusable: false, skipTaskbar: true, width: 1200, height: 800 });
      if (!previewWindow.contentView.children.includes(tab.view)) previewWindow.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
      tab.view.setVisible?.(true);
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        if (tab.view.webContents.isDestroyed()) return;
        const owner = window();
        if (!owner || owner.isDestroyed() || !owner.contentView.children.includes(tab.view)) tab.view.setVisible?.(false);
      };
    }
    return () => {};
  }

  function getBrowserTab(tabId = activeBrowserTabId) {
    return tabId ? browserTabs.get(tabId) ?? null : null;
  }

  function getActiveBrowserView() {
    return getBrowserTab()?.view ?? null;
  }

  function getActiveWebContents() {
    return getActiveBrowserView()?.webContents ?? null;
  }

  function getBrowserTabLabel(title, url) {
    if (title) {
      return title;
    }

    if (url && url !== "about:blank") {
      return url;
    }

    return "New tab";
  }

  function browserTabToPanelTab(tabId, tab) {
    const webContents = tab.view.webContents;
    const url = webContents.getURL();
    const title = webContents.getTitle();
    const isLoading = webContents.isLoading();

    return {
      id: tabId,
      background: tab.background,
      taskSessionId: tab.taskActive ? tab.taskSessionId : undefined,
      workspaceId: tab.workspaceId,
      dismissed: tab.dismissed,
      type: "browser",
      label: getBrowserTabLabel(title, url),
      url,
      favicon: tab.favicon ?? null,
      status: isLoading ? "loading" : "ready",
      canGoBack: (webContents.navigationHistory ?? webContents).canGoBack(),
      canGoForward: (webContents.navigationHistory ?? webContents).canGoForward(),
    };
  }

  function listBrowserTabs() {
    return browserTabOrder
      .map((tabId) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return null;
        return browserTabToPanelTab(tabId, tab);
      })
      .filter(Boolean);
  }

  function browserStatePayload() {
    return {
      activeTabId: activeBrowserTabId,
      tabs: listBrowserTabs(),
    };
  }

  function browserTabUrl(tab) {
    const url = tab?.view?.webContents?.getURL?.();
    return typeof url === "string" && url && url !== "about:blank" ? url : null;
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeMenuOverlayPoint(point) {
    if (!point || typeof point !== "object") {
      return { x: 0, y: 0 };
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: 0, y: 0 };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function menuOverlayBounds(point) {
    const [contentWidth, contentHeight] = window()?.getContentSize?.() ?? [MENU_OVERLAY_WIDTH, MENU_OVERLAY_HEIGHT];
    return {
      x: Math.min(Math.max(point.x, 0), Math.max(contentWidth - MENU_OVERLAY_WIDTH - 4, 0)),
      y: Math.min(Math.max(point.y, 0), Math.max(contentHeight - MENU_OVERLAY_HEIGHT - 4, 0)),
      width: MENU_OVERLAY_WIDTH,
      height: MENU_OVERLAY_HEIGHT,
    };
  }

  function menuOverlayUrl() {
    const currentUrl = window()?.webContents?.getURL?.();
    if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
      return new URL(MENU_OVERLAY_HTML, currentUrl).toString();
    }
    return null;
  }

  async function loadMenuOverlayRenderer(view) {
    const devUrl = menuOverlayUrl();
    if (devUrl) {
      await view.webContents.loadURL(devUrl);
      return;
    }

    const packagedOverlayPath = path.join(process.resourcesPath, "app-dist", MENU_OVERLAY_HTML);
    const devOverlayPath = path.resolve(__dirname, "../../app/dist", MENU_OVERLAY_HTML);
    await view.webContents.loadFile(app.isPackaged ? packagedOverlayPath : devOverlayPath);
  }

  async function ensureMenuOverlayView() {
    if (menuOverlayView && !menuOverlayView.webContents.isDestroyed()) {
      return menuOverlayView;
    }

    const view = new WebContentsView({
      webPreferences: {
        // Keep the bridge isolated and node-free for the React overlay document.
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "menu-overlay-preload.cjs"),
      },
    });
    view.setBackgroundColor?.("#00000000");
    view.setVisible?.(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) resetMenuOverlayReady();
    });
    view.webContents.once("destroyed", () => {
      if (menuOverlayView === view) {
        menuOverlayView = null;
        menuOverlayRequest = null;
        resetMenuOverlayReady({ resolvePending: true });
      }
    });

    menuOverlayView = view;
    resetMenuOverlayReady({ resolvePending: true });
    await loadMenuOverlayRenderer(view);
    return view;
  }

  function hideMenuOverlay() {
    const view = menuOverlayView;
    const mainWindow = window();
    menuOverlayShowSerial += 1;
    menuOverlayRequest = null;
    if (!view || !mainWindow) return;
    view.setVisible?.(false);
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
        view.setVisible?.(false);
      }
    } catch {
      // already removed
    }
  }

  function bringMenuOverlayToTop(view) {
    const mainWindow = window();
    if (!mainWindow) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
    mainWindow.contentView.addChildView(view);
  }

  function tabMenuRequest(tab, point) {
    const url = browserTabUrl(tab);
    return {
      id: `tab-menu:${tab.tabId}:${Date.now()}`,
      source: "tab",
      tabId: tab.tabId,
      url,
      bounds: menuOverlayBounds(normalizeMenuOverlayPoint(point)),
      items: [
        { id: "copy-url", label: "Copy URL", iconName: "copy", disabled: !url },
        { id: "open-external", label: "Open in Browser", iconName: "external", disabled: !(url && isHttpUrl(url)) },
        { id: "close-tab", label: "Close Tab", iconName: "close", separatorBefore: true },
        { id: "close-all-tabs", label: "Close All Tabs", iconName: "close" },
      ],
    };
  }

  async function showBrowserTabContextMenu(tabId, point) {
    const tab = getBrowserTab(String(tabId ?? ""));
    if (!window() || !tab || tab.view.webContents.isDestroyed()) return;

    const showSerial = menuOverlayShowSerial + 1;
    menuOverlayShowSerial = showSerial;
    const request = tabMenuRequest(tab, point ? scaleRendererPoint(point) : point);
    const view = await ensureMenuOverlayView();
    if (showSerial !== menuOverlayShowSerial || menuOverlayView !== view) return;
    menuOverlayRequest = request;
    view.setBounds(request.bounds);
    view.setVisible?.(true);
    bringMenuOverlayToTop(view);
    const ready = await waitForMenuOverlayReady(view);
    if (showSerial !== menuOverlayShowSerial || menuOverlayRequest !== request || menuOverlayView !== view) return;
    if (!ready) {
      console.warn("[menu-overlay] renderer did not signal readiness before show");
    }
    view.webContents.send("legalwork:menu-overlay:show", {
      id: request.id,
      source: request.source,
      items: request.items,
    });
    view.webContents.focus();
  }

  function handleMenuOverlayChoice(payload) {
    if (!payload || payload.requestId !== menuOverlayRequest?.id) return;
    const request = menuOverlayRequest;
    const tab = getBrowserTab(request.tabId);
    hideMenuOverlay();

    switch (payload.itemId) {
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) void safeOpen.openExternal(request.url);
        break;
      case "close-tab":
        if (tab) closeUserBrowserTab(tab);
        break;
      case "close-all-tabs":
        closeAllBrowserTabs();
        break;
    }
  }

  function resolveBrowserProxyInput(input) {
    const raw = String(input ?? "").trim();
    const envMatch = raw.match(/^env:([A-Za-z0-9_]+)$/i);
    if (!envMatch) return raw;
    const key = `LEGALWORK_BROWSER_PROXY_${envMatch[1].toUpperCase()}`;
    const value = String(process.env[key] ?? "").trim();
    if (!value) throw new Error(`No proxy configured: set the ${key} environment variable to a proxy URL.`);
    return value;
  }

  function parseBrowserProxyInput(input) {
    const raw = resolveBrowserProxyInput(input);
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`Invalid proxy URL: ${raw}`);
    }
    if (!url.hostname || !url.port) {
      throw new Error("Proxy must include host and port, e.g. http://user:pass@host:8080 or socks5://host:1080.");
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    return {
      rules: `${scheme}://${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  function browserProxyState() {
    return {
      proxy: proxyState.current
        ? { rules: proxyState.current.rules, authenticated: Boolean(proxyState.current.username) }
        : null,
    };
  }

  async function setBrowserProxy(proxyInput) {
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    const parsed = parseBrowserProxyInput(proxyInput);
    if (parsed) {
      await browserSession.setProxy({ proxyRules: parsed.rules, proxyBypassRules: "<local>" });
    } else {
      await browserSession.setProxy({ mode: "system" });
    }
    proxyState.current = parsed;
    // Drop keep-alive connections so existing tabs cannot bypass the new proxy.
    await browserSession.closeAllConnections();
    return browserProxyState();
  }

  function createBrowserTab(url = "about:blank", { select = true, downloadDirectory = null, taskSessionId = "", workspaceId = "", nativePage = null } = {}) {
    ensureDownloadHandler();
    const tabId = nativePage?.state().id ?? createBrowserTabId();
    const view = nativePage?.view ?? new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "browser-content-preload.cjs"),
        partition: BROWSER_SESSION_PARTITION,
      },
    });
    // Load about:blank immediately to preempt persistent-session restore.
    // Cookies live on the session object, not the document — they survive this.
    const initialLoad = nativePage?.ready ?? view.webContents.loadURL("about:blank");
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    const tab = { tabId, view, background: !select, taskSessionId, workspaceId, taskActive: Boolean(taskSessionId), dismissed: false, favicon: null, downloadDirectory, downloads: [], initialLoad, nativePage };
    browserTabs.set(tabId, tab);
    browserTabOrder.push(tabId);
    // A web page asking for a new window. It cannot open one here, and the
    // safe opener decides whether the OS ever sees the link.
    if (!nativePage) view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      void safeOpen.openExternal(targetUrl);
      return { action: "deny" };
    });
    // Navigation is data work. Only explicit user selection may attach a tab
    // to the visible pane; a redirect or an agent's CDP call must not do so.
    view.webContents.on("focus", () => {
      if (!browserViewVisible || !window()?.contentView.children.includes(view)) return;
      activeBrowserTabId = tabId;
      sendToRenderer("legalwork:browser:state", { ...browserStatePayload(), focusedTabId: tabId });
    });
    view.webContents.on("did-navigate", () => sendBrowserState());
    view.webContents.on("did-navigate-in-page", () => sendBrowserState());
    view.webContents.on("page-title-updated", () => sendBrowserState());
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
      sendBrowserState();
    });
    view.webContents.on("did-start-loading", () => sendBrowserState());
    view.webContents.on("did-stop-loading", () => sendBrowserState());
    view.webContents.once("destroyed", () => {
      if (previewWindow?.contentView.children.includes(view)) previewWindow.contentView.removeChildView(view);
      browserTabs.delete(tabId);
      paneBounds.delete(tabId);
      browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
      if (activeBrowserTabId === tabId) activeBrowserTabId = browserTabOrder.find(id => !browserTabs.get(id)?.background) ?? null;
      sendBrowserState();
    });
    if (select) {
      selectBrowserTab(tabId);
    } else {
      sendBrowserState();
    }
    const finalUrl = normalizeBrowserUrl(url, "about:blank");
    if (!nativePage && finalUrl !== "about:blank") {
      view.webContents.loadURL(finalUrl);
    }
    return tab;
  }

  function detachBrowserView(view) {
    const mainWindow = window();
    if (!mainWindow || !view) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
  }

  // The renderer reports bounds in CSS pixels, which Electron scales by the main
  // window's zoom factor. Read the factor from the webContents at apply time so
  // the conversion is always correct, no matter how the zoom was changed
  // (shortcuts, native menu, or Chromium's persisted per-origin zoom).
  function mainWindowZoomFactor() {
    try {
      const factor = window()?.webContents.getZoomFactor();
      return typeof factor === "number" && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  function scaleRendererBounds(bounds) {
    const zoom = mainWindowZoomFactor();
    // Round edges (not width/height) so the far edge has no sub-pixel seam.
    const x = Math.round(bounds.x * zoom);
    const y = Math.round(bounds.y * zoom);
    return {
      x,
      y,
      width: Math.round((bounds.x + bounds.width) * zoom) - x,
      height: Math.round((bounds.y + bounds.height) * zoom) - y,
    };
  }

  function scaleRendererPoint(point) {
    const zoom = mainWindowZoomFactor();
    return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  }

  function attachActiveBrowserView() {
    const mainWindow = window();
    if (!mainWindow || !browserViewVisible) return;
    for (const [id, tab] of browserTabs) {
      const bounds = paneBounds.size ? paneBounds.get(id) : id === activeBrowserTabId ? lastBrowserBounds : null;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) { detachBrowserView(tab.view); continue; }
      if (!mainWindow.contentView.children.includes(tab.view)) mainWindow.contentView.addChildView(tab.view);
      tab.view.setBounds(scaleRendererBounds(bounds));
      tab.view.setVisible?.(true);
    }
  }

  function selectBrowserTab(tabId) {
    if (!browserTabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
    hideMenuOverlay();
    browserTabs.get(tabId).background = false;
    const previousView = getActiveBrowserView();
    activeBrowserTabId = tabId;
    if (previousView && previousView !== getActiveBrowserView() && ![...paneBounds.keys()].some(id => browserTabs.get(id)?.view === previousView)) {
      detachBrowserView(previousView);
    }
    attachActiveBrowserView();
    sendBrowserState();
    return getBrowserTab(tabId);
  }

  function returnBrowserTabToBackground(tab) {
    detachBrowserView(tab.view);
    paneBounds.delete(tab.tabId);
    tab.background = true;
    tab.dismissed = false;
    if (activeBrowserTabId === tab.tabId) activeBrowserTabId = browserTabOrder.find(id => !browserTabs.get(id)?.background) ?? null;
    sendBrowserState();
    return tab.tabId;
  }

  function closeUserBrowserTab(tab) {
    return tab.taskActive ? returnBrowserTabToBackground(tab) : closeBrowserTab(tab.tabId);
  }

  function closeBrowserTab(tabId = activeBrowserTabId) {
    const tab = getBrowserTab(tabId);
    if (!tab) return null;
    capture.close(tab.view.webContents);
    if (menuOverlayRequest?.tabId === tabId) hideMenuOverlay();
    const closingIndex = browserTabOrder.indexOf(tabId);
    const wasActive = activeBrowserTabId === tabId;
    detachBrowserView(tab.view);
    browserTabs.delete(tabId);
    paneBounds.delete(tabId);
    browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
    if (wasActive) {
      const visibleTabs = browserTabOrder.filter(id => !browserTabs.get(id)?.background);
      const nextTabId = visibleTabs[Math.min(closingIndex, visibleTabs.length - 1)] ?? null;
      activeBrowserTabId = nextTabId;
      if (nextTabId) {
        attachActiveBrowserView();
      } else {
        hideBrowserView();
        sendToRenderer("legalwork:browser:panel-closed");
      }
    }
    if (tab.nativePage) {
      nativeHost.releaseExtension(window(), tab.nativeContext, tabId);
      void nativeHost.command(window(), tab.nativeContext, { type: "tabs.close", tabID: tabId }).catch(error => console.warn("[browser] native tab close failed", error));
    }
    else { try { tab.view.webContents.close(); } catch { /* already destroyed */ } }
    sendBrowserState();
    return tabId;
  }

  function closeAllBrowserTabs() {
    const closedTabIds = browserTabOrder.filter(id => !browserTabs.get(id)?.background);
    hideMenuOverlay();
    for (const id of closedTabIds) closeUserBrowserTab(browserTabs.get(id));
    return closedTabIds;
  }

  function reorderBrowserTabs(tabIds) {
    const nextOrder = Array.isArray(tabIds) ? tabIds.map(String) : [];
    if (new Set(nextOrder).size !== nextOrder.length) {
      throw new Error("Tab order must not contain duplicate tabs.");
    }
    const current = new Set(browserTabOrder);
    if (nextOrder.some((tabId) => !current.has(tabId))) {
      throw new Error("Tab order contains an unknown tab.");
    }
    // A renderer reorders one strip, not every pane and project in the app.
    const moved = new Set(nextOrder);
    let index = 0;
    browserTabOrder = browserTabOrder.map(id => moved.has(id) ? nextOrder[index++] : id);
    sendBrowserState();
    return listBrowserTabs();
  }

  function sendBrowserState() {
    sendToRenderer("legalwork:browser:state", browserStatePayload());
  }

  /**
   * Attach the browser view to the main window.
   * @param {object} bounds — { x, y, width, height }
   * @param {object} [opts]
   * @param {boolean} [opts.preloadDefault=false] - load default URL if the view has no URL
   * @param {boolean} [opts.ensureTab=false] - create a blank tab if needed
   */
  function attachBrowserView(bounds, { preloadDefault = false, ensureTab = false } = {}) {
    if (!window()) return;
    lastBrowserBounds = bounds;
    browserViewVisible = true;
    if (ensureTab && !activeBrowserTabId) createBrowserTab("about:blank");
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    if (bounds.width > 0 && bounds.height > 0) {
      view?.setBounds(scaleRendererBounds(bounds));
    }
    const url = view?.webContents.getURL();
    if (preloadDefault && (!url || url === "about:blank")) {
      view?.webContents.loadURL(BROWSER_DEFAULT_URL);
    }
    sendBrowserState();
  }

  function hideBrowserView(tabId) {
    if (tabId) {
      paneBounds.delete(tabId);
      const tab = getBrowserTab(tabId);
      if (tab) detachBrowserView(tab.view);
      if (!paneBounds.size) browserViewVisible = false;
      return;
    }
    paneBounds.clear();
    hideMenuOverlay();
    browserViewVisible = false;
    if (!window()) return;
    for (const tab of browserTabs.values()) {
      detachBrowserView(tab.view);
    }
  }

  function destroyBrowserView() {
    removeDownloadHandler?.();
    removeDownloadHandler = null;
    hideBrowserView();
    const overlayView = menuOverlayView;
    menuOverlayView = null;
    menuOverlayRequest = null;
    try { overlayView?.webContents.close(); } catch { /* already destroyed */ }
    for (const tab of browserTabs.values()) {
      capture.close(tab.view.webContents);
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    previewWindow?.destroy();
    previewWindow = null;
    browserTabs.clear();
    browserTabOrder = [];
    activeBrowserTabId = null;
    lastBrowserBounds = null;
    sendBrowserState();
  }

  function validBounds(bounds) {
    return bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
  }

  function registerIpc(ipcMain) {
    ipcMain.handle("legalwork:browser:registerConnection", (event, value) => {
      if (!nativeHost || event.sender !== window()?.webContents || event.senderFrame && event.senderFrame !== event.sender.mainFrame || !isAllowedAppNavigation(event.sender.getURL())) throw new Error("Only the trusted LegalWork app can register its selected server.");
      return nativeHost.registerConnection(window(), value);
    });
    ipcMain.handle("legalwork:browser:attachSession", async (_event, context) => {
      if (!nativeHost) throw new Error("Native browser integration is unavailable.");
      await nativeHost.attach(window(), context); return { attached: true };
    });
    ipcMain.handle("legalwork:browser:connection", (_event, tabID, context) => browserConnection(getBrowserTab(tabID), context));
    ipcMain.handle("legalwork:browser:show", (event, bounds, tabId) => {
      if (!validBounds(bounds)) return;
      if (tabId) {
        if (!browserTabs.has(tabId)) return;
        paneBounds.set(tabId, bounds);
        browserViewVisible = true;
        attachActiveBrowserView();
        return;
      }
      return attachBrowserView(bounds);
    });
    ipcMain.handle("legalwork:browser:hide", (event, tabId) => {
      if (event.sender !== window()?.webContents) return;
      return hideBrowserView(tabId);
    });
    ipcMain.handle("legalwork:browser:openUrl", (event, url, provider, context) => {
      return openBrowserUrlForAutomation(url, provider, context);
    });
    ipcMain.handle("legalwork:browser:navigate", async (event, url, tabId) => {
      const view = tabId ? getBrowserTab(tabId)?.view : getActiveBrowserView() ?? createBrowserTab("about:blank", { select: true, downloadDirectory: await resolveTabDownloadDirectory() }).view;
      view?.webContents.loadURL(normalizeBrowserUrl(url));
    });
    ipcMain.handle("legalwork:browser:back", (event, tabId) => {
      const webContents = tabId ? getBrowserTab(tabId)?.view.webContents : getActiveWebContents();
      const navigation = webContents?.navigationHistory ?? webContents;
      if (navigation?.canGoBack()) navigation.goBack();
    });
    ipcMain.handle("legalwork:browser:forward", (event, tabId) => {
      const webContents = tabId ? getBrowserTab(tabId)?.view.webContents : getActiveWebContents();
      const navigation = webContents?.navigationHistory ?? webContents;
      if (navigation?.canGoForward()) navigation.goForward();
    });
    ipcMain.handle("legalwork:browser:reload", (event, tabId) => {
      return (tabId ? getBrowserTab(tabId)?.view.webContents : getActiveWebContents())?.reload();
    });
    ipcMain.handle("legalwork:browser:bounds", (event, bounds, tabId) => {
      if (!validBounds(bounds)) return;
      if (event.sender !== window()?.webContents) return;
      if (tabId) {
        if (!paneBounds.has(tabId)) return;
        paneBounds.set(tabId, bounds);
        const view = getBrowserTab(tabId)?.view;
        if (view && bounds.width > 0 && bounds.height > 0) view.setBounds(scaleRendererBounds(bounds));
        return;
      }
      lastBrowserBounds = bounds;
      const view = getActiveBrowserView();
      if (view && browserViewVisible && bounds.width > 0 && bounds.height > 0) {
        view.setBounds(scaleRendererBounds(bounds));
      }
    });
    ipcMain.handle("legalwork:browser:state", () => {
      return browserStatePayload();
    });
    ipcMain.handle("legalwork:browser:createTab", async (event, url) => {
      const target = typeof url === "string" && url.trim() ? url : BROWSER_NEW_TAB_URL;
      const tab = createBrowserTab(target, { select: true, downloadDirectory: await resolveTabDownloadDirectory() });
      return { tabId: tab.tabId };
    });
    ipcMain.handle("legalwork:browser:closeTab", (event, tabId) => {
      const tab = getBrowserTab(tabId == null ? undefined : String(tabId));
      return tab ? closeUserBrowserTab(tab) : null;
    });
    ipcMain.handle("legalwork:browser:dismissTab", (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab?.background) return;
      if (!tab.taskActive) return closeBrowserTab(tabId);
      tab.dismissed = true;
      sendBrowserState();
    });
    ipcMain.handle("legalwork:browser:releaseSession", (_event, sessionId) => {
      for (const tab of [...browserTabs.values()]) {
        if (tab.taskSessionId !== sessionId) continue;
        tab.taskActive = false;
        if (tab.background) closeBrowserTab(tab.tabId);
      }
      sendBrowserState();
    });
    ipcMain.handle("legalwork:browser:previewTab", async (_event, tabId) => {
      const tab = getBrowserTab(tabId);
      if (!tab || tab.view.webContents.isDestroyed()) return null;
      await tab.initialLoad;
      if (getBrowserTab(tabId) !== tab || tab.view.webContents.isDestroyed()) return null;
      if (tab.nativePage && !tab.connection) tab.connection = await automationBroker.grant(tab.view.webContents, () => tab.downloads,
        tab.nativeContext, () => { tab.taskActive = true; tab.dismissed = false; sendBrowserState(); }, () => prepareBrowserCapture(tab));
      return automationBroker.preview(tab.view.webContents, () => {
        // Preserve the existing hidden preview host, but prepare only after this
        // page's preceding native screenshot has physically finished.
        if (!window()?.contentView.children.includes(tab.view)) {
          previewWindow ??= new BaseWindow({ show: false, focusable: false, skipTaskbar: true, width: 1200, height: 800 });
          if (!previewWindow.contentView.children.includes(tab.view)) previewWindow.contentView.addChildView(tab.view);
          tab.view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
        }
        tab.view.setVisible?.(true);
      });
    });
    ipcMain.handle("legalwork:browser:closeAllTabs", (event) => {
      return closeAllBrowserTabs();
    });
    ipcMain.handle("legalwork:browser:selectTab", (event, tabId) => {
      return selectBrowserTab(String(tabId ?? "")).tabId;
    });
    ipcMain.handle("legalwork:browser:reorderTabs", (event, tabIds) => {
      return reorderBrowserTabs(tabIds);
    });
    ipcMain.handle("legalwork:browser:listTabs", () => {
      return listBrowserTabs();
    });
    ipcMain.handle("legalwork:browser:setProxy", async (_event, proxy, context) => {
      await authorizeBrowserAutomation(context);
      return setBrowserProxy(proxy);
    });
    ipcMain.handle("legalwork:browser:getProxy", () => browserProxyState());
    ipcMain.handle("legalwork:browser:tabContextMenu", (event, tabId, point) => {
      return showBrowserTabContextMenu(tabId, point);
    });
    ipcMain.handle("legalwork:browser:destroy", (event) => {
      return destroyBrowserView();
    });
    ipcMain.on("legalwork:menu-overlay:ready", (event) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      markMenuOverlayReady(menuOverlayView);
    });
    ipcMain.on("legalwork:menu-overlay:choose", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      handleMenuOverlayChoice(payload);
    });
    ipcMain.on("legalwork:menu-overlay:close", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      if (payload?.requestId && payload.requestId !== menuOverlayRequest?.id) return;
      hideMenuOverlay();
    });
    ipcMain.on("legalwork:menu-overlay:dismiss", (event) => {
      if (event.sender === menuOverlayView?.webContents) return;
      hideMenuOverlay();
    });
  }

  return {
    destroy: destroyBrowserView,
    adoptNativePage,
    focusNativePage,
    isMainWindowAllowedNavigation,
    registerIpc,
    routeBlockedMainWindowNavigation,
  };
}
