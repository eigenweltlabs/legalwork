import { describe, it } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";

import {
  alignWindowsOpencodeConfigEnv,
  desktopProjectsDirectory,
  embeddedOpencodeConnection,
  commandMatchesPackagedSidecar,
  bundledNodeDirectory,
  bundledOpencodeSdkDirectory,
  toolImageRasterModules,
  nodeShimFileName,
  nodeShimScriptContent,
  opencodeHomeEnvFromRoot,
  prioritizeWorkspacePaths,
  resolveLegalworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyLegalworkPortWorkspace,
} from "./runtime.mjs";

describe("private embedded engine connection", () => {
  it("selects the exact workspace, including its overrides, instead of the first workspace", () => {
    const config = {
      opencodeBaseUrl: "http://127.0.0.1:41000", opencodeUsername: "default-user", opencodePassword: "default-password",
      workspaces: [
        { path: "/cases/other", opencodePassword: "other-password" },
        { path: "/cases/selected", directory: "/engine/location", baseUrl: "http://127.0.0.1:42000", opencodeUsername: "selected-user", opencodePassword: "selected-password" },
      ],
    };
    assert.deepEqual(embeddedOpencodeConnection(config, "/cases/selected/../selected", "linux"), {
      baseUrl: "http://127.0.0.1:42000", projectDir: "/engine/location", hostname: "127.0.0.1", port: 42000,
      opencodeUsername: "selected-user", opencodePassword: "selected-password",
    });
    assert.equal(embeddedOpencodeConnection(config, "/cases/missing", "linux"), null);
    assert.equal(embeddedOpencodeConnection(config, "", "linux"), null);
    assert.equal(embeddedOpencodeConnection(config, "/cases/SELECTED", "linux"), null);
    assert.equal(embeddedOpencodeConnection({ ...config, workspaces: [config.workspaces[1], config.workspaces[1]] }, "/cases/selected", "linux"), null);
  });

  it("reads newly published lifecycle credentials and preserves unauthenticated standalone connections", () => {
    const config = { workspaces: [{ path: "/cases/current" }], opencodeBaseUrl: "http://127.0.0.1:41000", opencodeUsername: "engine", opencodePassword: "before" };
    assert.equal(embeddedOpencodeConnection(config, "/cases/current", "darwin").opencodePassword, "before");
    Object.assign(config, { opencodeBaseUrl: "http://127.0.0.1:41001", opencodePassword: "after" });
    const rotated = embeddedOpencodeConnection(config, "/cases/current", "darwin");
    assert.equal(rotated.opencodePassword, "after");
    assert.equal(rotated.port, 41001);
    assert.equal(embeddedOpencodeConnection({ workspaces: config.workspaces, opencodeBaseUrl: config.opencodeBaseUrl }, "/cases/current", "darwin").opencodePassword, null);
    assert.equal(embeddedOpencodeConnection({ workspaces: config.workspaces }, "/cases/current", "darwin"), null);
  });

  it("matches Windows drive paths and extended paths without crossing projects", () => {
    const config = { opencodeBaseUrl: "http://127.0.0.1:41000", workspaces: [{ path: "C:\\Cases\\Current", opencodePassword: "private" }] };
    assert.equal(embeddedOpencodeConnection(config, "c:/cases/current", "win32").opencodePassword, "private");
    assert.equal(embeddedOpencodeConnection(config, "\\\\?\\C:\\Cases\\Current", "win32").opencodePassword, "private");
    assert.equal(embeddedOpencodeConnection(config, "C:\\Cases\\Current-other", "win32"), null);
  });
});

describe("host-owned image runtime modules", () => {
  // Windows 8.3 and long user-directory names can identify the same file.
  const physical = filename => realpathSync.native(filename);
  it("resolves physical packaged modules and rejects missing or escaping dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "image-runtime-"));
    try {
      const resourcesPath = path.join(root, "Resources");
      const modules = path.join(resourcesPath, "app.asar.unpacked", "node_modules");
      for (const name of ["@napi-rs/canvas", "image-size"]) {
        const directory = path.join(modules, name);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
        await writeFile(path.join(directory, "index.cjs"), "");
      }
      const options = { isPackaged: true, resourcesPath, serverEntry: path.join(root, "unrelated", "embedded.js") };
      const result = toolImageRasterModules(options);
      assert.deepEqual({ canvas: physical(result.canvas), imageSize: physical(result.imageSize) }, {
        canvas: physical(path.join(modules, "@napi-rs/canvas/index.cjs")),
        imageSize: physical(path.join(modules, "image-size/index.cjs")),
      });
      await rm(path.join(modules, "image-size"), { recursive: true });
      assert.throws(() => toolImageRasterModules(options), /Cannot find module|ENOENT/);
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "index.cjs"), "");
      await writeFile(path.join(outside, "package.json"), JSON.stringify({ main: "index.cjs" }));
      await symlink(outside, path.join(modules, "image-size"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => toolImageRasterModules(options), /escapes the unpacked application/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the server's installed dependencies in development", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "image-runtime-dev-"));
    try {
      for (const name of ["@napi-rs/canvas", "image-size"]) {
        const directory = path.join(root, "server/node_modules", name);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "package.json"), JSON.stringify({ main: "index.cjs" }));
        await writeFile(path.join(directory, "index.cjs"), "");
      }
      const result = toolImageRasterModules({ isPackaged: false, resourcesPath: "/unrelated/Electron", serverEntry: path.join(root, "server/dist/embedded.js") });
      assert.equal(physical(result.canvas), physical(path.join(root, "server/node_modules/@napi-rs/canvas/index.cjs")));
      assert.equal(physical(result.imageSize), physical(path.join(root, "server/node_modules/image-size/index.cjs")));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("bundled OpenCode SDK location", () => {
  it("uses the staged desktop SDK in development even when Electron has a resourcesPath", () => {
    assert.equal(bundledOpencodeSdkDirectory({ isPackaged: false, resourcesPath: "/Electron.app/Contents/Resources", desktopRoot: "/checkout/apps/desktop" }), path.join("/checkout/apps/desktop/resources/opencode-sdk"));
  });
  it("uses only the application resources in a packaged build", () => {
    assert.equal(bundledOpencodeSdkDirectory({ isPackaged: true, resourcesPath: "/LegalWork.app/Contents/Resources", desktopRoot: "/unrelated/checkout" }), path.join("/LegalWork.app/Contents/Resources/opencode-sdk"));
  });
});

describe("alignWindowsOpencodeConfigEnv", () => {
  it("keeps the engine and LegalWork on OpenCode's existing Windows config root", () => {
    const env = { APPDATA: "C:\\Users\\lawyer\\AppData\\Roaming" };
    assert.equal(alignWindowsOpencodeConfigEnv(env, "win32", "C:\\Users\\lawyer").XDG_CONFIG_HOME, path.join("C:\\Users\\lawyer", ".config"));
    assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  });

  it("preserves an explicit XDG config home", () => {
    const env = { APPDATA: "C:\\Users\\lawyer\\AppData\\Roaming", XDG_CONFIG_HOME: "D:\\opencode" };
    assert.equal(alignWindowsOpencodeConfigEnv(env, "win32").XDG_CONFIG_HOME, "D:\\opencode");
    assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  });

  it("preserves an explicit OpenCode config directory", () => {
    const env = { APPDATA: "C:\\Users\\lawyer\\AppData\\Roaming", OPENCODE_CONFIG_DIR: "D:\\opencode" };
    assert.equal(alignWindowsOpencodeConfigEnv(env, "win32").OPENCODE_CONFIG_DIR, "D:\\opencode");
    assert.equal(env.XDG_CONFIG_HOME, path.join(os.homedir(), ".config"));
  });

  it("does not change Unix config paths", () => {
    const env = { APPDATA: "/other" };
    assert.equal(alignWindowsOpencodeConfigEnv(env, "darwin").XDG_CONFIG_HOME, undefined);
  });
});

describe("opencodeHomeEnvFromRoot", () => {
  it("points every OpenCode dir under the app-owned root", () => {
    const root = path.join("/tmp", "userData", "opencode-home");
    const env = opencodeHomeEnvFromRoot(root);
    assert.equal(env.XDG_CONFIG_HOME, path.join(root, "config"));
    assert.equal(env.XDG_DATA_HOME, path.join(root, "data"));
    assert.equal(env.XDG_CACHE_HOME, path.join(root, "cache"));
    assert.equal(env.XDG_STATE_HOME, path.join(root, "state"));
    // The config dir must live under XDG_CONFIG_HOME so opencode and any XDG
    // reader agree on the same location.
    assert.equal(env.OPENCODE_CONFIG_DIR, path.join(env.XDG_CONFIG_HOME, "opencode"));
  });
});

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyLegalworkPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyLegalworkPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyLegalworkPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/LegalWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/LegalWork.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/LegalWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("resolveLegalworkServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveLegalworkServerConfigPath({ LEGALWORK_SERVER_CONFIG: "/tmp/legalwork/server.json" }),
      path.resolve("/tmp/legalwork/server.json"),
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveLegalworkServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/legalwork/server.json",
    );
  });
});

describe("packaged Node runtime", () => {
  it("requires the bundled executable on every platform", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-node-runtime-"));
    try {
      assert.throws(() => bundledNodeDirectory(root), /Bundled Node runtime is missing/);
      await mkdir(path.join(root, "node"));
      await writeFile(path.join(root, "node", "node"), "fixture");
      await writeFile(path.join(root, "node", "node.exe"), "fixture");
      /** @type {NodeJS.Platform[]} */
      const platforms = ["darwin", "linux", "win32"];
      for (const platform of platforms) assert.equal(bundledNodeDirectory(root, platform), path.join(root, "node"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("node shim", () => {
  it("names the shim node.cmd on Windows and node elsewhere", () => {
    assert.equal(nodeShimFileName("win32"), "node.cmd");
    assert.equal(nodeShimFileName("darwin"), "node");
    assert.equal(nodeShimFileName("linux"), "node");
  });

  it("re-execs the app binary in Node mode on posix", () => {
    assert.equal(
      nodeShimScriptContent("/Applications/LegalWork.app/Contents/MacOS/LegalWork", "darwin"),
      '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "/Applications/LegalWork.app/Contents/MacOS/LegalWork" "$@"\n',
    );
  });

  it("re-execs the app binary in Node mode on Windows", () => {
    assert.equal(
      nodeShimScriptContent("C:\\Program Files\\LegalWork\\LegalWork.exe", "win32"),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\LegalWork\\LegalWork.exe" %*\r\n',
    );
  });
});


describe("desktop project storage", () => {
  it("keeps macOS projects in Documents outside the app installation and engine home", () => {
    assert.equal(desktopProjectsDirectory("/Users/chris/Documents", false, "darwin"), "/Users/chris/Documents/LegalWork/Projects");
  });
  it("uses the exact Windows known-folder location, including redirected Documents", () => {
    assert.equal(desktopProjectsDirectory("D:\\OneDrive - Firm\\Documents", false, "win32"), "D:\\OneDrive - Firm\\Documents\\LegalWork\\Projects");
    assert.equal(desktopProjectsDirectory("\\\\fileserver\\users\\chris\\Documents", false, "win32"), "\\\\fileserver\\users\\chris\\Documents\\LegalWork\\Projects");
  });
  it("keeps development-created projects separate from released app projects", () => {
    assert.equal(desktopProjectsDirectory("/Users/chris/Documents", true, "darwin"), "/Users/chris/Documents/LegalWork Dev/Projects");
  });
});
