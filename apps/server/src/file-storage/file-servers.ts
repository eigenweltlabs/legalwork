import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "webdav";
import SftpClient from "ssh2-sftp-client";
import { Client as FtpClient } from "basic-ftp";
import type { StorageInput } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import {
  boundedSink,
  checkCondition,
  collectStream,
  conflict,
  ensureFileSize,
  entry,
  hashVersion,
  missingAsNull,
  pageEntries,
  type StorageAdapter,
  type WriteCondition,
} from "./common.js";

const inRoot = (root: string, path: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
const denied = () =>
  new ApiError(403, "storage_path_outside_root", "This path resolves outside the configured storage folder.");

export async function localAdapter(input: StorageInput): Promise<StorageAdapter> {
  if (input.config.kind !== "local" || !isAbsolute(input.config.rootPath))
    throw new ApiError(400, "invalid_storage_root", "Choose an absolute folder path on the LegalWork server.");
  const root = await realpath(input.config.rootPath);
  if (!(await stat(root)).isDirectory())
    throw new ApiError(400, "invalid_storage_root", "Choose a folder for this storage.");
  const resolvePath = async (path: string, creating = false) => {
    const target = join(root, path);
    const actual = await realpath(creating ? dirname(target) : target);
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw denied();
    if (creating) {
      const existing = await missingAsNull(() => lstat(target));
      if (existing?.isSymbolicLink()) throw denied();
    }
    return target;
  };
  const read = async (path: string) => {
    const target = await resolvePath(path);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ApiError(400, "storage_not_a_file", "Choose a file.");
      ensureFileSize(info.size);
      const data = await collectStream(file.createReadStream({ autoClose: false }));
      return { data, size: data.length, version: hashVersion(data) };
    } finally {
      await file.close();
    }
  };
  const fileStat = (path: string) =>
    missingAsNull(async () => {
      const { data: _data, ...info } = await read(path);
      return info;
    });
  return {
    async list(path, cursor) {
      const dir = await resolvePath(path);
      const items = await readdir(dir, { withFileTypes: true });
      const page = pageEntries(
        items
          .filter((item) => item.isFile() || item.isDirectory())
          .map((item) => entry(path ? `${path}/${item.name}` : item.name, item.isDirectory() ? "folder" : "file")),
        cursor,
      );
      // Only stat the visible page; never inspect the contents of child folders.
      page.entries = await Promise.all(
        page.entries.map(async (item) => {
          const info = await lstat(join(root, item.path));
          return { ...item, size: item.kind === "file" ? info.size : null, modifiedAt: info.mtime.toISOString() };
        }),
      );
      return page;
    },
    stat: fileStat,
    read,
    async write(path, data, _contentType, condition) {
      const target = await resolvePath(path, true);
      await checkCondition(await fileStat(path), condition);
      if (condition.createOnly) {
        const handle = await open(target, "wx", 0o600);
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
        return;
      }
      const temporary = join(dirname(target), `.legalwork-${randomUUID()}.tmp`);
      try {
        const existing = await stat(target);
        const handle = await open(temporary, "wx", existing.mode & 0o777);
        try {
          await handle.writeFile(data);
          await handle.chmod(existing.mode & 0o777);
        } finally {
          await handle.close();
        }
        checkCondition(await fileStat(path), condition);
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
    async mkdir(path) {
      await mkdir(await resolvePath(path, true));
    },
  };
}

export function webdavAdapter(input: StorageInput): StorageAdapter {
  if (input.config.kind !== "webdav") throw new Error("Invalid WebDAV configuration");
  const client = createClient(input.config.endpoint, {
    username: input.config.username || undefined,
    password: input.secrets.password || undefined,
  });
  const remote = (path: string) => `/${path}`;
  const options = { signal: AbortSignal.timeout(60_000) };
  const fileStat = (path: string) =>
    missingAsNull(async () => {
      const result = await client.stat(remote(path), options);
      const info = "data" in result ? result.data : result;
      if (info.type !== "file") throw new ApiError(400, "storage_not_a_file", "Choose a file.");
      return { size: info.size, version: info.etag || "", contentType: info.mime };
    });
  return {
    async list(path, cursor) {
      const result = await client.getDirectoryContents(remote(path), { ...options, deep: false });
      const entries = result;
      return pageEntries(
        entries.map((item) =>
          entry(
            path ? `${path}/${item.basename}` : item.basename,
            item.type === "directory" ? "folder" : "file",
            item.type === "file" ? item.size : null,
            item.lastmod || null,
          ),
        ),
        cursor,
      );
    },
    stat: fileStat,
    async read(path) {
      const info = await fileStat(path);
      if (!info) throw new ApiError(404, "storage_not_found", "File not found.");
      ensureFileSize(info.size);
      const data = await collectStream(
        client.createReadStream(remote(path), {
          ...options,
          headers: info.version && !info.version.startsWith("W/") ? { "If-Match": quoteEtag(info.version) } : {},
        }),
      );
      return { ...info, data, size: data.length, version: info.version || `sha256:${hashVersion(data)}` };
    },
    async write(path, data, contentType, condition) {
      if (condition.version?.startsWith("sha256:") || condition.version?.startsWith("W/")) {
        throw new ApiError(
          409,
          "storage_version_unavailable",
          "This WebDAV server does not expose a strong ETag for safe editing. Upload a new file instead.",
        );
      }
      const result = await client.putFileContents(remote(path), data, {
        ...options,
        overwrite: !condition.createOnly,
        headers: {
          "Content-Type": contentType,
          ...(condition.version ? { "If-Match": quoteEtag(condition.version) } : {}),
          ...(condition.createOnly ? { "If-None-Match": "*" } : {}),
        },
      });
      if (!result) conflict();
    },
    async mkdir(path) {
      await client.createDirectory(remote(path), options);
    },
  };
}

function quoteEtag(etag: string) {
  return etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;
}

export async function sftpAdapter(input: StorageInput): Promise<StorageAdapter> {
  if (input.config.kind !== "sftp") throw new Error("Invalid SFTP configuration");
  const config = input.config;
  if (!input.secrets.password && !input.secrets.privateKey)
    throw new ApiError(400, "storage_credentials_required", "Provide an SFTP password or private key.");
  const fingerprint = config.hostFingerprint.startsWith("SHA256:")
    ? Buffer.from(config.hostFingerprint.slice(7), "base64").toString("hex")
    : config.hostFingerprint.toLowerCase();
  const client = new SftpClient();
  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: input.secrets.password || undefined,
      privateKey: input.secrets.privateKey || undefined,
      passphrase: input.secrets.passphrase || undefined,
      hostHash: "sha256",
      hostVerifier: (hash: string) => hash === fingerprint,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 2,
    });
    const root = await client.realPath(config.rootPath);
    if (!root || !posix.isAbsolute(root)) throw denied();
    const remote = async (path: string, creating = false) => {
      const target = posix.join(root, path);
      const actual = await client.realPath(creating ? posix.dirname(target) : target);
      if (!inRoot(root, actual)) throw denied();
      if (creating && (await client.exists(target)) === "l") throw denied();
      return target;
    };
    const read = async (path: string) => {
      const target = await remote(path);
      const info = await client.stat(target);
      if (!info.isFile) throw new ApiError(400, "storage_not_a_file", "Choose a file.");
      ensureFileSize(info.size);
      const sink = boundedSink();
      await client.get(target, sink.sink);
      const data = sink.data();
      return { data, size: data.length, version: hashVersion(data) };
    };
    const fileStat = async (path: string) => {
      if (!(await client.exists(posix.join(root, path)))) return null;
      const { data: _data, ...info } = await read(path);
      return info;
    };
    return {
      async list(path, cursor) {
        const items = await client.list(await remote(path));
        return pageEntries(
          items
            .filter((item) => item.type === "d" || item.type === "-")
            .map((item) =>
              entry(
                path ? `${path}/${item.name}` : item.name,
                item.type === "d" ? "folder" : "file",
                item.type === "-" ? item.size : null,
                new Date(item.modifyTime).toISOString(),
              ),
            ),
          cursor,
        );
      },
      stat: fileStat,
      read,
      async write(path, data, _contentType, condition) {
        const target = await remote(path, true);
        checkCondition(await fileStat(path), condition);
        const temporary = posix.join(posix.dirname(target), `.legalwork-${randomUUID()}.tmp`);
        try {
          await pipeline(Readable.from(data), client.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
          checkCondition(await fileStat(path), condition);
          if (condition.createOnly) await client.rename(temporary, target);
          else {
            await client.chmod(temporary, (await client.stat(target)).mode & 0o777);
            // OpenSSH's extension replaces the file atomically. If unsupported,
            // fail while preserving the original instead of truncating it.
            await client.posixRename(temporary, target);
          }
        } finally {
          await client.delete(temporary, true).catch(() => undefined);
        }
      },
      async mkdir(path) {
        await client.mkdir(await remote(path, true));
      },
      async close() {
        await client.end();
      },
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function ftpAdapter(input: StorageInput): Promise<StorageAdapter> {
  if (input.config.kind !== "ftp") throw new Error("Invalid FTP configuration");
  const config = input.config;
  // Bun 1.3.9 can silently truncate FTPS data streams. Verified with 2,000
  // repeated listings on 1.4.2; fail explicitly on older bundled runtimes.
  if (config.security !== "none" && typeof Bun !== "undefined" && Bun.semver.order(Bun.version, "1.4.2") < 0) {
    throw new ApiError(
      503,
      "storage_runtime_upgrade_required",
      "FTPS requires a LegalWork server built with Bun 1.4.2 or newer. Update the server, or use Bun 1.4.2+ when running from source.",
    );
  }
  const client = new FtpClient(30_000);
  try {
    await client.access({
      host: config.host,
      port: config.port,
      user: config.username,
      password: input.secrets.password,
      secure: config.security === "implicit" ? "implicit" : config.security === "tls",
    });
    await client.cd(config.rootPath);
    const root = await client.pwd();
    const parent = async (path: string) => {
      await client.cd(root);
      const folder = posix.dirname(path);
      if (folder !== ".") await client.cd(folder);
      if (!inRoot(root, await client.pwd())) throw denied();
      const name = posix.basename(path);
      const existing = (await client.list()).find((item) => item.name === name);
      if (existing?.isSymbolicLink) throw denied();
      return { name, existing };
    };
    const read = async (path: string) => {
      const { name, existing } = await parent(path);
      if (!existing?.isFile) throw new ApiError(404, "storage_not_found", "File not found.");
      ensureFileSize(existing.size);
      const sink = boundedSink();
      await client.downloadTo(sink.sink, name);
      const data = sink.data();
      return { data, size: data.length, version: hashVersion(data) };
    };
    const fileStat = (path: string) =>
      missingAsNull(async () => {
        const { data: _data, ...info } = await read(path);
        return info;
      });
    return {
      async list(path, cursor) {
        await client.cd(root);
        if (path) await client.cd(path);
        if (!inRoot(root, await client.pwd())) throw denied();
        const items = await client.list();
        return pageEntries(
          items
            .filter((item) => !item.isSymbolicLink && (item.isDirectory || item.isFile))
            .map((item) =>
              entry(
                path ? `${path}/${item.name}` : item.name,
                item.isDirectory ? "folder" : "file",
                item.isFile ? item.size : null,
                item.modifiedAt?.toISOString() ?? null,
              ),
            ),
          cursor,
        );
      },
      stat: fileStat,
      read,
      async write(path, data, _contentType, condition) {
        checkCondition(await fileStat(path), condition);
        const { name } = await parent(path);
        const temporary = `.legalwork-${randomUUID()}.tmp`;
        try {
          await client.uploadFrom(Readable.from(data), temporary);
          checkCondition(await fileStat(path), condition);
          await parent(path);
          await client.rename(temporary, name);
        } finally {
          await client.remove(temporary, true).catch(() => undefined);
        }
      },
      async mkdir(path) {
        const { name, existing } = await parent(path);
        if (existing) conflict();
        await client.send(`MKD ${name}`);
      },
      async close() {
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
