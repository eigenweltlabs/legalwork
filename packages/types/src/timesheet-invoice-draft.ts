import { checkBillingNarrative } from "@legalwork/types/billing-narrative";
import { allocateInvoiceMinor, currencyScale, reducedInvoiceMinor, standardInvoice, timeFeeMinor } from "@legalwork/types/invoice-template";
import {
  hasTimeEntryPrice, isHourlyInvoiceLine, TimeDraftSchema, type resolveTimePolicy, type InvoiceDraftInput,
  type InvoiceWordingSuggestion, type TimeEntry, type TimeInvoiceDraft, type TimesheetState, type TimeAdjustment,
} from "@legalwork/types/timesheet";

type InvoiceDraftServices = {
  timeError: (message: string, status?: number) => never;
  invoiceLines: (entries: TimeEntry[], adjustments: TimeAdjustment[], expected: InvoiceDraftInput["adjustmentVersions"]) => TimeEntry[];
  invoiceWordingRules: (state: TimesheetState, entry: TimeEntry) => {
    policy: ReturnType<typeof resolveTimePolicy>;
    wording: ReturnType<typeof resolveTimePolicy>;
    versions: { id: string; revision: number; name: string; effectiveFrom: string }[];
  };
  newId: () => string;
};

function localDay() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function selectedLines(
  timeError: InvoiceDraftServices["timeError"],
  input: InvoiceDraftInput,
  entries: TimeEntry[],
  canReview: (entry: TimeEntry) => boolean,
) {
  const { period, matterId, clientId, pricing } = input;
  const selectedCurrency = pricing.mode === "hourly" ? pricing.currency : undefined;
  if (period.from && period.from > period.to)
    timeError("Choose a valid service period.");
  const eligible = entries.filter(
    (entry) =>
      entry.status === "approved" &&
      !entry.legacy &&
      entry.billable &&
      entry.matterId === matterId &&
      entry.clientId === clientId &&
      entry.date <= period.to &&
      (!period.from || period.from <= entry.date),
  );
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const unique = new Set(input.entries.map((entry) => entry.id));
  if (unique.size !== input.entries.length)
    timeError("Select each revision once.");
  const selected = input.entries.map((ref) => {
    const entry = byId.get(ref.id);
    if (!entry || entry.revision !== ref.revision)
      timeError(
        "An approved billing line changed or is no longer open. Refresh the invoice draft.",
        409,
      );
    return entry;
  });
  const matchesCurrency = (entry: TimeEntry) =>
    !selectedCurrency || (entry.currency === selectedCurrency && isHourlyInvoiceLine(entry));
  if (selected.some((entry) => !matchesCurrency(entry)))
    timeError("Select approved, priced billing lines in the invoice currency.", 409);
  if (!period.from && selected.length !== eligible.filter((entry) => matchesCurrency(entry) && canReview(entry)).length)
    timeError("The open entries through this date changed. Refresh and preview all open entries again.", 409);
  return selected;
}

export function calculateInvoiceDraft(
  services: InvoiceDraftServices,
  state: TimesheetState,
  input: InvoiceDraftInput,
  canReview: (entry: TimeEntry) => boolean,
  validateEntry: (entry: TimeEntry) => void,
  digest: (data: unknown) => string,
  previous?: TimeInvoiceDraft,
  advice?: InvoiceWordingSuggestion[],
): TimeInvoiceDraft {
  const timeError: InvoiceDraftServices["timeError"] = services.timeError;
  const { invoiceLines, invoiceWordingRules, newId } = services;
  const { matterId, clientId, pricing, reduction } = input;
  const matter = state.matters.find(({ id }) => id === matterId);
  const client = state.clients.find(({ id }) => id === clientId);
  if (!matter || !client || !matter.clientIds.includes(clientId))
    timeError("The selected matter or its billing client is unavailable.", 404);
  const originals = selectedLines(timeError, input, state.entries, canReview);
  const entries = invoiceLines(
    originals,
    state.adjustments ?? [],
    input.adjustmentVersions,
  );
  for (const entry of originals) validateEntry(entry);
  const currency = pricing.currency ?? entries[0].currency;
  if (
    !currency ||
    (pricing.mode === "hourly" &&
      entries.some(
        (entry) =>
          !isHourlyInvoiceLine(entry) || entry.currency !== currency,
      ))
  )
    timeError(
      "Hourly invoicing requires approved, priced billing lines in one currency.",
      409,
    );
  const scale = currencyScale(currency);
  const fixedShares =
    pricing.mode === "fixed"
      ? allocateInvoiceMinor(
          pricing.amountMinor,
          entries.map(({ id, workedMinutes }) => ({
            id,
            weight: workedMinutes,
          })),
        )
      : undefined;
  const wording = new Set(input.wording);
  if (wording.size !== input.wording.length)
    timeError("Choose each wording correction once.");
  const expectedSuggestions = new Map(
    input.expectedSuggestions?.map(({ id, narrative }) => [id, narrative]),
  );
  if (
    expectedSuggestions.size !== (input.expectedSuggestions?.length ?? 0) ||
    [...expectedSuggestions.keys()].some((id) => !wording.has(id))
  )
    timeError("Choose each expected wording correction once.");
  const edits = new Map(
    input.edits?.map(({ id, narrative }) => [id, narrative]),
  );
  if (
    edits.size !== (input.edits?.length ?? 0) ||
    [...edits.keys()].some((id) => wording.has(id))
  )
    timeError("Use one wording decision per invoice line.");
  const governed = entries.map((entry) => ({
    entry,
    ...invoiceWordingRules(state, entry),
  }));
  const guidelineDigests = new Map<string, string>();
  const modelBasis = digest(
    governed.map(({ entry, policy, wording, versions }) => {
      const imported = versions.map((version) => {
        const key = `${version.id}/${version.revision}`;
        let value = guidelineDigests.get(key);
        if (value === undefined) {
          value = digest(version);
          guidelineDigests.set(key, value);
        }
        return value;
      });
      return [
        entry.id,
        entry.revision,
        entry.narrative,
        policy,
        wording,
        imported,
      ];
    }),
  );
  const template = state.template ?? standardInvoice;
  const snapshot = {
    date: localDay(),
    client: client.name,
    clientAddress: client.billingAddress ?? "",
    template,
    wordTemplateRevision: template.word ? template.revision : undefined,
  };
  const sameWordingContext = previous?.modelBasis === modelBasis;
  const modelWording = advice ?? (
    sameWordingContext &&
    digest(previous.input) === digest(input) &&
    digest(previous.snapshot) === digest(snapshot)
      ? previous.modelWording
      : undefined
  );
  const modelHints = new Map(modelWording?.map((hint) => [hint.id, hint]));
  const priorHints = new Map(
    sameWordingContext ? previous.modelWording?.map((hint) => [hint.id, hint]) : undefined,
  );
  const priorSelections = new Set(previous?.input.wording);
  const priorLines = new Map(previous?.lines.map((line) => [line.entry.id, line]));
  const lines = governed.map(
    ({ entry, policy, wording: wordingPolicy, versions }) => {
      if (policy.ambiguousAgreement)
        timeError(
          "Resolve the applicable fee agreement before invoicing.",
          409,
        );
      if (
        policy.nonHourlyBasis === "tariff" ||
        entry.nonHourlyBasis === "tariff"
      )
        timeError("Tariff billing is not supported in Create Invoice.", 409);
      if (pricing.mode === "hourly" && policy.nonHourlyAgreement)
        timeError("Choose fixed-price billing for this fee agreement.", 409);
      const apply = wording.delete(entry.id);
      const expected = expectedSuggestions.get(entry.id);
      const priorLine = priorLines.get(entry.id);
      const priorNarrative = priorSelections.has(entry.id) &&
        priorLine?.entry.revision === entry.revision &&
        priorLine.currentNarrative === entry.narrative
        ? priorLine.entry.narrative
        : undefined;
      const priorHint = priorHints.get(entry.id)?.narrative;
      const originalCheck = checkBillingNarrative(entry, wordingPolicy);
      // A new review offers changes to the result, independently of any correction already selected.
      const selectedNarrative = apply
        ? [priorNarrative, priorHint, originalCheck?.narrative].find(
            (candidate) => candidate !== undefined && (expected === undefined || expected === candidate),
          )
        : undefined;
      if (apply && !selectedNarrative)
        timeError(
          "A wording correction changed. Refresh the invoice preview.",
          409,
        );
      if (
        apply &&
        !TimeDraftSchema.shape.narrative.safeParse(selectedNarrative).success
      )
        timeError(
          "A wording correction is too long for the invoice line. Review the billing text first.",
          409,
        );
      const edited = edits.get(entry.id);
      const narrative = edited ?? selectedNarrative ?? entry.narrative;
      const hint = modelHints.get(entry.id);
      const suggestedNarrative = hint?.narrative ?? selectedNarrative ?? originalCheck?.narrative;
      edits.delete(entry.id);
      const baseAmountMinor =
        fixedShares?.get(entry.id) ??
        timeFeeMinor(entry.billableMinutes, entry.hourlyRate ?? 0, scale);
      const actualAmountMinor =
        hasTimeEntryPrice(entry) && entry.currency === currency
          ? timeFeeMinor(entry.workedMinutes, entry.hourlyRate, scale)
          : undefined;
      return {
        entry: {
          ...entry,
          narrative,
          history: [],
          proposalDigest: undefined,
          sharedOriginal: undefined,
          suggestion: undefined,
        },
        originalNarrative: entry.submittedNarrative ?? entry.narrative,
        currentNarrative: entry.narrative,
        suggestedNarrative,
        modelRule: hint?.rule,
        rules: hint
          ? []
          : [...(originalCheck?.replacements ?? [])].map(
              ([before, after]) => before + " → " + after,
            ),
        actionFirst: hint ? undefined : originalCheck?.actionFirst,
        guidelineVersions: versions.length
          ? versions.map(({ id, revision, name, effectiveFrom }) => ({
              id,
              revision,
              name,
              effectiveFrom,
            }))
          : undefined,
        actualAmountMinor,
        baseAmountMinor,
        amountMinor: baseAmountMinor,
      };
    },
  );
  if (wording.size || edits.size)
    timeError("A wording change is outside this invoice.", 409);
  const scope = reduction?.scope;
  const scopeIds = new Set(scope && scope.type !== "all" ? scope.ids : []);
  const scopeId = (line: (typeof lines)[number]) =>
    scope?.type === "people" ? line.entry.workerId : line.entry.id;
  if (
    scope &&
    scope.type !== "all" &&
    (scopeIds.size !== scope.ids.length ||
      [...scopeIds].some((id) => !lines.some((line) => scopeId(line) === id)))
  )
    timeError("A selected person or line is outside this invoice.", 409);
  const selected = lines.filter(
    (line) => !scope || scope.type === "all" || scopeIds.has(scopeId(line)),
  );
  const selectedBaseMinor = selected.reduce(
    (sum, line) => sum + line.baseAmountMinor,
    0,
  );
  const baseMinor = lines.reduce((sum, line) => sum + line.baseAmountMinor, 0);
  if (!Number.isSafeInteger(baseMinor))
    timeError("The invoice total is too large.", 409);
  const protectedMinor = baseMinor - selectedBaseMinor;
  let selectedTotalMinor = selectedBaseMinor;
  if (reduction) {
    const adjustment = reduction.adjustment;
    selectedTotalMinor =
      adjustment.type === "percent"
        ? reducedInvoiceMinor(selectedBaseMinor, adjustment.basisPoints)
        : adjustment.amountMinor -
          (adjustment.basis === "invoice" ? protectedMinor : 0);
    if (selectedTotalMinor < 0)
      timeError(
        "The invoice target is below the total for protected lines.",
        409,
      );
    if (selectedTotalMinor > selectedBaseMinor)
      timeError(
        "The target exceeds the original amount for these lines. Enter a lower target.",
        409,
      );
    const amounts = allocateInvoiceMinor(
      selectedTotalMinor,
      selected.map((line) => ({
        id: line.entry.id,
        weight: line.baseAmountMinor,
      })),
    );
    for (const line of selected)
      line.amountMinor = amounts.get(line.entry.id) ?? line.baseAmountMinor;
  }
  const totalMinor = selectedTotalMinor + protectedMinor;
  if (
    scale < 100 &&
    BigInt(totalMinor) * BigInt(100 / scale) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    timeError("The invoice total is too large for this currency.", 409);
  const content = {
    input,
    currency,
    showHours: pricing.mode === "hourly" || pricing.showHours,
    totalMinor,
    protectedMinor,
    selectedBaseMinor,
    selectedTotalMinor,
    snapshot,
    modelBasis,
    modelWording,
    lines,
  };
  const revision = digest(content);
  const sameRevision = previous?.revision === revision;
  return {
    ...content,
    id: sameRevision ? previous.id : newId(),
    revision,
    approval: sameRevision ? previous.approval : undefined,
  };
}
