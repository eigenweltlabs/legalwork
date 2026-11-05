import { expect, test } from "bun:test";
import { runHostCommand } from "./host.js";
const run = (command: string, timeoutMs = 10000, signal = new AbortController().signal) => runHostCommand({ command, cwd: process.cwd(), timeoutMs, signal });
test("cold native shell starts and reports exit status", async () => {
  // Windows' first PowerShell launch also initializes .NET and scans the new
  // supervisor. Measure that separately from subsequent command deadlines.
  const start = performance.now();
  expect(await run("echo native-shell; exit 7", process.platform === "win32" ? 30000 : 10000)).toMatchObject({ exitCode: 7, truncated: false });
  console.info(`Cold native shell: ${Math.round(performance.now() - start)} ms`);
}, 35000);
test("warm native shell executes within the normal deadline", async () => {
  expect((await run("echo native-shell")).output).toContain("native-shell");
});
test.skipIf(process.platform !== "win32")("native cmdlets work when launched from a PowerShell 7 environment", async () => {
  const original = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\LEGALWORK_INCOMPATIBLE_PS7_MODULES";
  try {
    const result = await run("if ($env:PSModulePath.Contains('LEGALWORK_INCOMPATIBLE_PS7_MODULES')) { exit 99 }; Write-Output 'native-modules'; Get-Item . | Out-Null");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("native-modules");
    expect(process.env.PSModulePath).toBe("C:\\LEGALWORK_INCOMPATIBLE_PS7_MODULES");
  } finally {
    if (original === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = original;
  }
});
test("host runner bounds output without blocking the child", async () => {
  const command = process.platform === "win32" ? "[Console]::Write('x' * 2000000)" : "head -c 2000000 /dev/zero";
  const result = await run(command);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.output)).toBe(1024 * 1024);
});
test("configured commands keep complete output and remain cancellable without a default deadline", async () => {
  const command = process.platform === "win32" ? "[Console]::Write('x' * 2000000)" : "head -c 2000000 /dev/zero";
  const result = await runHostCommand({ command, cwd: process.cwd(), timeoutMs: null, capture: "complete", signal: new AbortController().signal });
  expect(result.truncated).toBe(false);
  expect(Buffer.byteLength(result.output)).toBe(2000000);
  const controller = new AbortController();
  const running = runHostCommand({ command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30", cwd: process.cwd(), timeoutMs: null, capture: "complete", signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(running).rejects.toThrow("cancelled");
});
test("host command timeout and cancellation settle promptly", async () => {
  const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  await expect(run(sleep, 100)).rejects.toThrow("timed out");
  const abort = new AbortController();
  const command = run(sleep, 10000, abort.signal);
  setTimeout(() => abort.abort(), 100);
  await expect(command).rejects.toThrow("cancelled");
});

test("background descendants do not outlive the native command", async () => {
  const { mkdtemp, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "host-descendant-"));
  const marker = join(dir, "escaped");
  try {
    const inner = `Start-Sleep -Milliseconds 1000; Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value escaped`;
    const command = process.platform === "win32"
      ? `Start-Process powershell.exe -ArgumentList '-NoProfile', '-EncodedCommand', '${Buffer.from(inner, "utf16le").toString("base64")}' -WindowStyle Hidden`
      : `(sleep 1; printf escaped > '${marker.replaceAll("'", "'\\''")}') &`;
    const result = await run(command);
    expect(result.exitCode).toBe(0);
    await Bun.sleep(1300);
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);

test("native shell errors and long commands keep their exit status", async () => {
  expect((await run(process.platform === "win32" ? "Write-Error 'failed-command'" : "false")).exitCode).not.toBe(0);
  const comment = "#" + "x".repeat(40000);
  expect((await run(comment + "\necho long-command")).output).toContain("long-command");
});

test.skipIf(process.platform === "win32")("revocation stops a child that has left the native process group", async () => {
  const { mkdtemp, readFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "host-detached-"));
  const marker = join(root, "escaped"), ready = join(root, "ready");
  const abort = new AbortController();
  const code = `import os,time
from pathlib import Path
child=os.fork()
if child==0:
 os.setsid()
 fd=os.open('/dev/null',os.O_RDWR)
 for stream in range(3): os.dup2(fd,stream)
 Path(${JSON.stringify(ready)}).write_text(str(os.getpid()))
 time.sleep(1)
 Path(${JSON.stringify(marker)}).write_text('escaped')
 os._exit(0)
time.sleep(10)`;
  const command = run(`python3 - <<'PY'\n${code}\nPY`, 15000, abort.signal).catch(error => error);
  try {
    for (let attempt = 0; ; attempt++) {
      if (await readFile(ready, "utf8").catch(() => "")) break;
      if (attempt === 300) throw new Error("Detached child did not start");
      await Bun.sleep(10);
    }
    abort.abort();
    expect(String(await command)).toContain("cancelled");
    await Bun.sleep(1200);
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally { abort.abort(); await command; await rm(root, { recursive: true, force: true }); }
}, 20000);
