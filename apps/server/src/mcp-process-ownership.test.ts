import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyMcpQuiescent } from "./mcp-migration.js";
import { processAuthPath, processesUsingAuthPath, sameAuthPath } from "./mcp-process-ownership.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("credential paths honor absolute XDG data paths and platform home defaults", () => {
  expect(processAuthPath({ HOME: "/home/user", XDG_DATA_HOME: "/data with spaces" }, "linux")).toBe("/data with spaces/opencode/mcp-auth.json");
  expect(processAuthPath({ HOME: "/home/user" }, "darwin")).toBe("/home/user/.local/share/opencode/mcp-auth.json");
  expect(processAuthPath({ HOME: "/home/user", XDG_DATA_HOME: "relative" }, "darwin")).toBeUndefined();
  expect(processAuthPath({ USERPROFILE: "C:\\Users\\test", XDG_DATA_HOME: "C:relative" }, "win32")).toBeUndefined();
  expect(processAuthPath({ USERPROFILE: "C:\\Users\\test user" }, "win32")).toBe("C:\\Users\\test user\\.local\\share\\opencode\\mcp-auth.json");
  expect(processAuthPath({ XDG_DATA_HOME: "D:\\data" }, "win32")).toBe("D:\\data\\opencode\\mcp-auth.json");
  expect(processAuthPath({ HOME: "relative" }, "linux")).toBeUndefined();
});

test("symlink aliases identify the same credential file even before it exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-paths-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  await symlink(join(root, "data"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  expect(await sameAuthPath(join(root, "data/opencode/mcp-auth.json"), join(root, "alias/opencode/mcp-auth.json"))).toBe(true);
  expect(await sameAuthPath(join(root, "other/mcp-auth.json"), join(root, "alias/opencode/mcp-auth.json"))).toBe(false);
});

test("native ownership inspection blocks the same store and allows unrelated running engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ownership Übermittlung 🧪 with spaces-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, process.platform === "win32" ? "opencode-ownership.exe" : "opencode-ownership");
  await copyFile(process.execPath, executable);
  const data = join(root, "shared data");
  const child = spawn(executable, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    env: { ...process.env, XDG_DATA_HOME: data, LEGALWORK_INSPECTION_TEST_SECRET: "must-never-be-returned" }, stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await stopped;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Ownership child exited: ${code}`)));
    child.stdout.once("data", () => resolve());
  });
  if (!child.pid) throw new Error("Missing child PID");
  const source = join(data, "opencode/mcp-auth.json");
  expect(await processesUsingAuthPath([child.pid], source)).toBe(true);
  expect(await processesUsingAuthPath([child.pid], join(root, "unrelated/opencode/mcp-auth.json"))).toBe(false);
  expect(await legacyMcpQuiescent(new Set(), source)).toBe(false);
  expect(await legacyMcpQuiescent(new Set([child.pid]), source)).toBe(true);
  expect(await legacyMcpQuiescent(new Set(), join(root, "unrelated/opencode/mcp-auth.json"))).toBe(true);
}, 30_000);

test("exited processes do not prevent handover", async () => {
  expect(await processesUsingAuthPath([2147483647], join(tmpdir(), "missing/mcp-auth.json"))).toBe(false);
});
