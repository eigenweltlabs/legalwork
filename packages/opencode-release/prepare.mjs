// Build/development entry only. Runtime consumers import the fixed selector.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import recipe from "./build/recipe.json" with { type: "json" };
import { opencodeReleaseTarget } from "./index.mjs";
import { sourceBuildPolicy } from "./build-policy.mjs";
import { prepareOpencodeEngine, checkPreparedOpencodeEngine } from "./build/prepare.mjs";

export function engineBuildMode(args, fallback = "development") {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--engine-mode") values.push(args[++i]);
    else if (args[i].startsWith("--engine-mode=")) values.push(args[i].slice(14));
  }
  if (values.length > 1 || values.length && !["development", "production"].includes(values[0])) {
    throw new Error("Supply one explicit --engine-mode development or production.");
  }
  const mode = values[0] ?? fallback;
  if (!["development", "production"].includes(mode)) throw new Error("An explicit engine build mode is required.");
  return mode;
}

/** Cross-compilation explicitly prepares the matching engine target subset. */
export function engineTargetsForBuild(targets) {
  if (!targets.length) return undefined;
  return [...new Set(targets.map(target => {
    const match = /^bun-(darwin|linux|windows)-(x64|arm64)(?:-baseline)?(-musl)?$/.exec(target);
    if (!match || match[3] && match[1] !== "linux") throw new Error(`No reviewed OpenCode target for Bun target: ${target}`);
    return opencodeReleaseTarget(match[1] === "windows" ? "win32" : match[1], match[2], match[3] ? "musl" : "glibc");
  }))];
}

export async function prepareForBuild({ mode, targets, checkOnly = false, ...options }, implementation = { prepareOpencodeEngine, checkPreparedOpencodeEngine }) {
  if (!["development", "production"].includes(mode)) throw new Error("An explicit engine build mode is required.");
  const input = { ...options, mode,
    ...(mode === "production" && options.macSigning === undefined ? { macSigning: sourceBuildPolicy.productionMacSigner } : {}),
    ...(targets ? { targets } : mode === "production" ? { targets: recipe.targets } : {}),
  };
  try {
    return await implementation[checkOnly ? "checkPreparedOpencodeEngine" : "prepareOpencodeEngine"](input);
  } catch (cause) {
    throw new Error(`OpenCode ${mode} ${checkOnly ? "preparation check" : "build preparation"} failed. Run pnpm engine:prepare${mode === "production" ? ":production" : ""} with the reviewed compiler/signing inputs before starting or packaging. ${cause.message}`, { cause });
  }
}

/** Stage the exact selected five-file artifact alongside standalone binaries. */
export async function stagePreparedEngineBuild({ prepared, outputDirectory, targets = [opencodeReleaseTarget()] }) {
  const { installSelectedOpencodeEngine, opencodeEngineSelection } = await import("./selection.mjs");
  if (opencodeEngineSelection.artifactId !== prepared.manifestSha256) throw new Error("Standalone engine staging does not match its prepared selector.");
  const staged = [];
  for (const target of targets) {
    const directory = path.resolve(outputDirectory, "opencode-engine", opencodeEngineSelection.artifactId, target);
    const installed = await installSelectedOpencodeEngine({ directory, target,
      archiveDirectory: prepared.archiveDirectory,
      cacheDirectory: path.join(path.dirname(prepared.receiptPath), "archive-cache"),
    });
    staged.push(installed.path);
  }
  return staged;
}

/** Development handoff only: location never replaces the fixed runtime pin. */
export async function developmentEngineEnvironment({ checkOnly = false, includeBinary = false } = {}) {
  const prepared = await prepareForBuild({ mode: "development", checkOnly });
  const environment = { LEGALWORK_OPENCODE_ARCHIVES: prepared.archiveDirectory };
  if (includeBinary) {
    // Load selection only after preparation has published its fixed input.
    const explicit = process.env.LEGALWORK_OPENCODE_BIN?.trim();
    if (explicit) {
      const { verifySelectedOpencodeEngine } = await import("./selection.mjs");
      await verifySelectedOpencodeEngine(explicit);
      environment.LEGALWORK_OPENCODE_BIN = explicit;
    } else {
      const { installSelectedEngineForHost } = await import("./install.mjs");
      const installed = await installSelectedEngineForHost({
        installRoot: path.join(path.dirname(prepared.receiptPath), "engines", prepared.sourceKey),
        cacheDirectory: path.join(path.dirname(prepared.receiptPath), "archive-cache"),
        archiveDirectory: prepared.archiveDirectory,
      });
      environment.LEGALWORK_OPENCODE_BIN = installed.path;
    }
  }
  return environment;
}

async function launchDevelopment(command, args, options) {
  const engineEnvironment = await developmentEngineEnvironment(options);
  if (options.devMode) engineEnvironment.LEGALWORK_DEV_MODE = "1";
  if (process.platform === "win32" && command === "pnpm") command = "pnpm.cmd";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...engineEnvironment },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command) });
    const handlers = ["SIGINT", "SIGTERM"].map(signal => [signal, () => child.kill(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const remove = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once("error", error => { remove(); reject(error); });
    child.once("close", code => { remove(); process.exitCode = code ?? 1; resolve(); });
  });
}

export async function preparationCli(args) {
  let mode, checkOnly = false, all = false, macSigningPath, launch;
  let includeBinary = false, devMode = false;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--") continue;
    if (argument === "--mode") {
      if (mode !== undefined) throw new Error("Only one --mode is allowed.");
      mode = args[++i];
    } else if (argument === "--run") { launch = args.slice(i + 1); break; }
    else if (argument === "--with-engine-binary") includeBinary = true;
    else if (argument === "--dev-mode") devMode = true;
    else if (argument === "--check") checkOnly = true;
    else if (argument === "--all-targets") all = true;
    else if (argument === "--target") targets.push(args[++i]);
    else if (argument === "--mac-signing-config") {
      if (macSigningPath) throw new Error("Only one signing configuration is allowed.");
      macSigningPath = args[++i];
      if (!macSigningPath || macSigningPath.startsWith("--")) throw new Error("--mac-signing-config requires an explicit build policy file.");
    } else throw new Error(`Unknown engine preparation argument: ${argument}`);
  }
  if (all && targets.length || targets.some(target => !recipe.targets.includes(target)) || new Set(targets).size !== targets.length) {
    throw new Error("Use --all-targets or distinct reviewed --target values.");
  }
  if (checkOnly && macSigningPath) throw new Error("A check-only start cannot change signing configuration.");
  if (launch) {
    if (mode !== "development" || all || targets.length || macSigningPath || !launch[0]) throw new Error("--run requires development mode and a command; preparation targets/signing belong to engine:prepare.");
    return launchDevelopment(launch[0], launch.slice(1), { checkOnly, includeBinary, devMode });
  }
  if (includeBinary || devMode) throw new Error("--with-engine-binary and --dev-mode require a development --run command.");
  return prepareForBuild({ mode, checkOnly, ...(all ? { targets: recipe.targets } : targets.length ? { targets } : {}),
    ...(macSigningPath ? { macSigning: JSON.parse(await readFile(macSigningPath, "utf8")) } : {}) });
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const result = await preparationCli(process.argv.slice(2));
    if (result) console.log(JSON.stringify(result, null, 2));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
