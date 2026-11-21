import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("review keeps stale selections out of approvals and preserves invoice preview", () => {
  const result = Bun.spawnSync(
    [process.execPath, fileURLToPath(new URL("./fixtures/billing-review.tsx", import.meta.url))],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Billing review passed");
}, 30_000);

test("wording proposals apply the client vocabulary literally and preserve the service details", async () => {
  const { resolveTimePolicy } = await import("@legalwork/types/timesheet");
  const { suggestBillingNarrative } = await import("@legalwork/types/billing-narrative");
  const common = { effectiveFrom: "2026-01-01", revision: 1 };
  const policy = resolveTimePolicy(
    [
      {
        ...common,
        scope: "firm",
        targetId: "firm",
        language: "en",
        actionFirst: true,
        narrativeCorrections: { "att.": "attachment", "doc(x)": "document" },
      },
      {
        ...common,
        scope: "client",
        targetId: "c",
        actionWords: { MOD: "Revising" },
        narrativeCorrections: { "att.": "appendix" },
      },
    ],
    "c",
    "m",
    "2026-05-01",
  );
  expect(suggestBillingNarrative({ narrative: "Memo att. amended", activity: "MOD" }, policy)).toBe(
    "Revising Memo appendix",
  );
  expect(
    suggestBillingNarrative({ narrative: "Reviewing doc(x) and docx", activity: "DR" }, policy),
  ).toBe("Reviewing document and docx");
  expect(
    suggestBillingNarrative({ narrative: "Reviewing statutes", activity: "RES" }, policy),
  ).toBeUndefined();
  expect(suggestBillingNarrative({ narrative: "Ammending memo", activity: "MOD" }, policy)).toBe(
    "Amending memo",
  );
});
