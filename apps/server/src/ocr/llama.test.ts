import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareQualityWindowsRuntime } from "./llama.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => Promise<boolean> | boolean) => {
  for (let attempt = 0; attempt < 100 && !await condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
};

test("Windows quality setup reuses only the application's CRT files and fails if a prerequisite is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "llama-crt-"));
  const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const resources = join(root, "resources"), target = join(root, "model-runtime");
  const source = join(resources, "app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64");
  const names = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
  try {
    await mkdir(source, { recursive: true }); await mkdir(target);
    await writeFile(join(resources, "app.asar"), "fixture");
    for (const name of [...names, "unrelated.dll"]) await writeFile(join(source, name), `signed-fixture:${name}`);
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });
    await prepareQualityWindowsRuntime(target);
    expect((await readdir(target)).sort()).toEqual(names.sort());
    for (const name of names) expect(await readFile(join(target, name), "utf8")).toBe(`signed-fixture:${name}`);
    const before = (await stat(join(target, "vcruntime140.dll"))).mtimeMs;
    await prepareQualityWindowsRuntime(target);
    expect((await stat(join(target, "vcruntime140.dll"))).mtimeMs).toBe(before);
    await writeFile(join(source, "vcruntime140.dll"), "updated-signed-fixture");
    await prepareQualityWindowsRuntime(target);
    expect(await readFile(join(target, "vcruntime140.dll"), "utf8")).toBe("updated-signed-fixture");
    await rm(join(source, "vcruntime140.dll"));
    await expect(prepareQualityWindowsRuntime(target)).rejects.toThrow();
  } finally {
    if (previous) Object.defineProperty(process, "resourcesPath", previous); else Reflect.deleteProperty(process, "resourcesPath");
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher stops llama-server when its owner closes stdin, even without a clean shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "llama-launcher-"));
  try {
    // A stand-in server that records its process ID and keeps running.
    const server = join(root, "server.cjs"), pidFile = join(root, "pid");
    await writeFile(server, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const launcher = spawn(process.execPath, [fileURLToPath(new URL("../../resources/ocr/llama-launcher.cjs", import.meta.url)), process.execPath, server], { stdio: ["pipe", "ignore", "ignore"] });
    await waitFor(() => readFile(pidFile, "utf8").then(Boolean, () => false));
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    // Closing stdin is what the operating system does when the owner dies.
    launcher.stdin?.end();
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
