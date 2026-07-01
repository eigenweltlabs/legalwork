// Pure logic for the Agents settings view (EIG-61): parsing/serializing the
// `.opencode/agents/<name>.md` files opencode discovers as agents/subagents,
// plus name validation and builder-form state helpers.
//
// The frontmatter schema is the small AgentConfig subset the builder edits
// (description, mode, model, temperature, tools, permission). The app has no
// YAML dependency, so this hand-rolls exactly that subset and preserves any
// unknown frontmatter entries verbatim so round-tripping a hand-edited file
// never loses data.

export const AGENTS_DIR = ".opencode/agents";

export function agentFilePath(name: string): string {
  return `${AGENTS_DIR}/${name}.md`;
}

export type AgentMode = "primary" | "subagent" | "all";
export type AgentPermissionAction = "allow" | "ask" | "deny";

/** Tool toggles surfaced by the builder; anything not listed keeps its default. */
export const AGENT_TOOL_KEYS = ["read", "write", "edit", "patch", "bash", "webfetch"] as const;
export type AgentToolKey = (typeof AGENT_TOOL_KEYS)[number];

/** Permission scopes the builder edits (plain allow/ask/deny actions). */
export const AGENT_PERMISSION_KEYS = ["edit", "bash", "webfetch"] as const;
export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number];

export type AgentDefinition = {
  description: string;
  mode: AgentMode;
  /** "provider/model" or "" for the workspace default model. */
  model: string;
  /** null = inherit the model's default temperature. */
  temperature: number | null;
  /** Sparse overrides; a missing key means the tool keeps its default. */
  tools: Record<string, boolean>;
  permission: Partial<Record<AgentPermissionKey, AgentPermissionAction>>;
  /**
   * Permission sub-entries the builder doesn't edit (patterns, other tools),
   * preserved as raw indented YAML lines inside the `permission:` block.
   */
  extraPermissionLines: string[];
  /** Markdown body — the agent's role prompt. */
  prompt: string;
  /**
   * Unknown top-level frontmatter entries (e.g. `color`, `top_p`), preserved
   * as raw YAML chunks and re-emitted verbatim on serialize.
   */
  extraFrontmatter: string[];
};

export function emptyAgentDefinition(): AgentDefinition {
  return {
    description: "",
    mode: "subagent",
    model: "",
    temperature: null,
    tools: {},
    permission: {},
    extraPermissionLines: [],
    prompt: "",
    extraFrontmatter: [],
  };
}

function isAgentMode(value: string): value is AgentMode {
  return value === "primary" || value === "subagent" || value === "all";
}

function isPermissionAction(value: string): value is AgentPermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function isPermissionKey(value: string): value is AgentPermissionKey {
  return AGENT_PERMISSION_KEYS.some((key) => key === value);
}

/** Unquotes a YAML scalar (double-quoted, single-quoted, or plain). */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the manual slice below
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Folds a YAML block scalar (`>`, `>-`, `|`, `|-` …) from its indented lines.
 * Folded style joins lines with spaces and keeps blank lines as newlines;
 * literal style keeps newlines as written.
 */
function parseBlockScalar(indicator: string, lines: string[]): string {
  const stripped = lines.map((line) => line.replace(/^\s+/, ""));
  if (indicator.startsWith("|")) return stripped.join("\n").trimEnd();
  let result = "";
  for (const line of stripped) {
    if (line === "") {
      result = `${result.replace(/ $/, "")}\n`;
    } else {
      result += result === "" || result.endsWith("\n") ? line : ` ${line}`;
    }
  }
  return result.trimEnd();
}

/** One top-level frontmatter entry: the `key:` line plus its indented lines. */
type FrontmatterChunk = { key: string; inline: string; lines: string[]; raw: string[] };

function splitFrontmatterChunks(header: string): FrontmatterChunk[] {
  const chunks: FrontmatterChunk[] = [];
  for (const line of header.split("\n")) {
    const isTopLevel = line.trim() !== "" && !/^[\s#]/.test(line) && line.includes(":");
    if (isTopLevel) {
      const colonIndex = line.indexOf(":");
      chunks.push({
        key: line.slice(0, colonIndex).trim(),
        inline: line.slice(colonIndex + 1).trim(),
        lines: [],
        raw: [line],
      });
      continue;
    }
    const current = chunks[chunks.length - 1];
    if (!current) continue;
    current.lines.push(line);
    current.raw.push(line);
  }
  return chunks;
}

function parseChunkValue(chunk: FrontmatterChunk): string {
  if (/^[>|]/.test(chunk.inline)) {
    return parseBlockScalar(chunk.inline, chunk.lines);
  }
  return parseScalar(chunk.inline);
}

function parseNestedMap(chunk: FrontmatterChunk): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const line of chunk.lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = parseScalar(trimmed.slice(colonIndex + 1));
    if (key) entries.push([key, value]);
  }
  return entries;
}

/** Parses an agent markdown file (YAML frontmatter + role-prompt body). */
export function parseAgentMarkdown(content: string): AgentDefinition {
  const definition = emptyAgentDefinition();
  // opencode's default for agent files is "all"; the builder writes the mode
  // explicitly, but a file without one must round-trip as-is.
  definition.mode = "all";
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    definition.prompt = normalized.trim();
    return definition;
  }
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    definition.prompt = normalized.trim();
    return definition;
  }
  const header = normalized.slice(4, endIndex);
  const afterMarker = normalized.indexOf("\n", endIndex + 1);
  definition.prompt = afterMarker === -1 ? "" : normalized.slice(afterMarker + 1).trim();

  for (const chunk of splitFrontmatterChunks(header)) {
    switch (chunk.key) {
      case "description":
        definition.description = parseChunkValue(chunk);
        break;
      case "mode": {
        const mode = parseScalar(chunk.inline);
        if (isAgentMode(mode)) definition.mode = mode;
        break;
      }
      case "model":
        definition.model = parseScalar(chunk.inline);
        break;
      case "temperature": {
        const value = Number.parseFloat(parseScalar(chunk.inline));
        if (Number.isFinite(value)) definition.temperature = value;
        break;
      }
      case "tools":
        for (const [key, value] of parseNestedMap(chunk)) {
          if (value === "true" || value === "false") {
            definition.tools[key] = value === "true";
          }
        }
        break;
      case "permission": {
        for (const line of chunk.lines) {
          if (line.trim() === "") continue;
          // Simple `key: action` entries the builder edits; everything else
          // (patterns, nested objects, other tools) is preserved raw.
          const match = /^\s{2}([a-z_]+):\s*(allow|ask|deny)\s*$/.exec(line);
          if (match && isPermissionKey(match[1]) && isPermissionAction(match[2])) {
            definition.permission[match[1]] = match[2];
          } else {
            definition.extraPermissionLines.push(line);
          }
        }
        break;
      }
      default:
        definition.extraFrontmatter.push(chunk.raw.join("\n"));
        break;
    }
  }
  return definition;
}

/** Quotes a scalar for YAML output when needed; plain otherwise. */
function serializeScalar(value: string): string {
  if (value === "" || /[:#'"\n\\{}[\],&*?|>%@`]/.test(value) || /^\s|\s$/.test(value) || /^[-!]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Serializes an agent definition to markdown with YAML frontmatter. */
export function serializeAgentMarkdown(definition: AgentDefinition): string {
  const lines: string[] = ["---"];
  if (definition.description.trim()) {
    lines.push(`description: ${JSON.stringify(definition.description.trim())}`);
  }
  lines.push(`mode: ${definition.mode}`);
  if (definition.model.trim()) {
    lines.push(`model: ${serializeScalar(definition.model.trim())}`);
  }
  if (definition.temperature !== null) {
    lines.push(`temperature: ${definition.temperature}`);
  }
  const toolEntries = Object.entries(definition.tools);
  if (toolEntries.length > 0) {
    lines.push("tools:");
    for (const [key, enabled] of toolEntries) {
      lines.push(`  ${key}: ${enabled}`);
    }
  }
  const permissionEntries = Object.entries(definition.permission).filter(
    (entry): entry is [AgentPermissionKey, AgentPermissionAction] => Boolean(entry[1]),
  );
  if (permissionEntries.length > 0 || definition.extraPermissionLines.length > 0) {
    lines.push("permission:");
    for (const [key, action] of permissionEntries) {
      lines.push(`  ${key}: ${action}`);
    }
    lines.push(...definition.extraPermissionLines);
  }
  for (const raw of definition.extraFrontmatter) {
    lines.push(raw);
  }
  lines.push("---", "");
  const prompt = definition.prompt.trim();
  return `${lines.join("\n")}\n${prompt ? `${prompt}\n` : ""}`;
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates a new agent's name (the `.opencode/agents/<name>.md` slug).
 * Returns an error message, or null when the name is valid.
 */
export function validateAgentName(name: string, existingNames: ReadonlySet<string>): string | null {
  const slug = name.trim();
  if (!slug) return "Enter a name.";
  if (slug.length > 64) return "Keep the name under 64 characters.";
  if (!AGENT_NAME_PATTERN.test(slug)) return "Use lowercase letters, numbers, and dashes only.";
  if (existingNames.has(slug)) return "An agent with this name already exists.";
  return null;
}

// ---------------------------------------------------------------------------
// Builder form state
// ---------------------------------------------------------------------------

export type AgentFormState = {
  name: string;
  description: string;
  mode: AgentMode;
  model: string;
  /** Raw input text; validated/parsed by agentFormToDefinition. */
  temperature: string;
  tools: Record<string, boolean>;
  permission: Partial<Record<AgentPermissionKey, AgentPermissionAction>>;
  extraPermissionLines: string[];
  prompt: string;
  extraFrontmatter: string[];
};

export function emptyAgentForm(): AgentFormState {
  return {
    name: "",
    description: "",
    mode: "subagent",
    model: "",
    temperature: "",
    tools: {},
    permission: {},
    extraPermissionLines: [],
    prompt: "",
    extraFrontmatter: [],
  };
}

export function agentFormFromDefinition(name: string, definition: AgentDefinition): AgentFormState {
  return {
    name,
    description: definition.description,
    mode: definition.mode,
    model: definition.model,
    temperature: definition.temperature === null ? "" : String(definition.temperature),
    tools: { ...definition.tools },
    permission: { ...definition.permission },
    extraPermissionLines: [...definition.extraPermissionLines],
    prompt: definition.prompt,
    extraFrontmatter: [...definition.extraFrontmatter],
  };
}

/** Parses the temperature input: null when blank, NaN when not a valid 0–2 number. */
export function parseTemperatureInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value < 0 || value > 2) return Number.NaN;
  return value;
}

export function agentFormToDefinition(form: AgentFormState): AgentDefinition {
  const temperature = parseTemperatureInput(form.temperature);
  return {
    description: form.description.trim(),
    mode: form.mode,
    model: form.model.trim(),
    temperature: temperature !== null && Number.isNaN(temperature) ? null : temperature,
    tools: { ...form.tools },
    permission: { ...form.permission },
    extraPermissionLines: [...form.extraPermissionLines],
    prompt: form.prompt.trim(),
    extraFrontmatter: [...form.extraFrontmatter],
  };
}

export type AgentFormErrors = {
  name?: string;
  temperature?: string;
  prompt?: string;
};

export function validateAgentForm(
  form: AgentFormState,
  options: { isNew: boolean; existingNames: ReadonlySet<string> },
): AgentFormErrors {
  const errors: AgentFormErrors = {};
  if (options.isNew) {
    const nameError = validateAgentName(form.name, options.existingNames);
    if (nameError) errors.name = nameError;
  }
  const temperature = parseTemperatureInput(form.temperature);
  if (temperature !== null && Number.isNaN(temperature)) {
    errors.temperature = "Use a number between 0 and 2.";
  }
  if (!form.prompt.trim()) {
    errors.prompt = "Describe how this agent should behave.";
  }
  return errors;
}

/** True unless the tool is explicitly turned off. */
export function isAgentToolEnabled(tools: Record<string, boolean>, key: AgentToolKey): boolean {
  return tools[key] !== false;
}

/**
 * Toggles a tool override. Tools default to enabled, so enabling removes the
 * override (keeping the file minimal) and disabling records `key: false`.
 */
export function toggleAgentTool(
  tools: Record<string, boolean>,
  key: AgentToolKey,
  enabled: boolean,
): Record<string, boolean> {
  const next = { ...tools };
  if (enabled) {
    delete next[key];
  } else {
    next[key] = false;
  }
  return next;
}

/** Sets a permission override; null clears it back to the workspace default. */
export function setAgentPermission(
  permission: Partial<Record<AgentPermissionKey, AgentPermissionAction>>,
  key: AgentPermissionKey,
  action: AgentPermissionAction | null,
): Partial<Record<AgentPermissionKey, AgentPermissionAction>> {
  const next = { ...permission };
  if (action === null) {
    delete next[key];
  } else {
    next[key] = action;
  }
  return next;
}
