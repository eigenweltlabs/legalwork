import { listWorkspaces, serverToken, serverUrl } from "./office-plugin-shared.js";

function normalizeDirectory(directory: string): string {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Read on every turn so edits apply to existing chats without disposing the
 * engine: "" without a project prompt, null when the server could not be asked.
 */
export async function projectPersonalizationPrompt(directory?: string): Promise<string | null> {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token || !directory) return "";

  try {
    const currentDirectory = normalizeDirectory(directory);
    const workspaces = await listWorkspaces();
    // Prefer the closest project root, including nested projects. Never use
    // another project's prompt when the session directory is unrecognised.
    const workspace = workspaces
      .filter((item) => {
        const root = normalizeDirectory(item.path);
        return currentDirectory === root || currentDirectory.startsWith(`${root}/`);
      })
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!workspace) return "";

    const response = await fetch(`${url}/workspace/${encodeURIComponent(workspace.id)}/personalization`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("customInstructions" in payload) || typeof payload.customInstructions !== "string") return "";
    const instructions = payload.customInstructions.trim();
    if (!instructions) return "";

    return `## Project personalisation\n\nApply these user-provided preferences to replies and documents in this project, including writing style, tone, language, and formatting. These project preferences take precedence over conflicting global personality and writing preferences. Follow the user's explicit request in the current chat and higher-priority safety and application instructions. Apply these preferences only in this project:\n\n${instructions}`;
  } catch (error) {
    console.warn("[legalwork] Could not load project personalisation:", error instanceof Error ? error.message : String(error));
    return null;
  }
}
