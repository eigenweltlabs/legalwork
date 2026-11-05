import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("released global policy authority cannot be replaced by a later explicit config file", async () => {
  const root = await realpath(await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-policy-order-")));
  const plugin = join(root, "plugin"), workspace = join(root, "matter"), marker = join(root, "imported");
  await Promise.all([plugin, workspace, ...["home", "original-global", "protected-global", "data", "state", "cache"].map(name => join(root, name))].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(plugin, "index.js"), `import{writeFileSync}from'node:fs';import{Plugin}from'@opencode/plugin';writeFileSync(${JSON.stringify(marker)},'imported');export default Plugin.define({id:'fixture.preimport',setup(){}});`);
  const original = join(root, "original-global", "opencode.jsonc"), protection = join(root, "protected-global", "opencode.json");
  await writeFile(original, JSON.stringify({ plugins: [plugin], policies: [{ action: "integration.use", resource: "plugin:*", effect: "allow" }] }));
  await writeFile(protection, JSON.stringify({ policies: [{ action: "integration.use", resource: "plugin:*", effect: "deny" }] }));
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    for (const protectedFirst of [true, false]) {
      await rm(marker, { force: true });
      engine = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: workspace, timeoutMs: 30_000, env: {
        HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "unused-xdg-config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DB: join(root, `engine-${protectedFirst}.db`), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_CONFIG_DIR: join(root, protectedFirst ? "protected-global" : "original-global"), OPENCODE_CONFIG: protectedFirst ? original : protection,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
      } });
      const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
      await client.model.list({ location: { directory: workspace } });
      expect(existsSync(marker)).toBe(!protectedFirst);
      const entries = await client.config.get({ location: { directory: workspace } });
      expect(entries.filter(entry => entry.type === "document").map(entry => entry.path)).toContain(original);
      expect(entries.filter(entry => entry.type === "document").map(entry => entry.path)).toContain(protection);
      await engine.close(); engine = undefined;
    }
  } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}, 45_000);
