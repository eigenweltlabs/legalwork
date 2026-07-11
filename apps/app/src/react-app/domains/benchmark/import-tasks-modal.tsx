/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ChevronDown, Download, Github, Scale, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkCatalogItem, BenchmarkWorkType } from "../../../app/lib/benchmark-types";
import { BENCHMARK_WORK_TYPES } from "../../../app/lib/benchmark-types";
import { SettingsListSearchInput } from "../settings/settings-list";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { collectCatalogTags, filterCatalogTasks } from "./filter-tasks";
import { workTypeLabel } from "./format";
import { useBenchmarkStore } from "./store";

export type ImportTasksModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** A selectable benchmark source (meta-layer above the task catalog). */
function SourceTile(props: {
  icon: typeof Scale;
  title: string;
  subtitle: string;
  onClick?: () => void;
  disabled?: boolean;
  link?: { href: string; label: string };
}) {
  const interactive = Boolean(props.onClick) && !props.disabled;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? props.onClick : undefined}
      onKeyDown={
        interactive
          ? (event) => (event.key === "Enter" || event.key === " ") && props.onClick?.()
          : undefined
      }
      className={cn(
        "flex flex-col items-start gap-3 rounded-2xl border border-dls-border bg-background p-5 text-left transition-shadow",
        props.disabled ? "cursor-default opacity-55" : "cursor-pointer hover:border-primary/40 hover:shadow-sm",
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
        <props.icon size={18} className="text-foreground" />
      </span>
      <div>
        <h3 className="text-[15px] font-medium text-foreground">{props.title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{props.subtitle}</p>
      </div>
      {props.link ? (
        <a
          href={props.link.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-primary hover:underline"
        >
          <Github size={13} />
          {props.link.label}
        </a>
      ) : null}
    </div>
  );
}

function CatalogPreview({ item }: { item: BenchmarkCatalogItem }) {
  const preview = useBenchmarkStore((state) => state.catalogPreviews[item.key]);
  const loading = useBenchmarkStore((state) => state.catalogPreviewLoading === item.key);
  const loadCatalogPreview = useBenchmarkStore((state) => state.loadCatalogPreview);
  const toggleSelection = useBenchmarkStore((state) => state.toggleImportSelection);
  const selected = useBenchmarkStore((state) => state.importSelection.includes(item.key));

  useEffect(() => {
    void loadCatalogPreview(item.key);
  }, [item.key, loadCatalogPreview]);

  const task = preview ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <div>
        <h3 className="text-[14px] font-semibold leading-snug">{task?.title ?? item.title ?? item.name}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {item.workType ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {workTypeLabel(item.workType)}
            </Badge>
          ) : null}
          {(task?.tags ?? item.tags ?? [item.verticalLabel]).map((tag) => (
            <Badge key={tag} variant="outline" className="px-1.5 py-0 text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      {loading && !task ? (
        <div className="flex items-center gap-2 py-4 text-muted-foreground">
          <Spinner />
        </div>
      ) : null}

      {task ? (
        <>
          <section>
            <h4 className="mb-1 text-[12px] font-medium text-muted-foreground">
              {t("benchmark.form_instructions")}
            </h4>
            <p className="whitespace-pre-wrap leading-relaxed">{task.instructions}</p>
          </section>

          {task.deliverables.length ? (
            <section>
              <h4 className="mb-1 text-[12px] font-medium text-muted-foreground">
                {t("benchmark.deliverables_title")}
              </h4>
              <ul className="space-y-0.5">
                {task.deliverables.map((name) => (
                  <li key={name} className="font-mono text-[12px]">
                    {name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {item.docCount > 0 ? (
            <section className="text-[12px] text-muted-foreground">
              {t("benchmark.doc_count", { count: item.docCount })}
            </section>
          ) : null}

          <section>
            <h4 className="mb-1 text-[12px] font-medium text-muted-foreground">
              {t("benchmark.form_criteria")} ({task.criteria.length})
            </h4>
            <ul className="space-y-2">
              {task.criteria.map((criterion) => (
                <li key={criterion.id} className="rounded-xl border border-dls-border p-2.5">
                  <div className="text-[12px] font-medium">
                    {criterion.id}: {criterion.title}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                    {criterion.matchCriteria}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      <div className="sticky bottom-0 bg-background pt-1">
        <Button variant={selected ? "outline" : "default"} size="sm" onClick={() => toggleSelection(item.key)}>
          {selected ? t("benchmark.remove_from_selection") : t("benchmark.add_to_selection")}
        </Button>
      </div>
    </div>
  );
}

export function ImportTasksModal(props: ImportTasksModalProps) {
  const catalogItems = useBenchmarkStore((state) => state.catalogItems);
  const catalogStatus = useBenchmarkStore((state) => state.catalogStatus);
  const catalogError = useBenchmarkStore((state) => state.catalogError);
  const hydration = useBenchmarkStore((state) => state.catalogHydration);
  const filters = useBenchmarkStore((state) => state.importFilters);
  const setFilters = useBenchmarkStore((state) => state.setImportFilters);
  const selection = useBenchmarkStore((state) => state.importSelection);
  const toggleSelection = useBenchmarkStore((state) => state.toggleImportSelection);
  const setSelection = useBenchmarkStore((state) => state.setImportSelection);
  const importing = useBenchmarkStore((state) => state.importing);
  const importError = useBenchmarkStore((state) => state.importError);
  const importSelected = useBenchmarkStore((state) => state.importSelected);
  const importTasksZip = useBenchmarkStore((state) => state.importTasksZip);
  const ensureCatalog = useBenchmarkStore((state) => state.ensureCatalog);
  const startCatalogPolling = useBenchmarkStore((state) => state.startCatalogPolling);
  const stopCatalogPolling = useBenchmarkStore((state) => state.stopCatalogPolling);
  const workspaceTasks = useBenchmarkStore((state) => state.tasks);
  const alreadyImported = useMemo(() => new Set(workspaceTasks.map((task) => task.id)), [workspaceTasks]);

  const [stage, setStage] = useState<"source" | "catalog">("source");
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [tagSearch, setTagSearch] = useState("");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setStage("source");
    setSelection([]);
    setPreviewKey(null);
    void ensureCatalog();
    startCatalogPolling();
    return () => stopCatalogPolling();
  }, [props.open, ensureCatalog, setSelection, startCatalogPolling, stopCatalogPolling]);

  const allTags = useMemo(() => collectCatalogTags(catalogItems), [catalogItems]);
  const visibleTags = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    const base = query ? allTags.filter((tag) => tag.toLowerCase().includes(query)) : allTags;
    return base.slice(0, 60);
  }, [allTags, tagSearch]);
  const filtered = useMemo(() => filterCatalogTasks(catalogItems, filters), [catalogItems, filters]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const allFilteredSelected = filtered.length > 0 && filtered.every((item) => selectedSet.has(item.key));
  const previewItem = useMemo(
    () => (previewKey ? catalogItems.find((item) => item.key === previewKey) ?? null : null),
    [previewKey, catalogItems],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 12,
  });

  const setSearch = (value: string) => {
    setSearchDraft(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setFilters({ search: value }), 200);
  };

  const toggleWorkType = (workType: BenchmarkWorkType) => {
    setFilters({
      workTypes: filters.workTypes.includes(workType)
        ? filters.workTypes.filter((entry) => entry !== workType)
        : [...filters.workTypes, workType],
    });
  };

  const toggleTag = (tag: string) => {
    setFilters({
      tags: filters.tags.includes(tag) ? filters.tags.filter((entry) => entry !== tag) : [...filters.tags, tag],
    });
  };

  const runImport = async () => {
    const count = await importSelected();
    if (count > 0) props.onOpenChange(false);
  };

  const handleZipSelected = async (file: File | undefined) => {
    if (!file) return;
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    const count = await importTasksZip(base64);
    if (count > 0) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(860px,92vh)] w-[min(1280px,95vw)] max-w-[95vw] flex-col sm:max-w-[1280px]">
        <DialogHeader>
          <DialogTitle>
            {stage === "catalog" ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[13px] font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => setStage("source")}
                >
                  <ArrowLeft size={14} />
                  {t("benchmark.import_sources")}
                </button>
                <span className="text-muted-foreground/40">/</span>
                {t("benchmark.import_title")}
              </span>
            ) : (
              t("benchmark.import_sources")
            )}
          </DialogTitle>
        </DialogHeader>

        {stage === "source" ? (
          <div className="min-h-0 flex-1">
            <p className="mb-4 text-[13px] text-muted-foreground">{t("benchmark.import_source_hint")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <SourceTile
                icon={Scale}
                title="Harvey Legal Agent Benchmark"
                subtitle="1,700+ realistic legal agent tasks across 25 practice areas, with rubric-based grading."
                onClick={() => setStage("catalog")}
                link={{ href: "https://github.com/harveyai/harvey-labs", label: t("benchmark.import_view_repo") }}
              />
              <SourceTile
                icon={Upload}
                title={t("benchmark.import_zip_title")}
                subtitle={importing ? t("benchmark.importing") : t("benchmark.import_zip_hint")}
                onClick={importing ? undefined : () => zipInputRef.current?.click()}
                disabled={importing}
              />
            </div>
            {importError ? (
              <div className="mt-4">
                <SettingsNotice tone="error">{importError}</SettingsNotice>
              </div>
            ) : null}
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                void handleZipSelected(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        ) : (
        <>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  {t("benchmark.filter_work_type")}
                  {filters.workTypes.length ? ` (${filters.workTypes.length})` : ""}
                  <ChevronDown size={13} />
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              {BENCHMARK_WORK_TYPES.map((workType) => (
                <DropdownMenuCheckboxItem
                  key={workType}
                  checked={filters.workTypes.includes(workType)}
                  onCheckedChange={() => toggleWorkType(workType)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {workTypeLabel(workType)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  {t("benchmark.filter_tags")}
                  {filters.tags.length ? ` (${filters.tags.length})` : ""}
                  <ChevronDown size={13} />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
              <div className="sticky top-0 z-10 bg-popover p-1.5">
                <Input
                  value={tagSearch}
                  placeholder={t("benchmark.search_tags")}
                  className="h-7 text-[12px]"
                  onChange={(event) => setTagSearch(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </div>
              {visibleTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={filters.tags.includes(tag)}
                  onCheckedChange={() => toggleTag(tag)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="min-w-52 flex-1">
            <SettingsListSearchInput
              placeholder={t("benchmark.search_tasks")}
              value={searchDraft}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <label className="flex items-center gap-1.5 text-[12px]">
            <Checkbox
              checked={allFilteredSelected}
              onCheckedChange={() => {
                if (allFilteredSelected) {
                  setSelection(selection.filter((key) => !filtered.some((item) => item.key === key)));
                } else {
                  setSelection([...selection, ...filtered.map((item) => item.key)]);
                }
              }}
            />
            {t("benchmark.select_all")} ({filtered.length})
          </label>
        </div>

        {catalogError ? (
          <SettingsNotice tone="error">{t("benchmark.error_load_catalog", { message: catalogError })}</SettingsNotice>
        ) : null}
        {importError ? <SettingsNotice tone="error">{importError}</SettingsNotice> : null}
        {hydration && hydration.hydrated < hydration.total ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Spinner />
            {t("benchmark.catalog_hydrating", { hydrated: hydration.hydrated, total: hydration.total })}
          </div>
        ) : null}

        {catalogStatus === "loading" ? (
          <div className="flex flex-1 items-center justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <div
              ref={scrollRef}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-xl border border-dls-border",
                previewItem ? "max-w-[55%]" : "",
              )}
            >
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const item = filtered[virtualRow.index]!;
                  const imported = alreadyImported.has(item.key);
                  return (
                    <div
                      key={item.key}
                      className={cn(
                        "absolute left-0 top-0 flex w-full items-center gap-3 border-b border-dls-border px-3",
                        previewKey === item.key && "bg-dls-hover",
                      )}
                      style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <Checkbox
                        checked={selectedSet.has(item.key)}
                        onCheckedChange={() => toggleSelection(item.key)}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setPreviewKey(previewKey === item.key ? null : item.key)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{item.title ?? item.name}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {item.verticalLabel}
                            {item.criteriaCount ? ` · ${item.criteriaCount} criteria` : ""}
                            {item.docCount ? ` · ${item.docCount} docs` : ""}
                          </span>
                        </span>
                        {item.workType ? (
                          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                            {workTypeLabel(item.workType)}
                          </Badge>
                        ) : null}
                        {imported ? (
                          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                            {t("benchmark.already_imported")}
                          </Badge>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {previewItem ? (
              <div className="flex min-h-0 w-[45%] flex-col rounded-xl border border-dls-border">
                <CatalogPreview item={previewItem} />
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <span className="mr-auto text-[12px] text-muted-foreground">
            {t("benchmark.selected_count", { count: selection.length })}
          </span>
          <Button onClick={() => void runImport()} disabled={importing || selection.length === 0}>
            <Download size={13} />
            {importing
              ? t("benchmark.importing")
              : `${t("benchmark.import_tasks")}${selection.length ? ` (${selection.length})` : ""}`}
          </Button>
        </DialogFooter>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
