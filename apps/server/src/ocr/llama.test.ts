import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => Promise<boolean> | boolean) => {
  for (let attempt = 0; attempt < 100 && !await condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
};

test("the launcher stops llama-server when its owner closes stdin, even without a clean shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "llama-launcher-"));
  try {
    // A stand-in server that records its process ID and keeps running.
    const server = join(root, "server.cjs"), pidFile = join(root, "pid");
    await writeFile(server, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`, { mode: 0o755 });
    const launcher = spawn(process.execPath, [new URL("../../resources/ocr/llama-launcher.cjs", import.meta.url).pathname, server], { stdio: ["pipe", "ignore", "ignore"] });
    await waitFor(() => readFile(pidFile, "utf8").then(Boolean, () => false));
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    // Closing stdin is what the operating system does when the owner dies.
    launcher.stdin?.end();
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
