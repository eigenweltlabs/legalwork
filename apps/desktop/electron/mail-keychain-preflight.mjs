import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";

const unavailable = () => new Error("mail_key_backend_unavailable");
function defaultKeychain() {
  return new Promise((resolve, reject) => {
    // This only reads the configured default; it cannot create, reset or unlock a keychain.
    execFile("/usr/bin/security", ["default-keychain", "-d", "user"],
      { timeout: 2000, maxBuffer: 8192, encoding: "utf8" },
      (error, output) => error ? reject(unavailable()) : resolve(output));
  });
}

/** Fail before Electron's synchronous native vault call when the OS home or
 * default keychain is missing. Never suggest repairing/resetting system credentials.
 */
export async function assertMailKeychainReady({ platform = process.platform,
  home = process.env.HOME, osHome = () => userInfo().homedir,
  query = defaultKeychain, inspect = stat } = {}) {
  if (platform !== "darwin") return;
  try {
    if (!home || home !== osHome()) throw unavailable();
    const path = JSON.parse(String(await query()).trim());
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw unavailable();
    if (!(await inspect(path)).isFile()) throw unavailable();
  } catch { throw unavailable(); }
}
