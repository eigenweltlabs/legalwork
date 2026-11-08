declare const verifiedBuild: unique symbol;
export type VerifiedOpencodeCandidate = Readonly<{
  directory: string; path: string; version: string; baseVersion: string; sha256: string; provenanceSha256: string;
  [verifiedBuild]: true;
}>;
export function verifyOpencodeCandidate(input: { directory: string; provenanceSha256: string }): Promise<VerifiedOpencodeCandidate>;
/** Metadata only; does not authorize execution or read executable contents. */
export function opencodeEngineIdentity(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<{ version: string; serviceFilename: "service.json" | "service-legalwork.json" }>;
/** Fresh integrity verification before every spawn, including retries. */
export function verifyOpencodeForExecution(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<string>;
/** Compatibility alias for verifyOpencodeForExecution, not a metadata lookup. */
export function expectedOpencodeVersion(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<string>;
export function expectedOpencodeServiceFilename(binary: string, descriptor?: VerifiedOpencodeCandidate): Promise<"service.json" | "service-legalwork.json">;
/** Only explicit candidate-validation preloads register a process-local build. */
export function registerOpencodeCandidateForValidation(descriptor: VerifiedOpencodeCandidate): Promise<void>;
