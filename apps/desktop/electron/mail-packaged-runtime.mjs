import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const names = ["worker.mjs", "maintenance-worker.mjs", "process.js", "package.json"];
const fail = () => new Error("mail_packaged_runtime_invalid");

/** Paths are installation-owned, never renderer input. Verification stays lazy. */
export function createPackagedMailRuntime(resourcesPath) {
  if (typeof resourcesPath !== "string" || !isAbsolute(resourcesPath)) throw fail();
  const directory = join(resourcesPath, "app.asar.unpacked/server/dist/mail-node-runtime");
  const executable = { kind: "node", path: join(resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node") };
  return {
    executable,
    entryPoint: join(directory, "worker.mjs"),
    maintenanceEntryPoint: join(directory, "maintenance-worker.mjs"),
    async verify() {
      try {
        const root = await realpath(resourcesPath);
        const binary = await lstat(executable.path);
        if (!binary.isFile() || await realpath(executable.path) !== join(root, "node", process.platform === "win32" ? "node.exe" : "node")) throw fail();
        const manifestPath = join(resourcesPath, "app.asar/server/dist/mail-node-runtime.json");
        const info = await lstat(manifestPath);
        if (!info.isFile() || !info.size || info.size > 4096) throw fail();
        const manifestFile = await open(manifestPath, "r");
        let manifest;
        try {
          const bytes = Buffer.alloc(4097), { bytesRead } = await manifestFile.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== info.size) throw fail();
          manifest = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        } finally { await manifestFile.close(); }
        if (!manifest || Object.keys(manifest).sort().join(",") !== "files,version" || manifest.version !== 1
          || !Array.isArray(manifest.files) || manifest.files.length !== names.length) throw fail();
        for (const [index, name] of names.entries()) {
          const expected = manifest.files[index];
          if (!expected || Object.keys(expected).sort().join(",") !== "bytes,name,sha256" || expected.name !== name
            || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > 16 * 1024 * 1024
            || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw fail();
          const path = join(directory, name), fileInfo = await lstat(path);
          if (!fileInfo.isFile() || fileInfo.size !== expected.bytes
            || await realpath(path) !== join(root, "app.asar.unpacked/server/dist/mail-node-runtime", name)) throw fail();
          const file = await open(path, "r");
          try {
            const hash = createHash("sha256"); let size = 0;
            for await (const chunk of file.createReadStream({ autoClose: false })) {
              size += chunk.length;
              if (size > expected.bytes) throw fail();
              hash.update(chunk);
            }
            if (size !== expected.bytes || hash.digest("hex") !== expected.sha256) throw fail();
          } finally { await file.close(); }
        }
      } catch { throw fail(); }
    },
  };
}
