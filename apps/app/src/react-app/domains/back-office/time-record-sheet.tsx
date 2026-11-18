import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X, Plus, Sparkles, Info, Copy, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { z, BackOfficeRecordSchema, BackOfficeViewSchema, type BackOfficeRecord, type BackOfficeValue } from "@legalwork/types/back-office";
import type { CaptureAction, CaptureProposal, CaptureState } from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { applySavedRecord, writeBackOfficeRecord, type BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordGrid } from "./record-grid";
import { sourceKeys } from "./timesheet-labels";
import { proposalValues, timeRecordDate } from "./time-record-values";
import { useNavigate } from "react-router-dom";

const memberPrefix = "member:";
const memberSource = (id: string) => "eigenwelt-member:" + id;
const membersSchema = z.object({ members: z.array(z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable() })) });
type Values = Record<string, BackOfficeValue>;
export type TimeCaptureSheet = {
  proposals: CaptureProposal[];
  drafts: CaptureState["drafts"];
  date: string;
  dates: string[];
  showSuggestions: boolean;
  privateAvailable: boolean;
  act: (action: CaptureAction) => Promise<boolean>;
  openSource: (proposal: CaptureProposal) => void;
};

/** One editable directory grid. Private candidate rows never enter the shared
 * record API until accepted; ordinary rows use the normal revision/outbox path. */
export function TimeRecordSheet({ client, directory, state, capture }: {
  client: LegalworkServerClient; directory: BackOfficeState; state: TimesheetState; capture: TimeCaptureSheet;
}) {
  const cache = useQueryClient(), navigate = useNavigate();
  const roster = useQuery({ queryKey: ["back-office", client.baseUrl, "time-members", directory.directoryId, directory.permissions.principalKey],
    queryFn: async () => membersSchema.parse(await client.backOffice("/time-members")), retry: false });
  const members = roster.data?.members ?? [];
  const self = memberPrefix + directory.permissions.userId;
  const pending = useRef(new Map<string, BackOfficeRecord>());
  const order = useRef(new Map<string, number>());
  const digests = useRef(new Map<string, string>());
  const bases = useRef(new Map<string, BackOfficeRecord>());
  const queues = useRef(new Map<string, Promise<void>>());
  const [version, render] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [hiddenProposals, hideProposal] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<string>();
  const [person, setPerson] = useState(self);
  const [copied, setCopied] = useState<Values>();
  const accepting = useRef(new Set<string>());
  const [blankId, setBlankId] = useState(() => Object.entries(capture.drafts).find(([, draft]) => !draft.proposalDigest && !draft.values.workflow)?.[0] ?? crypto.randomUUID());
  const raw = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);
  if (!raw) return <p role="alert">{t("timesheets.unavailable")}</p>;
  const object = { ...displayBackOfficeObject(raw), fields: displayBackOfficeObject(raw).fields.map(field => {
    if (field.id === "timekeeper") return { ...field, target: "@time-member" };
    if (field.id === "startedAt") return { ...field, type: "date", label: t("timesheets.ledger.date") };
    return field;
  }) } satisfies typeof raw;
  const fieldIds = new Set(raw.fields.map(field => field.id));
  function row(id: string, values: Values): BackOfficeRecord {
    const now = new Date().toISOString();
    return { id, objectId: "timeEntries", values, revision: 0, schemaRevision: directory.model.revision, ownerId: directory.permissions.userId,
      access: "org", members: [], sourceId: undefined, createdAt: now, updatedAt: now, archivedAt: null };
  }
  function display(record: BackOfficeRecord) {
    const person = directory.records.find(person => person.id === record.values.timekeeper);
    const member = members.find(member => person?.sourceId === memberSource(member.userId));
    return member ? { ...record, values: { ...record.values, timekeeper: memberPrefix + member.userId } } : record;
  }
  const stored = directory.records.filter(record => record.objectId === "timeEntries" && !record.archivedAt);
  for (const record of stored) if (!bases.current.has(record.id) || (!pending.current.has(record.id) && (bases.current.get(record.id)?.revision ?? 0) < record.revision)) bases.current.set(record.id, record);
  const visible = stored.filter(record => typeof record.values.startedAt === "string" && capture.dates.includes(timeRecordDate(record.values.startedAt)) && (!person || display(record).values.timekeeper === person || (person === self && !record.values.timekeeper && record.ownerId === directory.permissions.userId)));
  const booked = new Set(stored.map(record => record.id));
  const proposals = capture.proposals.filter(proposal => !booked.has(proposal.key) && !hiddenProposals.has(proposal.key));
  const proposalMap = new Map(proposals.map(proposal => [proposal.key, proposal]));
  for (const proposal of proposals) {
    const prior = digests.current.get(proposal.key);
    if (prior && prior !== proposal.digest) pending.current.delete(proposal.key);
    digests.current.set(proposal.key, proposal.digest);
  }
  const candidates = (capture.showSuggestions ? proposals : []).map(proposal => row(proposal.key, { ...proposalValues(proposal, state), timekeeper: self, ...(capture.drafts[proposal.key]?.proposalDigest === proposal.digest ? capture.drafts[proposal.key].values : {}) }));
  const privateRows = Object.entries(capture.drafts).filter(([id, draft]) => !draft.proposalDigest && !draft.values.workflow && id !== blankId && !booked.has(id)).map(([id, draft]) => row(id, { timekeeper: self, ...draft.values, startedAt: draft.values.startedAt ?? draft.date }));
  const blank = row(blankId, { name: "", billingNarrative: "", status: "Draft", timekeeper: self, recordedMinutes: null, billableMinutes: null, ...capture.drafts[blankId]?.values, startedAt: capture.drafts[blankId]?.values.startedAt ?? capture.date });
  const merged = new Map([...visible.map(display), ...privateRows, ...candidates, blank].map(record => [record.id, record]));
  for (const [id, record] of pending.current) if (!proposalMap.has(id) || capture.showSuggestions) merged.set(id, record);
  const entries = [...merged.values()].filter(record => record.id !== blankId && (!hiddenProposals.has(record.id) || bases.current.has(record.id)));
  for (const entry of entries) if (!order.current.has(entry.id)) order.current.set(entry.id, order.current.size);
  entries.sort((a, b) => order.current.get(a.id)! - order.current.get(b.id)!);
  entries.push(pending.current.get(blankId) ?? blank);
  const choices = members.map(member => ({ ...row(memberPrefix + member.userId, { name: member.userId === directory.permissions.userId ? t("timesheets.ledger.me") : member.name || member.email || member.userId }), objectId: "@time-member" }));
  const records = [...directory.records.filter(record => record.objectId !== "timeEntries"), ...choices, ...entries.map(record => ({ ...record, values: { ...record.values, startedAt: timeRecordDate(record.values.startedAt) } }))];
  const update = () => render(value => value + 1);
  function fail(id: string, error: unknown) { setErrors(previous => ({ ...previous, [id]: error instanceof Error ? error.message : String(error) })); }
  function valid(values: Values, id: string) {
    return Boolean(String(values.name ?? "").trim() && values.matter && values.timekeeper && typeof values.recordedMinutes === "number" && (values.recordedMinutes > 0 || (values.recordedMinutes === 0 && values.billableMinutes === 0 && (proposalMap.get(id)?.source === "stopwatch" || bases.current.get(id)?.values.recordedMinutes === 0)))
      && typeof values.billableMinutes === "number" && values.billableMinutes >= 0 && typeof values.startedAt === "string" && Number.isFinite(Date.parse(values.startedAt)));
  }
  function enqueue(id: string, task: () => Promise<void>) {
    const next = (queues.current.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.current.set(id, next);
    void next.catch(error => fail(id, error));
    return next;
  }
  async function privateDraft(record: BackOfficeRecord) {
    if (!capture.privateAvailable) return;
    const proposal = proposalMap.get(record.id);
    if (!await capture.act({ type: "draft", key: record.id, date: proposal?.date ?? (typeof record.values.startedAt === "string" && Number.isFinite(Date.parse(record.values.startedAt)) ? timeRecordDate(record.values.startedAt) : capture.date), values: record.values, ...(proposal ? { proposalDigest: proposal.digest } : {}) })) throw new Error(t("back_office.save_failed"));
  }
  async function persist(id: string, accepting = false) {
    const record = pending.current.get(id) ?? merged.get(id);
    if (!record) return;
    const proposal = bases.current.has(id) ? undefined : proposalMap.get(id);
    if ((proposal && !accepting) || !valid(record.values, id)) {
      await privateDraft(record);
      if (accepting) throw new Error(t("timesheets.sheet.complete"));
      return;
    }
    if (!proposal && !bases.current.has(id)) await privateDraft(record);
    setSaving(previous => new Set(previous).add(id));
    try {
      const base = bases.current.get(id), values = Object.fromEntries(Object.entries(record.values).filter(([key]) => fieldIds.has(key)));
      const worker = typeof values.timekeeper === "string" && values.timekeeper.startsWith(memberPrefix) ? values.timekeeper.slice(memberPrefix.length) : undefined;
      if (worker) delete values.timekeeper;
      const response = await writeBackOfficeRecord(client, directory, {
        id, objectId: "timeEntries", revision: base?.revision ?? 0, values,
        ...(base ? { expectedValues: { ...Object.fromEntries(Object.keys(values).map(key => [key, base.values[key] ?? null])), timekeeper: base.values.timekeeper ?? null } } : { create: true }),
        ...(worker ? { timekeeperUserId: worker } : {}),
        ...(proposal ? { privateProposal: { key: id, digest: proposal.digest, profileId: directory.captureProfileId } } : {}),
      });
      const saved = z.object({ record: BackOfficeRecordSchema }).parse(response).record;
      bases.current.set(id, saved);
      if (pending.current.get(id) === record) pending.current.set(id, { ...saved, values: { ...saved.values, ...(worker ? { timekeeper: memberPrefix + worker } : {}) } });
      if (proposal) hideProposal(previous => new Set(previous).add(id));
      await applySavedRecord(cache, client.baseUrl, directory, saved);
      if (capture.privateAvailable) await capture.act({ type: "draft", key: id, values: null });
      setErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
      update();
    } finally { setSaving(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }
  async function edit(record: BackOfficeRecord, patch: Values) {
    const latest = pending.current.get(record.id) ?? display(bases.current.get(record.id) ?? merged.get(record.id) ?? record);
    const values = { ...latest.values, ...patch };
    if ("startedAt" in patch) {
      const date = timeRecordDate(patch.startedAt) || capture.date;
      values.startedAt = date === timeRecordDate(latest.values.startedAt) ? latest.values.startedAt : date;
      if (date !== timeRecordDate(latest.values.startedAt)) values.endedAt = null;
    }
    if (typeof patch.billingNarrative === "string") values.name = patch.billingNarrative.slice(0, 240);
    if (typeof patch.matter === "string") {
      const matter = state.matters.find(matter => matter.id === patch.matter);
      values.client = matter?.clientIds.length === 1 ? matter.clientIds[0] : null;
    }
    pending.current.set(record.id, { ...latest, values });
    if (record.id === blankId && valid(values, record.id)) setBlankId(crypto.randomUUID());
    update();
    void enqueue(record.id, () => persist(record.id));
  }
  function duplicate(input: Values) {
    const values: Values = { ...input, timekeeper: self, status: "Draft" };
    delete values.invoice;
    const id = crypto.randomUUID(), copy = row(id, values);
    pending.current.set(id, copy); update();
    void enqueue(id, () => privateDraft(copy));
  }
  const sums = visible.reduce((sum, record) => ({ worked: sum.worked + Number(record.values.recordedMinutes || 0), charge: sum.charge + Number(record.values.billableMinutes || 0) }), { worked: 0, charge: 0 });
  const columns = ["startedAt", "timekeeper", "matter", "billingNarrative", "recordedMinutes", "billableMinutes"];
  return <div className="time-record-sheet" data-version={version} onCopy={event => {
    if (!copied || event.target instanceof HTMLInputElement || window.getSelection()?.toString()) return;
    event.clipboardData.setData("text/plain", JSON.stringify({ legalworkTimeRow: 1, values: copied })); event.preventDefault();
  }} onPaste={event => {
    try {
      const value = z.object({ legalworkTimeRow: z.literal(1), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).safeParse(JSON.parse(event.clipboardData.getData("text/plain")));
      if (value.success) { event.preventDefault(); duplicate(value.data.values); }
    } catch { /* Ordinary text remains available to the focused editor. */ }
  }}>
    <div className="time-sheet-summary">
      <select aria-label={t("timesheets.ledger.workers")} value={person} onChange={event => setPerson(event.target.value)}><option value="">{t("timesheets.sheet.all_people")}</option>{choices.map(member => <option key={member.id} value={member.id}>{String(member.values.name)}</option>)}</select>
      <span>{t("timesheets.sheet.worked", { minutes: sums.worked })}</span><span>{t("timesheets.sheet.charge", { minutes: sums.charge })}</span>
      <span className="time-sheet-sync" title={t(directory.scope === "local" ? "timesheets.sheet.local" : "timesheets.sheet.sharing")}><Info size={12} />{saving.size ? t("projects.saving") : directory.sync.error ? t("timesheets.sheet.sync_error") : directory.sync.pending ? t("timesheets.sheet.pending") : t("timesheets.sheet.synced")}</span>
    </div>
    {roster.error && <p className="bo-error" role="alert">{t("timesheets.sheet.members_error")} <Button size="xs" variant="outline" onClick={() => void roster.refetch()}>{t("timesheets.retry")}</Button></p>}
    <RecordGrid object={object} records={records} views={directory.views} editable={directory.permissions.edit && Boolean(roster.data)} finance={directory.permissions.finance}
      userId={directory.permissions.userId} archived={false} onArchivedChange={() => {}} lockedSchema
      onSave={edit} onCreate={() => {}} onOpen={record => navigate("/back-office/" + record.objectId + "?record=" + record.id)}
      onSaveView={async (view, expected) => {
        const saved = z.object({ view: BackOfficeViewSchema }).parse(await client.backOffice("/views", { method: "POST", body: { ...view, expected } })).view;
        void cache.invalidateQueries({ queryKey: ["back-office", client.baseUrl] }); return saved;
      }}
      sheet={{ columns, blankId, widths: { startedAt: 130, timekeeper: 140, matter: 200, billingNarrative: 340, recordedMinutes: 120, billableMinutes: 120 },
        onFocus: record => { if (record.id !== blankId && !proposalMap.has(record.id)) setCopied(record.values); },
        trailing: record => record.revision > 0 ? <button title={t("timesheets.ledger.history")} aria-label={t("timesheets.ledger.history")} onClick={() => navigate("/back-office/timeEntries?record=" + record.id)}><History size={13} /></button> : null,
        leading: record => {
          const proposal = proposalMap.get(record.id);
          if (proposal) return <div className="time-proposal-actions"><button aria-label={t("timesheets.sheet.accept")} title={t("timesheets.sheet.accept")} disabled={saving.has(record.id)} onClick={() => void enqueue(record.id, () => { accepting.current.add(record.id); return persist(record.id, true); })}><Check size={14} /></button><button aria-label={t("timesheets.sheet.decline")} title={t("timesheets.sheet.decline")} onClick={() => { void capture.act({ type: "dismiss", key: record.id }).then(ok => { if (ok) hideProposal(previous => new Set(previous).add(record.id)); }); }}><X size={14} /></button></div>;
          return record.id === blankId ? <button aria-label={t("back_office.add_new")} onClick={event => event.currentTarget.closest("[role=row]")?.querySelector<HTMLElement>("[role=gridcell]")?.click()}><Plus size={14} /></button> : <button aria-label={t("timesheets.sheet.copy_row")} title={t("timesheets.sheet.copy_row")} onClick={() => { setCopied(record.values); duplicate(record.values); }}><Copy size={13} /></button>;
        },
        details: record => {
          const proposal = proposalMap.get(record.id), error = errors[record.id];
          if (!proposal && !error) return null;
          const matches = proposal ? visible.filter(entry => (display(entry).values.timekeeper === self || (!entry.values.timekeeper && entry.ownerId === directory.permissions.userId)) && typeof entry.values.startedAt === "string" && timeRecordDate(entry.values.startedAt) === proposal.date && entry.values.matter === record.values.matter && entry.id !== record.id) : [];
          return <div className="time-proposal-details">
            {proposal && <><button className="time-proposal-source" onClick={() => setSource(source === record.id ? undefined : record.id)}><Sparkles size={13} />{t("timesheets.sheet.because", { source: t(sourceKeys[proposal.source]) })}{proposal.workedMinutes !== null && " · " + proposal.workedMinutes + " min"}{proposal.projectId && " · " + (state.projects.find(project => project.id === proposal.projectId)?.name ?? "")}</button>
              {matches.length > 0 && <select aria-label={t("timesheets.sheet.reconcile")} value="" onChange={event => { if (event.target.value) void capture.act({ type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: event.target.value }).then(ok => { if (ok) hideProposal(previous => new Set(previous).add(record.id)); }); }}><option value="">{t("timesheets.sheet.reconcile")}</option>{matches.map(match => <option key={match.id} value={match.id}>{String(match.values.billingNarrative || match.values.name)} · {String(match.values.recordedMinutes)} min</option>)}</select>}
              {source === record.id && <div className="time-proposal-evidence"><p>{proposal.startAt && proposal.endAt ? new Date(proposal.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "–" + new Date(proposal.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("timesheets.sheet.no_duration")}</p><p>{proposal.narrative}</p><Button size="xs" variant="ghost" onClick={() => capture.openSource(proposal)}>{t("timesheets.workday.correct")}</Button></div>}</>}
            {error && <span role="alert" className="bo-error">{error} <button onClick={() => void enqueue(record.id, () => persist(record.id, accepting.current.has(record.id)))}>{t("timesheets.retry")}</button></span>}
          </div>;
        },
      }} />
    <div className="time-sheet-footer"><span>{t("timesheets.sheet.keyboard")}</span></div>
  </div>;
}
