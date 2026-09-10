import { Client, SmbAuthError } from "smb3-client";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { StorageInput } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import {
  checkCondition,
  collectStream,
  entry,
  hashVersion,
  missingAsNull,
  pageEntries,
  receiveFile,
  sourceStream,
  storagePath,
  unsupportedSearch,
  type StorageAdapter,
  type WriteCondition,
} from "./common.js";

const REPARSE_POINT = 0x400;
export function smbPath(path: string) {
  storagePath(path);
  if (
    path
      .split("/")
      .some(
        (part) =>
          part &&
          (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
      )
  ) {
    throw new ApiError(400, "invalid_storage_path", "Use a valid Windows file or folder name.");
  }
  return path;
}

export async function smbAdapter(input: StorageInput): Promise<StorageAdapter> {
  if (input.config.kind !== "smb") throw new Error("Invalid SMB configuration");
  const config = input.config;
  if (!input.secrets.password)
    throw new ApiError(400, "storage_credentials_required", "Provide the network share password.");
  const client = new Client({
    ...config,
    password: input.secrets.password,
    signing: "required",
    connectTimeout: 10_000,
    requestTimeout: 30_000,
  });
  try {
    await client.connect();
    const prefix = smbPath(config.prefix.replace(/\/$/, ""));
    const root = [smbPath(config.share), prefix].filter(Boolean).join("/");
    // Never traverse junctions or symbolic links beyond the selected share/folder.
    const remote = async (path: string, creating = false) => {
      const target = [root, smbPath(path)].filter(Boolean).join("/");
      const parts = target.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const info = await missingAsNull(() => client.stat(parts.slice(0, i).join("/"), { followSymlinks: false }));
        if (!info && creating && i === parts.length) break;
        if (!info) throw new ApiError(404, "storage_not_found", "File or folder not found.");
        if (info.attributes & REPARSE_POINT)
          throw new ApiError(403, "storage_path_outside_root", "Links outside the selected folder cannot be opened.");
        if (i < parts.length && !info.isDirectory) throw new ApiError(400, "storage_not_a_folder", "Choose a folder.");
      }
      return target;
    };
    const download = async (path: string, destination?: string) => {
      const received = await receiveFile(client.createReadStream(await remote(path)), destination);
      return { ...received, version: received.sha256 };
    };
    const fileStat = (path: string) => missingAsNull(() => download(path));
    const list = async (path: string, cursor?: string, pattern = "*") => {
      const items = await client.readdir(await remote(path), { withFileTypes: true, pattern });
      return pageEntries(
        items
          .filter((item) => !(item.attributes & REPARSE_POINT))
          .map((item) => entry(path ? `${path}/${item.name}` : item.name, item.isDirectory() ? "folder" : "file")),
        cursor,
      );
    };
    const upload = async (path: string, source: Buffer | string, _contentType: string, condition: WriteCondition) => {
      const target = await remote(path, true);
      checkCondition(await fileStat(path), condition);
      const temporary = posix.join(posix.dirname(target), `.legalwork-${randomUUID()}.tmp`);
      try {
        await pipeline(sourceStream(source), client.createWriteStream(temporary, { exclusive: true }));
        await remote(path, true);
        checkCondition(await fileStat(path), condition);
        // SMB rename keeps the original intact until upload completes. No replace for creates.
        await client.rename(temporary, target, { replace: !condition.createOnly });
      } finally {
        await client.rm(temporary).catch(() => undefined);
      }
    };
    return {
      list,
      stat: fileStat,
      download,
      write: upload,
      upload,
      async read(path) {
        const data = await collectStream(client.createReadStream(await remote(path)));
        return { data, size: data.length, version: hashVersion(data) };
      },
      async searchCapabilities() {
        return { modes: ["name"], pagination: true, scope: "folder" };
      },
      async search(input) {
        if (input.mode !== "name") unsupportedSearch();
        // SMB QUERY_DIRECTORY performs matching remotely, in this directory only.
        if (/[<>:"/\\|?*\x00-\x1f]/.test(input.query))
          throw new ApiError(
            400,
            "invalid_storage_search",
            "Search for part of a file or folder name without wildcards.",
          );
        return { ...(await list(input.path, input.cursor, `*${input.query}*`)), scope: "folder", path: input.path };
      },
      async mkdir(path) {
        await client.mkdir(await remote(path, true));
      },
      async close() {
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof SmbAuthError)
      throw new ApiError(
        403,
        "storage_access_denied",
        "Could not sign in to this network share. Check the account, password, domain, and required encryption.",
      );
    throw error;
  }
}
