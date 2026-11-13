import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAC_COPY_FILES = `
ObjC.import('AppKit');
function run(paths) {
  const urls = $.NSMutableArray.alloc.init;
  paths.forEach(path => urls.addObject($.NSURL.fileURLWithPath($(path))));
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects(urls)) throw new Error('Could not copy files');
}
`;

/** Put real file references on the OS clipboard; no files are moved or read into memory.
 * @param {string[]} paths
 * @param {Pick<import('electron').Clipboard, 'writeBuffer'>} clipboard
 * @param {{ platform?: NodeJS.Platform; run?: (command: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<unknown> }} [options]
 */
export async function copyFilesToClipboard(paths, clipboard, { platform = process.platform, run = execute } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(item => typeof item !== "string" || !path.isAbsolute(item) || item.includes("\0"))) {
    throw new Error("Choose up to 100 local files or folders to copy.");
  }
  const files = [...new Set(paths)];
  // Validate the entire selection before replacing the clipboard.
  await Promise.all(files.map(async file => {
    const info = await stat(file);
    if (!info.isFile() && !info.isDirectory()) throw new Error("Only files and folders can be copied.");
  }));
  if (platform === "darwin") {
    // Paths are arguments, never interpolated into executable source.
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_COPY_FILES, ...files], { timeout: 5000, windowsHide: true });
  } else if (platform === "win32") {
    const data = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$items = New-Object System.Collections.Specialized.StringCollection
foreach ($file in $paths) { [void]$items.Add($file) }
[System.Windows.Forms.Clipboard]::SetFileDropList($items)`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 10000, windowsHide: true });
  } else if (platform === "linux") {
    clipboard.writeBuffer("text/uri-list", Buffer.from(files.map(file => pathToFileURL(file).href).join("\r\n") + "\r\n"));
  } else throw new Error("File copying is unavailable on this platform.");
}
