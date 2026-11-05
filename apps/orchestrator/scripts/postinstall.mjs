#!/usr/bin/env node

import os from "node:os"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const platform = { win32: "windows" }[os.platform()] || os.platform()
const packageName = `legalwork-orchestrator-${platform}-${os.arch()}`

try {
  require.resolve(`${packageName}/package.json`)
  console.log(`legalwork-orchestrator: installed platform package: ${packageName}`)
} catch {
  console.error(
    `legalwork-orchestrator: missing platform package ${packageName}.\n` +
    "Standalone GitHub binary downloads are retired. Enable optionalDependencies and reinstall the npm package, " +
    "or use the normal Node development entrypoint/desktop app.",
  )
  process.exitCode = 1
}
