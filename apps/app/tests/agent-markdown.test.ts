import { describe, expect, test } from "bun:test";

import {
  agentFilePath,
  agentFormFromDefinition,
  agentFormToDefinition,
  emptyAgentDefinition,
  emptyAgentForm,
  isAgentToolEnabled,
  parseAgentMarkdown,
  parseTemperatureInput,
  serializeAgentMarkdown,
  setAgentPermission,
  toggleAgentTool,
  validateAgentForm,
  validateAgentName,
  type AgentDefinition,
} from "../src/react-app/domains/settings/agent-markdown";

describe("agent markdown serialization", () => {
  test("serializes all builder fields", () => {
    const definition: AgentDefinition = {
      description: "Reviews diligence documents.",
      mode: "subagent",
      model: "anthropic/claude-sonnet-4-20250514",
      temperature: 0.2,
      tools: { write: false, edit: false, bash: true },
      permission: { edit: "deny", bash: "ask", webfetch: "allow" },
      extraPermissionLines: [],
      prompt: "You are a diligence reviewer.",
      extraFrontmatter: [],
    };
    expect(serializeAgentMarkdown(definition)).toBe(
      [
        "---",
        'description: "Reviews diligence documents."',
        "mode: subagent",
        "model: anthropic/claude-sonnet-4-20250514",
        "temperature: 0.2",
        "tools:",
        "  write: false",
        "  edit: false",
        "  bash: true",
        "permission:",
        "  edit: deny",
        "  bash: ask",
        "  webfetch: allow",
        "---",
        "",
        "You are a diligence reviewer.",
        "",
      ].join("\n"),
    );
  });

  test("omits optional fields that are unset", () => {
    const definition = emptyAgentDefinition();
    definition.prompt = "Prompt only.";
    expect(serializeAgentMarkdown(definition)).toBe("---\nmode: subagent\n---\n\nPrompt only.\n");
  });

  test("quotes model ids with special characters", () => {
    const definition = emptyAgentDefinition();
    definition.model = "ollama/llama3:8b";
    const content = serializeAgentMarkdown(definition);
    expect(content).toContain('model: "ollama/llama3:8b"');
    expect(parseAgentMarkdown(content).model).toBe("ollama/llama3:8b");
  });
});

describe("agent markdown parsing", () => {
  test("round-trips every builder field", () => {
    const definition: AgentDefinition = {
      description: "Analyzes compliance: filings & policies.",
      mode: "primary",
      model: "openai/gpt-5",
      temperature: 1,
      tools: { write: false, webfetch: false },
      permission: { bash: "deny" },
      extraPermissionLines: [],
      prompt: "You are a compliance analyst.\n\nBe precise.",
      extraFrontmatter: [],
    };
    expect(parseAgentMarkdown(serializeAgentMarkdown(definition))).toEqual(definition);
  });

  test("parses folded block-scalar descriptions (core agent style)", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "description: >-",
        "  Extracts and reviews a SINGLE legal document against a defined set of",
        "  review columns, and returns a strict JSON object.",
        "mode: subagent",
        "temperature: 0.1",
        'color: "#2563EB"',
        "tools:",
        "  write: false",
        "  edit: false",
        "---",
        "",
        "You are a document extraction agent.",
        "",
      ].join("\n"),
    );
    expect(parsed.description).toBe(
      "Extracts and reviews a SINGLE legal document against a defined set of review columns, and returns a strict JSON object.",
    );
    expect(parsed.mode).toBe("subagent");
    expect(parsed.temperature).toBe(0.1);
    expect(parsed.tools).toEqual({ write: false, edit: false });
    expect(parsed.extraFrontmatter).toEqual(['color: "#2563EB"']);
    expect(parsed.prompt).toBe("You are a document extraction agent.");
  });

  test("preserves unknown frontmatter fields on round-trip", () => {
    const original = [
      "---",
      "description: Reviewer",
      "mode: subagent",
      'color: "#FF5733"',
      "top_p: 0.9",
      "steps: 12",
      "---",
      "",
      "Prompt body.",
      "",
    ].join("\n");
    const parsed = parseAgentMarkdown(original);
    expect(parsed.extraFrontmatter).toEqual(['color: "#FF5733"', "top_p: 0.9", "steps: 12"]);
    const reparsed = parseAgentMarkdown(serializeAgentMarkdown(parsed));
    expect(reparsed).toEqual(parsed);
  });

  test("preserves permission entries the builder does not edit", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "mode: primary",
        "permission:",
        "  edit: ask",
        "  bash:",
        '    "git push": deny',
        "  skill: allow",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    expect(parsed.permission).toEqual({ edit: "ask" });
    expect(parsed.extraPermissionLines).toEqual(["  bash:", '    "git push": deny', "  skill: allow"]);
    const serialized = serializeAgentMarkdown(parsed);
    // A single permission block containing both edited and preserved entries.
    expect(serialized.match(/^permission:$/gm)).toHaveLength(1);
    expect(parseAgentMarkdown(serialized)).toEqual(parsed);
  });

  test("treats a file without frontmatter as prompt-only, defaulting mode to all", () => {
    const parsed = parseAgentMarkdown("Just a role prompt.\n");
    expect(parsed.prompt).toBe("Just a role prompt.");
    expect(parsed.mode).toBe("all");
    expect(parsed.description).toBe("");
  });

  test("parses quoted scalars and CRLF newlines", () => {
    const parsed = parseAgentMarkdown(
      '---\r\ndescription: "Line one\\nLine two"\r\nmode: subagent\r\n---\r\n\r\nBody.\r\n',
    );
    expect(parsed.description).toBe("Line one\nLine two");
    expect(parsed.prompt).toBe("Body.");
  });

  test("ignores invalid temperature and mode values", () => {
    const parsed = parseAgentMarkdown("---\nmode: chaotic\ntemperature: warm\n---\n\nBody.\n");
    expect(parsed.mode).toBe("all");
    expect(parsed.temperature).toBeNull();
  });
});

describe("agent name validation", () => {
  const existing = new Set(["document-extractor"]);

  test("accepts kebab-case slugs", () => {
    expect(validateAgentName("diligence-reviewer", existing)).toBeNull();
    expect(validateAgentName("analyst2", existing)).toBeNull();
  });

  test("rejects empty, malformed, overlong, and duplicate names", () => {
    expect(validateAgentName("", existing)).not.toBeNull();
    expect(validateAgentName("  ", existing)).not.toBeNull();
    expect(validateAgentName("Diligence Reviewer", existing)).not.toBeNull();
    expect(validateAgentName("-leading-dash", existing)).not.toBeNull();
    expect(validateAgentName("trailing-dash-", existing)).not.toBeNull();
    expect(validateAgentName("a".repeat(65), existing)).not.toBeNull();
    expect(validateAgentName("document-extractor", existing)).not.toBeNull();
  });
});

describe("agent form state", () => {
  test("converts a definition to a form and back", () => {
    const definition: AgentDefinition = {
      description: "Litigation research.",
      mode: "primary",
      model: "anthropic/claude-opus-4",
      temperature: 0.5,
      tools: { webfetch: false },
      permission: { webfetch: "deny" },
      extraPermissionLines: [],
      prompt: "You research case law.",
      extraFrontmatter: ["color: primary"],
    };
    const form = agentFormFromDefinition("litigation-researcher", definition);
    expect(form.name).toBe("litigation-researcher");
    expect(form.temperature).toBe("0.5");
    expect(agentFormToDefinition(form)).toEqual(definition);
  });

  test("parses and validates the temperature input", () => {
    expect(parseTemperatureInput("")).toBeNull();
    expect(parseTemperatureInput(" 0.7 ")).toBe(0.7);
    expect(parseTemperatureInput("2")).toBe(2);
    expect(Number.isNaN(parseTemperatureInput("2.5"))).toBe(true);
    expect(Number.isNaN(parseTemperatureInput("-1"))).toBe(true);
    expect(Number.isNaN(parseTemperatureInput("hot"))).toBe(true);
  });

  test("validates the whole form", () => {
    const form = emptyAgentForm();
    const existing = new Set(["build"]);
    let errors = validateAgentForm(form, { isNew: true, existingNames: existing });
    expect(errors.name).toBeDefined();
    expect(errors.prompt).toBeDefined();

    form.name = "diligence-reviewer";
    form.prompt = "You review diligence documents.";
    form.temperature = "9";
    errors = validateAgentForm(form, { isNew: true, existingNames: existing });
    expect(errors.name).toBeUndefined();
    expect(errors.prompt).toBeUndefined();
    expect(errors.temperature).toBeDefined();

    form.temperature = "0.3";
    errors = validateAgentForm(form, { isNew: true, existingNames: existing });
    expect(errors).toEqual({});

    // Existing agents keep their name; it is not re-validated.
    form.name = "build";
    errors = validateAgentForm(form, { isNew: false, existingNames: existing });
    expect(errors.name).toBeUndefined();
  });

  test("tool toggles keep the overrides map sparse", () => {
    let tools: Record<string, boolean> = {};
    expect(isAgentToolEnabled(tools, "write")).toBe(true);
    tools = toggleAgentTool(tools, "write", false);
    expect(tools).toEqual({ write: false });
    expect(isAgentToolEnabled(tools, "write")).toBe(false);
    tools = toggleAgentTool(tools, "write", true);
    expect(tools).toEqual({});
  });

  test("permission overrides can be set and cleared", () => {
    let permission = setAgentPermission({}, "bash", "deny");
    expect(permission).toEqual({ bash: "deny" });
    permission = setAgentPermission(permission, "edit", "ask");
    expect(permission).toEqual({ bash: "deny", edit: "ask" });
    permission = setAgentPermission(permission, "bash", null);
    expect(permission).toEqual({ edit: "ask" });
  });
});

describe("agent file path", () => {
  test("builds workspace-relative paths", () => {
    expect(agentFilePath("diligence-reviewer")).toBe(".opencode/agents/diligence-reviewer.md");
  });
});
