const retired = "Standalone binary downloads are retired. Use the desktop app, normal Node development entrypoint, or the complete npm platform package/local bundle.";

/** Reject removed inputs before creating runtime state or starting a process. */
export function assertNoRetiredBinaryDownloads(flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): void {
  for (const [flag, variable] of [["sidecar-base-url", "LEGALWORK_SIDECAR_BASE_URL"], ["sidecar-manifest", "LEGALWORK_SIDECAR_MANIFEST_URL"]]) {
    if (flags.has(flag) || env[variable]?.trim()) throw new Error(`${retired} Remove --${flag}/${variable}.`);
  }
  if (env.LEGALWORK_ORCHESTRATOR_DOWNLOAD_BASE_URL?.trim()) throw new Error(`${retired} Remove LEGALWORK_ORCHESTRATOR_DOWNLOAD_BASE_URL.`);
  for (const [flag, variable] of [["sidecar-source", "LEGALWORK_SIDECAR_SOURCE"], ["opencode-source", "LEGALWORK_OPENCODE_SOURCE"]]) {
    if (String(flags.get(flag) ?? env[variable] ?? "").trim().toLowerCase() === "downloaded") throw new Error(`${retired} Use auto, bundled or external for --${flag}.`);
  }
}
