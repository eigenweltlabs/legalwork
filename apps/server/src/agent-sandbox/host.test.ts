import { expect, test } from "bun:test";
import { runHostCommand } from "./host.js";
const run = (command: string, timeoutMs = 10000, signal = new AbortController().signal) => runHostCommand({ command, cwd: process.cwd(), timeoutMs, signal });
test("host runner uses the native shell and reports exit status", async () => {
  expect(await run("echo native-shell; exit 7")).toMatchObject({ exitCode: 7, truncated: false });
  expect((await run("echo native-shell")).output).toContain("native-shell");
});
test("host runner bounds output without blocking the child", async () => {
  const command = process.platform === "win32" ? "[Console]::Write('x' * 2000000)" : "head -c 2000000 /dev/zero";
  const result = await run(command);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.output)).toBe(1024 * 1024);
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
