import { listWorkspaces, serverToken, serverUrl } from "./office-plugin-shared.js";
import { findProjectForDirectory } from "../workspace-path-match.js";

/**
 * Read on every turn so edits apply to existing chats without disposing the
 * engine: "" without a project prompt, null when the server could not be asked.
 */
export async function projectPersonalizationPrompt(directory?: string): Promise<string | null> {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token || !directory) return "";

  try {
    const workspace = await findProjectForDirectory(await listWorkspaces(), directory);
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
