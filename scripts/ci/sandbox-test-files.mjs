// Portable sandbox policy belongs to the ordinary server suite. These files
// exercise real native processes/filesystem boundaries or the packaged VM.
export const sandboxTransportTestFile = 'agent-sandbox/raw-http-node.test.ts';
export const sandboxRuntimeTestFiles = [
  'agent-sandbox/host.test.ts',
  'agent-sandbox/runtime.test.ts',
  'agent-sandbox/files.test.ts',
  'agent-sandbox/filesystem.test.ts',
  'agent-sandbox/shared-skills.test.ts',
  sandboxTransportTestFile,
  'agent-sandbox/raw-http-proxy.test.ts',
  'agent-sandbox/vm.integration.test.ts',
  'agent-sandbox/network.integration.test.ts',
  'calculations/calculations.sandbox.integration.test.ts',
  'skill-package.native.test.ts',
];

// These have dedicated workflow steps and must not also enter engine discovery.
export const standaloneEngineTestFiles = [
  'managed-opencode.released.test.ts',
  'agent-sandbox/engine.integration.test.ts',
];
export const serverUnitIgnorePatterns = [...sandboxRuntimeTestFiles, ...standaloneEngineTestFiles]
  .map(file => `**/${file}`);
