import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { z } from "zod";

export type ManagedOpencodeServiceOptions = { configDirectory: string; stateDirectory: string; filename?: "service.json" | "service-legalwork.json" };
const registration = z.object({ url: z.string().url(), pid: z.number().int().positive(), password: z.string().optional() });
const engineInfo = z.object({ pid: z.number().int() });

/** Binding succeeds only while nothing listens on the registered address, so
 * a gone engine is recognised at once, without connecting or sending its
 * password. `localhost` may resolve to another loopback address than the one
 * the engine bound, and a URL without a port names none to bind, so both are
 * always asked instead. */
async function registeredAddressIsFree(url: URL): Promise<boolean> {
  if (url.hostname === "localhost" || url.port === "") return false;
  const server = net.createServer();
  return new Promise(resolve => {
    server.once("error", () => resolve(false));
    server.listen(Number(url.port), url.hostname.replace(/^\[(.*)\]$/, "$1"), () => server.close(() => resolve(true)));
  });
}

/** A listener at the registered address that reports the registered PID is the
 * registered engine. A refused or reset connection, or any other answer, means
 * the registration is stale; a listener that stays silent might be a stuck
 * engine and blocks startup. */
async function registeredEngineAnswers(info: z.infer<typeof registration>): Promise<boolean> {
  const signal = AbortSignal.timeout(5000);
  const headers = Service.headers({ url: info.url, auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password } });
  const body: unknown = await fetch(new URL("/api/info", info.url), { headers, signal }).then(response => response.json()).catch(() => undefined);
  if (signal.aborted) throw new Error("LegalWork's previous engine does not respond. Wait a minute and restart LegalWork. If this message returns, sign out of the computer and back in, or restart the computer.");
  return engineInfo.safeParse(body).data?.pid === info.pid;
}

/** Stops the engine a leftover registration names only after it identifies
 * itself. The operating system's PID never decides whether the engine is
 * still there: Windows reuses PIDs quickly, often for LegalWork's own next
 * processes, and an engine force-killed on quit cannot remove its registration. */
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
      if (!await registeredAddressIsFree(url) && await registeredEngineAnswers(info.data)) await Service.stop({ file, pty: "clear" });
      // Retain stale diagnostics, including their private file permissions.
      else await rename(file, `${file}.stale-${randomUUID()}`);
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
