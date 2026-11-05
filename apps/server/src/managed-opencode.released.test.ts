import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { z } from "zod";
import { getCACertificates } from "node:tls";

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("released v2 startup authenticates and fully reaps the child before a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-managed-v2-"));
  const plugin = join(root, "native-system-ca-plugin"), marker = join(root, "native-trust.json");
  await mkdir(plugin);
  await writeFile(join(plugin, "index.js"), `import{writeFileSync}from'node:fs';import{getCACertificates}from'node:tls';export default{id:'fixture.native-system-ca',setup(){const system=getCACertificates('system'),defaults=new Set(getCACertificates('default'));writeFileSync(${JSON.stringify(marker)},JSON.stringify({flag:process.env.NODE_USE_SYSTEM_CA,bun:process.versions.bun,systemCount:system.length,defaultCount:defaults.size,bundledCount:getCACertificates('bundled').length,systemInDefaults:system.every(cert=>defaults.has(cert))}));}};`);
  const env = {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", plugins: [plugin] }), NODE_USE_SYSTEM_CA: "0",
  };
  await Promise.all(["home", "config", "data", "state", "cache"].map(name => mkdir(join(root, name), { recursive: true })));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Only the second run retains the host's OS trust/keychain HOME. All
      // OpenCode discovery, data and cache paths remain the private test home.
      const childEnv = attempt === 0 ? env : { ...env, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      const server = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: root, env: childEnv, timeoutMs: 30_000 });
      try {
        const client = OpenCode.make({ baseUrl: server.url, headers: { authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}` } });
        const info = await client.server.info();
        expect(info.version).toBe(await expectedOpencodeVersion(process.env.LEGALWORK_TEST_OPENCODE_BIN!));
        expect(server.pid).toBe(info.pid);
        await client.model.list({ location: { directory: root } });
        const trust = z.object({ flag: z.literal("1"), bun: z.string(), systemCount: z.number().int().nonnegative(), defaultCount: z.number().int().nonnegative(), bundledCount: z.number().int().nonnegative(), systemInDefaults: z.boolean() }).parse(JSON.parse(await readFile(marker, "utf8")));
        expect(trust.systemInDefaults).toBe(true);
        if (attempt === 1 && getCACertificates("system").length > 0) expect(trust.systemCount).toBeGreaterThan(0);
        const evidenceDirectory = process.env.LEGALWORK_NATIVE_CA_ACCEPTANCE_DIR;
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
          await writeFile(join(evidenceDirectory, `native-engine-trust-${attempt}.json`), JSON.stringify({ info, homeContext: attempt === 0 ? "isolated fixture OS home" : "normal host OS home; OpenCode data/discovery private", trust }, null, 2), { mode: 0o600 });
        }
        expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
        const authorization = `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`;
        const document = await fetch(server.url, { headers: { authorization } });
        expect(document.status).toBe(200);
        expect(document.headers.get("content-type")).toContain("text/html");
        const html = await document.text();
        const assetPath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
        expect(assetPath).toBeDefined();
        const assetUrl = new URL(assetPath!, server.url);
        expect(assetUrl.origin).toBe(new URL(server.url).origin);
        const asset = await fetch(assetUrl, { headers: { authorization } });
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain("javascript");
        expect((await asset.text()).length).toBeGreaterThan(0);
      } finally { await Promise.all([server.close(), server.close()]); }
      expect(server.running()).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
