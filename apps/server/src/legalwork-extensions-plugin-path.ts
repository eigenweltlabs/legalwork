import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function legalworkPluginPath(name: string, here = dirname(fileURLToPath(import.meta.url))): string {
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const legalworkExtensionsPreviewPluginPath = () => legalworkPluginPath("legalwork-extensions-preview");
export const legalworkCapabilitiesKnowledgePluginPath = () => legalworkPluginPath("legalwork-capabilities-knowledge");
export const legalworkLegalMemoryKnowledgePluginPath = () => legalworkPluginPath("legalwork-legalmemory-knowledge");
export const legalworkAnthropicAdaptiveThinkingPluginPath = () => legalworkPluginPath("legalwork-anthropic-adaptive-thinking");
export const legalworkAnthropicToolSchemaPluginPath = () => legalworkPluginPath("legalwork-anthropic-tool-schema");
export const legalworkWordToolsPluginPath = () => legalworkPluginPath("legalwork-word-tools");
export const legalworkExcelToolsPluginPath = () => legalworkPluginPath("legalwork-excel-tools");
export const legalworkPowerPointToolsPluginPath = () => legalworkPluginPath("legalwork-powerpoint-tools");
export const legalworkBenchmarkToolsPluginPath = () => legalworkPluginPath("legalwork-benchmark-tools");
