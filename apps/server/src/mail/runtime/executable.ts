import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export type WorkerExecutable = { kind: "node" | "electron"; path: string };

/** Never inherit the parent's token-bearing environment or NODE_OPTIONS loader hooks. */
export function workerEnvironment(executable: WorkerExecutable): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (executable.kind === "electron") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** Explicit executable required under Bun; an Electron binary must retain its RunAsNode fuse. */
export async function probeWorkerExecutable(executable: WorkerExecutable): Promise<{ nodeVersion: string }> {
  if (!isAbsolute(executable.path)) throw new Error("mail_worker_executable_invalid");
  const script = 'process.stdout.write(JSON.stringify({node:process.versions.node,bun:Boolean(process.versions.bun)}))';
  return new Promise((resolve, reject) => {
    execFile(executable.path, ["--eval", script], {
      env: workerEnvironment(executable), timeout: 3000, maxBuffer: 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(new Error("mail_worker_executable_unavailable")); return; }
      try {
        const value: unknown = JSON.parse(stdout);
        if (typeof value !== "object" || value === null || !("node" in value) || !("bun" in value)
          || typeof value.node !== "string" || !/^\d+\.\d+\.\d+$/.test(value.node)
          || Number(value.node.split(".")[0]) < 22 || value.bun !== false) {
          reject(new Error("mail_worker_requires_node_22_or_newer")); return;
        }
        resolve({ nodeVersion: value.node });
      } catch { reject(new Error("mail_worker_executable_invalid")); }
    });
  });
}
