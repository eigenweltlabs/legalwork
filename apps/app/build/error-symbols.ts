import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import posthog from "@posthog/rollup-plugin";

export function diagnosticBuildId(root: string): string | null {
  const configured = process.env.VITE_LEGALWORK_BUILD_ID ?? process.env.GITHUB_SHA;
  if (configured && /^[a-f0-9]{7,40}$/.test(configured)) return configured;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return null; }
}
export function errorSymbolPlugins(root: string, surface: string, version: string): Plugin[] {
  const buildId = diagnosticBuildId(root);
  const key = process.env.POSTHOG_SOURCEMAP_API_KEY;
  const project = process.env.POSTHOG_SOURCEMAP_PROJECT_ID;
  const plugins: Plugin[] = [];
  if (key && project) plugins.push(posthog({
    personalApiKey: key, projectId: project, host: "https://eu.posthog.com", logLevel: "warn",
    sourcemaps: { enabled: true, deleteAfterUpload: true, releaseMode: "symbol-set", releaseName: "legalwork", releaseVersion: `${version}+${buildId ?? "unknown"}` },
  }));
  plugins.push({
    name: "legalwork-private-error-symbols",
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "diagnostics-assets.json", source: JSON.stringify(Object.values(bundle).flatMap(chunk => {
        if (chunk.type !== "chunk" || !/^assets\/.+-[\w-]{8,}\.js$/.test(chunk.fileName)) return [];
        const chunkId = chunk.code.match(/\/\/# chunkId=([a-f0-9-]{36})/)?.[1] ?? null;
        return [{ asset: basename(chunk.fileName), chunk_id: chunkId }];
      })) });
    },
    writeBundle: {
      order: "post", sequential: true,
      handler(options, bundle) {
        const privateRoot = resolve(root, ".error-symbols", buildId ?? "unknown", surface);
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk" || !chunk.map) continue;
          const file = resolve(privateRoot, chunk.fileName);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, chunk.code);
          writeFileSync(`${file}.map`, chunk.map.toString());
          // Hidden maps must also be absent from distributed web/desktop bundles.
          if (options.dir) rmSync(resolve(options.dir, chunk.sourcemapFileName ?? `${chunk.fileName}.map`), { force: true });
        }
      },
    },
  });
  return plugins;
}
