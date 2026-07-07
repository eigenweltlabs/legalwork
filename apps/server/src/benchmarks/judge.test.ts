import { describe, expect, test } from "bun:test";
import {
  buildAgentPrompt,
  buildJudgePrompt,
  buildJudgeSystemPrompt,
  parseJudgeVerdicts,
  parseJudgeVerdictsFromText,
  scoreVerdicts,
} from "./judge.js";
import type { BenchmarkTaskDefinition } from "./task-schema.js";

const TASK: BenchmarkTaskDefinition = {
  title: "Draft Tax Memo",
  workType: "draft",
  tags: ["Tax"],
  instructions: "Draft the memo covering sections A and B.",
  deliverables: ["memo.docx", "summary.md"],
  criteria: [
    { id: "C-001", title: "Has section A", deliverables: ["memo.docx"], matchCriteria: "PASS if section A present." },
    { id: "C-002", title: "Summary exists", deliverables: ["summary.md"], matchCriteria: "PASS if summary present." },
  ],
};

describe("buildAgentPrompt", () => {
  test("includes instructions, deliverable manifest and documents hint", () => {
    const prompt = buildAgentPrompt(TASK);
    expect(prompt).toContain("Draft the memo covering sections A and B.");
    expect(prompt).toContain("- memo.docx");
    expect(prompt).toContain("- summary.md");
    expect(prompt).toContain("documents/");
    expect(prompt).toContain("Work autonomously");
  });
});

describe("buildJudgePrompt (batched)", () => {
  test("lists every criterion and flags missing deliverables", () => {
    const prompt = buildJudgePrompt({
      task: TASK,
      deliverables: [
        { name: "memo.docx", relativePath: "memo.docx", size: 120 },
        { name: "summary.md", relativePath: null, size: null },
      ],
    });
    expect(prompt).toContain("## Criteria to judge (2)");
    expect(prompt).toContain("### C-001: Has section A");
    expect(prompt).toContain("### C-002: Summary exists");
    expect(prompt).toContain("PASS if section A present.");
    expect(prompt).toContain("read the file at `memo.docx`");
    expect(prompt).toContain("summary.md — MISSING");
    expect(prompt).toContain("one entry per criterion id");
  });

  test("embeds extracted deliverable content instead of a read instruction", () => {
    const prompt = buildJudgePrompt({
      task: TASK,
      deliverables: [
        { name: "memo.docx", relativePath: "memo.docx", size: 120, text: "Section A: the memo body." },
        { name: "summary.md", relativePath: null, size: null },
      ],
    });
    expect(prompt).toContain("content included below");
    expect(prompt).toContain("## Content of memo.docx");
    expect(prompt).toContain("Section A: the memo body.");
    expect(prompt).not.toContain("read the file at");
    expect(prompt).not.toContain("Read the deliverable file(s)");
  });

  test("system prompt demands independent per-criterion JSON verdicts", () => {
    const system = buildJudgeSystemPrompt();
    expect(system).toContain("INDEPENDENTLY");
    expect(system).toContain('"verdicts"');
    expect(system).toContain("one entry for every criterion");
  });
});

describe("parseJudgeVerdicts", () => {
  test("accepts structured objects and JSON strings", () => {
    const decisions = parseJudgeVerdicts({
      verdicts: [
        { id: "C-001", verdict: "pass", reasoning: "found it" },
        { id: "C-002", verdict: "FAIL", reasoning: "missing" },
      ],
    });
    expect(decisions?.get("C-001")).toEqual({ verdict: "pass", reasoning: "found it" });
    expect(decisions?.get("C-002")).toEqual({ verdict: "fail", reasoning: "missing" });

    const fromString = parseJudgeVerdicts('{"verdicts": [{"id": "C-001", "verdict": "pass", "reasoning": "ok"}]}');
    expect(fromString?.size).toBe(1);
  });

  test("skips malformed entries and rejects malformed shapes", () => {
    const partial = parseJudgeVerdicts({
      verdicts: [
        { id: "C-001", verdict: "maybe", reasoning: "?" },
        { id: "C-002", verdict: "pass", reasoning: "ok" },
      ],
    });
    expect(partial?.size).toBe(1);
    expect(partial?.has("C-001")).toBe(false);

    expect(parseJudgeVerdicts(null)).toBeNull();
    expect(parseJudgeVerdicts({ verdicts: "nope" })).toBeNull();
    expect(parseJudgeVerdicts({ verdicts: [] })).toBeNull();
    expect(parseJudgeVerdicts("not json")).toBeNull();
  });
});

describe("parseJudgeVerdictsFromText", () => {
  test("parses bare JSON replies", () => {
    const decisions = parseJudgeVerdictsFromText(
      '  {"verdicts": [{"id": "C-001", "verdict": "pass", "reasoning": "ok"}]}  ',
    );
    expect(decisions?.get("C-001")?.verdict).toBe("pass");
  });

  test("extracts the verdicts from prose, fences and thinking-style replies", () => {
    const fenced =
      'Here are my verdicts:\n```json\n{"verdicts": [{"id": "C-001", "verdict": "fail", "reasoning": "missing {section}"}]}\n```\nDone.';
    expect(parseJudgeVerdictsFromText(fenced)?.get("C-001")?.verdict).toBe("fail");

    const thinking = [
      'First I thought {"verdicts": [{"id": "C-001", "verdict": "fail", "reasoning": "initial hunch"}]} but re-reading,',
      "the section is clearly present.",
      '{"verdicts": [{"id": "C-001", "verdict": "pass", "reasoning": "section found"}]}',
    ].join("\n");
    expect(parseJudgeVerdictsFromText(thinking)?.get("C-001")).toEqual({
      verdict: "pass",
      reasoning: "section found",
    });
  });

  test("returns null for garbage", () => {
    expect(parseJudgeVerdictsFromText("no json here")).toBeNull();
    expect(parseJudgeVerdictsFromText('The config is {"a": 1} and nothing else.')).toBeNull();
    expect(parseJudgeVerdictsFromText("")).toBeNull();
  });
});

describe("scoreVerdicts", () => {
  test("all-pass scoring", () => {
    expect(scoreVerdicts([{ verdict: "pass" }, { verdict: "pass" }])).toEqual({
      score: 1,
      nCriteria: 2,
      nPassed: 2,
    });
    expect(scoreVerdicts([{ verdict: "pass" }, { verdict: "fail" }])).toEqual({
      score: 0,
      nCriteria: 2,
      nPassed: 1,
    });
    // judge errors count as failures
    expect(scoreVerdicts([{ verdict: "pass" }, { verdict: "error" }])).toEqual({
      score: 0,
      nCriteria: 2,
      nPassed: 1,
    });
    expect(scoreVerdicts([])).toEqual({ score: 0, nCriteria: 0, nPassed: 0 });
  });
});
