// Failure-only synthetic package-test evidence. Never copy profile/config/DB
// contents: retain metadata and scrubbed, explicitly named application logs.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scrubSecrets } from "../electron/support-bundle.mjs";

const sensitiveKey = /password|token|secret|credential|authorization|api[-_]?key|cookie|^auth$/i;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function credentials(value, found) {
  if (!value || typeof value !== "object") return;
  if (typeof value.username === "string" && typeof value.password === "string") {
    found.add(Buffer.from(`${value.username}:${value.password}`).toString("base64"));
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && typeof item === "string" && item) found.add(item);
    else credentials(item, found);
  }
}

export function scrubStartupText(text, secrets = []) {
  let value = String(text ?? "");
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const encoded of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))
      value = value.split(encoded).join("<redacted>");
  }
  return scrubSecrets(value)
    .replace(/\b((?:set-cookie|cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/((?:username|user_name)["']?\s*[:=]\s*)(["']?)[^"'\s,;}]+\2/gi, "$1$2<redacted>$2");
}

async function regularFile(file) {
  try {
    const info = await lstat(file);
    return { path: file, exists: true, regularFile: info.isFile(), symlink: info.isSymbolicLink(), device: info.dev, inode: info.ino,
      size: info.size, mtime: info.mtime.toISOString() };
  } catch (error) {
    return { path: file, exists: false, error: error.code ?? error.name };
  }
}

const applicationLogs = ["main.log", "main.old.log", "runtime-boot-failure.log", "chromium-startup.log"];
export async function snapshotStartupLogs(directories) {
  return Promise.all([...new Set(directories)].flatMap(directory => applicationLogs.map(name => regularFile(path.join(directory, name)))));
}

function ownedProcesses(appPid, registeredPids) {
  let rows;
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
    rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5000 }));
    rows = (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name }));
  } else {
    rows = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,comm="], { encoding: "utf8", timeout: 5000 }).trim().split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), state: match[3], name: match[4] }] : [];
    });
  }
  const owned = new Set([appPid, ...registeredPids].filter(pid => Number.isSafeInteger(pid) && pid > 0));
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parentPid)) owned.add(row.pid);
  }
  return rows.filter(row => owned.has(row.pid));
}

function ownedWindows(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1) return [];
  // Inspect only the still-live launched synthetic main process. Do not read other
  // applications' window text, command lines, environment or profile contents.
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]${pid})
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$result = @($windows | ForEach-Object {
  [PSCustomObject]@{
    pid = $_.Current.ProcessId
    title = $_.Current.Name
    className = $_.Current.ClassName
    controls = @($_.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition) | ForEach-Object {
      [PSCustomObject]@{ name = $_.Current.Name; controlType = $_.Current.ControlType.ProgrammaticName }
    })
  }
})
ConvertTo-Json -Depth 5 -Compress -InputObject $result`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5000 }));
}

export async function collectStartupFailure({ artifactDirectory, root, userData, runtime, logDirectories,
  logBaseline, child, output, milestones, startedAt, failure, selection, processSnapshot = ownedProcesses, windowSnapshot = ownedWindows }) {
  const names = [
    path.join(userData, "legalwork-ui-control.json"), path.join(userData, "legalwork-server-tokens.json"),
    path.join(userData, "legalwork-server-state.json"), path.join(runtime, "server.json"),
    path.join(runtime, "desktop-bootstrap.json"), path.join(runtime, "runtime.db"), path.join(runtime, "runtime.db-wal"),
    path.join(runtime, "opencode.db"), path.join(runtime, "opencode.db-wal"),
    ...["service.json", "service-legalwork.json"].map(name => path.join(runtime, "engine-home", "state", "opencode", name)),
  ];
  const secrets = new Set(), registeredPids = [], states = [];
  for (const file of names) {
    const info = await regularFile(file);
    states.push(info);
    if (!info.regularFile || !file.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      credentials(value, secrets);
      if (/service(?:-legalwork)?\.json$/.test(file) && Number.isSafeInteger(value.pid) && value.pid > 0)
        registeredPids.push(value.pid);
    } catch { /* The metadata still records a missing/incomplete file. */ }
  }
  const scrub = text => scrubStartupText(text, secrets);
  const directory = path.join(artifactDirectory, `${process.platform}-${process.arch}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logs = [];
  for (const logDirectory of [...new Set(logDirectories)]) {
    for (const name of applicationLogs) {
      const source = path.join(logDirectory, name), info = await regularFile(source);
      if (!info.regularFile || Date.parse(info.mtime) < startedAt) { logs.push({ ...info, retained: false }); continue; }
      // Rotation can rename main.log to main.old.log. Match inode/device
      // across all prelaunch names, and never include its prelaunch bytes.
      const previous = logBaseline.find(item => item.regularFile && item.device === info.device && item.inode === info.inode);
      const offset = previous?.size ?? 0;
      if (offset > info.size) { logs.push({ ...info, retained: false, reason: "prelaunch-file-truncated" }); continue; }
      const original = await readFile(source);
      const bytes = Buffer.from(scrub(original.subarray(offset).toString("utf8")));
      const destination = `application-${logs.length}-${name}`;
      await writeFile(path.join(directory, destination), bytes, { mode: 0o600, flag: "wx" });
      logs.push({ ...info, retained: true, offset, destination, redactedBytes: bytes.length, redactedSha256: digest(bytes) });
    }
  }
  const consoleOutput = scrub(output);
  await writeFile(path.join(directory, "stdio.log"), consoleOutput, { mode: 0o600, flag: "wx" });
  let processes;
  try { processes = processSnapshot(child.pid, registeredPids); }
  catch (error) { processes = { unavailable: true, error: scrub(error.message) }; }
  let windows;
  try { windows = child.exitCode === null && child.signalCode === null && !child.killed
    ? windowSnapshot(child.pid) : { skipped: true, reason: "synthetic-main-process-not-live" }; }
  catch (error) { windows = { unavailable: true, error: scrub(error.message) }; }
  const summary = { schemaVersion: 1, scope: "Synthetic package-test failure only; no profile, database, cookie or config contents copied",
    platform: process.platform, architecture: process.arch, sourceCommit: process.env.GITHUB_SHA ?? null,
    collectedAt: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
    failure: scrub(failure?.stack ?? failure), root, selection, milestones,
    child: { pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed },
    states, logs, processes, windows, stdio: { file: "stdio.log", redactedBytes: Buffer.byteLength(consoleOutput), redactedSha256: digest(consoleOutput) } };
  const clean = value => typeof value === "string" ? scrub(value) : Array.isArray(value) ? value.map(clean)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitiveKey.test(key) && typeof item === "string" ? "<redacted>" : clean(item)])) : value;
  await writeFile(path.join(directory, "diagnostics.json"), JSON.stringify(clean(summary), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { directory, consoleOutput };
}
