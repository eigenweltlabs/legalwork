import type { StorageInput } from "@legalwork/types/file-storage";
import { oauthProvider } from "./oauth/providers.js";
import { tokenBindings } from "./oauth/session.js";
import { ApiError } from "../errors.js";
import { azureAdapter, gcsAdapter, s3Adapter } from "./object-storage.js";
import { smbAdapter } from "./smb.js";
import { ftpAdapter, sftpAdapter, webdavAdapter } from "./file-servers.js";
import { objectPrefix, providerError, type StorageAdapter } from "./common.js";

export async function withStorage<T>(
  input: StorageInput,
  operation: (adapter: StorageAdapter) => Promise<T>,
): Promise<T> {
  let adapter: StorageAdapter | undefined;
  try {
    if ("prefix" in input.config) objectPrefix(input.config.prefix);
    if ((input.config.kind === "sftp" || input.config.kind === "ftp") && !input.config.rootPath.startsWith("/"))
      throw new ApiError(400, "invalid_storage_root", "Use an absolute path for the storage root.");
    switch (input.config.kind) {
      case "oauth": {
        const token = tokenBindings.get(input);
        if (!token) throw new ApiError(401, "storage_signin_required", "Sign in to this connection in File storage settings.");
        adapter = await oauthProvider(input.config.provider).adapter(input.config, token);
        break;
      }
      case "smb":
        adapter = await smbAdapter(input);
        break;
      case "s3":
        adapter = s3Adapter(input);
        break;
      case "azure":
        adapter = azureAdapter(input);
        break;
      case "gcs":
        adapter = gcsAdapter(input);
        break;
      case "webdav":
        adapter = webdavAdapter(input);
        break;
      case "sftp":
        adapter = await sftpAdapter(input);
        break;
      case "ftp":
        adapter = await ftpAdapter(input);
        break;
    }
    return await operation(adapter);
  } catch (error) {
    throw providerError(error);
  } finally {
    await adapter?.close?.().catch(() => undefined);
  }
}
