import { Template, waitForFile } from "e2b";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const assets = process.env.LEGALWORK_TEMPLATE_ASSETS;
if (!assets || !existsSync(resolve(assets, "legalwork-server"))) throw new Error("Set LEGALWORK_TEMPLATE_ASSETS to the prepared template directory");
if (!process.env.E2B_API_URL || !process.env.E2B_API_KEY_FILE) throw new Error("E2B_API_URL and E2B_API_KEY_FILE are required; no managed cloud fallback");
const template = Template({ fileContextPath: assets }).fromTemplate("base").setUser("root")
  .runCmd("mkdir -p /opt/legalwork /data/home /data/projects/Assistant")
  .copy("legalwork-server", "/opt/legalwork/legalwork-server", { mode: 0o755 })
  .copy("cli.js", "/opt/legalwork/cli.js")
  .copy("bun", "/opt/legalwork/bun", { mode: 0o755 })
  .copy("opencode", "/usr/local/bin/opencode", { mode: 0o755 })
  .copy("opencode-plugins", "/opt/legalwork/opencode-plugins")
  .copy("ocr", "/opt/legalwork/resources/ocr")
  // Embed stages COPY extraction in guest /tmp (tmpfs). Unpack the native
  // runtime directly on the disk to avoid doubling its size in guest RAM.
  .copy("native-deps.tar.gz", "/opt/legalwork/native-deps.tar.gz")
  .runCmd("tar -xzf /opt/legalwork/native-deps.tar.gz -C /opt/legalwork && rm /opt/legalwork/native-deps.tar.gz")
  .copy("start-worker.sh", "/opt/legalwork/start-worker.sh", { mode: 0o755 })
  .runCmd("touch /opt/legalwork/installed")
  .setStartCmd("/opt/legalwork/start-worker.sh", waitForFile("/opt/legalwork/installed"));
const result = await Template.build(template, process.env.E2B_LEGALWORK_TEMPLATE ?? "legalwork-sync-v1", {
  cpuCount: 2, memoryMB: 4096, minFreeDiskMb: 8192,
  apiUrl: process.env.E2B_API_URL,
  apiKey: readFileSync(process.env.E2B_API_KEY_FILE, "utf8").trim(),
  onBuildLogs: entry => console.log(String(entry)),
});
console.log(JSON.stringify(result));
