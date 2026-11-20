import { createHash } from "node:crypto";
import { eigenweltConnectionIdentityUrl } from "./eigenwelt-endpoints.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import type { ServerConfig } from "./types.js";

export async function launcherDraftAccount(config: ServerConfig) {
  const connection = await readEigenweltConnection(config);
  const account = connection.account;
  const identity = account ? [eigenweltConnectionIdentityUrl(connection), account.orgId, account.userId] : ["signed-out"];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
