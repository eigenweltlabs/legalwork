#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { opencodeReleaseTarget } from "@legalwork/opencode-release"
import { opencodeEngineSelection, stageSelectedOpencodeEngine } from "@legalwork/opencode-release/selection"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const version = String(pkg.version || "").trim()
if (!version) {
  throw new Error("legalwork-orchestrator version missing in apps/orchestrator/package.json")
}

const constantsSrc = resolve(root, "..", "..", "constants.json")
if (!existsSync(constantsSrc)) {
  throw new Error(`Missing constants.json at ${constantsSrc}`)
}

const tag = String(process.env.NPM_TAG || "").trim()
const dry = String(process.env.DRY_RUN || "").trim() === "1"

const targets = [
  { id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-x64", bun: "bun-linux-x64", os: "linux", cpu: "x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { id: "windows-x64", bun: "bun-windows-x64", os: "win32", cpu: "x64" },
]

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (res.status !== 0) {
    process.exit(res.status ?? 1)
  }
}

function packageVersionExists(name) {
  const res = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  return res.status === 0 && res.stdout.trim() === version
}

function writeJson(filepath, data) {
  writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function platformPkgName(target) {
  const platform = target.id.split("-")[0]
  const arch = target.id.split("-").slice(1).join("-")
  return `legalwork-orchestrator-${platform}-${arch}`
}

// Preparation is importable for local pack checks; publishing remains an
// explicit command-line action, never an import side effect.
export async function prepareNpmPackages() {
  const outroot = join(root, "dist", "npm")
  rmSync(outroot, { recursive: true, force: true })
  mkdirSync(outroot, { recursive: true })
  const optionalDependencies = {}
  const published = []

  for (const target of targets) {
    const name = platformPkgName(target)
    optionalDependencies[name] = version

    const ext = target.id.startsWith("windows") ? ".exe" : ""
    const src = join(root, "dist", "bin", `legalwork-${target.bun}${ext}`)
    if (!existsSync(src)) {
      throw new Error(`Missing legalwork binary at ${src}. Run: pnpm --filter legalwork-orchestrator build:bin:all`)
    }

    const dir = join(outroot, name)
    const bindir = join(dir, "bin")
    mkdirSync(bindir, { recursive: true })

    const dest = join(bindir, `legalwork${ext}`)
    copyFileSync(src, dest)
    if (!target.id.startsWith("windows")) {
      chmodSync(dest, 0o755)
    }

    const serverSource = join(root, "dist", "sidecars", `legalwork-server-${target.id}${ext}`)
    if (!existsSync(serverSource)) throw new Error(`Missing local server bundle at ${serverSource}. Run: pnpm --filter legalwork-orchestrator build:sidecars`)
    const serverDestination = join(bindir, `legalwork-server${ext}`)
    copyFileSync(serverSource, serverDestination)
    if (!ext) chmodSync(serverDestination, 0o755)
    const serverVersion = JSON.parse(readFileSync(resolve(root, "..", "server", "package.json"), "utf8")).version
    writeJson(join(bindir, "versions.json"), { "legalwork-server": { version: serverVersion,
      sha256: createHash("sha256").update(readFileSync(serverDestination)).digest("hex") } })

    const engineTarget = opencodeReleaseTarget(target.os, target.cpu)
    await stageSelectedOpencodeEngine({
      binary: join(root, "dist", "bin", "opencode-engine", opencodeEngineSelection.artifactId, engineTarget, `opencode${ext}`),
      directory: join(bindir, "opencode-engine", opencodeEngineSelection.artifactId, engineTarget), target: engineTarget,
    })

    writeJson(join(dir, "package.json"), {
      name,
      version,
      description: "Platform binary for legalwork-orchestrator",
      license: "MIT",
      os: [target.os],
      cpu: [target.cpu],
      bin: {
        legalwork: `./bin/legalwork${ext}`,
        "legalwork-orchestrator": `./bin/legalwork${ext}`,
      },
      files: ["bin"],
    })

    published.push({ name, dir })
  }

  const meta = join(outroot, "legalwork-orchestrator")
  mkdirSync(join(meta, "bin"), { recursive: true })

  const wrapperSrc = join(root, "bin", "legalwork")
  if (!existsSync(wrapperSrc)) {
    throw new Error(`Missing wrapper at ${wrapperSrc}`)
  }
  copyFileSync(wrapperSrc, join(meta, "bin", "legalwork"))
  chmodSync(join(meta, "bin", "legalwork"), 0o755)

  const postinstallSrc = join(root, "scripts", "postinstall.mjs")
  if (!existsSync(postinstallSrc)) {
    throw new Error(`Missing postinstall at ${postinstallSrc}`)
  }
  copyFileSync(postinstallSrc, join(meta, basename(postinstallSrc)))
  copyFileSync(constantsSrc, join(meta, "constants.json"))

  writeJson(join(meta, "package.json"), {
    name: "legalwork-orchestrator",
    version,
    description: "LegalWork host orchestrator for OpenCode and LegalWork server",
    license: "MIT",
    bin: {
      legalwork: "./bin/legalwork",
      "legalwork-orchestrator": "./bin/legalwork",
    },
    scripts: {
      postinstall: "node ./postinstall.mjs",
    },
    optionalDependencies,
    files: ["bin", "postinstall.mjs", "constants.json"],
  })

  published.push({ name: "legalwork-orchestrator", dir: meta })

  return published
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const published = await prepareNpmPackages()
  for (const item of published) {
    if (dry) {
      console.log(`Packing (dry run) ${item.name} from ${item.dir}`)
      run("npm", ["pack"], item.dir)
      continue
    }

    const args = ["publish", "--access", "public"]
    if (tag) args.push("--tag", tag)
    if (packageVersionExists(item.name)) {
      console.log(`Skipping ${item.name}@${version}; already published`)
      continue
    }
    console.log(`Publishing ${item.name} from ${item.dir}`)
    run("npm", args, item.dir)
  }

}
