import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JevSearchAnswerCounts, withLatestJevSearchProgress } from "../src/components/chat/review/jev-search-card";
import { JevSearchProgressSchema } from "@legalwork/types/corpus";
import type { DynamicToolUIPart } from "ai";

const jobId = "066576b9-cde7-45d7-aa21-30d9cbdb96e9";
const progress = JevSearchProgressSchema.parse({ jobId, status: "complete", total: 5000, processed: 5000,
  question: "Is this document a contract?", counts: { Contract: 740, Resolution: 60, Operational: 4200, error: 0 } });
test("answer counts remain literal, include zero answers and expose selection accessibly", () => {
  const html = renderToStaticMarkup(<JevSearchAnswerCounts progress={progress} selectedAnswer="Contract" disabled={false} onSelect={() => {}} />);
  expect(html).toContain("4200"); expect(html).toContain("740"); expect(html).toContain("Resolution");
  expect(html).toContain('aria-pressed="true"'); expect(html).toContain('type="button"');
  const pending = renderToStaticMarkup(<JevSearchAnswerCounts progress={{ ...progress, status: "running" }} selectedAnswer={null} disabled onSelect={() => {}} />);
  expect(pending).toContain("disabled");
});
test("reopened older cards can acquire the saved question without increasing progress", () => {
  const { question: _, ...old } = progress;
  const first: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_jev_corpus_question", toolCallId: "first", state: "output-available", input: {}, output: { ok: true, workspaceId: "project", data: old } };
  const next: DynamicToolUIPart = { ...first, output: { ok: true, workspaceId: "project", data: progress } };
  expect(withLatestJevSearchProgress(first, next).output).toEqual(next.output);
});
