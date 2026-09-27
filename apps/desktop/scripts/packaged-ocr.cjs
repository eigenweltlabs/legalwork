const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

/** Keep only the target CPU runtime; the npm package contains every platform. */
function pruneOcrRuntime(resources, platform, arch) {
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  const requireUnpacked = createRequire(path.join(modules, "ocr-check.cjs"));
  const runtime = path.dirname(requireUnpacked.resolve("onnxruntime-node/package.json"));
  const binaries = path.join(runtime, "bin", "napi-v6");
  const target = path.join(binaries, platform, arch);
  if (!fs.existsSync(path.join(target, "onnxruntime_binding.node"))) {
    throw new Error(`Missing OCR runtime for ${platform}/${arch}`);
  }
  for (const os of fs.readdirSync(binaries)) {
    if (os !== platform) fs.rmSync(path.join(binaries, os), { recursive: true, force: true });
    else for (const cpu of fs.readdirSync(path.join(binaries, os))) {
      if (cpu !== arch) fs.rmSync(path.join(binaries, os, cpu), { recursive: true, force: true });
    }
  }
  // Resolve all entry points from the external Node worker's real filesystem view.
  for (const dependency of ["onnxruntime-node", "@napi-rs/canvas", "paddleocr", "image-size"]) requireUnpacked.resolve(dependency);
  createRequire(requireUnpacked.resolve("onnxruntime-node")).resolve("onnxruntime-common");
  if (!fs.existsSync(path.join(resources, "ocr", "native-worker.cjs"))) throw new Error("Missing bundled OCR worker");
}

module.exports = { pruneOcrRuntime };
