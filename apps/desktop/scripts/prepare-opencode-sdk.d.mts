export function stageOpencodeSdk(options: {
  sourcePackage: string;
  destination: string;
  expectedVersion: string;
}): Promise<{ version: string; packages: number }>;
