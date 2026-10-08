import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";

const engineTokens = new WeakMap<ServerConfig, string>();
/** Mail-only capability for the local managed engine. Never serialize it or expose it to shared clients. */
export function localMailEngineToken(config: ServerConfig) {
  let token = engineTokens.get(config);
  if (!token) { token = randomBytes(32).toString("base64url"); engineTokens.set(config, token); }
  return token;
}
export function requireLocalMailEngine(config: ServerConfig, request: Request) {
  const actual = request.headers.get("X-LegalWork-Mail-Token") || "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!actual || !timingSafeEqual(digest(actual), digest(localMailEngineToken(config)))) throw new ApiError(403, "mail_local_engine_required", "Personal email is available only to your local LegalWork agent.");
}
