import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createToolImageRaster, toolImageRasterEnvironment, type ToolImageRasterRuntime } from "./tool-image-raster.js";
import { TOOL_IMAGE_RASTER_CODE } from "./tool-image-raster-code.js";

process.env.DISABLE_SYSTEM_FONTS_LOAD = "1";
const resources = process.env.LEGALWORK_TEST_RASTER_RESOURCES;
const require = createRequire(resources ? join(resources, "app.asar.unpacked/package.json") : new URL("../package.json", import.meta.url));
const canvas: typeof import("@napi-rs/canvas") = require("@napi-rs/canvas");
const runtime: ToolImageRasterRuntime = {
  executable: resources ? join(resources, "node", process.platform === "win32" ? "node.exe" : "node") : resolve(import.meta.dir, "../../desktop/resources/node", process.platform === "win32" ? "node.exe" : "node"),
  canvas: require.resolve("@napi-rs/canvas"), imageSize: require.resolve("image-size"),
};
const services: ReturnType<typeof createToolImageRaster>[] = [];
function service(selected = () => runtime) { const result = createToolImageRaster(selected); services.push(result); return result; }
afterEach(async () => { await Promise.all(services.splice(0).map(value => value.close())); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const rectangle = { x: 0, y: 0, width: 1, height: 1 };
async function fixture(encoding: "png" | "jpeg" | "webp" = "png") {
  const image = canvas.createCanvas(6, 4), context = image.getContext("2d");
  context.fillStyle = "red"; context.fillRect(0, 0, 3, 2);
  context.fillStyle = "lime"; context.fillRect(3, 0, 3, 2);
  context.fillStyle = "blue"; context.fillRect(0, 2, 3, 2);
  context.fillStyle = "yellow"; context.fillRect(3, 2, 3, 2);
  context.clearRect(0, 0, 1, 1);
  context.clearRect(1, 0, 1, 1); context.fillStyle = "rgba(255,0,0,0.5)"; context.fillRect(1, 0, 1, 1);
  if (encoding === "jpeg") return image.encode("jpeg");
  if (encoding === "webp") return image.encode("webp");
  return image.encode("png");
}
async function pixels(bytes: Uint8Array) {
  const image = await canvas.loadImage(bytes), surface = canvas.createCanvas(image.width, image.height), context = surface.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: [...context.getImageData(0, 0, image.width, image.height).data] };
}
function tiff(orientation: number) {
  const bytes = Buffer.alloc(26); bytes.write("II"); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(0x112, 10); bytes.writeUInt16LE(3, 12); bytes.writeUInt32LE(1, 14); bytes.writeUInt16LE(orientation, 18); return bytes;
}
function exifJpeg(bytes: Buffer, orientation: number) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff(orientation)]), size = Buffer.alloc(2); size.writeUInt16BE(payload.length + 2);
  return Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 225]), size, payload, bytes.subarray(2)]);
}
function exifPng(bytes: Buffer, orientation: number) {
  const payload = tiff(orientation), kind = Buffer.from("eXIf"), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(payload.length);
  let sum = 0xffffffff; for (const byte of Buffer.concat([kind, payload])) { sum ^= byte; for (let index = 0; index < 8; index++) sum = (sum >>> 1) ^ (sum & 1 ? 0xedb88320 : 0); }
  crc.writeUInt32BE((sum ^ 0xffffffff) >>> 0);
  return Buffer.concat([bytes.subarray(0, 33), size, kind, payload, crc, bytes.subarray(33)]);
}
function exifWebp(bytes: Buffer, orientation: number) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff(orientation)]), size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  const output = Buffer.concat([bytes, Buffer.from("EXIF"), size, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  output.writeUInt32LE(output.length - 8, 4); if (output.toString("ascii", 12, 16) === "VP8X") output[20] |= 8; return output;
}
function gone(pid: number | undefined) { if (pid === undefined) return true; try { process.kill(pid, 0); return false; } catch { return true; } }
function worker() {
  const child = spawn(runtime.executable, ["-", runtime.canvas, runtime.imageSize], { env: toolImageRasterEnvironment(process.env), stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json" });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once("close", (code, signal) => done({ code, signal })));
  const records: unknown[] = []; child.on("message", value => records.push(value));
  const ready = new Promise<void>(done => child.once("message", () => done()));
  child.stdin?.end(TOOL_IMAGE_RASTER_CODE);
  return { child, ready, closed, records };
}

test("crop environment excludes app secrets, native overrides, preloads, proxies and font discovery", () => {
  expect(toolImageRasterEnvironment({ HOME: "/fixture", PATH: "/bin", NODE_OPTIONS: "--require private", NODE_PATH: "/private", LEGALWORK_SERVER_TOKEN: "secret", NAPI_RS_NATIVE_LIBRARY_PATH: "/private", HTTPS_PROXY: "http://private", DISABLE_SYSTEM_FONTS_LOAD: "0" }))
    .toEqual({ HOME: "/fixture", PATH: "/bin", DISABLE_SYSTEM_FONTS_LOAD: "1" });
});

test("actual PNG crop preserves alpha, exact right edge, original hash and whole derived PNG", async () => {
  const bytes = await fixture(), original = Buffer.from(bytes), raster = service();
  const alpha = await raster.crop({ bytes, mime: "image/png", rectangle: { x: 0, y: 0, width: 2, height: 1 }, signal: signal() });
  expect((await pixels(alpha.bytes)).data).toEqual([0, 0, 0, 0, 255, 0, 0, 127]);
  const edge = await raster.crop({ bytes, mime: "image/png", rectangle: { x: 5, y: 3, width: 1, height: 1 }, signal: signal() });
  expect((await pixels(edge.bytes)).data).toEqual([255, 255, 0, 255]);
  expect(edge.originalSha256).toBe(hash(original)); expect(edge.output.sha256).toBe(hash(edge.bytes)); expect(bytes).toEqual(original);
  expect(edge.source).toEqual({ mime: "image/png", encodedWidth: 6, encodedHeight: 4, decodedWidth: 6, decodedHeight: 4, orientation: null,
    orientationSource: "not-exposed", orientationPolicy: "png-webp-metadata-unhandled", coordinateSpace: "decoded-raster-pixels", decoder: { name: "@napi-rs/canvas", version: "1.0.9" } });
});

test("actual JPEG orientations1–8 use decoded coordinates and preserve exact original provenance", async () => {
  const base = await fixture("jpeg"), original = await pixels(base), raster = service();
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = exifJpeg(base, orientation), width = orientation >= 5 ? 4 : 6, height = orientation >= 5 ? 6 : 4;
    const result = await raster.crop({ bytes, mime: "image/jpeg", rectangle: { x: 0, y: 0, width, height }, signal: signal() });
    const output = await pixels(result.bytes), expected: number[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sx = x, sy = y;
      if (orientation === 2) sx = 5 - x;
      if (orientation === 3) { sx = 5 - x; sy = 3 - y; }
      if (orientation === 4) sy = 3 - y;
      if (orientation === 5) { sx = y; sy = x; }
      if (orientation === 6) { sx = y; sy = 3 - x; }
      if (orientation === 7) { sx = 5 - y; sy = 3 - x; }
      if (orientation === 8) { sx = 5 - y; sy = x; }
      expected.push(...original.data.slice((sy * 6 + sx) * 4, (sy * 6 + sx) * 4 + 4));
    }
    expect(output.data).toEqual(expected);
    expect(result.source).toMatchObject({ encodedWidth: 6, encodedHeight: 4, decodedWidth: width, decodedHeight: height,
      orientation, orientationSource: "jpeg-exif", orientationPolicy: "jpeg-exif-applied" });
    expect(result.originalSha256).toBe(hash(bytes));
  }
  const rotated = exifJpeg(base, 6);
  await expect(raster.crop({ bytes: rotated, mime: "image/jpeg", rectangle: { x: 5, y: 0, width: 1, height: 1 }, signal: signal() })).rejects.toThrow("bounds");
});

test("PNG/WebP EXIF orientation remains explicitly unhandled, with actual decoded pixel provenance", async () => {
  for (const encoding of ["png", "webp"]) {
    if (encoding !== "png" && encoding !== "webp") throw new Error("Unsupported fixture encoding");
    const base = await fixture(encoding), bytes = encoding === "png" ? exifPng(base, 6) : exifWebp(base, 6);
    const result = await service().crop({ bytes, mime: `image/${encoding}`, rectangle: { x: 0, y: 0, width: 6, height: 4 }, signal: signal() });
    expect((await pixels(result.bytes)).data).toEqual((await pixels(base)).data);
    expect(result.source).toMatchObject({ encodedWidth: 6, encodedHeight: 4, decodedWidth: 6, decodedHeight: 4, orientation: null, orientationPolicy: "png-webp-metadata-unhandled" });
    expect(result.originalSha256).toBe(hash(bytes));
  }
});

test("invalid bounds are rejected without clamping, scaling or unsafe integers", async () => {
  const bytes = await fixture(), raster = service();
  for (const invalid of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: Number.MAX_SAFE_INTEGER + 1, y: 0, width: 1, height: 1 }])
    await expect(raster.crop({ bytes, mime: "image/png", rectangle: invalid, signal: signal() })).rejects.toThrow("safe-integer");
  for (const invalid of [{ x: 6, y: 0, width: 1, height: 1 }, { x: 0, y: 4, width: 1, height: 1 }, { x: 0, y: 0, width: 7, height: 4 }, { x: Number.MAX_SAFE_INTEGER, y: 0, width: Number.MAX_SAFE_INTEGER, height: 1 }])
    await expect(raster.crop({ bytes, mime: "image/png", rectangle: invalid, signal: signal() })).rejects.toThrow("bounds");
});

test("vector/external-resource bytes, mismatched MIME and corrupt raster are explicit failures", async () => {
  const raster = service(), svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>');
  await expect(raster.crop({ bytes: svg, mime: "image/svg+xml", rectangle, signal: signal() })).rejects.toThrow("PNG, JPEG and WebP");
  await expect(raster.crop({ bytes: await fixture(), mime: "image/jpeg", rectangle, signal: signal() })).rejects.toThrow("MIME");
  await expect(raster.crop({ bytes: Buffer.from([255, 216, 255, 0]), mime: "image/jpeg", rectangle, signal: signal() })).rejects.toThrow();
});

test("pre-abort and abort during host selection do not start a child; closed service cannot admit", async () => {
  const bytes = await fixture(), pre = new AbortController(); pre.abort(new Error("Already stopped"));
  let reads = 0; const raster = service(() => { reads++; return runtime; });
  await expect(raster.crop({ bytes, mime: "image/png", rectangle, signal: pre.signal })).rejects.toThrow("Already stopped"); expect(reads).toBe(0);
  const during = new AbortController(), second = service(() => { during.abort(new Error("Selection revoked")); return runtime; });
  await expect(second.crop({ bytes, mime: "image/png", rectangle, signal: during.signal })).rejects.toThrow("Selection revoked");
  await raster.close(); await expect(raster.crop({ bytes, mime: "image/png", rectangle, signal: signal() })).rejects.toThrow("stopping");
  const selected = service(() => { void selected.close(); return runtime; });
  await expect(selected.crop({ bytes, mime: "image/png", rectangle, signal: signal() })).rejects.toThrow("stopping");
  await expect(service(() => ({ ...runtime, canvas: "relative.js" })).crop({ bytes, mime: "image/png", rectangle, signal: signal() })).rejects.toThrow("absolute host-owned");
});

test("Stop during actual native raster work reaps only its child before rejection; parallel peer succeeds", async () => {
  const large = canvas.createCanvas(4096, 4096), context = large.getContext("2d");
  const image = context.createImageData(4096, 4096); for (let index = 0; index < image.data.length; index++) image.data[index] = index * 17 % 251;
  context.putImageData(image, 0, 0); const bytes = await large.encode("png"), raster = service(), controller = new AbortController();
  const stopped = raster.crop({ bytes, mime: "image/png", rectangle: { x: 0, y: 0, width: 4096, height: 4096 }, signal: controller.signal }).catch(error => error);
  const peer = raster.crop({ bytes: await fixture(), mime: "image/png", rectangle, signal: signal() });
  await new Promise(done => setTimeout(done, 200)); controller.abort(new Error("Owned crop Stop"));
  const error = await stopped; expect(error).toBeInstanceOf(Error); expect(error.message).toBe("Owned crop Stop");
  expect(error.imageWorker.observations.some((value: { phase: string }) => value.phase === "decode" || value.phase === "encode")).toBe(true);
  expect(error.imageWorker.signal).toBe("SIGKILL"); expect(gone(error.imageWorker.pid)).toBe(true);
  expect((await peer).output).toMatchObject({ width: 1, height: 1 });
}, 15000);

test("private child rejects extra path/code authority and exits on parent disconnect", async () => {
  const malformed = worker(); await malformed.ready;
  malformed.child.send?.({ bytes: (await fixture()).toString("base64"), mime: "image/png", rectangle, path: "/private", code: "not allowed" });
  expect((await malformed.closed).code).toBe(0); expect(JSON.stringify(malformed.records)).toContain("Invalid private image worker request");
  const orphan = worker(); await orphan.ready; orphan.child.disconnect(); expect((await orphan.closed).code).toBe(1); expect(gone(orphan.child.pid)).toBe(true);
});

test.skipIf(process.platform === "win32")("malformed/early/duplicate replies, changed output and native failure never become crop success", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-protocol-"));
  try {
    const bytes = await fixture(), actual = await service().crop({ bytes, mime: "image/png", rectangle, signal: signal() });
    const correct = { ...actual, bytes: Buffer.from(actual.bytes).toString("base64") };
    for (const scenario of ["early", "wrong-pid", "changed-output", "duplicate", "native-failure"]) {
      const script = join(root, `${scenario}.cjs`), executable = join(root, scenario);
      const ready = "process.send({kind:'ready',pid:process.pid,node:process.versions.node,rss:1});";
      const result = `{kind:'result',result:${JSON.stringify(correct)},rss:1}`;
      const source = scenario === "early" ? `process.send(${result});` : scenario === "wrong-pid" ? "process.send({kind:'ready',pid:0,node:process.versions.node,rss:1});"
        : scenario === "native-failure" ? "process.exit(7);" : scenario === "changed-output" ? `${ready}process.on('message',()=>process.send({kind:'result',result:${JSON.stringify({ ...correct, output: { ...correct.output, sha256: "0".repeat(64) } })},rss:1}));`
        : `${ready}process.on('message',()=>{process.send(${result});process.send(${result});});`;
      await writeFile(script, `process.stdin.resume();process.stderr.write('complete-private-${scenario}');${source}`);
      await writeFile(executable, `#!/bin/sh\nexec '${runtime.executable.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`); await chmod(executable, 0o700);
      const error = await service(() => ({ ...runtime, executable })).crop({ bytes, mime: "image/png", rectangle, signal: signal() }).catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(error.imageWorker.stderr).toBe(`complete-private-${scenario}`); expect(gone(error.imageWorker.pid)).toBe(true);
      if (scenario === "native-failure") expect(error.imageWorker.code).toBe(7);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("cancellation after a complete reply still rejects, and close waits exact child exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-late-"));
  try {
    const script = join(root, "worker.cjs"), executable = join(root, "worker"), marker = join(root, "replied");
    const bytes = await fixture(), real = await service().crop({ bytes, mime: "image/png", rectangle, signal: signal() });
    const wire = { ...real, bytes: Buffer.from(real.bytes).toString("base64") };
    await writeFile(script, `const fs=require('node:fs');process.stdin.resume();process.send({kind:'ready',pid:process.pid,node:process.versions.node,rss:1});process.on('message',()=>process.send({kind:'result',result:${JSON.stringify(wire)},rss:1},()=>fs.writeFileSync(${JSON.stringify(marker)},String(process.pid))));`);
    await writeFile(executable, `#!/bin/sh\nexec '${runtime.executable.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`); await chmod(executable, 0o700);
    const raster = service(() => ({ ...runtime, executable })), controller = new AbortController();
    const pending = raster.crop({ bytes, mime: "image/png", rectangle, signal: controller.signal }).catch(error => error);
    let pid = 0; while (!pid) { try { pid = Number(await readFile(marker, "utf8")); } catch { await new Promise(done => setTimeout(done, 5)); } }
    await new Promise(done => setTimeout(done, 30));
    controller.abort(new Error("Revoke after dispatch")); const error = await pending; expect(error).toBeInstanceOf(Error); expect(error.message).toBe("Revoke after dispatch");
    expect(error.imageWorker.observations.some((value: { phase: string }) => value.phase === "result")).toBe(true); expect(gone(pid)).toBe(true);
    await rm(marker);
    const second = service(() => ({ ...runtime, executable })); const waiting = second.crop({ bytes, mime: "image/png", rectangle, signal: signal() }).catch(error => error);
    let secondPid = 0; while (!secondPid) { try { secondPid = Number(await readFile(marker, "utf8")); } catch { await new Promise(done => setTimeout(done, 5)); } }
    await second.close(); const closedError = await waiting; expect(closedError).toBeInstanceOf(Error); expect(closedError.message).toBe("Image raster service is stopping."); expect(gone(secondPid)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
