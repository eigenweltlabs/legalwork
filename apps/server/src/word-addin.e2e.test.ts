import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { buildWordAddinManifest, WORD_ADDIN_MANIFEST_IDS } from "./word-addin.js";
import { WORD_ADDIN_SHELL_VERSION } from "./word-addin-shell.js";
import type { ServerConfig, WordAddinConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-word-addin-"));
  roots.push(root);
  return root;
}

async function createDistBundle(root: string) {
  const dist = join(root, "dist-word-addin");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "taskpane.html"), "<!doctype html><html><body>LegalWork Word Pane</body></html>");
  await writeFile(join(dist, "assets", "taskpane-abc123.js"), "console.log('legalwork word addin');");
  // A secret OUTSIDE the dist dir that must never be reachable.
  await writeFile(join(root, "secret.txt"), "top-secret");
  return dist;
}

function baseConfig(root: string, wordAddin?: WordAddinConfig): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_client_token",
    hostToken: "host_test_token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
    wordAddin,
  };
}

async function startTestServer(config: ServerConfig) {
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

describe("word add-in hosting", () => {
  test("returns 404 when disabled", async () => {
    const root = await createTempRoot();
    const { baseUrl } = await startTestServer(baseConfig(root));

    const response = await fetch(`${baseUrl}/word-addin/bootstrap`);
    expect(response.status).toBe(404);
  });

  test("serves bootstrap token without CORS headers", async () => {
    const root = await createTempRoot();
    const dist = await createDistBundle(root);
    const { baseUrl } = await startTestServer(
      baseConfig(root, {
        enabled: true,
        port: 45999,
        distPath: dist,
        certPath: join(root, "missing.crt"),
        keyPath: join(root, "missing.key"),
      }),
    );

    const response = await fetch(`${baseUrl}/word-addin/bootstrap`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token?: string };
    expect(body.token).toBe("owt_test_client_token");
    // The bootstrap payload contains the client token; it must never be
    // readable cross-origin, so no ACAO header even though corsOrigins is *.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    // Regular API responses keep their CORS behavior.
    const api = await fetch(`${baseUrl}/capabilities`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(api.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("serves shell, redirector, bundle, and assets with the right cache headers", async () => {
    const root = await createTempRoot();
    const dist = await createDistBundle(root);
    const { baseUrl } = await startTestServer(
      baseConfig(root, {
        enabled: true,
        port: 45999,
        distPath: dist,
        certPath: join(root, "missing.crt"),
        keyPath: join(root, "missing.key"),
      }),
    );

    // The manifest URL serves the long-cached frozen redirector, not the
    // bundle: it must render from the webview cache while the server is
    // down (see word-addin-shell.ts).
    const entry = await fetch(`${baseUrl}/word-addin/taskpane.html`);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toContain("text/html");
    expect(entry.headers.get("cache-control")).toBe("public, max-age=2592000");
    expect(await entry.text()).toContain("shell-v");

    // The versioned shell is immutable; older versions redirect to current.
    const shell = await fetch(`${baseUrl}/word-addin/shell-v${WORD_ADDIN_SHELL_VERSION}.html`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toContain("immutable");
    expect(await shell.text()).toContain("Open LegalWork");
    const oldShell = await fetch(`${baseUrl}/word-addin/shell-v0.html`, { redirect: "manual" });
    expect(oldShell.status).toBe(302);
    expect(oldShell.headers.get("location")).toBe(`shell-v${WORD_ADDIN_SHELL_VERSION}.html`);

    // The real pane page stays no-store so app updates apply on every load.
    const app = await fetch(`${baseUrl}/word-addin/app.html`);
    expect(app.status).toBe(200);
    expect(app.headers.get("cache-control")).toBe("no-store");
    expect(await app.text()).toContain("LegalWork Word Pane");

    const asset = await fetch(`${baseUrl}/word-addin/assets/taskpane-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const spaFallback = await fetch(`${baseUrl}/word-addin/some/deep/route`);
    expect(spaFallback.status).toBe(200);
    expect(await spaFallback.text()).toContain("LegalWork Word Pane");

    const missingAsset = await fetch(`${baseUrl}/word-addin/assets/nope.js`);
    expect(missingAsset.status).toBe(404);
  });

  test("blocks path traversal out of the bundle directory", async () => {
    const root = await createTempRoot();
    const dist = await createDistBundle(root);
    const { baseUrl } = await startTestServer(
      baseConfig(root, {
        enabled: true,
        port: 45999,
        distPath: dist,
        certPath: join(root, "missing.crt"),
        keyPath: join(root, "missing.key"),
      }),
    );

    const encoded = await fetch(`${baseUrl}/word-addin/..%2Fsecret.txt`);
    expect(encoded.status).toBe(404);
    const doubleEncoded = await fetch(`${baseUrl}/word-addin/%2e%2e%2fsecret.txt`);
    expect(doubleEncoded.status).toBe(404);
  });

  test("serves a manifest pointing at the HTTPS add-in origin", async () => {
    const root = await createTempRoot();
    const dist = await createDistBundle(root);
    const { baseUrl } = await startTestServer(
      baseConfig(root, {
        enabled: true,
        port: 45999,
        distPath: dist,
        certPath: join(root, "missing.crt"),
        keyPath: join(root, "missing.key"),
      }),
    );

    const response = await fetch(`${baseUrl}/word-addin/manifest.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    const xml = await response.text();
    expect(xml).toContain("https://localhost:45999/word-addin/taskpane.html");
    expect(xml).toContain('xsi:type="TaskPaneApp"');
    expect(xml).toContain("<Host Name=\"Document\"/>");
  });

  test("reports a helpful error when the bundle is missing", async () => {
    const root = await createTempRoot();
    const { baseUrl } = await startTestServer(
      baseConfig(root, {
        enabled: true,
        port: 45999,
        distPath: join(root, "does-not-exist"),
        certPath: join(root, "missing.crt"),
        keyPath: join(root, "missing.key"),
      }),
    );

    // The shell chain works without the bundle (that is its whole point);
    // the bundle-backed page reports the actionable error.
    const shell = await fetch(`${baseUrl}/word-addin/taskpane.html`);
    expect(shell.status).toBe(200);

    const response = await fetch(`${baseUrl}/word-addin/app.html`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("word_addin_bundle_missing");
  });
});

describe("buildWordAddinManifest", () => {
  test("escapes the base URL and falls back to a valid version", () => {
    const xml = buildWordAddinManifest({ baseUrl: "https://localhost:47443/", version: "not-a-version" });
    expect(xml).toContain("<Version>1.0.0.0</Version>");
    expect(xml).toContain('SourceLocation DefaultValue="https://localhost:47443/word-addin/taskpane.html"');
    expect(xml).not.toContain("47443//word-addin");
  });

  test("declares all hosts under the multi-host id by default", () => {
    const xml = buildWordAddinManifest({ baseUrl: "https://localhost:47443" });
    expect(xml).toContain(`<Id>${WORD_ADDIN_MANIFEST_IDS.all}</Id>`);
    expect(xml).toContain('<Host Name="Document"/>');
    expect(xml).toContain('<Host Name="Workbook"/>');
    expect(xml).toContain('<Host Name="Presentation"/>');
  });

  test("single-host manifests carry only their host and a per-host id", () => {
    const cases = [
      { host: "word", name: "Document", xsiType: 'xsi:type="Document"' },
      { host: "excel", name: "Workbook", xsiType: 'xsi:type="Workbook"' },
      { host: "powerpoint", name: "Presentation", xsiType: 'xsi:type="Presentation"' },
    ] as const;
    for (const { host, name, xsiType } of cases) {
      const xml = buildWordAddinManifest({ baseUrl: "https://localhost:47443", host });
      expect(xml).toContain(`<Id>${WORD_ADDIN_MANIFEST_IDS[host]}</Id>`);
      expect(xml).toContain(`<Host Name="${name}"/>`);
      expect(xml).toContain(`<Host ${xsiType}>`);
      for (const other of cases) {
        if (other.host === host) continue;
        expect(xml).not.toContain(`<Host Name="${other.name}"/>`);
        expect(xml).not.toContain(`<Host ${other.xsiType}>`);
      }
    }
    // Office treats the manifest id as the add-in's identity — the per-host
    // ids must be distinct from each other and from the multi-host id.
    const ids = Object.values(WORD_ADDIN_MANIFEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
