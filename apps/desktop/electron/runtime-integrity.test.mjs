import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyOpencodeCandidate } from "@legalwork/opencode-release/candidate";
import { opencodeEngineSelection } from "@legalwork/opencode-release/selection";
import { opencodeReleaseTarget } from "./opencode-release.mjs";
import { createRuntimeManager } from "./runtime.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

test("doctor and boot diagnostics never execute a candidate rejected after verification", { skip: process.platform === "win32" && "POSIX sentinel fixture; Windows executable acceptance is separate" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-runtime-integrity-"));
  try {
    const target = opencodeReleaseTarget();
    const directory = opencodeEngineSelection.kind === "derivative"
      ? path.join(root, "resources", "opencode-engine", opencodeEngineSelection.artifactId, target)
      : path.join(root, "resources", "sidecars");
    await mkdir(directory, { recursive: true });
    const recipe = JSON.parse(await readFile(new URL("../../../packages/opencode-release/build/recipe.json", import.meta.url), "utf8"));
    const release = JSON.parse(await readFile(new URL("../../../packages/opencode-release/release.json", import.meta.url), "utf8"));
    const binary = path.join(directory, "opencode");
    const bytes = `#!/bin/sh\nprintf '%s\\n' '${recipe.version}'\n`;
    await writeFile(binary, bytes);
    await chmod(binary, 0o700);
    const provenance = JSON.stringify({
      ...recipe, target, officialBase: release.packages[target],
      compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables["darwin-arm64"].sha256 },
      binary: { filename: "opencode", sha256: digest(bytes) },
    });
    await writeFile(path.join(directory, "provenance.json"), provenance);
    const candidate = await verifyOpencodeCandidate({ directory, provenanceSha256: digest(provenance) });
    const manager = createRuntimeManager({
      app: { isPackaged: false, getPath: name => path.join(root, name) },
      desktopRoot: root, listLocalWorkspacePaths: async () => [], recorder: null,
      onSidecarExit: () => {}, modelDownloadFetch: undefined,
      getApprovalWindow: () => null, opencodeCandidateBuild: candidate,
    });
    assert.equal((await manager.engineDoctor()).version, recipe.version);
    const marker = path.join(root, "rejected-engine-ran");
    await writeFile(binary, `#!/bin/sh\nprintf 'executed' > '${marker}'\n`);
    await assert.rejects(manager.engineDoctor(), /binary changed/);
    const diagnostics = await manager.collectRuntimeDiagnostics();
    assert.ok(diagnostics.opencode && "error" in diagnostics.opencode);
    assert.match(diagnostics.opencode.error, /binary changed/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
