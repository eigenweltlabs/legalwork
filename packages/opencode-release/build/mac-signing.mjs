import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const macEntitlementsSha256 = "55031b092985f55d4aa22ce1ee3aec1650cf160d46c15b7334476e9f2961074a";
const entitlementKeys = ["allow-jit", "allow-unsigned-executable-memory", "disable-executable-page-protection", "allow-dyld-environment-variables", "disable-library-validation"].map(key => `com.apple.security.cs.${key}`).sort();
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");

/** Public build policy only. CI owns certificate import/keychain lifetime; this
 * helper never imports, reads or exports a private key or accepts a name match. */
export function validateMacSigningConfiguration(value) {
  if (value === undefined) return;
  const allowed = ["mode", "identitySha1", "certificateSha256", "teamId", "keychainPath"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || value.mode !== "developer-id" || typeof value.identitySha1 !== "string" || !/^[a-fA-F0-9]{40}$/.test(value.identitySha1)
    || typeof value.certificateSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.certificateSha256)
    || typeof value.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(value.teamId)
    || value.keychainPath !== undefined && (typeof value.keychainPath !== "string" || !path.isAbsolute(value.keychainPath) || /[\0\r\n]/.test(value.keychainPath))) {
    throw new Error("Production Mac signing requires exact public certificate SHA1/SHA256 pins, TeamID and an optional absolute existing keychain path.");
  }
}

export function developerIdRequirement(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Invalid expected signing TeamID.");
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

export async function macSigningBuildInputs() {
  const helper = await readFile(new URL(import.meta.url));
  const entitlements = await readFile(new URL("./macos-entitlements.plist", import.meta.url));
  if (hash(entitlements) !== macEntitlementsSha256) throw new Error("The pinned upstream Bun/OpenCode entitlement profile changed.");
  return { helper, entitlements };
}

async function executeMacTool(command, args, input) {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  env.LANG = "en_US.UTF-8"; env.LC_ALL = "en_US.UTF-8";
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes.toString(); });
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  child.stdin.on("error", () => { /* The process result remains authoritative on early exit. */ });
  child.stdin.end(input);
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

/** Signs only a new build-owned executable, before provenance/archive pins.
 * The injected executor supports contract tests; production uses native Apple
 * tools. No environment variable can opt an application into this build mode. */
export async function signMacEngine({ binary, evidenceDirectory, configuration, inputs, platform = process.platform }, execute = executeMacTool) {
  validateMacSigningConfiguration(configuration);
  configuration = configuration === undefined ? undefined : Object.freeze({ ...configuration });
  if (platform !== "darwin") throw new Error("Mac engine signing requires the reviewed macOS builder.");
  const metadata = await lstat(binary);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("The signing input must be a new ordinary build-owned executable.");
  const beforeSha256 = hash(await readFile(binary));
  const root = path.join(evidenceDirectory, "mac-signing");
  await mkdir(root, { mode: 0o700 });
  const commands = [];
  async function tool(command, args, input) {
    const number = commands.length;
    const result = await execute(command, args, input);
    commands.push({ command, args, code: result.code, signal: result.signal ?? null });
    await writeFile(path.join(root, `${number}.stdout`), result.stdout, { flag: "wx", mode: 0o444 });
    await writeFile(path.join(root, `${number}.stderr`), result.stderr, { flag: "wx", mode: 0o444 });
    await writeFile(path.join(root, "commands.json"), JSON.stringify(commands, null, 2) + "\n");
    if (result.code !== 0) throw new Error(`Mac engine signing/verification failed: ${path.basename(command)} (${result.signal ?? result.code}). See retained build evidence.`);
    return result;
  }
  await writeFile(path.join(root, "before.json"), JSON.stringify({ beforeSha256, mode: configuration?.mode ?? "ad-hoc" }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  if (configuration) await writeFile(path.join(root, "public-policy.json"), JSON.stringify(configuration, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  try {
    if (configuration === undefined) {
      // Keep the existing acceptance signing commands unchanged.
      await tool("/usr/bin/codesign", ["--force", "--sign", "-", binary]);
      await tool("/usr/bin/codesign", ["--verify", "--strict", binary]);
      return { signing: "macOS ad-hoc; application signing/notarization remains a distribution gate", beforeSha256, afterSha256: hash(await readFile(binary)) };
    }
    if (hash(inputs?.entitlements ?? "") !== macEntitlementsSha256) throw new Error("Production signing requires the exact captured upstream entitlement profile.");
    const entitlementFile = path.join(root, "entitlements.plist");
    await writeFile(entitlementFile, inputs.entitlements, { flag: "wx", mode: 0o444 });
    const requirement = developerIdRequirement(configuration.teamId);
    const args = ["--force", "--sign", configuration.identitySha1, "--options", "runtime", "--timestamp", "--entitlements", entitlementFile];
    if (configuration.keychainPath) args.push("--keychain", configuration.keychainPath);
    await tool("/usr/bin/codesign", [...args, binary]);
    const signedSha256 = hash(await readFile(binary));
    await tool("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", `=${requirement}`, binary]);
    const displayed = await tool("/usr/bin/codesign", ["--display", "--verbose=4", binary]);
    const details = displayed.stdout + "\n" + displayed.stderr;
    const field = name => {
      const values = [...details.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map(match => match[1].trim());
      if (values.length !== 1 || !values[0]) throw new Error(`Missing or ambiguous Mac signing metadata: ${name}.`);
      return values[0];
    };
    const authority = [...details.matchAll(/^Authority=(.*)$/gm)].map(match => match[1].trim())[0];
    const teamId = field("TeamIdentifier"), timestamp = field("Timestamp");
    const flags = [...details.matchAll(/^CodeDirectory .*\bflags=0x([a-fA-F0-9]+)/gm)];
    if (teamId !== configuration.teamId || !authority?.startsWith("Developer ID Application: ")
      || flags.length !== 1 || !(Number.parseInt(flags[0][1], 16) & 0x10000) || /^(none|not set)$/i.test(timestamp)) {
      throw new Error("The engine must have the expected Developer ID team, hardened runtime and secure timestamp.");
    }
    const extracted = await tool("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", binary]);
    const plist = await tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], extracted.stdout);
    const entitlements = JSON.parse(plist.stdout);
    if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)
      || JSON.stringify(Object.keys(entitlements).sort()) !== JSON.stringify(entitlementKeys) || Object.values(entitlements).some(value => value !== true)) {
      throw new Error("The signed engine entitlements differ from the exact reviewed upstream profile.");
    }
    const prefix = path.join(root, "public-certificate-");
    await tool("/usr/bin/codesign", ["--display", `--extract-certificates=${prefix}`, binary]);
    const certificate = await readFile(`${prefix}0`);
    const certificateSha256 = hash(certificate), identitySha1 = hash(certificate, "sha1");
    if (certificateSha256 !== configuration.certificateSha256.toLowerCase() || identitySha1 !== configuration.identitySha1.toLowerCase()) {
      throw new Error("The actual signing leaf certificate does not match both reviewed public certificate pins.");
    }
    const afterSha256 = hash(await readFile(binary));
    if (afterSha256 !== signedSha256) throw new Error("The signed engine changed during signature verification.");
    const result = { signing: "macOS Developer ID Application; hardened runtime; secure timestamp; exact upstream Bun entitlements", mode: configuration.mode,
      beforeSha256, afterSha256, certificateSha256, identitySha1, teamId, authority, timestamp, hardenedRuntime: true,
      entitlementsSha256: macEntitlementsSha256, verifiedRequirement: requirement };
    await writeFile(path.join(root, "verified.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o444 });
    return result;
  } catch (error) {
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ beforeSha256, currentSha256: hash(await readFile(binary)), error: error.message, productionAccepted: false }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
    throw error;
  }
}
