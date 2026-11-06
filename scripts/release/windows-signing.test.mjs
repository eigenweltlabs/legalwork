import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { parse } = require("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("Azure overlay is valid for the installed packager and preserves the NSIS app configuration", async () => {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { getConfig, validateConfiguration } = builderRequire("app-builder-lib/out/util/config/config.js");
  const { DebugLogger } = builderRequire("builder-util");
  const directory = fileURLToPath(new URL("../../apps/desktop", import.meta.url));
  const config = await getConfig(directory, "electron-builder.azure.yml", null);
  await validateConfiguration(config, new DebugLogger(false));
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.appId, "com.eigenweltlabs.legalwork");
  assert.deepEqual(config.win.target, ["nsis"]);
  assert.equal(config.nsis.include, "build/installer.nsh");
  assert.equal(config.afterSign, "scripts/electron-after-sign.cjs");
  assert.ok(config.win.extraResources.some((resource) => resource.to === "sidecars"));
  const sidecars = config.win.extraResources.find((resource) => resource.to === "sidecars");
  for (const triple of ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"]) {
    assert.ok(sidecars.filter.includes(`versions.json-${triple}`), "Package target metadata as data");
    assert.ok(!sidecars.filter.includes(`versions.json-${triple}.exe`), "JSON metadata must never enter executable signing");
  }
  assert.equal(config.win.azureSignOptions.publisherName, "Eigenwelt Labs UG (haftungsbeschränkt)");
  const local = parse(readFileSync(new URL("../../apps/desktop/electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(local.win.azureSignOptions, undefined);
});

test("both Windows architectures must sign and verify before uploading alpha or stable assets", () => {
  const stable = workflow("release-macos-aarch64");
  const alpha = workflow("alpha-windows-x64");
  const combined = workflow("alpha-macos-aarch64");
  const jobs = [stable.jobs["publish-electron-windows"], alpha.jobs["publish-alpha-windows"], combined.jobs["publish-alpha-windows"]];
  for (const job of jobs) {
    assert.equal(job.environment, "windows-signing");
    assert.equal(job.permissions["id-token"], "write");
    assert.equal(job.strategy.matrix.include.length, 2);
    const login = job.steps.findIndex((step) => step.uses === "azure/login@v2");
    const tools = job.steps.findIndex((step) => step.run?.includes("prepare-windows-signing.ps1"));
    const build = job.steps.findIndex((step) => step.run?.includes("build:electron"));
    const packageIndex = job.steps.findIndex((step) => step.run?.includes("exec electron-builder"));
    const verify = job.steps.findIndex((step) => step.name === "Verify signed Windows artifacts");
    const engine = job.steps.findIndex((step) => step.uses === "./.github/actions/setup-opencode");
    assert.ok(job.needs.includes("opencode-engine"));
    assert.ok(engine >= 0 && engine < build);
    assert.equal(job.steps[engine].with["build-mode"], "production");
    assert.equal(job.steps[engine].with["manifest-sha256"], "${{ needs.opencode-engine.outputs.manifest-sha256 }}");
    assert.match(job.steps[build].run, /build:electron:production/);
    assert.ok(build < login && login < packageIndex && packageIndex < verify);
    assert.ok(build < tools && tools < login, "Verify signing tools before refreshing Azure credentials");
    assert.equal(job.steps[tools].shell, "pwsh");
    assert.match(job.steps[packageIndex].run, /--config electron-builder\.azure\.yml/);
    assert.equal(job.steps[verify].if, undefined);
    assert.equal(job.steps[verify]["continue-on-error"], undefined);
    assert.match(job.steps[verify].run, /-AppExecutable/);
    for (const [index, step] of job.steps.entries()) {
      if (step.run?.includes("gh release")) assert.ok(index > verify, step.name);
    }
    assert.doesNotMatch(JSON.stringify(job), /SIGNPATH|signpath/);
  }
  assert.equal(stable.jobs["publish-electron"].environment, undefined);
  assert.ok(stable.jobs["publish-electron"].strategy.matrix.include.every((entry) => entry.os_type !== "windows"));
  for (const name of ["publish-electron-assets", "publish-release"]) {
    assert.ok(stable.jobs[name].needs.includes("publish-electron-windows"));
    assert.match(stable.jobs[name].if, /needs\.publish-electron-windows\.result == 'success'/);
  }
});

test("signing smoke test uses the production signature checks and cannot publish a release", () => {
  const config = workflow("alpha-windows-x64");
  assert.equal(config.on.workflow_dispatch.inputs.signing_test.default, false);
  const job = config.jobs["publish-alpha-windows"];
  for (const step of job.steps) {
    if (step.run?.includes("gh release")) assert.equal(step.if, "${{ !inputs.signing_test }}", step.name);
    if (step.run?.includes("verify-windows-signature.ps1")) assert.equal(step.env?.SIGNPATH_TEST, undefined);
  }
  const upload = job.steps.find((step) => step.name === "Upload signed Windows test artifacts");
  assert.equal(upload.if, "inputs.signing_test");
  assert.equal(upload.with.name, "azure-signing-test-windows-${{ matrix.arch }}");
});

const pwsh = process.env.PWSH_PATH || "pwsh";
const hasPowerShell = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
const prepareSigning = fileURLToPath(new URL("./prepare-windows-signing.ps1", import.meta.url));
for (const scenario of ["cold", "warm", "transient-install", "missing-command", "repair-existing"]) {
  test(`Signing module preparation: ${scenario}`, { skip: !hasPowerShell && process.platform !== "win32" }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "signing-module-test-"));
    try {
      const module = path.join(directory, "TrustedSigning", "0.5.8");
      mkdirSync(module, { recursive: true });
      const fixture = path.join(directory, "exercise.ps1");
      writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
$scenario = $env:SIGNING_TEST_SCENARIO
$global:installs = 0
$module = Join-Path $env:SIGNING_TEST_DIRECTORY 'TrustedSigning/0.5.8'
function Write-TestModule([bool]$valid) {
  $body = if ($valid) { 'function Invoke-TrustedSigning {}' } else { 'function Other-Command {}' }
  Set-Content (Join-Path $module 'TrustedSigning.psm1') $body
  New-ModuleManifest -Path (Join-Path $module 'TrustedSigning.psd1') -RootModule TrustedSigning.psm1 -ModuleVersion 0.5.8 -FunctionsToExport '*' -ErrorAction Stop
}
function Install-Module {
  [CmdletBinding()]
  param($Name, $RequiredVersion, $Repository, $Scope, [switch]$Force)
  if ($Name -ne 'TrustedSigning' -or $RequiredVersion -ne '0.5.8' -or $Repository -ne 'PSGallery' -or $Scope -ne 'CurrentUser' -or -not $Force) { throw 'Unexpected installation arguments' }
  $global:installs++
  if ($scenario -eq 'transient-install' -and $global:installs -eq 1) { Write-Error 'Simulated module download failure' }
  Write-TestModule ($scenario -ne 'missing-command')
}
if ($scenario -in @('warm', 'repair-existing')) { Write-TestModule ($scenario -eq 'warm') }
$failure = $null
try { . $env:SIGNING_TEST_SCRIPT -RetryDelaySeconds 0 } catch { $failure = $_ }
if ($scenario -eq 'missing-command') {
  if (-not $failure -or $failure.Exception.Message -ne 'TrustedSigning is unavailable to a fresh signing process') { throw 'Accepted a module without the signing command or failed for an unrelated reason' }
  Write-Host 'Rejected an installer that returns success without the signing command.'
} elseif ($failure) { throw $failure }
$expected = switch ($scenario) { 'warm' { 0 } 'transient-install' { 2 } 'missing-command' { 3 } default { 1 } }
if ($global:installs -ne $expected) { throw "Unexpected installation count: $global:installs expected $expected" }
Write-Host "PASS: $scenario"
`);
      const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", fixture], {
        encoding: "utf8",
        env: { ...process.env, PSModulePath: directory + path.delimiter + (process.env.PSModulePath || ""),
          SIGNING_TEST_DIRECTORY: directory, SIGNING_TEST_SCENARIO: scenario, SIGNING_TEST_SCRIPT: prepareSigning },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes(`PASS: ${scenario}`), result.stdout + result.stderr);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
const fixture = fileURLToPath(new URL("./windows-signature-test.ps1", import.meta.url));
const cases = [
  ["valid", null],
  ["no-installer", /Expected exactly one/],
  ["multiple-installers", /Expected exactly one/],
  ["unsigned-installer", /not trusted/],
  ["untrusted-installer", /not trusted/],
  ["unsigned-app", /not trusted/],
  ["wrong-publisher", /Unexpected publisher/],
  ["missing-certificate", /No signing certificate/],
  ["missing-timestamp", /No Authenticode timestamp/],
  ["app-missing-timestamp", /No Authenticode timestamp/],
  ["undetected-tamper", /not rejected with HashMismatch/],
];
for (const [scenario, error] of cases) {
  test(`Authenticode verification: ${scenario}`, { skip: !hasPowerShell && process.platform !== "win32" }, () => {
    assert.ok(hasPowerShell, "PowerShell is required on Windows");
    const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", fixture, "-Scenario", scenario], { encoding: "utf8" });
    assert.equal(result.status, error ? 1 : 0, result.stdout + result.stderr);
    if (error) assert.match(result.stderr, error);
    else assert.match(result.stdout, /modified installer rejected with HashMismatch/);
  });
}
