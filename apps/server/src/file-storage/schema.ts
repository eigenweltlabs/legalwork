// Bundled to plain JS by `build`, so packaged Electron never loads TypeScript
// from a workspace dependency. UI and server still share one schema definition.
export {
  storageInputSchema,
  storageSecretKeys,
  STORAGE_MAX_FILE_BYTES,
  STORAGE_PAGE_SIZE,
} from "@legalwork/types/file-storage";
