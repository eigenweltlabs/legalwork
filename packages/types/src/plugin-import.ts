export type PluginImportProvider = "chatgpt" | "claude";
export type PluginImportScope = "global" | "project";
export type PluginImportSource = { provider: PluginImportProvider; path: string } | { provider: PluginImportProvider; zipBase64: string };
export type PluginImportCandidate = { path: string; name: string; version: string | null };
export type PluginImportPreview = {
  id: string;
  digest: string;
  name: string;
  description: string | null;
  version: string | null;
  format: "codex" | "claude" | "portable" | "skills";
  root: string;
  fileCount: number;
  bytes: number;
  components: Array<{ type: "skill" | "agent" | "command" | "mcp"; name: string; installedName: string }>;
  warnings: string[];
};
export type PluginImportRequest = { source: PluginImportSource; root?: string; scope: PluginImportScope; digest?: string };
