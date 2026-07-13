import { describe, it } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import {
  commandMatchesPackagedSidecar,
  nodeShimFileName,
  nodeShimScriptContent,
  opencodeHomeEnvFromRoot,
  prioritizeWorkspacePaths,
  resolveLegalworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyLegalworkPortWorkspace,
} from "./runtime.mjs";

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
      "/tmp/legalwork/server.json",
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
