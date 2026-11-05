import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
async function stage(root, native = false) {
  const source = await readFile(
    new URL("./catalog-observer.mjs", import.meta.url),
    "utf8",
  );
  const staged = source
    .replace(
      'from "effect"',
      native
        ? 'from "effect"'
        : `from ${JSON.stringify(pathToFileURL(require.resolve("effect")).href)}`,
    )
    .replace(
      'from "zod/v4/core"',
      `from ${JSON.stringify(require.resolve("zod/v4/core"))}`,
    );
  const directory = join(root, "observer");
  await mkdir(directory, { recursive: true });
  const input = join(directory, "source.mjs");
  const path = join(directory, "index.mjs");
  await writeFile(input, staged, { mode: 0o600 });
  if (native)
    execFileSync(
      "bun",
      [
        "build",
        input,
        "--target=node",
        "--format=esm",
        "--external=effect",
        `--outfile=${path}`,
      ],
      { stdio: "pipe" },
    );
  else await writeFile(path, staged, { mode: 0o600 });
  return path;
}
test("observer registers only read-only RPC and preserves nested schema definitions and full descriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lw-observer-schema-"));
  try {
    const plugin = (await import(pathToFileURL(await stage(root)).href))
      .default;
    const { Schema } = await import(
      pathToFileURL(require.resolve("effect")).href
    );
    const { z } = await import(pathToFileURL(require.resolve("zod")).href);
    const recursive = Schema.Struct({ label: Schema.String }).annotate({
      identifier: "CompleteRecord",
    });
    const description = "description ".repeat(15000) + "SCHEMA-TAIL";
    let definition;
    let handlers;
    let disposed = false;
    const cleanup = await plugin.setup({
      location: { directory: "/synthetic" },
      rpc: {
        register: async (def, impl) => {
          definition = def;
          handlers = impl;
          return {
            dispose() {
              disposed = true;
            },
          };
        },
      },
      tool: {
        list: async () => [
          {
            id: "effect",
            name: "effect-tool",
            description,
            input: Schema.Struct({ record: recursive }),
          },
          {
            id: "standard",
            name: "standard-tool",
            input: {
              "~standard": {
                jsonSchema: {
                  input: () => ({
                    type: "object",
                    $defs: { Complete: { type: "string" } },
                    properties: { tail: { $ref: "#/$defs/Complete" } },
                  }),
                },
              },
            },
          },
          {
            id: "zod",
            name: "zod-tool",
            input: z.object({ tail: z.string() }),
          },
        ],
      },
    });
    const catalog = await handlers.catalog();
    assert.deepEqual(Object.keys(definition.methods), ["catalog"]);
    assert.deepEqual(definition.events, {});
    assert.equal(catalog.observer.mutatesEngine, false);
    assert.equal(catalog.tools[0].description, description);
    assert.equal(
      catalog.tools[0].input.$defs.CompleteRecord.properties.label.type,
      "string",
    );
    assert.equal(catalog.tools[1].input.$defs.Complete.type, "string");
    assert.equal(catalog.tools[2].input.properties.tail.type, "string");
    cleanup();
    assert.equal(disposed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "released native engine loads observer and exposes complete catalog without model inference",
  { skip: !process.env.LEGALWORK_TEST_OPENCODE_BIN, timeout: 45000 },
  async () => {
    const binary = resolve(process.env.LEGALWORK_TEST_OPENCODE_BIN);
    const root = await mkdtemp(join(tmpdir(), "lw-observer-host-"));
    let child;
    let exited;
    let output = "";
    try {
      for (const name of [
        "home",
        "config",
        "data",
        "cache",
        "state",
        "tmp",
        "workspace",
      ])
        await mkdir(join(root, name));
      const pluginPath = await stage(root, true);
      await writeFile(
        join(root, "config", "opencode.json"),
        JSON.stringify({
          plugins: [join(root, "observer")],
          update: "disable",
        }),
      );
      const password = randomBytes(32).toString("hex");
      const env = {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        TMPDIR: join(root, "tmp"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        OPENCODE_CONFIG_DIR: join(root, "config"),
        OPENCODE_DB: join(root, "data", "engine.db"),
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugins: [join(root, "observer")],
          update: "disable",
        }),
      };
      child = spawn(
        binary,
        ["serve", "--hostname", "127.0.0.1", "--port", "0"],
        {
          cwd: join(root, "workspace"),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      // Explicit startup-only watchdog. No agent is admitted and no provider credentials are inherited.
      const startupDeadline = Date.now() + 30000;
      let base;
      while (Date.now() < startupDeadline) {
        base = /^server listening on (https?:\/\/[^\s]+)/m.exec(output)?.[1];
        if (base) break;
        if (child.exitCode !== null)
          throw new Error(
            "engine startup failed: " +
              output.replaceAll(password, "[private]"),
          );
        await delay(30);
      }
      assert.ok(base, "engine readiness watchdog expired");
      const query = new URLSearchParams({
        "location[directory]": join(root, "workspace"),
      });
      const headers = {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      };
      await fetch(`${base}/api/model?${query}`, { headers }).then(
        async (response) => {
          assert.equal(response.status, 200);
          await response.arrayBuffer();
        },
      );
      let inventory = [];
      const catalogDeadline = Date.now() + 30000;
      do {
        const value = await fetch(`${base}/api/plugin?${query}`, {
          headers,
        }).then((response) => response.json());
        inventory = value.data ?? [];
        if (inventory.some((plugin) => plugin.source?.type !== "builtin"))
          break;
        await delay(100);
      } while (Date.now() < catalogDeadline);
      const response = await fetch(
        `${base}/api/rpc/legalwork-benchmark-observer/catalog?${query}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
          body: '{"input":{}}',
        },
      );
      const body = await response.json();
      if (response.status !== 200) {
        const diagnostics = await fetch(`${base}/api/plugin?${query}`, {
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
        }).then((response) => response.text());
        const config = await fetch(`${base}/api/config?${query}`, {
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
        }).then((response) => response.text());
        async function logs(dir) {
          const result = [];
          for (const item of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, item.name);
            if (item.isDirectory()) result.push(...(await logs(path)));
            else if (item.name.endsWith(".log"))
              result.push(await readFile(path, "utf8"));
          }
          return result;
        }
        const log = await logs(root);
        assert.fail(
          log.join("\n").replaceAll(password, "[private]") +
            JSON.stringify(body) +
            " plugins " +
            JSON.stringify(
              JSON.parse(diagnostics).data?.filter(
                (plugin) => plugin.source?.type !== "builtin",
              ),
            ) +
            " config " +
            config +
            " " +
            output.replaceAll(password, "[private]"),
        );
      }
      assert.equal(body.output.schemaCoverage, "complete");
      assert.ok(body.output.tools.length > 0);
      assert.ok(
        body.output.tools.every(
          (tool) => typeof tool.name === "string" && tool.input !== undefined,
        ),
      );
      assert.equal(
        body.output.tools.some(
          (tool) => tool.name === "legalwork-benchmark-observer",
        ),
        false,
      );
    } finally {
      if (child) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(3000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
