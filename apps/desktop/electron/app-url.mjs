// Recognises LegalWork's own app documents, and guards IPC so only those
// documents can use the desktop bridge. Pure helpers so they can be tested
// without Electron.
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns `isAppUrl(url)`: true for the dev server origin when one is set,
 * otherwise for file URLs inside `appRoot` (the folder holding index.html).
 * @param {{ devServerUrl?: string, appRoot: string, pathApi?: import("node:path").PlatformPath }} options
 * @returns {(url: string | null | undefined) => boolean}
 */
export function createAppUrlMatcher({ devServerUrl, appRoot, pathApi = path }) {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  return function isAppUrl(url) {
    let target;
    try {
      target = new URL(String(url ?? ""));
    } catch {
      return false;
    }
    if (devOrigin) return target.origin === devOrigin;
    if (target.protocol !== "file:") return false;
    let filePath;
    try {
      filePath = fileURLToPath(target, { windows: pathApi === path.win32 });
    } catch {
      return false;
    }
    const relative = pathApi.relative(appRoot, filePath);
    return relative !== "" && !pathApi.isAbsolute(relative) && relative.split(pathApi.sep)[0] !== "..";
  };
}

/**
 * Wraps ipcMain so every handler only runs for senders whose frame URL passes
 * `isTrustedUrl`. Channels in `openChannels` accept any sender.
 * @param {{
 *   handle: import("electron").IpcMain["handle"],
 *   on: (channel: string, listener: Parameters<import("electron").IpcMain["on"]>[1]) => unknown,
 * }} ipcMain
 * @param {{
 *   isTrustedUrl: (url: string | null | undefined) => boolean,
 *   openChannels?: string[],
 *   onRejected?: (channel: string, event: import("electron").IpcMainEvent | import("electron").IpcMainInvokeEvent) => void,
 * }} options
 */
export function guardIpcMain(ipcMain, { isTrustedUrl, openChannels = [], onRejected = () => {} }) {
  const open = new Set(openChannels);
  /** @param {string} channel @param {import("electron").IpcMainEvent | import("electron").IpcMainInvokeEvent} event */
  const trusted = (channel, event) => open.has(channel) || isTrustedUrl(event?.senderFrame?.url);
  return {
    /** @type {import("electron").IpcMain["handle"]} */
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!trusted(channel, event)) {
          onRejected(channel, event);
          throw new Error(`Refused ${channel} from a page outside LegalWork`);
        }
        return listener(event, ...args);
      });
    },
    /** @param {string} channel @param {Parameters<import("electron").IpcMain["on"]>[1]} listener */
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!trusted(channel, event)) {
          onRejected(channel, event);
          return;
        }
        listener(event, ...args);
      });
    },
  };
}
