/** Repeatable real-VM workloads. Build with Bun --target node to run on Windows. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { VmSandbox, sandboxResources } from "../../apps/server/src/agent-sandbox/vm.js";

const sandbox = new VmSandbox(process.argv[2] ? resolve(process.argv[2]) : sandboxResources());
const workspace = await mkdtemp(join(tmpdir(), "legalwork-performance-"));
const results: Record<string, unknown> = { platform: process.platform, architecture: process.arch, hostCpus: availableParallelism() };
const run = async (command: string, writable = false) => {
  const result = await sandbox.run({ command, cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable }],
    networkMode: "block", timeoutMs: 120000, signal: AbortSignal.timeout(300000), authorizeNetwork: async () => { throw new Error("Unexpected network request"); } });
  assert.equal(result.exitCode, 0, result.output);
  return result.output;
};
async function measure(name: string, action: () => Promise<unknown>) {
  const start = performance.now();
  const value = await action();
  results[name] = Math.round(performance.now() - start);
  console.log(JSON.stringify({ workload: name, milliseconds: results[name] }));
  return value;
}
async function memory() {
  const exec = promisify(execFile);
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Where-Object { $_.Name -like 'qemu-system-*' } | ForEach-Object { $p=Get-Process -Id $_.ProcessId; [pscustomobject]@{pid=$p.Id;residentMiB=$p.WorkingSet64/1MB;committedMiB=$p.PrivateMemorySize64/1MB} } | ConvertTo-Json -Compress`], { windowsHide: true });
    return JSON.parse(stdout);
  }
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  return stdout.split("\n").filter((line) => line.includes("qemu-system-")).flatMap((line) => {
    const [pid, parent, rss] = line.trim().split(/\s+/);
    return Number(parent) === process.pid ? [{ pid: Number(pid), residentMiB: Number(rss) / 1024 }] : [];
  });
}
try {
  await measure("verifyMs", () => sandbox.prepare());
  await measure("coldCommandMs", () => run("true"));
  results.guestCpus = Number(await run("nproc"));
  for (let trial = 1; trial <= 3; trial++) {
    await measure(`tenWorkersMs${trial}`, () => Promise.all(Array.from({ length: 10 }, () => run("python3 -c 'print(sum(i*i for i in range(500000)))'"))));
  }
  await measure("documentImportsMs", () => run("python3 -c 'import docx, openpyxl, pptx, pypdf, reportlab, PIL'"));
  const bytes = randomBytes(8 * 1024 * 1024);
  await writeFile(join(workspace, "input.bin"), bytes);
  await measure("binaryRoundtrip8MiBMs", () => run("python3 -c 'from pathlib import Path; Path(\"output.bin\").write_bytes(Path(\"input.bin\").read_bytes())'", true));
  assert.deepEqual(await readFile(join(workspace, "output.bin")), bytes);
  if (process.argv.includes("--memory")) {
    results.memoryBefore = await memory();
    const allocation = await sandbox.run({ command: `python3 - <<'PY'
import urllib.request, urllib.error
data = bytearray(384 * 1024 * 1024)
for i in range(0, len(data), 4096): data[i] = 1
try: urllib.request.urlopen('https://example.com/memory-barrier')
except urllib.error.HTTPError as error: assert error.code == 403
print(len(data))
PY`, cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }],
      timeoutMs: 120000, signal: AbortSignal.timeout(180000), networkMode: "approve", authorizeNetwork: async (request) => {
        assert.equal(request.url, "https://example.com/memory-barrier");
        results.memoryDuring384MiB = await memory();
        return false;
      } });
    assert.equal(allocation.exitCode, 0, allocation.output);
    await delay(5000);
    results.memoryAfter5s = await memory();
  }
  if (process.argv.includes("--idle")) {
    const before = await run("cat /proc/sys/kernel/random/boot_id");
    await delay(35000);
    const after = await measure("commandAfter35sIdleMs", () => run("cat /proc/sys/kernel/random/boot_id"));
    results.reusedAfter35s = before === after;
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await VmSandbox.shutdown();
  await rm(workspace, { recursive: true, force: true });
}
