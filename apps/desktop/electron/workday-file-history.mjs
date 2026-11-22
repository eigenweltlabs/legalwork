import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { requestRecorderServer } from "./audio/recorder-server-request.mjs";

/** @type {(binary: string, args: string[], options: import("node:child_process").ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>} */
const run = promisify(execFile);
const limit = 200;
const document = /\.(?:docx?|odt|rtf|pdf|txt|md|xlsx?|ods|csv|pptx?|odp|pages|numbers|key)$/i;
// Foundation reports the selected volume's locality, including mounted network shares.
const macVolumeLocality = `ObjC.import("Foundation");
function run(argv) {
  const value = Ref();
  if (!$.NSURL.fileURLWithPath(argv[0]).getResourceValueForKeyError(value, $.NSURLVolumeIsLocalKey, null)) return "unknown";
  return value[0].boolValue ? "local" : "remote";
}`;
const powershell = `
$ErrorActionPreference='Stop'
$folder = [Environment]::GetFolderPath('Recent')
$shell = New-Object -ComObject Shell.Application
$recent = $shell.Namespace($folder)
$rows = @()
$candidates = 0
$limited = $false
if (([IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:LEGALWORK_HISTORY_DIRECTORY))).DriveType -eq 'Network') { throw 'Choose a local folder' }
if (!$recent) { throw 'Recent file metadata is unavailable' }
foreach ($item in $recent.Items()) {
  if (++$candidates -gt 500) { $limited = $true; break }
  if ([IO.Path]::GetExtension($item.Path) -ne '.lnk') { continue }
  $target = $item.ExtendedProperty('System.Link.TargetParsingPath')
  if (!$target -or ![IO.Path]::IsPathRooted($target) -or $target.StartsWith('\\\\')) { continue }
  if (![string]::Equals([IO.Path]::GetDirectoryName($target), $env:LEGALWORK_HISTORY_DIRECTORY, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $visit = $item.ExtendedProperty('System.Link.DateVisited')
  if ($visit -isnot [datetime]) { continue }
  $rows += @{ name = [IO.Path]::GetFileName($target); observedAt = $visit.ToUniversalTime().ToString('o') }
  if ($rows.Count -ge 200) { $limited = $true; break }
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
ConvertTo-Json -Compress -Depth 3 -InputObject @{ entries = @($rows); limited = $limited }
`;

export function validDay(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date + "T12:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(date);
}

function safeDocument(name) {
  return typeof name === "string" && name.length <= 240 && document.test(name) &&
    !name.startsWith(".") && !name.startsWith("~$") && !/[\p{Cc}\p{Cf}\\/:]/u.test(name);
}
export function normalizeHistory(entries, date, zone) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const unique = new Map();
  for (const row of entries) {
    if (!safeDocument(row?.name) || typeof row.observedAt !== "string") continue;
    const ms = Date.parse(row.observedAt);
    if (!Number.isFinite(ms) || day.format(ms) !== date) continue;
    const observedAt = new Date(ms).toISOString();
    unique.set(JSON.stringify([row.name, observedAt]), { name: row.name, observedAt });
  }
  return [...unique.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.name.localeCompare(b.name));
}

/** Inspect metadata only for regular documents immediately inside the chosen local directory. */
export async function collectFileHistory(folder, date, { platform = process.platform, zone = Intl.DateTimeFormat().resolvedOptions().timeZone, execute = run } = {}) {
  if (!validDay(date) || !["darwin", "win32"].includes(platform)) throw Error("Unavailable file history");
  if (platform === "win32" && folder.startsWith("\\\\")) throw Error("Choose a local folder");
  if (!(await lstat(folder)).isDirectory()) throw Error("Choose a directory");
  const root = await realpath(folder);
  if (root === path.parse(root).root || root === homedir() || root === path.dirname(homedir())) throw Error("Choose a specific folder");
  const rows = [];
  let limited = false;
  if (platform === "darwin") {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", macVolumeLocality, "--", root],
      { encoding: "utf8", timeout: 2000, maxBuffer: 2048 });
    if (stdout.trim() !== "local") throw Error("Choose a local folder");
    const dir = await opendir(root);
    let checked = 0;
    const names = [];
    for await (const entry of dir) {
      if (++checked > 500 || names.length >= limit) { limited = true; break; }
      if (entry.isFile() && safeDocument(entry.name)) names.push(entry.name);
    }
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(names.slice(i, i + 8).map(async name => {
        const file = path.join(root, name);
        const before = await lstat(file).catch(() => null);
        if (!before?.isFile() || await realpath(file).catch(() => "") !== file) return;
        const metadata = await execute("/usr/bin/mdls", ["-raw", "-name", "kMDItemLastUsedDate", file],
          { encoding: "utf8", timeout: 2000, maxBuffer: 2048 }).catch(error => { if (error.code === 1) return null; throw error; });
        const after = await lstat(file).catch(() => null);
        if (metadata && after?.isFile() && after.dev === before.dev && after.ino === before.ino) rows.push({ name, observedAt: metadata.stdout.replace(/\0+$/, "").trim() });
      }));
    }
  } else {
    // The Shell may still know paths under a directory we cannot currently open.
    // Require directory access before querying Recent Items.
    const dir = await opendir(root);
    await dir.close();
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const binary = path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await execute(binary, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(powershell, "utf16le").toString("base64")],
      { env: { ...process.env, LEGALWORK_HISTORY_DIRECTORY: root }, encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 160000 });
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.entries)) throw Error("Invalid recent document metadata");
    limited = parsed.limited === true;
    for (const row of parsed.entries.slice(0, limit)) {
      if (!safeDocument(row.name)) continue;
      const target = path.join(root, row.name);
      // Do not follow a junction, symlink or shortcut from the selected folder.
      const resolved = await realpath(target).catch(() => "");
      if (resolved && !path.relative(target, resolved) && (await lstat(target).catch(() => undefined))?.isFile()) rows.push(row);
    }
  }
  return { platform, date, entries: normalizeHistory(rows, date, zone).slice(0, limit), limited };
}

export async function importWorkdayFileHistory({ info, profileId, date, choose, collect = collectFileHistory, request = requestRecorderServer }) {
  if (!validDay(date) || !info?.running || !info.hostToken || !info.baseUrl) throw Error("Private desktop history unavailable");
  const url = new URL(info.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("A local server is required");
  if (date > new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())) throw Error("Choose a past or current date");
  const endpoint = "/private-timesheet/desktop-history?profileId=" + encodeURIComponent(profileId);
  const preflight = () => request(info, endpoint, undefined, AbortSignal.timeout(4000));
  const initial = await preflight();
  if (!Number.isSafeInteger(initial?.epoch) || initial.epoch < 0) throw Error("Desktop history settings unavailable");
  const directory = await choose();
  if (!directory) return null;
  if ((await preflight()).epoch !== initial.epoch) throw Error("Desktop history settings changed");
  const evidence = await collect(directory, date);
  const result = await request(info, endpoint, { ...evidence, epoch: initial.epoch }, AbortSignal.timeout(8000));
  return { imported: result.imported, matched: evidence.entries.length, limited: evidence.limited };
}
