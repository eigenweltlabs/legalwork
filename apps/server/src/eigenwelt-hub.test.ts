import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildIntegrationPayload,
  installWorkflowFiles,
  parseIntegrationPayload,
  serializeWorkflowSkill,
  validateHubFilePath,
  validateHubName,
  EIGENWELT_HUB_MAX_PAYLOAD_BYTES,
} from "./eigenwelt-hub.js";
import { parseEigenweltAccountIdentity, parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { ApiError } from "./errors.js";

const cleanups: Array<() => Promise<void> | void> = [];
const originalConfigHome = process.env.XDG_CONFIG_HOME;
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hub-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSkill(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, ".opencode", "skills", name);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

function useIsolatedConfigHome(root: string): string {
  const configHome = join(root, "xdg-config");
  process.env.XDG_CONFIG_HOME = configHome;
  return join(configHome, "opencode", "skills");
}

describe("validateHubFilePath", () => {
  test("accepts safe relative paths", () => {
    expect(validateHubFilePath("SKILL.md")).toBe("SKILL.md");
    expect(validateHubFilePath("resources/playbook.md")).toBe("resources/playbook.md");
    expect(validateHubFilePath("resources/nested/x.txt")).toBe("resources/nested/x.txt");
  });

  test("rejects absolute, traversal and backslash paths", () => {
    for (const bad of [
      "/etc/passwd",
      "../secret",
      "resources/../../escape",
      "resources/..",
      "C:\\Windows\\system32",
      "resources\\win.md",
      "..\\..\\x",
      "",
      "   ",
      "a//b",
    ]) {
      expect(() => validateHubFilePath(bad)).toThrow(ApiError);
    }
  });
});

describe("validateHubName", () => {
  test("accepts and rejects per platform rules", () => {
    expect(validateHubName("firm-nda-review")).toBe("firm-nda-review");
    expect(validateHubName("A_b-9")).toBe("A_b-9");
    expect(() => validateHubName("-leading")).toThrow(ApiError);
    expect(() => validateHubName("has space")).toThrow(ApiError);
    expect(() => validateHubName("a".repeat(101))).toThrow(ApiError);
  });
});

describe("serializeWorkflowSkill", () => {
  test("serializes SKILL.md + resources to base64 files", async () => {
    const root = await makeWorkspace();
    await writeSkill(root, "nda-review", {
      "SKILL.md": "---\nname: nda-review\ndescription: Review NDAs\n---\nBody\n",
      "resources/checklist.md": "1. Parties\n2. Term\n",
    });

    const { files } = await serializeWorkflowSkill(root, "nda-review");
    const byPath = new Map(files.map((f) => [f.path, f.contentBase64]));
    expect(byPath.has("SKILL.md")).toBe(true);
    expect(byPath.has("resources/checklist.md")).toBe(true);
    expect(Buffer.from(byPath.get("resources/checklist.md")!, "base64").toString("utf8")).toBe(
      "1. Parties\n2. Term\n",
    );
  });

  test("rejects a folder missing SKILL.md", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, ".opencode", "skills", "empty-one"), { recursive: true });
    await writeFile(join(root, ".opencode", "skills", "empty-one", "notes.md"), "x", "utf8");
    // resolveSkillDir requires a SKILL.md to find the folder at all → 404.
    await expect(serializeWorkflowSkill(root, "empty-one")).rejects.toThrow(ApiError);
  });

  test("rejects a workflow whose JSON payload exceeds 20 MiB", async () => {
    const root = await makeWorkspace();
    const big = "x".repeat(EIGENWELT_HUB_MAX_PAYLOAD_BYTES); // base64 inflates ~4/3 → > 20 MiB
    await writeSkill(root, "huge", {
      "SKILL.md": "---\nname: huge\ndescription: Big\n---\n",
      "resources/big.bin": big,
    });
    await expect(serializeWorkflowSkill(root, "huge")).rejects.toMatchObject({ status: 413 });
  });
});

describe("installWorkflowFiles", () => {
  test("writes a workflow folder into the global skills dir", async () => {
    const root = await makeWorkspace();
    const skillsDir = useIsolatedConfigHome(root);
    const result = await installWorkflowFiles(root, "shared-flow", [
      { path: "SKILL.md", contentBase64: Buffer.from("---\nname: shared-flow\ndescription: d\n---\n").toString("base64") },
      { path: "resources/tpl.md", contentBase64: Buffer.from("hello").toString("base64") },
    ]);
    expect(result.written).toBe(2);
    const written = await readFile(join(skillsDir, "shared-flow", "resources", "tpl.md"), "utf8");
    expect(written).toBe("hello");
  });

  test("rejects a payload with a traversal path before writing anything", async () => {
    const root = await makeWorkspace();
    useIsolatedConfigHome(root);
    await expect(
      installWorkflowFiles(root, "evil", [
        { path: "SKILL.md", contentBase64: Buffer.from("x").toString("base64") },
        { path: "../../escape.md", contentBase64: Buffer.from("pwn").toString("base64") },
      ]),
    ).rejects.toThrow(ApiError);
    // The bad path is refused, so no partial write escapes the install root.
    await expect(readFile(join(root, "..", "escape.md"), "utf8")).rejects.toBeDefined();
  });

  test("rejects an absolute path", async () => {
    const root = await makeWorkspace();
    useIsolatedConfigHome(root);
    await expect(
      installWorkflowFiles(root, "evil2", [
        { path: "SKILL.md", contentBase64: Buffer.from("x").toString("base64") },
        { path: "/tmp/escape.md", contentBase64: Buffer.from("pwn").toString("base64") },
      ]),
    ).rejects.toThrow(ApiError);
  });

  test("rejects files without SKILL.md", async () => {
    const root = await makeWorkspace();
    useIsolatedConfigHome(root);
    await expect(
      installWorkflowFiles(root, "noskill", [
        { path: "resources/x.md", contentBase64: Buffer.from("x").toString("base64") },
      ]),
    ).rejects.toThrow(ApiError);
  });

  test("rejects duplicate paths and malformed base64 before writing", async () => {
    const root = await makeWorkspace();
    useIsolatedConfigHome(root);
    await expect(installWorkflowFiles(root, "duplicates", [
      { path: "SKILL.md", contentBase64: "eA==" },
      { path: "SKILL.md", contentBase64: "eQ==" },
    ])).rejects.toThrow(ApiError);
    await expect(installWorkflowFiles(root, "bad-base64", [
      { path: "SKILL.md", contentBase64: "not base64!" },
    ])).rejects.toThrow(ApiError);
  });

  test("refuses a symlinked workflow destination", async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    const skillsDir = useIsolatedConfigHome(root);
    await mkdir(skillsDir, { recursive: true });
    await symlink(outside, join(skillsDir, "linked"));
    await expect(installWorkflowFiles(root, "linked", [
      { path: "SKILL.md", contentBase64: "eA==" },
    ])).rejects.toThrow(ApiError);
  });

  test("rejects nested symlinks before creating directories or writing files", async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    const skillsDir = useIsolatedConfigHome(root);
    const installRoot = join(skillsDir, "nested-link");
    await mkdir(installRoot, { recursive: true });
    await symlink(outside, join(installRoot, "resources"));
    await expect(installWorkflowFiles(root, "nested-link", [
      { path: "SKILL.md", contentBase64: "eA==" },
      { path: "resources/created-outside/x.md", contentBase64: "eA==" },
    ])).rejects.toThrow(ApiError);
    await expect(readFile(join(installRoot, "SKILL.md"), "utf8")).rejects.toBeDefined();
    await expect(readFile(join(outside, "created-outside", "x.md"), "utf8")).rejects.toBeDefined();
  });
});

describe("integration payloads", () => {
  test("build + parse round-trips a remote MCP entry", () => {
    const payload = buildIntegrationPayload("highq", { type: "remote", url: "https://acme.highq.com/mcp" });
    expect(payload.key).toBe("highq");
    const parsed = parseIntegrationPayload(payload);
    expect(parsed.key).toBe("highq");
    expect(parsed.mcp.url).toBe("https://acme.highq.com/mcp");
  });

  test("rejects an integration payload with an invalid MCP config", () => {
    expect(() => parseIntegrationPayload({ key: "x", mcp: { type: "bogus" } })).toThrow(ApiError);
    expect(() => parseIntegrationPayload({ key: "", mcp: { type: "remote", url: "https://x.dev" } })).toThrow(ApiError);
    expect(() => parseIntegrationPayload(null)).toThrow(ApiError);
  });
});

describe("parseEigenweltEntitlements", () => {
  test("returns undefined for absent / non-object input (legacy platform)", () => {
    expect(parseEigenweltEntitlements(undefined)).toBeUndefined();
    expect(parseEigenweltEntitlements(null)).toBeUndefined();
    expect(parseEigenweltEntitlements("plus")).toBeUndefined();
  });

  test("normalizes a full entitlements block and filters unknown features", () => {
    const parsed = parseEigenweltEntitlements({
      plan: "pro",
      subscriptionStatus: "active",
      features: ["admin_hub", "settings_presets", "not_a_feature", "org_management", "premium_models"],
      seats: 12,
      usage: {
        dailyAllowanceCents: 5000,
        dailyRemainingCents: 1200,
        dailyUsedPercent: 76,
        extraUsageEnabled: true,
        prepaidBalanceCents: 900,
      },
    });
    expect(parsed).toEqual({
      plan: "pro",
      subscriptionStatus: "active",
      features: ["admin_hub", "settings_presets", "org_management", "premium_models"],
      seats: 12,
      usage: {
        dailyAllowanceCents: 5000,
        dailyRemainingCents: 1200,
        dailyUsedPercent: 76,
        extraUsageEnabled: true,
        prepaidBalanceCents: 900,
      },
    });
  });

  test("derives dailyUsedPercent from cents when a legacy platform omits it", () => {
    const parsed = parseEigenweltEntitlements({
      plan: "pro",
      usage: { dailyAllowanceCents: 5000, dailyRemainingCents: 1200 },
    });
    // (5000 - 1200) / 5000 = 76%
    expect(parsed?.usage.dailyUsedPercent).toBe(76);
  });

  test("defaults malformed numeric / plan fields safely", () => {
    const parsed = parseEigenweltEntitlements({ plan: "enterprise", features: "nope", usage: null });
    expect(parsed).toEqual({
      plan: null,
      subscriptionStatus: null,
      features: [],
      seats: 0,
      usage: {
        dailyAllowanceCents: 0,
        dailyRemainingCents: 0,
        dailyUsedPercent: 0,
        extraUsageEnabled: false,
        prepaidBalanceCents: 0,
      },
    });
  });
});

describe("parseEigenweltAccountIdentity", () => {
  test("normalizes safe account fields", () => {
    expect(
      parseEigenweltAccountIdentity({
        userId: " user_123 ",
        userName: " Ada Lovelace ",
        userEmail: " ada@example.com ",
        orgId: " org_123 ",
        orgName: " Analytical Engine LLP ",
      }),
    ).toEqual({
      userId: "user_123",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      orgId: "org_123",
      orgName: "Analytical Engine LLP",
    });
  });

  test("rejects incomplete identity and normalizes optional user fields", () => {
    expect(parseEigenweltAccountIdentity({ userId: "user_123", orgId: "org_123" })).toBeUndefined();
    expect(
      parseEigenweltAccountIdentity({
        userId: "user_123",
        userName: " ",
        orgId: "org_123",
        orgName: "Firm",
      }),
    ).toEqual({
      userId: "user_123",
      userName: null,
      userEmail: null,
      orgId: "org_123",
      orgName: "Firm",
    });
  });
});
