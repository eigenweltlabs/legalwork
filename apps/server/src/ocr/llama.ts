// The quality model runs in llama.cpp's llama-server: Paddle's official PaddleOCR-VL-1.6 GGUF release (Apache-2.0)
// and an official llama.cpp build (MIT), both pinned and checksum-verified. No Python is involved.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { assetReady, downloadModelAsset } from "./models.js";
import { OcrError } from "./types.js";

const build = "b11234";
const builds: Record<string, { name: string; bytes: number; sha256: string }> = {
  "darwin-arm64": { name: `llama-${build}-bin-macos-arm64.tar.gz`, bytes: 11757756, sha256: "ee87c0ef14d224a408f8fa409c355f6734d2b34a899afe25a25975b275cc5094" },
};
const gguf = "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/511b09642bb324401f15f97cc23bc67e8f0a291d";
const weights = [
  { name: "PaddleOCR-VL-1.6-GGUF.gguf", bytes: 935769056, sha256: "f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8" },
  { name: "PaddleOCR-VL-1.6-GGUF-mmproj.gguf", bytes: 881770560, sha256: "204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a" },
].map(asset => ({ ...asset, url: `${gguf}/${asset.name}` }));
const unavailable = "Prepare the selected local OCR runtime and model before extraction.";
const failed = "The local OCR model failed. Check the runtime installation or select another engine.";

/** Whether an official llama.cpp build is pinned for this platform. */
export const llamaSupported = () => `${process.platform}-${process.arch}` in builds;

function paths(directory: string) {
  const root = join(directory, "paddleocr-vl-1.6");
  return { root, build: join(root, `llama-${build}`), server: join(root, `llama-${build}`, "llama-server"), model: join(root, weights[0]!.name), mmproj: join(root, weights[1]!.name) };
}

export async function qualityModelReady(directory: string, signal?: AbortSignal) {
  const { root, server } = paths(directory);
  if (!await access(server).then(() => true, () => false)) return false;
  for (const asset of weights) if (!await assetReady(join(root, asset.name), asset, signal)) return false;
  return true;
}

/** Downloads the pinned llama.cpp build and the model files. Complete files are reused on retry. */
export async function prepareQualityModel(directory: string, signal: AbortSignal) {
  const archive = builds[`${process.platform}-${process.arch}`];
  if (!archive) throw new OcrError("runtime-unavailable", "This model requires an Apple Silicon Mac.");
  const location = paths(directory);
  await mkdir(location.root, { recursive: true, mode: 0o700 });
  if (!await access(location.server).then(() => true, () => false)) {
    const file = join(location.root, archive.name), temporary = join(location.root, `extract-${randomUUID()}`);
    try {
      await downloadModelAsset({ ...archive, url: `https://github.com/ggml-org/llama.cpp/releases/download/${build}/${archive.name}` }, file, signal);
      await mkdir(temporary, { mode: 0o700 });
      // The system tar keeps the build's library symlinks; the archive's checksum was verified above.
      await new Promise<void>((resolve, reject) => execFile("tar", ["-xf", file, "-C", temporary], { signal }, error => error ? reject(error) : resolve()));
      await rm(location.build, { recursive: true, force: true });
      await rename(join(temporary, `llama-${build}`), location.build);
    } finally { await rm(temporary, { recursive: true, force: true }); await rm(file, { force: true }); }
  }
  for (const asset of weights) await downloadModelAsset(asset, join(location.root, asset.name), signal);
}

/** Crops read at once. Two slots answered 53 crops 21% faster than one, with identical text; four gained little more. */
export const readers = 2;
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable() })).min(1) });

/** One llama-server with the quality model, started on first use and kept loaded until closed or idle.
 * Cancelling a request only stops that answer: the server keeps the model loaded for the next page. */
export class LlamaServer {
  private server?: Promise<{ url: string; key: string }>;
  private child?: ChildProcess;
  private idle?: ReturnType<typeof setTimeout>;
  private active = 0;

  /** `launcher` runs resources/ocr/llama-launcher.cjs with the bundled Node, which stops the server when this process exits. */
  constructor(private readonly directory: string, private readonly launcher: { executable: string; script: string; env: NodeJS.ProcessEnv },
    private readonly idleMs = 120_000) {}

  async read(request: { image: Uint8Array; prompt: string; limit: number }, signal: AbortSignal) {
    signal.throwIfAborted();
    clearTimeout(this.idle);
    this.active++;
    try {
      const { url, key } = await this.start();
      let response: Response;
      try {
        response = await fetch(`${url}/v1/chat/completions`, {
          method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          // Paddle's request to an inference server: the crop, then the task prompt; greedy decoding.
          body: JSON.stringify({ messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(request.image).toString("base64")}` } },
            { type: "text", text: request.prompt },
          ] }], temperature: 0, max_tokens: request.limit }),
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new OcrError("local-failed", failed);
      }
      if (!response.ok) { await response.body?.cancel(); throw new OcrError("local-failed", failed); }
      const choice = completionSchema.safeParse(await response.json());
      if (!choice.success) throw new OcrError("invalid-response", "The local OCR model returned invalid output.");
      return { text: choice.data.choices[0]!.message.content, cut: choice.data.choices[0]!.finish_reason === "length" };
    } finally {
      if (--this.active === 0) { this.idle = setTimeout(() => this.close(), this.idleMs); this.idle.unref(); }
    }
  }

  close() {
    clearTimeout(this.idle);
    // Closing stdin makes the launcher stop llama-server.
    this.child?.stdin?.end();
    this.child = undefined;
    this.server = undefined;
  }

  private start() {
    this.server ??= this.launch().catch(error => { this.server = undefined; throw error; });
    return this.server;
  }

  private async launch() {
    if (!await qualityModelReady(this.directory)) throw new OcrError("runtime-unavailable", unavailable);
    const { root, server, model, mmproj } = paths(this.directory);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")));
      });
    });
    // Local only, behind a per-run key, without the web UI or slot inspection: other programs cannot use it or read prompts.
    // The key goes through an owner-only file, not the command line other users can list; it is deleted once the server runs.
    const key = randomBytes(24).toString("hex"), url = `http://127.0.0.1:${port}`, keyFile = join(root, `key-${randomUUID()}`);
    await writeFile(keyFile, key, { mode: 0o600, flag: "wx" });
    const child = spawn(this.launcher.executable, [this.launcher.script, server, "-m", model, "--mmproj", mmproj, "--host", "127.0.0.1",
      "--port", String(port), "--api-key-file", keyFile, "--no-webui", "--no-slots", "-c", String(16384 * readers), "-np", String(readers)],
    { env: this.launcher.env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.on("error", () => { /* The exit handler forgets a server that died. */ });
    this.child = child;
    let exited = false;
    const forget = () => { exited = true; if (this.child === child) { this.child = undefined; this.server = undefined; } };
    child.once("exit", forget);
    child.once("error", forget);
    try {
      for (const deadline = Date.now() + 120_000; ;) {
        if (exited) throw new OcrError("local-failed", failed);
        if (await fetch(`${url}/health`).then(response => response.ok, () => false)) return { url, key };
        if (Date.now() > deadline) { child.stdin?.end(); throw new OcrError("local-failed", failed); }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } finally { await rm(keyFile, { force: true }); }
  }
}
