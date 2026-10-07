import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { z } from "zod";
import { brokerRequest, prepareOutboundRequest, type OutboundRequest } from "./network.js";
import { applyChanges, hashFile, locate, readSnapshotFile, snapshotFolders, MAX_FILE_BYTES, MAX_FILES, MAX_SNAPSHOT_BYTES, type FileChange, type SandboxMount, type Snapshot } from "./files.js";
export { validateMounts, within, type SandboxMount } from "./files.js";

const exec = promisify(execFile);
const OUTPUT_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 24 * 1024 * 1024;

async function connectPipe(name: string, signal: AbortSignal): Promise<Socket> {
  while (true) {
    signal.throwIfAborted();
    const socket = createConnection(`\\\\.\\pipe\\${name}`);
    try { await once(socket, "connect", { signal }); return socket; }
    catch (error) {
      socket.destroy();
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await delay(50, undefined, { signal });
    }
  }
}
const manifestSchema = z.object({ version: z.literal(1), architecture: z.enum(["aarch64", "x86_64"]),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export type SandboxResult = { output: string; exitCode: number; truncated: boolean };
export type SandboxRun = { command: string; cwd: string; mounts: SandboxMount[]; timeoutMs: number;
  signal: AbortSignal; authorizeNetwork: (request: OutboundRequest) => Promise<boolean> };
const eventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ready") }),
  z.object({ event: z.literal("output"), stream: z.enum(["stdout", "stderr"]), data: z.string().max(16384) }),
  z.object({ event: z.literal("exit"), code: z.number().int() }),
  z.object({ event: z.literal("error"), message: z.string().max(8192) }),
  z.object({ event: z.literal("file"), path: z.string().max(4096), directory: z.boolean().optional(), deleted: z.boolean().optional(), mode: z.number().int().optional(),
    data: z.string().max(6 * 1024 * 1024).optional(), end: z.boolean().optional() }),
  z.object({ event: z.literal("request"), id: z.string().regex(/^[a-f0-9]{32}$/), request: z.object({
    url: z.string().max(16384), method: z.string().max(32), headers: z.record(z.string(), z.string().max(8192)),
    bodyBase64: z.string().max(6 * 1024 * 1024),
  }) }),
]);

export function sandboxResources(): string {
  return process.resourcesPath ? join(process.resourcesPath, "agent-sandbox")
    : fileURLToPath(new URL("../../resources/agent-sandbox/runtime/", import.meta.url));
}

/** The VM has no network device or host mounts. The host treats every guest
 * message as untrusted, including output from a compromised guest kernel. */
export class VmSandbox {
  private static active = 0;
  private prepared: Promise<z.infer<typeof manifestSchema>> | undefined;
  constructor(readonly resources = sandboxResources()) {}
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

  async run(input: SandboxRun): Promise<SandboxResult> {
    if (VmSandbox.active >= 2) throw new Error("Two protected commands are already running. Wait for one to finish.");
    VmSandbox.active++;
    try { return await this.runIsolated(input); }
    finally { VmSandbox.active--; }
  }

  private async runIsolated(input: SandboxRun): Promise<SandboxResult> {
    input.signal.throwIfAborted();
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600000) throw new Error("Invalid sandbox timeout.");
    if (!input.command || input.command.length > 128000) throw new Error("Invalid sandbox command.");
    const executable = await this.prepare();
    const manifest = await this.prepared!;
    const snapshot = await snapshotFolders(input.mounts, input.signal);
    if (!snapshot.mounts.some((mount) => input.cwd === mount.target || input.cwd.startsWith(mount.target + "/")) || input.cwd.split("/").includes("..")) throw new Error("Command directory is outside the sandbox folders.");
    const arm = manifest.architecture === "aarch64";
    const nativeMac = process.platform === "darwin" && (arm ? process.arch === "arm64" : process.arch === "x64");
    const diagnostics = await mkdtemp(join(tmpdir(), "legalwork-vm-"));
    const consolePath = join(diagnostics, "console.log");
    // QEMU's Windows stdio drops input when the guest cannot accept a byte.
    // Its named-pipe backend preserves backpressure for binary file transfers.
    const pipeName = process.platform === "win32" ? `legalwork-${randomUUID()}` : undefined;
    const args = ["-no-user-config", "-nodefaults", "-L", this.resources, "-machine", arm ? "virt" : "q35",
      "-accel", nativeMac ? "hvf" : "tcg", "-cpu", nativeMac ? "host" : arm ? "cortex-a72" : "max",
      "-m", "2048", "-smp", "2", "-display", "none", "-monitor", "none", "-serial", `file:${consolePath}`, "-nic", "none", "-no-reboot",
      "-kernel", join(this.resources, "kernel"), "-initrd", join(this.resources, "initrd.gz"),
      "-append", `rdinit=/init panic=1 quiet console=${arm ? "ttyAMA0" : "ttyS0"}`,
      "-chardev", pipeName ? `pipe,id=rpc,path=${pipeName}` : "stdio,id=rpc", "-device", arm ? "virtio-serial-device" : "virtio-serial-pci",
      "-device", "virtserialport,chardev=rpc,name=org.legalwork.rpc"];
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(180000 + input.timeoutMs)]);
    try {
      const { result, changes } = await this.execute(executable, args, input, snapshot, signal, consolePath, pipeName);
      controller.abort();
      // The VM process has exited before any file is written back to the host.
      await applyChanges(snapshot, changes, input.signal);
      return result;
    } finally { controller.abort(); await rm(diagnostics, { recursive: true, force: true }); }
  }

  private execute(executable: string, args: string[], input: SandboxRun, snapshot: Snapshot, signal: AbortSignal, consolePath: string, pipeName?: string): Promise<{ result: SandboxResult; changes: FileChange[] }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, signal, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
      let pending = "", output = "", stderr = "";
      let exitCode: number | undefined, failure: Error | undefined;
      let truncated = false, ready = false, requests = 0, fileBytes = 0;
      const active = new Set<string>(), files = new Map<string, FileChange>();
      let current: { path: string; chunks: Buffer[]; size: number; mode?: number } | undefined;
      const pipeController = new AbortController();
      let pipe: Socket | undefined;
      let writer = child.stdin;
      const fail = (error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); child.kill("SIGKILL"); };
      const send = async (message: unknown) => {
        signal.throwIfAborted();
        if (!writer.write(JSON.stringify(message) + "\n")) await once(writer, "drain", { signal });
      };
      child.on("error", fail);
      child.stdin.on("error", (error) => { if (exitCode === undefined) fail(error); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
      const receive = (chunk: Buffer) => {
        pending += chunk.toString();
        if (pending.length > FRAME_LIMIT) return fail(new Error("Sandbox protocol frame exceeded its limit."));
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (exitCode !== undefined || failure) return;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const event = eventSchema.parse(JSON.parse(line));
            if (event.event === "error") return fail(new Error(event.message));
            if (event.event === "ready") {
              if (ready) throw new Error("Duplicate sandbox startup.");
              ready = true;
              void (async () => {
                await send({ command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs, uid: 1000, gid: 1000,
                  mounts: snapshot.mounts.map(({ target, writable }) => ({ target, writable })), directories: snapshot.directories });
                for (const file of snapshot.files.values()) {
                  const bytes = await readSnapshotFile(locate(snapshot, file.path).host);
                  if (hashFile(bytes) !== file.sha256) throw new Error(`File changed during sandbox preparation: ${file.path}`);
                  await send({ file: file.path, mode: file.mode, sha256: file.sha256 });
                  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) await send({ data: bytes.subarray(offset, offset + 1024 * 1024).toString("base64") });
                  await send({ end: true });
                }
                await send({ run: true });
              })().catch(fail);
            }
            if (event.event === "output") {
              const text = Buffer.from(event.data, "base64").toString();
              truncated ||= output.length + text.length > OUTPUT_LIMIT;
              output = (output + text).slice(0, OUTPUT_LIMIT);
            }
            if (event.event === "file") {
              locate(snapshot, event.path);
              if (event.directory || event.deleted) {
                if (current || files.has(event.path) || event.data) throw new Error("Invalid file metadata.");
                files.set(event.path, event.directory ? { path: event.path, directory: true, deleted: event.deleted } : { path: event.path, deleted: true });
              }
              else {
                current ??= { path: event.path, chunks: [], size: 0, mode: event.mode };
                if (current.path !== event.path || files.has(event.path)) throw new Error("Invalid file output sequence.");
                const bytes = Buffer.from(event.data ?? "", "base64");
                current.size += bytes.length; fileBytes += bytes.length; current.chunks.push(bytes);
                if (current.size > MAX_FILE_BYTES || fileBytes > MAX_SNAPSHOT_BYTES) throw new Error("Sandbox file output exceeded its limit.");
                if (event.end) { files.set(event.path, { path: event.path, mode: current.mode, content: Buffer.concat(current.chunks) }); current = undefined; }
              }
              if (files.size > MAX_FILES) throw new Error("Too many sandbox output files.");
            }
            if (event.event === "exit") { if (current || !ready) throw new Error("Incomplete sandbox output."); exitCode = event.code; child.kill("SIGKILL"); }
            if (event.event === "request") {
              if (++requests > 200 || active.size >= 16 || active.has(event.id)) throw new Error("Sandbox network request limit exceeded.");
              active.add(event.id);
              void (async () => {
                try {
                  const response = await brokerRequest(prepareOutboundRequest(event.request), input.authorizeNetwork, signal);
                  await send({ id: event.id, response });
                } catch (error) {
                  if (!writer.destroyed) await send({ id: event.id, error: error instanceof Error ? error.message : "Request denied" });
                } finally { active.delete(event.id); }
              })().catch(fail);
            }
          } catch (error) { fail(error); }
        }
      };
      if (pipeName) {
        void connectPipe(pipeName, AbortSignal.any([signal, pipeController.signal])).then((socket) => {
          pipe = socket; writer = socket;
          socket.on("error", fail);
          socket.on("data", receive);
          socket.on("end", () => { if (exitCode === undefined) fail(new Error("Sandbox channel closed early.")); });
        }).catch((error) => { if (!pipeController.signal.aborted) fail(error); });
      } else child.stdout.on("data", receive);
      child.on("close", async () => {
        pipeController.abort();
        pipe?.destroy();
        if (failure) return reject(failure);
        if (signal.aborted) return reject(signal.reason);
        if (exitCode === undefined) {
          const diagnostic = await readFile(consolePath, "utf8").catch(() => "");
          return reject(new Error(`Protected environment stopped unexpectedly: ${stderr}\n${diagnostic.slice(-8192)}`));
        }
        resolve({ result: { output, exitCode, truncated }, changes: [...files.values()] });
      });
    });
  }
}
