import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { TOOL_IMAGE_RASTER_CODE } from "./tool-image-raster-code.js";
import { base64Bytes, exactKeys, isRecord, isRectangle, rasterMime, type ToolImageCrop, type ToolImageCropResult, type ToolImageRasterRuntime } from "./tool-image-raster-contract.js";

export type { ToolImageCrop, ToolImageCropResult, ToolImageRasterRuntime, ToolImageRectangle } from "./tool-image-raster-contract.js";
export type ToolImageRaster = { crop(request: ToolImageCrop): Promise<ToolImageCropResult>; close(): Promise<void> };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** No app credentials, module/preload overrides, proxies, font discovery or native binding overrides. */
export function toolImageRasterEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "temp", "tmp", "home", "userprofile", "homedrive", "homepath", "lang", "lc_all", "lc_ctype", "tz"]);
  return { ...Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name.toLowerCase()))), DISABLE_SYSTEM_FONTS_LOAD: "1" };
}

function readResult(value: unknown, request: ToolImageCrop, originalSha256: string): ToolImageCropResult {
  if (!isRecord(value) || !exactKeys(value, ["bytes", "mime", "originalSha256", "source", "rectangle", "output"])
    || value.mime !== "image/png" || value.originalSha256 !== originalSha256 || !isRectangle(value.rectangle)
    || value.rectangle.x !== request.rectangle.x || value.rectangle.y !== request.rectangle.y || value.rectangle.width !== request.rectangle.width || value.rectangle.height !== request.rectangle.height
    || !isRecord(value.source) || !isRecord(value.output)) throw new Error("Invalid private image worker result.");
  const source = value.source, output = value.output;
  if (!exactKeys(source, ["mime", "encodedWidth", "encodedHeight", "decodedWidth", "decodedHeight", "orientation", "orientationSource", "orientationPolicy", "coordinateSpace", "decoder"])
    || source.mime !== request.mime || !(source.mime === "image/png" || source.mime === "image/jpeg" || source.mime === "image/webp") || source.coordinateSpace !== "decoded-raster-pixels"
    || ![source.encodedWidth, source.encodedHeight, source.decodedWidth, source.decodedHeight].every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || !(source.orientation === null && source.orientationSource === "not-exposed" || source.mime === "image/jpeg" && typeof source.orientation === "number" && Number.isInteger(source.orientation) && source.orientation >= 1 && source.orientation <= 8 && source.orientationSource === "jpeg-exif")
    || source.orientationPolicy !== (source.mime === "image/jpeg" ? "jpeg-exif-applied" : "png-webp-metadata-unhandled")
    || !isRecord(source.decoder) || !exactKeys(source.decoder, ["name", "version"]) || source.decoder.name !== "@napi-rs/canvas" || typeof source.decoder.version !== "string"
    || !exactKeys(output, ["width", "height", "sha256", "encoding"]) || output.width !== request.rectangle.width || output.height !== request.rectangle.height || output.encoding !== "png") throw new Error("Invalid private image worker provenance.");
  const bytes = base64Bytes(value.bytes);
  if (rasterMime(bytes) !== "image/png" || bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== request.rectangle.width || bytes.readUInt32BE(20) !== request.rectangle.height
    || digest(bytes) !== output.sha256) throw new Error("Image worker output digest, dimensions or PNG encoding mismatch.");
  // The checks above validate the complete private wire object before its typed projection.
  return { bytes, mime: "image/png", originalSha256, source: {
    mime: source.mime, encodedWidth: Number(source.encodedWidth), encodedHeight: Number(source.encodedHeight),
    decodedWidth: Number(source.decodedWidth), decodedHeight: Number(source.decodedHeight),
    orientation: source.orientation === null ? null : Number(source.orientation),
    orientationSource: source.orientationSource === "jpeg-exif" ? "jpeg-exif" : "not-exposed",
    orientationPolicy: source.mime === "image/jpeg" ? "jpeg-exif-applied" : "png-webp-metadata-unhandled",
    coordinateSpace: "decoded-raster-pixels", decoder: { name: "@napi-rs/canvas", version: source.decoder.version },
  }, rectangle: value.rectangle, output: { width: request.rectangle.width, height: request.rectangle.height, sha256: digest(bytes), encoding: "png" } };
}

/** One host-owned Node process per crop. A stopped crop cannot interrupt a peer's decoder. */
export function createToolImageRaster(runtime: () => ToolImageRasterRuntime): ToolImageRaster {
  const active = new Set<{ stop(error: Error): void; closed: Promise<void> }>();
  let closing: Promise<void> | undefined, admissionClosed = false;
  return {
    async crop(request) {
      request.signal.throwIfAborted();
      if (admissionClosed) throw new Error("Image raster service is stopping.");
      if (!isRectangle(request.rectangle)) throw new Error("Crop rectangle must contain nonnegative safe-integer coordinates and positive safe-integer dimensions.");
      const bytes = Buffer.from(request.bytes), originalSha256 = digest(bytes), rectangle = { ...request.rectangle };
      if (rasterMime(bytes) !== request.mime) throw new Error("Declared image MIME does not match its raster bytes.");
      const selected = runtime();
      request.signal.throwIfAborted();
      if (admissionClosed) throw new Error("Image raster service is stopping.");
      if (![selected.executable, selected.canvas, selected.imageSize].every(value => typeof value === "string" && isAbsolute(value))) throw new Error("Image worker runtime requires absolute host-owned executable and module entrypoints.");
      const child = spawn(selected.executable, ["-", selected.canvas, selected.imageSize], {
        env: toolImageRasterEnvironment(process.env), stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true,
      });
      let finish = () => {};
      const closed = new Promise<void>(done => { finish = done; });
      let error: Error | undefined, result: ToolImageCropResult | undefined, ready = false, terminal = false, terminating = false;
      const stderr: Buffer[] = [], stdout: Buffer[] = [], terminationErrors: unknown[] = [];
      const observations: Array<{ phase: string; rss: number; at: number }> = [];
      const startedAt = performance.now();
      function stop(reason: Error) {
        error ??= reason;
        if (terminating || child.exitCode !== null || child.signalCode !== null) return;
        terminating = true;
        try { if (!child.kill("SIGKILL") && child.pid !== undefined) terminationErrors.push(new Error("Image worker termination was not accepted.")); }
        catch (failure) { terminationErrors.push(failure); }
      }
      const owned = { stop, closed };
      active.add(owned);
      const abort = () => stop(failure(request.signal.reason));
      request.signal.addEventListener("abort", abort, { once: true });
      const outcome = new Promise<ToolImageCropResult>((resolve, reject) => {
        child.stdout?.on("data", value => stdout.push(Buffer.from(value)));
        child.stderr?.on("data", value => stderr.push(Buffer.from(value)));
        child.on("error", reason => { if (terminating) terminationErrors.push(reason); stop(reason); });
        child.stdin?.on("error", stop);
        child.on("message", (value: unknown) => {
          if (error) return;
          if (!isRecord(value) || typeof value.kind !== "string" || typeof value.rss !== "number" || !Number.isFinite(value.rss) || value.rss < 0) { stop(new Error("Invalid private image worker reply.")); return; }
          observations.push({ phase: value.kind === "phase" && typeof value.phase === "string" ? value.phase : value.kind, rss: value.rss, at: performance.now() - startedAt });
          if (!ready) {
            if (!exactKeys(value, ["kind", "pid", "node", "rss"]) || value.kind !== "ready" || value.pid !== child.pid || typeof value.node !== "string") { stop(new Error("Image worker replied before its genuine ready handshake.")); return; }
            ready = true;
            if (request.signal.aborted) { abort(); return; }
            try { child.send({ bytes: bytes.toString("base64"), mime: request.mime, rectangle }, sendError => { if (sendError) stop(sendError); }); }
            catch (reason) { stop(failure(reason)); }
            return;
          }
          if (terminal) { stop(new Error("Duplicate private image worker terminal reply.")); return; }
          if (value.kind === "phase" && exactKeys(value, ["kind", "phase", "rss"]) && (value.phase === "decode" || value.phase === "encode")) return;
          terminal = true;
          if (value.kind === "result" && exactKeys(value, ["kind", "result", "rss"])) {
            try { result = readResult(value.result, { ...request, bytes, rectangle }, originalSha256); }
            catch (reason) { stop(failure(reason)); }
          } else if (value.kind === "error" && exactKeys(value, ["kind", "error", "rss"]) && isRecord(value.error) && typeof value.error.name === "string" && typeof value.error.message === "string" && (value.error.stack === undefined || typeof value.error.stack === "string")) {
            error = Object.assign(new Error(value.error.message), { name: value.error.name, stack: value.error.stack });
          } else stop(new Error("Invalid private image worker terminal reply."));
        });
        child.once("close", (code, signal) => {
          request.signal.removeEventListener("abort", abort);
          active.delete(owned);
          finish();
          if (request.signal.aborted) error ??= failure(request.signal.reason);
          if (code !== 0 || signal !== null) error ??= new Error(`Image worker exited unsuccessfully (code ${code}, signal ${signal}).`);
          if (!terminal || !result) error ??= new Error("Image worker closed without a complete crop result.");
          if (error) reject(Object.assign(error, { imageWorker: { pid: child.pid, code, signal, elapsedMs: performance.now() - startedAt, observations, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), terminationErrors } }));
          else if (result) resolve(result);
        });
      });
      if (request.signal.aborted) abort();
      if (!error) child.stdin?.end(TOOL_IMAGE_RASTER_CODE);
      return outcome;
    },
    close() {
      if (closing) return closing;
      admissionClosed = true;
      for (const child of active) child.stop(new Error("Image raster service is stopping."));
      closing = Promise.all([...active].map(child => child.closed)).then(() => {});
      return closing;
    },
  };
}
