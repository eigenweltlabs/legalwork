import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { PersonalizationSettings, Personality } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { globalOpencodeConfigDir } from "./workspace-files.js";

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

  return additions.length ? `${basePrompt}\n\n${additions.join("\n\n")}` : basePrompt;
}

/** The firm's instructions (from its policy) follow the member's own. */
export function withFirmInstructions(prompt: string, firmInstructions: string | undefined): string {
  return firmInstructions
    ? `${prompt}\n\n## Firm instructions\n\nYour firm set these instructions for everyone. Follow them in every chat unless they conflict with higher-priority safety or application instructions:\n\n${firmInstructions}`
    : prompt;
}

/**
 * Where the former local memory plugin (opencode-agent-memory 0.2.0) stored
 * its blocks: ~/.config/opencode/memory and each workspace's .opencode/memory.
 * Nothing reads them any more; Settings still offers to delete them.
 */
export function localMemoryDirectories(
  config: ServerConfig,
  globalMemoryDirectory = join(globalOpencodeConfigDir(), "memory"),
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
