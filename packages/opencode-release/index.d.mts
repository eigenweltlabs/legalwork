export type ReleaseArtifact = { name: string; tarball: string; integrity: string };
export const opencodeRelease: { version: string; packages: Record<string, ReleaseArtifact> };
export function opencodeArchiveTarExecutable(): string;
export function opencodeReleaseTarget(platform?: string, arch?: string, libc?: string): string;
export function verifyOpencodeArchive(bytes: Uint8Array, integrity: string): void;
export function downloadOpencodeBinary(options: { destination: string; cacheDirectory: string; target?: string; version?: string; fetcher?: typeof fetch }): Promise<{ version: string; target: string; package: string; integrity: string; destination: string }>;
