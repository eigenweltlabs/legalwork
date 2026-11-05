export type EngineBuildMode = "development" | "production";
export type PreparedEngineBuild = {
  archiveDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  selectionPath: string;
  sourceKey: string;
  receiptPath: string;
  targets: string[];
  mode: EngineBuildMode;
};
export function engineTargetsForBuild(targets: string[]): string[] | undefined;
export function engineBuildMode(args: string[], fallback?: EngineBuildMode): EngineBuildMode;
export function prepareForBuild(input: {
  mode: EngineBuildMode;
  targets?: string[];
  checkOnly?: boolean;
  cacheDirectory?: string;
  outputDirectory?: string;
  distributionDirectory?: string;
  manifestSha256?: string;
  macSigning?: { mode: "developer-id"; identitySha1: string; certificateSha256: string; teamId: string; keychainPath?: string };
}): Promise<PreparedEngineBuild>;
export function stagePreparedEngineBuild(options: { prepared: PreparedEngineBuild; outputDirectory: string; targets?: string[] }): Promise<string[]>;
export function developmentEngineEnvironment(options?: { checkOnly?: boolean; includeBinary?: boolean }): Promise<{
  LEGALWORK_OPENCODE_ARCHIVES: string;
  LEGALWORK_OPENCODE_BIN?: string;
}>;
export function preparationCli(args: string[]): Promise<PreparedEngineBuild | void>;
