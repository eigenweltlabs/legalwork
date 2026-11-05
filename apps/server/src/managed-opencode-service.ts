import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { z } from "zod";
import { quarantineForeignWindowsService } from "./managed-opencode-windows-recovery.js";

export type ManagedOpencodeServiceOptions = { configDirectory: string; stateDirectory: string; filename?: "service.json" | "service-legalwork.json"; executablePath?: string };
const registration = z.object({ url: z.string().url(), pid: z.number().int().positive(), password: z.string().optional() });

/** Only a verified service in this application's private registration can be
 * stopped. A reused PID or unrelated listener is never killed from stale JSON. */
export async function stopManagedOpencodeService(options: ManagedOpencodeServiceOptions): Promise<void> {
  await Promise.all([options.configDirectory, options.stateDirectory].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  // Both reviewed channels use the same private engine DB. Verify and stop a
  // predecessor from either registration before another channel may launch.
  for (const filename of ["service.json", "service-legalwork.json"]) {
    const file = join(options.stateDirectory, "opencode", filename);
    let text: string | undefined;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (text !== undefined) {
      const info = registration.safeParse(JSON.parse(text));
      if (!info.success) throw new Error("The private OpenCode service registration is invalid. Preserve it and inspect the managed engine before restarting.");
      const url = new URL(info.data.url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") throw new Error("The private OpenCode service registration must point to a local engine.");
      let alive = true, inaccessibleExecutable: string | undefined;
      try { process.kill(info.data.pid, 0); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
        else if (error instanceof Error && "code" in error && error.code === "EPERM" && process.platform === "win32" && options.executablePath) inaccessibleExecutable = options.executablePath;
        else throw error;
      }
      if (alive) {
        const endpoint = await Service.discover({ file });
        if (inaccessibleExecutable) {
          if (endpoint) throw new Error("The previous OpenCode engine is still responding but this user cannot stop it. Close that engine before restarting LegalWork.");
          await quarantineForeignWindowsService({ file, text, pid: info.data.pid, url, executablePath: inaccessibleExecutable });
          continue;
        }
        if (!endpoint) throw new Error("A process still owns the private OpenCode service registration but cannot be verified. Resolve that engine before starting another copy.");
        await Service.stop({ file, pty: "clear" });
      } else {
        // Retain stale diagnostics, including their private file permissions.
        await rename(file, `${file}.stale-${randomUUID()}`);
      }
    }
  }
}

export async function prepareManagedOpencodeService(options: ManagedOpencodeServiceOptions, password: string): Promise<{ XDG_STATE_HOME: string; OPENCODE_CONFIG_DIR: string }> {
  await stopManagedOpencodeService(options);
  const path = join(options.configDirectory, options.filename ?? "service.json"), temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ password }), { mode: 0o600 });
  await rename(temporary, path);
  return { XDG_STATE_HOME: options.stateDirectory, OPENCODE_CONFIG_DIR: options.configDirectory };
}
