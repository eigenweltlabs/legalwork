import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Pairing = { serverUrl: string; token: string; scheme: string };

function pairingCandidates(appData: string) {
  const names = ["com.eigenweltlabs.legalwork", "com.eigenweltlabs.legalwork.dev", "LegalWork", "LegalWork Dev"];
  return names.map(name => path.join(appData, name, "launcher-pairing.json"));
}
function applicationDataDirectory() {
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
}

export async function readPairing(appData = applicationDataDirectory()): Promise<Pairing | null> {
  for (const candidate of pairingCandidates(appData)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      if (parsed?.enabled === true && typeof parsed.serverUrl === "string" && typeof parsed.token === "string" && parsed.token) {
        const url = new URL(parsed.serverUrl);
        if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) continue;
        return { serverUrl: url.href.replace(/\/+$/, ""), token: parsed.token, scheme: parsed.scheme === "legalwork-dev" ? "legalwork-dev" : "legalwork" };
      }
    } catch { /* try the next profile */ }
  }
  return null;
}
