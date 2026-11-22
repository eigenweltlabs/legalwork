import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { SearchInput } from "twenty-ui/components/input";
import type { BackOfficeFilterCriteria, BackOfficeObject, BackOfficeRecord } from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { DirectoryMenu } from "./twenty-controls";
import { RecordFilterEditor, recordFilterOperatorLabel, recordFilterValueLabel } from "./record-filter-editor";

type FilterProps = {
  object: BackOfficeObject;
  records: BackOfficeRecord[];
  filters: BackOfficeFilterCriteria;
  onFilters: (filters: BackOfficeFilterCriteria) => void;
};

export function RecordSearchFilters({ query, onQuery, filters, onFilters, object, records, rows, finance, filterRecord }: FilterProps & {
  query: string;
  onQuery: (query: string) => void;
  rows: BackOfficeRecord[];
  filterRecord?: (record: BackOfficeRecord) => BackOfficeRecord;
  finance: boolean;
}) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  return <>
    <div className="bo-search">
      <SearchInput
        ref={searchInput}
        size="sm"
        aria-label={t("back_office.search_records")}
        placeholder={t("back_office.search_records")}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        actions={query ? <Button size="sm" type="button" variant="ghost" color="neutral" aria-label={t("integrations.clear_search")} startIcon={<X size={12} />} onClick={() => { onQuery(""); searchInput.current?.focus({ preventScroll: true }); }} /> : undefined}
      />
    </div>
    <DirectoryMenu type="panel" className="bo-record-filter-popup" open={filterOpen} onOpenChange={setFilterOpen} trigger={
      <Button size="sm" variant="ghost" color="neutral">{t("back_office.filters.button")}{filters.conditions.length > 0 && <span className="bo-filter-count">{filters.conditions.length}</span>}</Button>
    }>
      <RecordFilterEditor key={String(filterOpen)} object={object} records={records} rows={filterOpen && filterRecord ? rows.map(filterRecord) : rows} finance={finance} value={filters} onCancel={() => setFilterOpen(false)} onApply={next => { onFilters(next); setFilterOpen(false); }} />
    </DirectoryMenu>
  </>;
}

export function RecordFilterChips({ object, records, filters, onFilters }: FilterProps) {
  if (!filters.conditions.length) return null;
  return <div className="bo-filter-chips" aria-label={t("back_office.filters.active")}>
    {filters.conditions.length > 1 && <span className="bo-muted">{t(filters.mode === "all" ? "projects.reference.all_rules" : "projects.reference.any_rule")}</span>}
    {filters.conditions.map((condition, index) => {
      const field = object.fields.find(field => field.id === condition.fieldId);
      const label = `${field?.label ?? condition.fieldId} ${recordFilterOperatorLabel(condition.operator, field)} ${recordFilterValueLabel(condition, object, records)}`.trim();
      return <Button key={index} type="button" size="sm" variant="outline" color="neutral" title={label} aria-label={t("back_office.filters.remove", { name: label })} endIcon={<X size={12} />} onClick={() => onFilters({ ...filters, conditions: filters.conditions.filter((_, i) => i !== index) })}><span>{label}</span></Button>;
    })}
  </div>;
}
