import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LegalWorkSkillTools,
  buildSkillMarkdown,
  fitSkillName,
  resolveSkillName,
} from "./legalwork-skill-tools.js";

type Recorded = { url: string; method: string; body: Record<string, unknown> | null };

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LEGALWORK_SERVER_URL;
const originalToken = process.env.LEGALWORK_SERVER_TOKEN;

let requests: Recorded[] = [];
let installedNames: string[] = [];

// The office-plugin-shared workspace lookup caches per URL, so every test hits
// the same server URL and workspace to keep the cache consistent.
const SERVER_URL = "http://127.0.0.1:9911";
const WORKSPACE = { id: "ws-1", path: "/firm/matters" };

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ url, method, body });

    const path = url.slice(SERVER_URL.length);
    if (path === "/workspaces") {
      return new Response(JSON.stringify({ items: [WORKSPACE] }), { status: 200 });
    }
    if (path.startsWith("/workspace/ws-1/skills?")) {
      return new Response(JSON.stringify({ items: installedNames.map((name) => ({ name, scope: "global" })) }), {
        status: 200,
      });
    }
    if (path === "/workspace/ws-1/skills" && method === "POST") {
      const name = String(body?.name ?? "");
      installedNames.push(name);
      return new Response(
        JSON.stringify({ name, path: `/config/opencode/skills/${name}/SKILL.md`, scope: "global" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: `unexpected ${method} ${path}` }), { status: 404 });
  }) as typeof fetch;
}

async function createSkill(args: Record<string, unknown>) {
  const plugin = await LegalWorkSkillTools();
  const raw = await plugin.tool.legalwork_skill_create.execute(args, { directory: WORKSPACE.path });
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  requests = [];
  installedNames = [];
  process.env.LEGALWORK_SERVER_URL = SERVER_URL;
  process.env.LEGALWORK_SERVER_TOKEN = "test-token";
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
  else process.env.LEGALWORK_SERVER_URL = originalUrl;
  if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
  else process.env.LEGALWORK_SERVER_TOKEN = originalToken;
});

describe("skill naming", () => {
  test("slugifies a free-text name, transliterating umlauts", () => {
    expect(fitSkillName("Antrag Baugenehmigung (Bayern)")).toBe("antrag-baugenehmigung-bayern");
  });

  test("drops whole trailing words to fit the 64-char tool-name cap", () => {
    const fitted = fitSkillName("workflow assistant a very long german sounding workflow name that keeps going forever");
    expect(fitted.length).toBeLessThanOrEqual(64);
    expect(fitted.endsWith("-")).toBe(false);
    expect(fitted.startsWith("workflow-assistant-a-very-long")).toBe(true);
  });

  test("marks workflows with the workflow-<type>- prefix the app filters on", () => {
    expect(resolveSkillName({ name: "NDA review", kind: "workflow", workflowType: "assistant" })).toBe(
      "workflow-assistant-nda-review",
    );
    expect(resolveSkillName({ name: "Lease terms", kind: "workflow", workflowType: "tabular" })).toBe(
      "workflow-tabular-lease-terms",
    );
    expect(resolveSkillName({ name: "NDA review", kind: "skill", workflowType: "assistant" })).toBe("nda-review");
  });

  test("does not stack the prefix when the name already carries one", () => {
    expect(
      resolveSkillName({ name: "workflow-assistant-nda-review", kind: "workflow", workflowType: "assistant" }),
    ).toBe("workflow-assistant-nda-review");
  });
});

describe("SKILL.md content", () => {
  test("keeps frontmatter to name + description so the engine loads it", () => {
    const md = buildSkillMarkdown({
      fullName: "workflow-assistant-nda-review",
      description: 'Use when reviewing an "NDA".',
      instructions: "Do the review.",
      kind: "workflow",
      workflowType: "assistant",
    });
    expect(md.startsWith('---\nname: workflow-assistant-nda-review\ndescription: "Use when reviewing an \\"NDA\\"."\n---\n')).toBe(true);
    expect(md).not.toContain("kind: workflow");
    expect(md).toContain("Do the review.");
  });

  test("routes a tabular workflow through the tabular-review skill", () => {
    const md = buildSkillMarkdown({
      fullName: "workflow-tabular-lease-terms",
      description: "Use when comparing lease terms.",
      instructions: "Rent, term, break clause",
      kind: "workflow",
      workflowType: "tabular",
    });
    expect(md).toContain("# Lease Terms");
    expect(md).toContain("`tabular-review`");
    expect(md).toContain("Rent, term, break clause");
  });
});

describe("legalwork_skill_create", () => {
  // The desktop Skills/Workflows screens list the shared library only — a skill
  // written into the workspace never shows up there.
  test("installs into the shared library, not the workspace", async () => {
    const result = await createSkill({
      name: "NDA review",
      description: "Use when a counterparty sends an NDA.",
      instructions: "Review the NDA against the firm playbook.",
      kind: "workflow",
    });

    expect(result).toMatchObject({ ok: true, name: "workflow-assistant-nda-review", kind: "workflow" });
    const post = requests.find((entry) => entry.method === "POST");
    expect(post?.url).toBe(`${SERVER_URL}/workspace/ws-1/skills`);
    expect(post?.body).toMatchObject({ name: "workflow-assistant-nda-review", scope: "global" });
  });

  test("refuses to silently replace an existing name", async () => {
    installedNames.push("workflow-assistant-nda-review");
    const result = await createSkill({
      name: "NDA review",
      description: "Use when a counterparty sends an NDA.",
      instructions: "Review it.",
      kind: "workflow",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("already exists");
    expect(requests.some((entry) => entry.method === "POST")).toBe(false);
  });

  test("overwrites when asked", async () => {
    installedNames.push("workflow-assistant-nda-review");
    const result = await createSkill({
      name: "NDA review",
      description: "Use when a counterparty sends an NDA.",
      instructions: "Review it.",
      kind: "workflow",
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    expect(requests.some((entry) => entry.method === "POST")).toBe(true);
  });

  test("reports a missing server connection instead of throwing", async () => {
    delete process.env.LEGALWORK_SERVER_TOKEN;
    const result = await createSkill({
      name: "NDA review",
      description: "Use when a counterparty sends an NDA.",
      instructions: "Review it.",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("not configured");
  });
});

describe("system prompt", () => {
  test("tells the agent the tool is the only path into the app", async () => {
    const plugin = await LegalWorkSkillTools();
    const output: { system: string[] } = { system: [] };
    await plugin["experimental.chat.system.transform"](null, output);
    expect(output.system.join("\n")).toContain("legalwork_skill_create");
  });
});
