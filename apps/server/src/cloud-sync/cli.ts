import { parseCliArgs, resolveServerConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { assertSyncOffline } from "./lifecycle.js";
import { CloudReplica, readCloudSyncConfig } from "./replica.js";
import { syncPreferences } from "./settings.js";

export async function runCloudSyncCli(argv: string[]) {
  const [action, ...rest] = argv;
  if (!action || action === "--help") {
    console.log("legalwork-server sync <seed|restore|files|status> --sync-config <path> [--config <server.json>] [--replace] [--allow-deletions]");
    return;
  }
  if (!["seed", "restore", "files", "status"].includes(action)) throw new Error(`Unknown sync action: ${action}`);
  const index = rest.indexOf("--sync-config"), path = index >= 0 ? rest[index + 1] : process.env.LEGALWORK_CLOUD_SYNC_CONFIG;
  if (!path) throw new Error("Provide --sync-config or LEGALWORK_CLOUD_SYNC_CONFIG");
  const serverArgs = rest.filter((value, offset) => (index < 0 || offset !== index && offset !== index + 1) && value !== "--replace" && value !== "--allow-deletions");
  const config = await resolveServerConfig(parseCliArgs(serverArgs));
  const settings = await readCloudSyncConfig(path);
  if (action !== "status") await assertSyncOffline(config);
  // Seeding is an explicit offline handoff; normal desktop mode remains files.
  const replica = await CloudReplica.open(config, action === "seed" ? { ...settings, role: "executor" } : settings);
  try {
    if (action === "status") {
      const { value } = await replica.control();
      console.log(JSON.stringify({ owner: value.owner, expiresAt: value.expiresAt, checkpointAt: value.checkpointAt, nextRunAt: value.nextRunAt }, null, 2));
    } else if (action === "seed") {
      await replica.acquire();
      // Register private projects and reuse the existing sync before exporting.
      replica.settings.role = "files";
      await replica.syncFiles(rest.includes("--allow-deletions"));
      await syncPreferences(config, replica.objects);
      replica.settings.role = "executor";
      await replica.publishState();
      console.log("Personal assistant state and selected projects synced.");
    } else if (action === "restore") {
      await replica.acquire();
      await replica.restore(rest.includes("--replace"));
      await replica.syncFiles();
      await syncPreferences(config, replica.objects);
      console.log("Personal assistant state restored; project files load when requested.");
    } else {
      if (settings.role !== "files") throw new ApiError(409, "sync_files_role", "Use a files-role profile for this command.");
      await replica.syncFiles(rest.includes("--allow-deletions"));
      await syncPreferences(config, replica.objects);
      console.log("Selected project files and preferences synced.");
    }
  } finally { try { await replica.release(); } finally { replica.close(); } }
}
