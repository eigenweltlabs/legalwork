import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { developerIdRequirement, macSigningBuildInputs, macEntitlementsSha256, signMacEngine, validateMacSigningConfiguration } from "./mac-signing.mjs";

const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
// Synthetic command-contract data, never a certificate or a real signed build.
// Apple trust validation is performed by real codesign in CI, not simulated here.
const certificate = Buffer.from("unit fixture public leaf bytes");
const configuration = { mode: "developer-id", identitySha1: hash(certificate, "sha1"), certificateSha256: hash(certificate), teamId: "TESTTEAM01" };
const inputs = await macSigningBuildInputs();
const keys = ["allow-jit", "allow-unsigned-executable-memory", "disable-executable-page-protection", "allow-dyld-environment-variables", "disable-library-validation"];
const entitlements = Object.fromEntries(keys.map(key => [`com.apple.security.cs.${key}`, true]));

async function fixture(change = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-mac-signing-"));
  const binary = path.join(root, "opencode"), evidenceDirectory = path.join(root, "evidence"), calls = [];
  await mkdir(evidenceDirectory); await writeFile(binary, "original compiled executable");
  const execute = async (command, args, input) => {
    calls.push({ command, args, input });
    if (args.includes("--sign")) await writeFile(binary, "fixture signed executable");
    if (args.includes("--verify") && change.verifyFailure) return { code: 1, stdout: "", stderr: "native Apple chain requirement rejected" };
    let stdout = "", stderr = "";
    if (args.includes("--verbose=4")) stderr = change.metadata ?? "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded\nAuthority=Developer ID Application: Fixture (TESTTEAM01)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TESTTEAM01\nTimestamp=Oct 26, 2026 at 12:00:00\n";
    if (args.includes("--entitlements") && args.includes("--display")) stdout = "<plist/>";
    if (command === "/usr/bin/plutil") stdout = JSON.stringify(change.entitlements ?? entitlements);
    const certificateOption = args.find(arg => arg.startsWith("--extract-certificates="));
    if (certificateOption) await writeFile(certificateOption.slice("--extract-certificates=".length) + "0", change.certificate ?? certificate);
    if (change.mutateDuringVerification && certificateOption) await writeFile(binary, "changed after signature verification");
    return { code: 0, stdout, stderr };
  };
  return { root, binary, evidenceDirectory, execute, calls, clean: () => rm(root, { recursive: true, force: true }) };
}

test("production policy rejects names, missing pins, invalid team, private fields and redirected keychain syntax", () => {
  validateMacSigningConfiguration(undefined); validateMacSigningConfiguration(configuration);
  for (const value of [null, {}, { ...configuration, mode: "ad-hoc" }, { ...configuration, identitySha1: "Developer ID Application: partial name" },
    { ...configuration, certificateSha256: undefined }, { ...configuration, teamId: "unreviewed" }, { ...configuration, privateKey: "forbidden" },
    { ...configuration, keychainPath: "relative.keychain" }, { ...configuration, keychainPath: "/tmp/keychain\nother" }]) {
    assert.throws(() => validateMacSigningConfiguration(value), /requires exact public/);
  }
  assert.throws(() => developerIdRequirement('TEAM" or true'), /Invalid/);
});

test("production signs before pinning and verifies exact public identity, Apple chain, runtime, timestamp and upstream entitlements", async () => {
  const f = await fixture();
  try {
    const result = await signMacEngine({ ...f, configuration, inputs, platform: "darwin" }, f.execute);
    assert.equal(result.beforeSha256, hash("original compiled executable"));
    assert.equal(result.afterSha256, hash(await readFile(f.binary)));
    assert.equal(result.certificateSha256, configuration.certificateSha256);
    assert.equal(result.identitySha1, configuration.identitySha1);
    assert.equal(result.entitlementsSha256, macEntitlementsSha256);
    assert.equal(result.teamId, configuration.teamId);
    const sign = f.calls[0]; assert.equal(sign.command, "/usr/bin/codesign");
    assert.equal(sign.args[sign.args.indexOf("--sign") + 1], configuration.identitySha1);
    assert.ok(sign.args.includes("--timestamp")); assert.equal(sign.args[sign.args.indexOf("--options") + 1], "runtime");
    assert.ok(f.calls[1].args.includes(`=${developerIdRequirement(configuration.teamId)}`));
    assert.ok(f.calls[1].args.includes("--all-architectures"));
    assert.deepEqual(await readFile(path.join(f.evidenceDirectory, "mac-signing/entitlements.plist")), inputs.entitlements);
    assert.equal(JSON.parse(await readFile(path.join(f.evidenceDirectory, "mac-signing/verified.json"))).afterSha256, result.afterSha256);
  } finally { await f.clean(); }
});

for (const [name, change, policy] of [
  ["native Apple requirement failure", { verifyFailure: true }],
  ["another certificate", { certificate: Buffer.from("foreign public certificate") }],
  ["SHA256 identity conflict", {}, { ...configuration, certificateSha256: "0".repeat(64) }],
  ["SHA1 identity conflict", {}, { ...configuration, identitySha1: "0".repeat(40) }],
  ["missing timestamp", { metadata: "CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=TESTTEAM01\n" }],
  ["wrong team", { metadata: "CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=OTHERTEAM1\nTimestamp=now\n" }],
  ["ad-hoc authority", { metadata: "CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=adhoc\nTeamIdentifier=TESTTEAM01\nTimestamp=now\n" }],
  ["hardened runtime absent", { metadata: "CodeDirectory v=20500 flags=0x0(none)\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=TESTTEAM01\nTimestamp=now\n" }],
  ["unexpected entitlement", { entitlements: { ...entitlements, "com.apple.security.get-task-allow": true } }],
  ["missing native-plugin entitlement", { entitlements: { ...entitlements, "com.apple.security.cs.disable-library-validation": false } }],
  ["binary changed after native validation", { mutateDuringVerification: true }],
]) test(`production fails closed on ${name}`, async () => {
  const f = await fixture(change);
  try {
    await assert.rejects(signMacEngine({ ...f, configuration: policy ?? configuration, inputs, platform: "darwin" }, f.execute));
    await assert.rejects(readFile(path.join(f.evidenceDirectory, "mac-signing/verified.json")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(f.evidenceDirectory, "mac-signing/failure.json"))).productionAccepted, false);
  } finally { await f.clean(); }
});

test("non-Mac builder and changed profile fail without accepted production evidence", async () => {
  const f = await fixture();
  try {
    await assert.rejects(signMacEngine({ ...f, configuration, inputs, platform: "linux" }, f.execute), /macOS builder/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(signMacEngine({ ...f, configuration, inputs: { ...inputs, entitlements: Buffer.from("changed") }, platform: "darwin" }, f.execute), /exact captured/);
    assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});

test("existing real Mac ad-hoc path uses no production identity and remains executable", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-real-adhoc-"));
  try {
    const binary = path.join(root, "opencode"), evidenceDirectory = path.join(root, "evidence");
    await mkdir(evidenceDirectory);
    // Sign a new build-owned native executable, as the helper requires. Apple
    // platform utilities can include arm64e/platform signing semantics that
    // are unrelated to ordinary Bun/OpenCode build outputs.
    const source = path.join(root, "main.c");
    await writeFile(source, "int main(void) { return 0; }\n");
    // Fail clearly when the existing developer toolchain is unavailable;
    // never install it or skip the native signing/execution assertions.
    await promisify(execFile)("/usr/bin/xcode-select", ["-p"]);
    await promisify(execFile)("/usr/bin/xcrun", ["clang", source, "-o", binary]);
    const result = await signMacEngine({ binary, evidenceDirectory });
    assert.match(result.signing, /ad-hoc/); assert.equal(result.afterSha256, hash(await readFile(binary)));
    await promisify(execFile)(binary, []);
    const commands = JSON.parse(await readFile(path.join(evidenceDirectory, "mac-signing/commands.json")));
    assert.deepEqual(commands.map(row => row.args.slice(0, -1)), [["--force", "--sign", "-"], ["--verify", "--strict"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native Apple requirement parser accepts the exact Developer ID/team policy", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-signing-requirement-"));
  try {
    const output = path.join(root, "requirement.bin");
    await promisify(execFile)("/usr/bin/csreq", ["-r", `=${developerIdRequirement(configuration.teamId)}`, "-b", output]);
    assert.ok((await readFile(output)).length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
