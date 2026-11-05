import type { VerifiedOpencodeCandidate } from "./candidate.mjs";
export const opencodeEngineSelection: Readonly<{ kind: "official" | "derivative"; version: string; baseVersion: string; artifactId: string }>;
export function verifySelectedOpencodeEngine(binary: string, options?: { target?: string }): Promise<VerifiedOpencodeCandidate | undefined>;
export function stageSelectedOpencodeEngine(input: { binary: string; directory: string; target: string }): Promise<string>;
export function installSelectedOpencodeEngine(input: {
  directory: string; cacheDirectory: string; archiveDirectory?: string; target?: string; fetcher?: typeof fetch;
}): Promise<{ path: string; version: string; baseVersion: string; target: string; candidateBuild?: VerifiedOpencodeCandidate }>;
