import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { engineBuildMode, engineTargetsForBuild, prepareForBuild, stagePreparedEngineBuild } from "../../../packages/opencode-release/prepare.mjs";

const bunRuntime = (globalThis as typeof globalThis & {
  Bun?: {
    build?: (...args: any[]) => Promise<any>;
    argv?: string[];
  };
}).Bun;

if (!bunRuntime?.build || !bunRuntime.argv) {
  console.error("This script must be run with Bun.");
  process.exit(1);
}

const bun = bunRuntime as { build: (...args: any[]) => Promise<any>; argv: string[] };

type BuildOptions = {
  targets: string[];
  outdir: string;
  filename: string;
  engineMode: "development" | "production";
};

function readArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    targets: [],
    outdir: resolve("dist", "bin"),
    filename: "legalwork-server",
    engineMode: engineBuildMode(argv),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;

    if (value === "--target") {
      const next = argv[index + 1];
      if (next) {
        options.targets.push(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--target=")) {
      const next = value.slice("--target=".length).trim();
      if (next) options.targets.push(next);
      continue;
    }

    if (value === "--outdir") {
      const next = argv[index + 1];
      if (next) {
        options.outdir = resolve(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--outdir=")) {
      const next = value.slice("--outdir=".length).trim();
      if (next) options.outdir = resolve(next);
      continue;
    }

    if (value === "--filename") {
      const next = argv[index + 1];
      if (next) {
        options.filename = next;
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--filename=")) {
      const next = value.slice("--filename=".length).trim();
      if (next) options.filename = next;
    }
  }

  return options;
}

function outputName(filename: string, target?: string) {
  const needsExe = target ? target.includes("windows") : process.platform === "win32";
  const suffix = target ? `-${target}` : "";
  const ext = needsExe ? ".exe" : "";
  return `${filename}${suffix}${ext}`;
}

async function buildOnce(entrypoint: string, outdir: string, filename: string, target?: string) {
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, outputName(filename, target));

  // ssh2 falls back to pure JS when its optional native CPU detector is absent.
  const args = ["build", entrypoint, "--compile", "--external", "cpu-features", "--outfile", outfile];
  if (target) {
    args.push("--target", target);
  }

  const result = spawnSync("bun", args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const options = readArgs(bun.argv.slice(2));
const preparedEngine = await prepareForBuild({ mode: options.engineMode,
  ...(options.engineMode === "development" ? { targets: engineTargetsForBuild(options.targets) } : {}) });
await stagePreparedEngineBuild({ prepared: preparedEngine, outputDirectory: options.outdir,
  targets: engineTargetsForBuild(options.targets) });
const raster = spawnSync(process.execPath, [resolve("scripts", "gen-tool-image-raster-code.ts")], { stdio: "inherit" });
if (raster.status !== 0) process.exit(raster.status ?? 1);
const plugins = spawnSync(process.execPath, [resolve("scripts", "build-opencode-plugins.ts")], { stdio: "inherit" });
if (plugins.status !== 0) process.exit(plugins.status ?? 1);
const pluginDirectory = resolve("dist", "opencode-plugins");
const bundles = Object.fromEntries(readdirSync(pluginDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => [entry.name, readFileSync(join(pluginDirectory, entry.name, "index.js"), "utf8")]));
mkdirSync(options.outdir, { recursive: true });
const entrypoint = join(options.outdir, `.native-server-entry-${randomUUID()}.ts`);
writeFileSync(entrypoint, `import {installEmbeddedNativePluginBundles} from ${JSON.stringify(resolve("src", "native-plugin-assets.ts"))};\ninstallEmbeddedNativePluginBundles(${JSON.stringify(bundles)});\nawait import(${JSON.stringify(resolve("src", "cli.ts"))});\n`);
const targets = options.targets.length ? options.targets : [undefined];

try {
  for (const target of targets) await buildOnce(entrypoint, options.outdir, options.filename, target);
} finally { rmSync(entrypoint, { force: true }); }
