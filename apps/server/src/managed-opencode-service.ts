import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { z } from "zod";

export type ManagedOpencodeServiceOptions = { configDirectory: string; stateDirectory: string; filename?: "service.json" | "service-legalwork.json" };
const registration = z.object({ url: z.string().url(), pid: z.number().int().positive(), password: z.string().optional() });
const engineInfo = z.object({ pid: z.number().int() });

/** The registered engine proves itself by answering with its password and PID.
 * A refused connection or another listener's answer proves the registration
 * stale; a listener that stays silent might be a stuck engine and blocks. */
async function registeredEngineAnswers(info: z.infer<typeof registration>): Promise<boolean> {
  const signal = AbortSignal.timeout(5000);
  const headers = Service.headers({ url: info.url, auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password } });
  const body: unknown = await fetch(new URL("/api/info", info.url), { headers, signal }).then(response => response.json()).catch(() => undefined);
  if (signal.aborted) throw new Error("The previous OpenCode engine's address is in use but does not answer. Close that engine before restarting LegalWork.");
  return engineInfo.safeParse(body).data?.pid === info.pid;
}

/** Managed engines hold a stdin lease and cannot outlive the process that
 * started them, so a registration nothing answers for is stale. Only an engine
 * that proves itself is stopped; a PID from the file alone never is. */
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
      if (await registeredEngineAnswers(info.data)) await Service.stop({ file, pty: "clear" });
      // Retain stale diagnostics, including their private file permissions.
      else await rename(file, `${file}.stale-${randomUUID()}`);
    }
  }
}

export async function prepareManagedOpencodeService(options: ManagedOpencodeServiceOptions, password: string): Promise<{ XDG_STATE_HOME: string; OPENCODE_CONFIG_DIR: string; OPENCODE_SERVICE_STDIN_LEASE: "1" }> {
  await stopManagedOpencodeService(options);
  const path = join(options.configDirectory, options.filename ?? "service.json"), temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ password }), { mode: 0o600 });
  await rename(temporary, path);
  return { XDG_STATE_HOME: options.stateDirectory, OPENCODE_CONFIG_DIR: options.configDirectory, OPENCODE_SERVICE_STDIN_LEASE: "1" };
}
