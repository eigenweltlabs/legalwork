import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { brokerRequest, prepareOutboundRequest, type OutboundRequest, networkModeSchema, type NetworkMode } from "./network.js";
import { validateMounts, type SandboxMount } from "./files.js";
import { SandboxFilesystem, filesystemError, filesystemRequestSchema } from "./filesystem.js";
import { SharedVmRuntime } from "./runtime.js";
export { validateMounts, within, type SandboxMount } from "./files.js";

const exec = promisify(execFile);
const OUTPUT_LIMIT = 1024 * 1024;
const manifestSchema = z.object({ version: z.literal(1), architecture: z.enum(["aarch64", "x86_64"]),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export type SandboxResult = { output: string; exitCode: number; truncated: boolean };
export type SandboxRun = { command: string; cwd: string; mounts: SandboxMount[]; timeoutMs: number;
  signal: AbortSignal; networkMode?: NetworkMode; authorizeNetwork: (request: OutboundRequest) => Promise<boolean> };
const eventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("output"), stream: z.enum(["stdout", "stderr"]), data: z.string().max(16384) }),
  z.object({ event: z.literal("exit"), code: z.number().int() }),
  z.object({ event: z.literal("error"), message: z.string().max(8192) }),
  z.object({ event: z.literal("filesystem"), id: z.string().regex(/^[a-f0-9]{32}$/), request: filesystemRequestSchema }),
  z.object({ event: z.literal("request"), id: z.string().regex(/^[a-f0-9]{32}$/), request: z.object({
    url: z.string().max(16384), method: z.string().max(32), headers: z.record(z.string(), z.string().max(8192)),
    bodyBase64: z.string().max(6 * 1024 * 1024),
  }) }),
]);

export function sandboxResources(): string {
  return process.resourcesPath && process.env.LEGALWORK_DEV_MODE !== "1" ? join(process.resourcesPath, "agent-sandbox")
    : fileURLToPath(new URL("../../resources/agent-sandbox/runtime/", import.meta.url));
}

/** Brokered and unrestricted commands use separate shared VMs. Only the latter
 * has a NIC. Neither has host mounts; each command has its own folder broker. */
export class VmSandbox {
  private static runtimes = new Map<string, Promise<SharedVmRuntime>>();
  private static commits = Promise.resolve();
  static async shutdown(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map(async (runtime) => (await runtime).close()));
  }
  private prepared: Promise<z.infer<typeof manifestSchema>> | undefined;
  constructor(readonly resources = sandboxResources(), private readonly acceleration: "auto" | "software" = "auto") {}
  private executable(architecture: string) { return join(this.resources, `qemu-system-${architecture}${process.platform === "win32" ? ".exe" : ""}`); }

  async status(): Promise<{ available: boolean; reason?: string }> {
    try { await this.prepare(); return { available: true }; }
    catch (error) { return { available: false, reason: error instanceof Error ? error.message : "Protected runtime is unavailable." }; }
  }
  async prepare(): Promise<string> {
    this.prepared ??= this.verify().catch((error: unknown) => { this.prepared = undefined; throw error; });
    const manifest = await this.prepared;
    return this.executable(manifest.architecture);
  }
  private async verify() {
    const raw = await readFile(join(this.resources, "manifest.json"), "utf8").catch(() => {
      throw new Error("The bundled protected runtime is missing. Repair or reinstall LegalWork; commands will remain blocked.");
    });
    const manifest = manifestSchema.parse(JSON.parse(raw));
    const executable = `qemu-system-${manifest.architecture}${process.platform === "win32" ? ".exe" : ""}`;
    for (const name of [executable, "kernel", "initrd.gz"]) {
      if (!manifest.files[name]) throw new Error("The protected runtime manifest is incomplete.");
    }
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) throw new Error("Invalid runtime file name.");
      const actual = createHash("sha256").update(await readFile(join(this.resources, name))).digest("hex");
      if (actual !== expected) throw new Error(`Protected runtime integrity check failed: ${name}`);
    }
    await exec(this.executable(manifest.architecture), ["--version"], { timeout: 60000, windowsHide: true });
    return manifest;
  }

  private sharedRuntime(directNetwork: boolean): Promise<SharedVmRuntime> {
    const key = `${this.resources}:${this.acceleration}:${directNetwork}`;
    let runtime = VmSandbox.runtimes.get(key);
    if (!runtime) {
      runtime = this.startRuntime(directNetwork, () => { if (VmSandbox.runtimes.get(key) === runtime) VmSandbox.runtimes.delete(key); });
      VmSandbox.runtimes.set(key, runtime);
      void runtime.catch(() => { if (VmSandbox.runtimes.get(key) === runtime) VmSandbox.runtimes.delete(key); });
    }
    return runtime;
  }

  private async startRuntime(directNetwork: boolean, onClose: () => void): Promise<SharedVmRuntime> {
    const executable = await this.prepare();
    const manifest = await this.prepared!;
    const arm = manifest.architecture === "aarch64";
    const nativeMac = this.acceleration === "auto" && process.platform === "darwin" && (arm ? process.arch === "arm64" : process.arch === "x64") &&
      await exec("/usr/sbin/sysctl", ["-n", "kern.hv_support"], { timeout: 5000 }).then(({ stdout }) => stdout.trim() === "1", () => false) &&
      // Nested Intel HVF can corrupt the guest or hang despite hv_support=1.
      // Physical Intel Macs retain HVF; virtual Intel Macs use the tested TCG path.
      (arm || await exec("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { timeout: 5000 }).then(({ stdout }) => stdout.trim() === "0", () => false));
    const diagnostics = await mkdtemp(join(tmpdir(), "legalwork-vm-"));
    const consolePath = join(diagnostics, "console.log");
    // QEMU's Windows stdio drops input when the guest cannot accept a byte.
    // Its named-pipe backend preserves backpressure for binary file transfers.
    const pipeName = process.platform === "win32" ? `legalwork-${randomUUID()}` : undefined;
    const args = ["-no-user-config", "-nodefaults", "-L", this.resources, "-machine", arm ? "virt" : "q35",
      "-accel", nativeMac ? "hvf" : "tcg", "-cpu", nativeMac ? "host" : arm ? "cortex-a72" : "max",
      "-m", String(Math.max(2048, Math.min(8192, Math.floor(totalmem() / 1024 ** 2 / 4)))), "-smp", "2", "-display", "none", "-monitor", "none", "-serial", `file:${consolePath}`, "-no-reboot",
      // Direct kernel boot needs no PCI network boot ROM.
      ...(directNetwork ? ["-netdev", "user,id=outbound", "-device", `${arm ? "virtio-net-device" : "virtio-net-pci,romfile="},netdev=outbound`] : ["-nic", "none"]),
      "-kernel", join(this.resources, "kernel"), "-initrd", join(this.resources, "initrd.gz"),
      "-append", `rdinit=/init panic=1 quiet console=${arm ? "ttyAMA0" : "ttyS0"}${directNetwork ? " legalwork.network=allow" : ""}`,
      "-chardev", pipeName ? `pipe,id=rpc,path=${pipeName}` : "stdio,id=rpc", "-device", arm ? "virtio-serial-device" : "virtio-serial-pci",
      "-device", "virtserialport,chardev=rpc,name=org.legalwork.rpc"];
    return new SharedVmRuntime(executable, args, diagnostics, consolePath, onClose, pipeName);
  }

  async run(input: SandboxRun): Promise<SandboxResult> {
    input.signal.throwIfAborted();
    const networkMode = networkModeSchema.parse(input.networkMode ?? "approve");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600000) throw new Error("Invalid sandbox timeout.");
    if (!input.command || input.command.length > 128000) throw new Error("Invalid sandbox command.");
    const mounts = await validateMounts(input.mounts);
    if (!mounts.some((mount) => input.cwd === mount.target || input.cwd.startsWith(mount.target + "/")) || input.cwd.split("/").includes("..")) throw new Error("Command directory is outside the sandbox folders.");
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(180000 + input.timeoutMs)]);
    const filesystem = await SandboxFilesystem.create(mounts, signal);
    let output = "", truncated = false, requests = 0, exitCode: number | undefined;
    const active = new Set<string>(), activeFilesystem = new Set<string>();
    let filesystemWork = Promise.resolve();
    try {
      const runtime = await this.sharedRuntime(networkMode === "allow");
      await runtime.execute({ command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs, networkMode,
        mounts: filesystem.mounts.map(({ target, writable }) => ({ target, writable })) }, signal, (raw, send, finish) => {
        try {
          const event = eventSchema.parse(raw);
          if (event.event === "error") { finish(new Error(event.message)); return; }
          if (event.event === "exit") {
            if (activeFilesystem.size) throw new Error("Incomplete sandbox filesystem operation.");
            exitCode = event.code;
            finish();
            return;
          }
          if (signal.aborted) return;
          if (event.event === "output") {
            const text = Buffer.from(event.data, "base64").toString();
            truncated ||= output.length + text.length > OUTPUT_LIMIT;
            output = (output + text).slice(0, OUTPUT_LIMIT);
          }
          if (event.event === "filesystem") {
            if (activeFilesystem.size >= 16 || activeFilesystem.has(event.id) || active.has(event.id)) throw new Error("Invalid filesystem request sequence.");
            activeFilesystem.add(event.id);
            filesystemWork = filesystemWork.then(async () => {
              signal.throwIfAborted();
              let response: unknown;
              try { response = { result: await filesystem.request(event.request) }; }
              catch (error) { response = { errno: filesystemError(error) }; }
              await send({ id: event.id, response });
              activeFilesystem.delete(event.id);
            }).catch((error: unknown) => controller.abort(error));
          }
          if (event.event === "request") {
            if (++requests > 200 || active.size >= 16 || active.has(event.id) || activeFilesystem.has(event.id)) throw new Error("Sandbox network request limit exceeded.");
            active.add(event.id);
            void (async () => {
              try {
                if (networkMode !== "approve") throw new Error("Network request broker is disabled by the sandbox network policy.");
                const response = await brokerRequest(prepareOutboundRequest(event.request), input.authorizeNetwork, signal);
                await send({ id: event.id, response });
              } catch (error) {
                if (!signal.aborted) await send({ id: event.id, error: error instanceof Error ? error.message : "Request denied" });
              } finally { active.delete(event.id); }
            })().catch((error: unknown) => controller.abort(error));
          }
        } catch (error) { controller.abort(error); }
      });
      controller.abort();
      filesystem.cancel();
      await filesystemWork;
      if (exitCode === undefined) throw new Error("Protected command did not finish.");
      // Serialize validation and publication: concurrent workers must not both
      // validate the same old contents and then overwrite each other's edits.
      const commit = VmSandbox.commits.then(() => filesystem.commit(input.signal));
      VmSandbox.commits = commit.catch(() => {});
      await commit;
      return { output, exitCode, truncated };
    } finally {
      controller.abort();
      filesystem.cancel();
      await filesystemWork;
      await filesystem.dispose();
    }
  }
}
