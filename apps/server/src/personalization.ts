import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PersonalizationSettings, Personality } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** Pinned because OpenCode otherwise re-downloads unpinned plugins on every start. */
export const AGENT_MEMORY_PLUGIN_SPEC = "opencode-agent-memory@0.2.0";

const PERSONALITY_PROMPTS: Record<Personality, string | null> = {
  default: null,
  pragmatic:
    "Use a pragmatic tone: be direct, concrete, and action-oriented. Lead with the useful answer and make trade-offs explicit.",
  professional:
    "Use a professional tone: polished, measured, precise, and appropriate for legal work.",
  friendly:
    "Use a friendly tone: warm, approachable, and collaborative while remaining precise.",
  candid:
    "Use a candid tone: be frank and concise, respectfully challenge weak assumptions, and do not hide material concerns.",
};

export function buildPersonalizedAgentPrompt(
  basePrompt: string,
  settings: PersonalizationSettings,
): string {
  const additions: string[] = [];
  const personalityPrompt = PERSONALITY_PROMPTS[settings.personality];
  if (personalityPrompt) additions.push(`## Response personality\n\n${personalityPrompt}`);

  const customInstructions = settings.customInstructions.trim();
  if (customInstructions) {
    additions.push(
      `## User-provided system prompt additions\n\nFollow these host-wide instructions in every chat unless they conflict with higher-priority safety or application instructions:\n\n${customInstructions}`,
    );
  }

  if (settings.localMemoriesEnabled) {
    additions.push(
      settings.allowToolAssistedMemory
        ? "## Local memory policy\n\nYou may use the local memory tools to retain durable, high-signal preferences and context from chats, including chats that used web search or MCP tools. Never store secrets, credentials, privileged matter content, or transient task details."
        : "## Local memory policy\n\nUse the local memory tools only for durable information the user states directly in chat. Do not create or update memory from web search, MCP results, other tool output, documents, or inferred private matter details. Never store secrets, credentials, privileged matter content, or transient task details.",
    );
  }

  return additions.length ? `${basePrompt}\n\n${additions.join("\n\n")}` : basePrompt;
}

/**
 * Agent Memory 0.2.0 stores global blocks under ~/.config/opencode/memory and
 * project blocks under each workspace's .opencode/memory directory.
 */
export function localMemoryDirectories(
  config: ServerConfig,
  globalMemoryDirectory = join(homedir(), ".config", "opencode", "memory"),
): string[] {
  const directories = [
    globalMemoryDirectory,
    ...config.workspaces.map((workspace) => join(workspace.path, ".opencode", "memory")),
  ];
  return directories.filter((directory, index) => directories.indexOf(directory) === index);
}

export async function deleteAllLocalMemories(
  config: ServerConfig,
  globalMemoryDirectory?: string,
): Promise<number> {
  const directories = localMemoryDirectories(config, globalMemoryDirectory);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  return directories.length;
}
