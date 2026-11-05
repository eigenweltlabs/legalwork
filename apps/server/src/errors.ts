import type { ApiErrorBody } from "./types.js";
import { basename } from "node:path";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Keep a project filesystem failure actionable and scoped to that project. */
export function projectFileError(projectPath: string, error: unknown, platform: string = process.platform): ApiError {
  if (error instanceof ApiError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const errno = error instanceof Error && "errno" in error ? error.errno : undefined;
  const needsAuthentication = code === "ENEEDAUTH" || (platform === "darwin" && (
    code === "Unknown system error -81" || (code === undefined && errno === -81)
  ));
  const recovery = needsAuthentication
    ? "Your cloud storage provider requires authentication. Open your cloud storage app (for example Nextcloud or iCloud Drive), sign in, and retry."
    : `${reason}. Check the folder's permissions and, for cloud files, that your storage app is connected and the files are downloaded, then retry.`;
  return new ApiError(503, needsAuthentication ? "cloud_auth_required" : "project_files_unavailable",
    `Cannot access project "${basename(projectPath)}".\nFolder: ${projectPath}\n${recovery}`, { path: projectPath, reason });
}

/** The published engine client wraps fetch failures in ClientError.cause. */
export function findApiError(error: unknown): ApiError | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ApiError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

export function formatError(err: ApiError): ApiErrorBody {
  return {
    code: err.code,
    message: err.message,
    details: err.details,
  };
}
