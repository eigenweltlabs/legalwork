import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = resolve(desktopRoot, "native-notifications");
  const build = resolve(desktopRoot, "dist-electron/native-notifications");
  const target = resolve(desktopRoot, "resources/helpers/LegalWorkNotifications.node");
  const inputs = ["CMakeLists.txt", "notification-macos.mm"].map(name => resolve(source, name));
  if (!existsSync(target) || inputs.some(file => statSync(file).mtimeMs > statSync(target).mtimeMs)) {
    const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
    const addonInclude = dirname(require.resolve("node-addon-api/package.json"));
    execFileSync(process.execPath, [require.resolve("cmake-js/bin/cmake-js"), "compile", "--directory", source, "--out", build,
      "--runtime", "electron", "--runtime-version", electronVersion, `--CDNODE_ADDON_API_DIR=${addonInclude}`], { cwd: desktopRoot, stdio: "inherit" });
    mkdirSync(dirname(target), { recursive: true });
    // Preserve already mapped code and avoid macOS caching a previous signature by inode.
    const temporary = `${target}.${process.pid}.tmp`;
    copyFileSync(resolve(build, "Release/LegalWorkNotifications.node"), temporary);
    renameSync(temporary, target);
    console.log("[notifications] Built macOS sender-avatar bridge");
  }
}
