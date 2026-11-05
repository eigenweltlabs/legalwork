declare const verifiedBuild: unique symbol;
export type VerifiedOpencodeCandidate = Readonly<{
  directory: string; path: string; version: string; baseVersion: string; sha256: string; provenanceSha256: string;
  [verifiedBuild]: true;
}>;
export function verifyOpencodeCandidate(input: { directory: string; provenanceSha256: string }): Promise<VerifiedOpencodeCandidate>;
export function expectedOpencodeVersion(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<string>;
export function expectedOpencodeServiceFilename(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<"service.json" | "service-legalwork.json">;
/** Only explicit candidate-validation preloads register a process-local build. */
export function registerOpencodeCandidateForValidation(descriptor: VerifiedOpencodeCandidate): Promise<void>;
