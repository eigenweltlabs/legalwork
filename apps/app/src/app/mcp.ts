import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/desktop";
import { deriveMcpServerName } from "./mcp-identity";

type McpConfigValue = Record<string, unknown> | null | undefined;

export {
  deriveMcpServerName,
  getMcpIdentityKey,
  resolveMcpSignInName,
  validateMcpServerName,
  type McpIdentity,
} from "./mcp-identity";
import { t } from "@/i18n";

/**
 * Slugify a display name into a server name. Alias of `deriveMcpServerName`;
 * the derivation lives in one module so connect and sign-in cannot drift apart.
 */
export const normalizeMcpSlug = deriveMcpServerName;

export async function removeMcpFromConfig(
  projectDir: string,
  name: string,
): Promise<void> {
  const configFile = await readOpencodeConfig("project", projectDir) as { path: string; exists: boolean; content: string | null };
  const raw = configFile.exists && configFile.content?.trim()
    ? configFile.content
    : "{}\n";

  const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
  const existingConfig = parse(raw, parseErrors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((entry) => printParseErrorCode(entry.error))
      .join(", ");
    throw new Error(`Failed to parse opencode config: ${details}`);
  }

  const mcpSection = existingConfig?.["mcp"] as Record<string, unknown> | undefined;
  if (!mcpSection || !(name in mcpSection)) return;

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  const updated = applyEdits(raw, modify(raw, ["mcp", name], undefined, { formattingOptions }));
  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    updated.endsWith("\n") ? updated : `${updated}\n`,
  ) as { ok: boolean; stderr?: string; stdout?: string };
  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || t("mcp.write_opencode_failed"));
  }
}

export function parseMcpServersFromContent(content: string): McpServerEntry[] {
  if (!content.trim()) return [];

  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const mcp = parsed?.mcp as McpConfigValue;

    if (!mcp || typeof mcp !== "object") {
      return [];
    }

    return Object.entries(mcp).flatMap(([name, value]) => {
      if (!value || typeof value !== "object") {
        return [];
      }

      const config = value as McpServerConfig;
      if (config.type !== "remote" && config.type !== "local") {
        return [];
      }

      return [{ name, config, source: "config.project" as const }];
    });
  } catch {
    return [];
  }
}
