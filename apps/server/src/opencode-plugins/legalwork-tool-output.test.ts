import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import definition from "./legalwork-tool-output.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("output guidance exposes no reader tools and never intercepts native results", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-tool-hook-")));
  const runtime = nativePluginTestRuntime(root);
  try {
    await runtime.start(definition);
    expect([...runtime.tools.keys()]).toEqual([]);
    const call = { sessionID: "ses_example", agent: "legalwork", messageID: "msg_example", id: "call_example", input: {} };
    await runtime.hook("tool", "execute.before", { ...call, tool: "execute" });
    const text = "complete intermediate data\n".repeat(4000);
    const inner = { ...call, tool: "connector", status: "completed", result: { content: text } };
    await runtime.hook("tool", "execute.after", inner);
    expect(inner.result.content).toBe(text);
    expect(await readdir(root)).toEqual([]);
    const outer = { ...call, tool: "execute", status: "completed", result: { content: text, metadata: {} } };
    await runtime.hook("tool", "execute.after", outer);
    expect(outer.result.content).toBe(text);
    expect(outer.result.metadata).toEqual({});
    expect(await readdir(root)).toEqual([]);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
