import { createHmac, randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError } from "./errors.js";
import type { Actor } from "./types.js";
import { hashToken, tokensMatch } from "./utils.js";

/** Shared only through the current user's private, locally installed manifest. */
export async function loadOfficeConnectionToken(keyPath?: string): Promise<string> {
  const directory = keyPath ? dirname(keyPath) : join(homedir(), ".office-addin-dev-certs");
  const path = join(directory, "office-connection.token");
  try {
    return validToken(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString("hex")}`;
  await writeFile(temporary, randomBytes(48).toString("base64url"), { flag: "wx", mode: 0o600 });
  try {
    // Publish only complete contents; concurrent desktop/server starts agree.
    await link(temporary, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    await unlink(temporary);
  }
  return validToken(await readFile(path, "utf8"));
}

function validToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{64}$/.test(token)) throw new Error("Invalid local Office connection credential");
  return token;
}

/** Office credentials survive desktop restarts and remain bound to their origin. */
export class OfficeConnectionService {
  private disposed = false;

  constructor(private installationToken?: string) {}

  private origin(request: Request): string {
    const url = new URL(request.url);
    const authority = request.headers.get("host") ?? url.host;
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) {
      throw new ApiError(403, "office_origin_forbidden", "Office requires a loopback host");
    }
    const origin = new URL(`${url.protocol}//${authority}`).origin;
    const supplied = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if ((supplied !== null && supplied !== origin) || (site && site !== "same-origin" && site !== "none")) {
      throw new ApiError(403, "office_origin_forbidden", "Office requires the add-in's own origin");
    }
    return origin;
  }

  installationCredential(): string {
    if (!this.installationToken || this.disposed) throw new ApiError(401, "office_connection_invalid", "Office is not connected");
    return this.installationToken;
  }

  private token(origin: string): string {
    return "office_" + createHmac("sha256", this.installationCredential()).update(origin).digest("base64url");
  }

  connect(request: Request, existingClient = false) {
    const origin = this.origin(request);
    const supplied = request.headers.get("x-legalwork-office-launch");
    if (!existingClient && (!supplied || !this.installationToken || !tokensMatch(supplied, this.installationToken))) {
      throw new ApiError(401, "office_connection_invalid", "Open the installed LegalWork add-in");
    }
    return { token: this.token(origin) };
  }

  actor(request: Request, host = false): Actor | undefined {
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token?.startsWith("office_")) return undefined;
    if (!tokensMatch(token, this.token(this.origin(request)))) {
      throw new ApiError(401, "office_connection_invalid", "Open the installed LegalWork add-in");
    }
    const path = new URL(request.url).pathname;
    if (host && !(request.method === "POST" && (
      path === "/workspaces/pick-folder" || path === "/workspaces/local" ||
      /^\/workspaces\/[^/]+\/activate$/.test(path) || path === "/voice/realtime/call"
    )) && !(request.method === "GET" && path === "/voice/realtime/capability")) {
      throw new ApiError(403, "office_scope_forbidden", "This operation requires the LegalWork desktop owner");
    }
    return { type: "remote", clientId: "Office add-in", scope: "collaborator", tokenHash: hashToken(token) };
  }

  dispose(): void {
    this.disposed = true;
  }
}
