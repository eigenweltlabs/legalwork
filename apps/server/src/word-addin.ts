/**
 * Word add-in host: serves the built task pane bundle, a same-origin
 * bootstrap endpoint, and the add-in manifest.
 *
 * All responses under /word-addin are intentionally served WITHOUT CORS
 * headers. The bootstrap endpoint hands out the client bearer token so the
 * task pane (same origin -- it is served by this server) can authenticate;
 * cross-origin pages must not be able to read it.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerConfig, WordAddinConfig } from "./types.js";
import type { ServeTlsOptions } from "./serve-node.js";
import { buildWordAddinRedirectorHtml, buildWordAddinShellHtml, WORD_ADDIN_SHELL_VERSION } from "./word-addin-shell.js";

export const WORD_ADDIN_PATH_PREFIX = "/word-addin";

export type WordAddinHost = "word" | "excel" | "powerpoint";

/**
 * Stable identities of the add-in across installs; referenced by Office.
 * `all` is the original multi-host manifest id (macOS sideload folders,
 * manual downloads). The per-host ids exist for Windows, where each Office
 * app is registered individually under HKCU\...\WEF\Developer and the
 * registry value name must be the manifest's Id — so per-app install needs
 * per-app manifests with distinct ids.
 *
 * Keep in sync with the copies in
 * apps/desktop/electron/office-addin-platform.mjs and
 * apps/desktop/build/installer.nsh (the NSIS uninstaller cleanup).
 */
export const WORD_ADDIN_MANIFEST_IDS: Record<"all" | WordAddinHost, string> = {
  all: "47744a24-6fd7-4ee5-b981-97b16ce5d488",
  word: "fdea378d-ff62-4a4f-af08-d1622c083957",
  excel: "65facd67-9deb-4356-8072-e2cc6e36d9fe",
  powerpoint: "db1cc438-a239-4b01-b732-2ff838ecca38",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Directories where `office-addin-dev-certs` may have installed certificates.
 * Desktop hosts (Electron) can override HOME to an app-scoped sandbox, so the
 * real account home from the user database is probed as well.
 */
function devCertCandidateDirs(): string[] {
  const dirs = [join(homedir(), ".office-addin-dev-certs")];
  try {
    const realHome = userInfo().homedir;
    const candidate = realHome ? join(realHome, ".office-addin-dev-certs") : "";
    if (candidate && !dirs.includes(candidate)) dirs.push(candidate);
  } catch {
    // userInfo can throw for accounts without a passwd entry.
  }
  return dirs;
}

async function readOrError(path: string): Promise<{ content: string } | { error: string }> {
  try {
    return { content: await readFile(path, "utf8") };
  } catch (error) {
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type WordAddinTlsResult = {
  tls: ServeTlsOptions | null;
  certPath: string;
  keyPath: string;
  /** Human-readable reason when tls is null. */
  error?: string;
};

/**
 * Load the TLS material for the add-in HTTPS listener. Falls back to the
 * certificates installed by `npx office-addin-dev-certs install` when no
 * explicit paths are configured.
 */
export async function loadWordAddinTls(wordAddin: WordAddinConfig): Promise<WordAddinTlsResult> {
  const seen = new Set<string>();
  const candidates = devCertCandidateDirs()
    .map((dir) => ({
      certPath: wordAddin.certPath ?? join(dir, "localhost.crt"),
      keyPath: wordAddin.keyPath ?? join(dir, "localhost.key"),
    }))
    .filter((candidate) => {
      const id = `${candidate.certPath}\n${candidate.keyPath}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  const errors: string[] = [];
  for (const { certPath, keyPath } of candidates) {
    const [cert, key] = await Promise.all([readOrError(certPath), readOrError(keyPath)]);
    if ("content" in cert && "content" in key) {
      return { tls: { cert: cert.content, key: key.content }, certPath, keyPath };
    }
    errors.push(...[cert, key].flatMap((entry) => ("error" in entry ? [entry.error] : [])));
  }

  const last = candidates[candidates.length - 1]!;
  return { tls: null, certPath: last.certPath, keyPath: last.keyPath, error: errors.join("; ") };
}

/**
 * Locate the built task pane bundle. Explicit config wins; otherwise probe
 * the monorepo layout relative to this module (works from src/ via bun and
 * from dist/ after tsc -- both sit two levels below apps/server).
 */
export async function resolveWordAddinDistPath(wordAddin: WordAddinConfig): Promise<string | null> {
  const candidates: string[] = [];
  if (wordAddin.distPath) {
    candidates.push(resolve(wordAddin.distPath));
  } else {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      candidates.push(resolve(here, "..", "..", "app", "dist-word-addin"));
    } catch {
      // import.meta.url may be unusable in single-file compiled builds.
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(join(candidate, "taskpane.html"));
      if (info.isFile()) return candidate;
    } catch {
      // keep probing
    }
  }
  return null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `<Hosts>` declaration names, in the manifest's declaration order. */
const HOST_DECLARATIONS: ReadonlyArray<{ host: WordAddinHost; name: string }> = [
  { host: "word", name: "Document" },
  { host: "excel", name: "Workbook" },
  { host: "powerpoint", name: "Presentation" },
];

/** VersionOverrides blocks, in the manifest's (historical) block order. */
const VERSION_OVERRIDE_HOSTS: ReadonlyArray<{ host: WordAddinHost; xsiType: string; idInfix: string }> = [
  { host: "word", xsiType: "Document", idInfix: "" },
  { host: "powerpoint", xsiType: "Presentation", idInfix: "Ppt." },
  { host: "excel", xsiType: "Workbook", idInfix: "Excel." },
];

function versionOverrideHostXml(xsiType: string, idInfix: string): string {
  return `      <Host xsi:type="${xsiType}">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="LegalWork.${idInfix}Group">
                <Label resid="LegalWork.GroupLabel"/>
                <Icon>
                  <bt:Image size="16" resid="LegalWork.Icon16"/>
                  <bt:Image size="32" resid="LegalWork.Icon32"/>
                  <bt:Image size="80" resid="LegalWork.Icon80"/>
                </Icon>
                <Control xsi:type="Button" id="LegalWork.${idInfix}OpenPane">
                  <Label resid="LegalWork.OpenPane.Label"/>
                  <Supertip>
                    <Title resid="LegalWork.OpenPane.Label"/>
                    <Description resid="LegalWork.OpenPane.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="LegalWork.Icon16"/>
                    <bt:Image size="32" resid="LegalWork.Icon32"/>
                    <bt:Image size="80" resid="LegalWork.Icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>LegalWork.TaskPane</TaskpaneId>
                    <SourceLocation resid="LegalWork.Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>`;
}

/**
 * Add-in only manifest (XML) for the Office task pane. The base URL is the
 * HTTPS listener this server starts; Office requires HTTPS even on localhost.
 *
 * Without `host` this is the multi-host manifest (Word + Excel + PowerPoint)
 * used on macOS and for manual downloads. With `host` it is a single-host
 * manifest with that host's stable id — Windows registers each Office app
 * individually in the registry, keyed by manifest id.
 */
export function buildWordAddinManifest(input: {
  baseUrl: string;
  version?: string;
  host?: WordAddinHost;
}): string {
  const base = xmlEscape(input.baseUrl.replace(/\/+$/, ""));
  const version = /^\d+\.\d+\.\d+\.\d+$/.test(input.version ?? "") ? input.version : "1.0.0.0";
  const manifestId = WORD_ADDIN_MANIFEST_IDS[input.host ?? "all"];
  const hostDeclarations = HOST_DECLARATIONS.filter(
    (entry) => !input.host || entry.host === input.host,
  )
    .map((entry) => `    <Host Name="${entry.name}"/>`)
    .join("\n");
  const versionOverrideHosts = VERSION_OVERRIDE_HOSTS.filter(
    (entry) => !input.host || entry.host === input.host,
  )
    .map((entry) => versionOverrideHostXml(entry.xsiType, entry.idInfix))
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">
  <Id>${manifestId}</Id>
  <Version>${version}</Version>
  <ProviderName>Eigenwelt Labs</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="LegalWork"/>
  <Description DefaultValue="The LegalWork agent in the Word sidebar. Draft, review, and rework documents with your workspaces."/>
  <IconUrl DefaultValue="${base}/word-addin/favicon-32x32.png"/>
  <HighResolutionIconUrl DefaultValue="${base}/word-addin/apple-touch-icon.png"/>
  <SupportUrl DefaultValue="https://eigenweltlabs.com"/>
  <AppDomains>
    <AppDomain>${base}</AppDomain>
  </AppDomains>
  <Hosts>
${hostDeclarations}
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="${base}/word-addin/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
${versionOverrideHosts}
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="LegalWork.Icon16" DefaultValue="${base}/word-addin/favicon-16x16.png"/>
        <bt:Image id="LegalWork.Icon32" DefaultValue="${base}/word-addin/favicon-32x32.png"/>
        <bt:Image id="LegalWork.Icon80" DefaultValue="${base}/word-addin/favicon-80x80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="LegalWork.Taskpane.Url" DefaultValue="${base}/word-addin/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="LegalWork.GroupLabel" DefaultValue="LegalWork"/>
        <bt:String id="LegalWork.OpenPane.Label" DefaultValue="Open LegalWork"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="LegalWork.OpenPane.Tooltip" DefaultValue="Open the LegalWork agent in the sidebar to work on this document."/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function notFound(message: string): Response {
  return jsonResponse({ code: "not_found", message }, 404);
}

async function serveStaticFile(distPath: string, relativePath: string): Promise<Response | null> {
  const decoded = (() => {
    try {
      return decodeURIComponent(relativePath);
    } catch {
      return null;
    }
  })();
  if (decoded == null || decoded.includes("\0")) return null;

  const root = resolve(distPath);
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) return null;

  let body: Buffer;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    body = await readFile(target);
  } catch {
    return null;
  }

  // Cache-Control policy, by asset kind:
  //  - assets/*: Vite content-hashes these, so they can cache forever.
  //  - *.html (the task pane entry): never cache — Word's webview cache is
  //    sticky and `no-cache` without validators still lets stale panes survive.
  //  - everything else, notably the ribbon icons: MUST be cacheable. Office
  //    desktop (Windows) refuses to render add-in command icons served with
  //    no-store/no-cache, so the ribbon logo came up blank. The icons are not
  //    content-hashed, so use a modest TTL rather than immutable.
  //    See https://learn.microsoft.com/office/dev/add-ins/design/add-in-icons
  const cacheControl = decoded.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : decoded.endsWith(".html")
      ? "no-store"
      : "public, max-age=86400";
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(target),
      "Cache-Control": cacheControl,
    },
  });
}

/**
 * The desktop app's analytics identity (per-launch distinct id + consent),
 * pushed via PUT /analytics/identity and served to the Office pane by the
 * bootstrap. In-memory only — the id rotates per launch and must not be
 * persisted; a server restart resets to "no id, analytics off".
 */
export type AnalyticsIdentity = { distinctId: string | null; enabled: boolean };
let analyticsIdentity: AnalyticsIdentity = { distinctId: null, enabled: false };

export function setAnalyticsIdentity(next: { distinctId?: unknown; analyticsEnabled?: unknown }): void {
  const distinctId =
    typeof next.distinctId === "string" && next.distinctId.trim() ? next.distinctId.trim() : null;
  analyticsIdentity = { distinctId, enabled: next.analyticsEnabled === true };
}

export function getAnalyticsIdentity(): AnalyticsIdentity {
  return analyticsIdentity;
}

/**
 * Handle a request under /word-addin. Returns null only for non-GET/HEAD
 * methods so the caller can produce its standard 404/405 handling.
 */
export async function handleWordAddinRequest(input: {
  request: Request;
  url: URL;
  config: ServerConfig;
}): Promise<Response | null> {
  const { request, url, config } = input;
  const wordAddin = config.wordAddin;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (!wordAddin?.enabled) {
    return notFound("Word add-in hosting is disabled. Start the server with --word-addin.");
  }

  const rest = url.pathname.slice(WORD_ADDIN_PATH_PREFIX.length).replace(/^\/+/, "");

  // The manifest's SourceLocation. Served long-cacheable so the Office
  // webview can render it from its HTTP cache while the server is down
  // (instead of Office's uncustomizable "Add-in Error" page). It is a
  // frozen redirector to the versioned shell; see word-addin-shell.ts
  // for the full update mechanics.
  //
  // 30 days, not a year: the redirector has no other update path, so this
  // caps how long a hypothetical redirector bug could persist on user
  // machines. Within the window offline opens work from cache; after it,
  // the next online open revalidates via ETag (a 304 when unchanged) and
  // restarts the clock. Only a user who hasn't opened the pane with
  // LegalWork running for 30+ days falls back to Office's error page.
  if (rest === "" || rest === "taskpane.html") {
    const etag = '"lw-redirector-v1"';
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(buildWordAddinRedirectorHtml(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=2592000",
        ETag: etag,
      },
    });
  }

  // Versioned, immutable shell pages. Requests for a non-current version
  // can only happen online (the request reached us), so redirect them to
  // the current shell instead of serving stale markup under a versioned
  // URL.
  const shellMatch = rest.match(/^shell-v([A-Za-z0-9._-]+)\.html$/);
  if (shellMatch) {
    if (shellMatch[1] !== WORD_ADDIN_SHELL_VERSION) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `shell-v${WORD_ADDIN_SHELL_VERSION}.html`,
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(buildWordAddinShellHtml(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (rest === "bootstrap") {
    // Same-origin only by construction: no CORS headers are attached to
    // /word-addin responses, so cross-origin scripts cannot read the tokens.
    // The pane is the server's own UI (same trust as the desktop renderer),
    // so it also receives the host token — host-scoped routes like workspace
    // creation and the native folder picker need it.
    const identity = getAnalyticsIdentity();
    return jsonResponse({
      app: "legalwork-server",
      token: config.token,
      hostToken: config.hostToken,
      wordAddinPort: wordAddin.port,
      // Desktop analytics identity (per-launch, in-memory); the pane polls
      // this endpoint so consent changes propagate.
      analyticsDistinctId: identity.distinctId,
      analyticsEnabled: identity.enabled,
      // Lets a cached shell detect it is outdated and reload itself once
      // (reloads end-to-end revalidate the navigation cache entry, which
      // subresource fetches provably do not).
      shellVersion: WORD_ADDIN_SHELL_VERSION,
    });
  }

  // Debug/support utility: clears the origin's HTTP cache (including the
  // long-cached shell) in browsers that honor Clear-Site-Data.
  if (rest === "clear-cache") {
    return new Response("LegalWork add-in cache cleared. Reopen the pane.", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Clear-Site-Data": '"cache"',
        "Cache-Control": "no-store",
      },
    });
  }

  if (rest === "manifest.xml") {
    const manifest = buildWordAddinManifest({ baseUrl: `https://localhost:${wordAddin.port}` });
    return new Response(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": 'attachment; filename="legalwork-word-addin.manifest.xml"',
        "Cache-Control": "no-store",
      },
    });
  }

  const distPath = await resolveWordAddinDistPath(wordAddin);
  if (!distPath) {
    return jsonResponse(
      {
        code: "word_addin_bundle_missing",
        message:
          "Word add-in bundle not found. Build it with `pnpm --filter @legalwork/app build:word-addin` or set --word-addin-dist.",
      },
      503,
    );
  }

  // The real pane page (the vite-built entry), reached via the shell's
  // hand-off. Stays no-store so app updates apply on every load.
  const relativePath = rest === "app.html" ? "taskpane.html" : rest;
  const file = await serveStaticFile(distPath, relativePath);
  if (file) return file;
  // SPA-style fallback: unknown non-asset paths load the task pane entry so
  // deep links (hash routing) and reloads keep working.
  if (!relativePath.includes(".")) {
    const fallback = await serveStaticFile(distPath, "taskpane.html");
    if (fallback) return fallback;
  }
  return notFound("Not found");
}
