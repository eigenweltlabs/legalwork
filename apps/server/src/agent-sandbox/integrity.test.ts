import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSandbox } from "./vm.js";

test("streamed integrity verification refuses a changed tail of a large guest image before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-integrity-"));
  try {
    const executable = `qemu-system-aarch64${process.platform === "win32" ? ".exe" : ""}`;
    const contents = { [executable]: Buffer.from("must never execute"), kernel: Buffer.from("kernel"), "initrd.gz": Buffer.alloc(2 * 1024 ** 2, 17) };
    const files: Record<string, string> = {};
    for (const [name, data] of Object.entries(contents)) {
      files[name] = createHash("sha256").update(data).digest("hex");
      await writeFile(join(directory, name), data);
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, architecture: "aarch64", files }));
    contents["initrd.gz"][contents["initrd.gz"].length - 1] = 18;
    await writeFile(join(directory, "initrd.gz"), contents["initrd.gz"]);
    await expect(new VmSandbox(directory).prepare()).rejects.toThrow("Protected runtime integrity check failed: initrd.gz");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
