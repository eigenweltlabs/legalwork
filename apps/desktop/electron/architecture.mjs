export function normalizeRuntimeArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["arm64", "aarch64", "arm64e"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

// On Windows x64 emulation, even os.machine() can report x86_64.
// Electron's native translation check takes precedence over process values.
/** @param {{platform: string, machine: string, appArch: string, translated?: boolean, env?: NodeJS.ProcessEnv}} options */
export function resolveSystemArch({ platform, machine, env = {}, appArch, translated = false }) {
  if (["darwin", "win32"].includes(platform) && translated) return "arm64";
  return normalizeRuntimeArch(
    (platform === "win32" ? env.PROCESSOR_ARCHITEW6432 : null) || machine || env.PROCESSOR_ARCHITECTURE || appArch,
  );
}

export function architectureInfo({ platform, appArch, systemArch, version, releaseUrl }) {
  const label = (arch) => arch === "arm64" ? "ARM64" : arch === "x64" ? "x64" : arch;
  return {
    appArch,
    appArchLabel: label(appArch),
    systemArch,
    systemArchLabel: label(systemArch),
    mismatch: ["arm64", "x64"].includes(systemArch) && appArch !== systemArch,
    platform: platform === "win32" ? "windows" : platform,
    version,
    downloadUrl: null,
    releaseUrl,
  };
}

export function parseUpdaterManifestFiles(raw) {
  const files = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (match) files.push({ url: match[1].trim().replace(/^['"]|['"]$/g, "") });
  }
  return files;
}

export function selectArchitectureDownload(files, platform, arch) {
  const assetArch = platform === "linux" && arch === "x64" ? "x86_64" : arch;
  const extension = platform === "darwin" ? "dmg" : platform === "win32" ? "exe" : "AppImage";
  const matching = files.filter((file) => file.url.includes(`-${assetArch}-`));
  return matching.find((file) => file.url.endsWith(`.${extension}`)) ||
    matching.find((file) => file.url.endsWith(".zip")) || null;
}

/** Called on demand. No network request belongs in the startup architecture check. */
export async function findArchitectureDownload({ platform, arch, feeds, fetchImpl = fetch, timeoutMs = 5_000 }) {
  const manifest = platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? (arch === "arm64" ? "latest-arm64.yml" : "latest.yml") : arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
  let readManifest = false;
  let missingManifests = 0;
  for (const baseUrl of feeds) {
    try {
      const response = await fetchImpl(`${baseUrl}/${manifest}`, {
        headers: { Accept: "text/yaml, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        if (response.status === 404) missingManifests++;
        continue;
      }
      const files = parseUpdaterManifestFiles(await response.text());
      if (!files.length) continue;
      readManifest = true;
      const file = selectArchitectureDownload(files, platform, arch);
      if (file) return { status: "available", downloadUrl: new URL(file.url, `${baseUrl}/`).toString() };
    } catch { /* A bounded request to the fallback feed may still succeed. */ }
  }
  return { status: readManifest || missingManifests === feeds.length ? "unavailable" : "error", downloadUrl: null };
}
