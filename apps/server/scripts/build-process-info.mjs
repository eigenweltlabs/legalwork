import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = resolve(server, "resources/helpers/LegalWorkProcessInfo");
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-Werror", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", resolve(server, "native/process-info.c"), "-o", output]);
  const desktop = resolve(server, "../desktop/resources/helpers/LegalWorkProcessInfo");
  mkdirSync(dirname(desktop), { recursive: true });
  copyFileSync(output, desktop);
}
