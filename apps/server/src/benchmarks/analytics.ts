/**
 * Cross-run model analytics: aggregate the latest judged result per
 * (task, model) into per-model overall + per-practice-area (vertical) scores.
 * Pure and testable — the store supplies the rows, this reduces them.
 */

/** One "latest per (task, model)" row from the store. */
export type AnalyticsRow = {
  taskKey: string;
  providerID: string;
  modelID: string;
  vertical: string;
  tags: string[];
  nPassed: number | null;
  nCriteria: number | null;
};

export type AnalyticsStat = {
  /** Mean rubric pass rate (0–1), or null when nothing judged. */
  rate: number | null;
  /** Number of judged tasks contributing. */
  tasks: number;
  criteriaPassed: number;
  criteriaTotal: number;
};

export type ModelAnalytics = {
  providerID: string;
  modelID: string;
  overall: AnalyticsStat;
  /** Per-tag breakdown: a task contributes to every tag it carries. */
  byTag: Array<{ tag: string } & AnalyticsStat>;
};

export type BenchmarkAnalytics = {
  /** Models ranked by overall mean rubric pass rate (best first). */
  models: ModelAnalytics[];
  /** All tags across judged results (unfiltered), for the tag filter. */
  tags: string[];
};

type Acc = { rateSum: number; n: number; criteriaPassed: number; criteriaTotal: number };

function newAcc(): Acc {
  return { rateSum: 0, n: 0, criteriaPassed: 0, criteriaTotal: 0 };
}

function accumulate(acc: Acc, rate: number, passed: number, total: number): void {
  acc.rateSum += rate;
  acc.n += 1;
  acc.criteriaPassed += passed;
  acc.criteriaTotal += total;
}

function finalize(acc: Acc): AnalyticsStat {
  return {
    rate: acc.n ? acc.rateSum / acc.n : null,
    tasks: acc.n,
    criteriaPassed: acc.criteriaPassed,
    criteriaTotal: acc.criteriaTotal,
  };
}

export function aggregateModelAnalytics(rows: AnalyticsRow[], filterTags: string[] = []): BenchmarkAnalytics {
  const judged = rows.filter((row) => row.nPassed !== null && row.nCriteria !== null && row.nCriteria > 0);

  // Available tags stay stable across filter changes: computed from all judged rows.
  const allTags = new Set<string>();
  for (const row of judged) for (const tag of row.tags) if (tag.trim()) allTags.add(tag.trim());

  const wanted = new Set(filterTags.map((tag) => tag.trim()).filter(Boolean));
  const selected = wanted.size ? judged.filter((row) => row.tags.some((tag) => wanted.has(tag.trim()))) : judged;

  const models = new Map<string, { providerID: string; modelID: string; all: Acc; byTag: Map<string, Acc> }>();

  for (const row of selected) {
    const passed = row.nPassed as number;
    const total = row.nCriteria as number;
    const rate = passed / total;
    const modelKey = `${row.providerID}/${row.modelID}`;
    let model = models.get(modelKey);
    if (!model) {
      model = { providerID: row.providerID, modelID: row.modelID, all: newAcc(), byTag: new Map() };
      models.set(modelKey, model);
    }
    accumulate(model.all, rate, passed, total);
    for (const rawTag of row.tags) {
      const tag = rawTag.trim();
      if (!tag) continue;
      let tagAcc = model.byTag.get(tag);
      if (!tagAcc) {
        tagAcc = newAcc();
        model.byTag.set(tag, tagAcc);
      }
      accumulate(tagAcc, rate, passed, total);
    }
  }

  const modelList: ModelAnalytics[] = Array.from(models.values())
    .map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      overall: finalize(model.all),
      byTag: Array.from(model.byTag.entries()).map(([tag, acc]) => ({ tag, ...finalize(acc) })),
    }))
    .sort((a, b) => (b.overall.rate ?? -1) - (a.overall.rate ?? -1));

  return { models: modelList, tags: Array.from(allTags).sort((a, b) => a.localeCompare(b)) };
}
