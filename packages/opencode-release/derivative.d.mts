import type { VerifiedOpencodeCandidate } from "./candidate.mjs";
declare const verifiedDistribution: unique symbol;
export type VerifiedDerivativeDistribution = Readonly<{
  manifestPath?: string; manifestSha256: string; version: string; baseVersion: string; channel: string; scope: "complete" | "development"; targets: readonly string[];
  [verifiedDistribution]: true;
}>;
export function derivativeFileSha256(filename: string): Promise<string>;
export function verifyDerivativeDistribution(input: { manifestPath: string; manifestSha256: string }): Promise<VerifiedDerivativeDistribution & { readonly manifestPath: string }>;
export function verifyDerivativeDistributionContent(input: { manifestContent: string; manifestSha256: string }): Promise<VerifiedDerivativeDistribution>;
export function verifyInstalledDerivativeEngine(input: {
  distribution: VerifiedDerivativeDistribution; directory: string; target?: string;
}): Promise<VerifiedOpencodeCandidate>;
export function downloadDerivativeArchive(input: {
  distribution: VerifiedDerivativeDistribution; cacheDirectory: string; downloadBaseUrl: string; target?: string; fetcher?: typeof fetch;
}): Promise<string>;
export function installLocalDerivativeEngine(input: {
  distribution: VerifiedDerivativeDistribution; archiveDirectory?: string; cacheDirectory: string; destinationDirectory: string; target?: string;
}): Promise<{ candidateBuild: VerifiedOpencodeCandidate; target: string; reused: boolean }>;
