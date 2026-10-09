import { execFile } from "node:child_process";
import { availableParallelism, cpus as hostCpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const WARM_IDLE_MS = 5 * 60_000;

// A shared allowance, independent of how many chats are open. Leave capacity
// for the host and for the other network-capability VM if it is also running.
export function vmResources(cpus = availableParallelism(), memory = totalmem()) {
  // Bun can return undefined from availableParallelism after PDF processing.
  // Keep affinity-aware capacity when valid, otherwise use the OS core count.
  const cores = Number.isInteger(cpus) && cpus > 0 ? cpus : Math.max(1, hostCpus().length);
  return { cpus: Math.max(1, Math.min(8, cores, Math.max(2, Math.floor(cores / 2)))),
    memoryMiB: Math.max(2048, Math.min(8192, Math.floor(memory / 1024 ** 2 / 4))) };
}

export async function hostNeedsMemory(): Promise<boolean> {
  if (process.platform === "darwin") {
    // macOS uses otherwise free RAM for caches. freemem() alone is not pressure.
    return exec("/usr/bin/memory_pressure", ["-Q"], { timeout: 2000 }).then(({ stdout }) => {
      const percentage = stdout.match(/System-wide memory free percentage:\s*(\d+)%/);
      return percentage !== null && Number(percentage[1]) < 10;
    }, () => false);
  }
  return freemem() < Math.max(512 * 1024 ** 2, totalmem() * 0.05);
}
