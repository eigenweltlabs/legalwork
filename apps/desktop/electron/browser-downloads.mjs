import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Reserve a new file synchronously: Electron needs setSavePath during will-download.
function reserveDownload(projectRoot, suggestedName) {
  const root = realpathSync(projectRoot);
  const folder = path.join(root, "Downloads");
  mkdirSync(folder, { recursive: true });
  if (realpathSync(folder) !== folder) throw new Error("The project's Downloads folder must not be a symbolic link.");
  const name = path.basename(String(suggestedName).replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 160) || "download";
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 10000; index += 1) {
    const filename = index ? `${stem} (${index + 1})${extension}` : name;
    const destination = path.join(folder, filename);
    try {
      closeSync(openSync(destination, "wx", 0o600));
      return { path: destination, relativePath: `Downloads/${filename}`, name: filename };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not reserve a unique download filename.");
}

export function installBrowserDownloads(browserSession, findTab) {
  const handleDownload = (_event, item, webContents) => {
    const tab = findTab(webContents);
    if (!tab) return;
    const record = {
      id: randomUUID(), name: item.getFilename(), state: "progressing",
      receivedBytes: 0, totalBytes: item.getTotalBytes(),
      path: null, relativePath: null, error: null,
    };
    tab.downloads.push(record);
    try {
      if (!tab.downloadDirectory) throw new Error("This browser tab is not attached to a local project. Open it from a local project before downloading.");
      Object.assign(record, reserveDownload(tab.downloadDirectory, item.getFilename()));
      item.setSavePath(record.path);
    } catch (error) {
      record.state = "cancelled";
      record.error = error instanceof Error ? error.message : "Could not save the download in the project.";
      item.cancel();
      return;
    }
    item.on("updated", (_update, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
    });
    item.once("done", (_done, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      if (state !== "completed") record.error = `Download ${state}. The file may be incomplete.`;
    });
  };
  browserSession.on("will-download", handleDownload);
  return () => browserSession.removeListener("will-download", handleDownload);
}
