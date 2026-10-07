import type { ApiErrorBody } from "./types.js";
import type { ErrorDiagnostic } from "@legalwork/types/error-report";

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

export function formatError(err: ApiError, diagnostic?: ErrorDiagnostic): ApiErrorBody {
  return {
    code: err.code,
    message: err.message,
    details: err.details,
    ...(diagnostic ? { diagnostic } : {}),
  };
}
