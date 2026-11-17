import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import definition from "./legalwork-tool-output.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("Code Mode intermediates remain complete; only the outer result is saved", async () => {
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
    const info = z.object({ outputPath: z.string(), truncated: z.literal(true) }).parse(outer.result.metadata);
    expect(await readFile(info.outputPath, "utf8")).toBe(text);
    expect(info.outputPath).toContain(join(root, ".legalwork", "tool-output", "ses_example"));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
