import { useEffect, useRef, useState, useId } from "react";
import { Univer, LocaleType, LogLevel, LifecycleStages } from "@univerjs/core";
import { FUniver } from "@univerjs/core/lib/facade";
import { defaultTheme } from "@univerjs/themes";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import { officeRange, xlsxReadSchema, xlsxWriteSchema } from "@legalwork/types/office-editor";
import { openWorkbook } from "./office-workbook";
import { useOfficeEditor, type OfficeEditorProps } from "./office-editor-state";
import { PreviewError, PreviewLoading } from "./preview";
import "@univerjs/preset-sheets-core/lib/index.css";
import "./office-editor.css";

// Structural edits require rewriting references in charts, names, tables and
// other retained parts. Block them at command execution, including shortcuts.
const supported = new Set(["set-range-values", "set-bold", "set-italic", "set-font-family", "set-font-size", "set-text-color", "reset-text-color", "set-background-color", "reset-background-color", "set-horizontal-text-align", "set-vertical-text-align", "set-text-wrap", "set-style", "clear-selection-content", "auto-clear-content", "select-range", "set-worksheet-activate", "copy-down", "copy-right", "set-border", "set-border-basic", "set-border-color", "set-border-position", "set-border-style", "set-underline", "set-stroke", "text-to-number", "move-selection", "move-selection-enter-tab"]);
const hidden = ["add-range-protection-from-toolbar", "set-once-format-painter", "set-infinite-format-painter", "insert-sheet", "remove-sheet", "set-worksheet-name", "set-worksheet-order", "set-worksheet-hidden", "set-worksheet-show", "insert-row-before", "insert-row-after", "insert-col-before", "insert-col-after", "remove-row-by-range", "remove-col-by-range", "add-worksheet-merge", "add-worksheet-merge-all", "add-worksheet-merge-horizontal", "add-worksheet-merge-vertical", "remove-worksheet-merge", "set-overline", "set-text-rotation", "set-frozen", "cancel-frozen", "clear-selection-all", "clear-selection-format"];
export function ArtifactXlsxEditor(props: OfficeEditorProps) {
  const [initial] = useState(props.content);
  const workbookId = useId();
  const container = useRef<HTMLDivElement>(null);
  const state = useOfficeEditor(props);
  const [ready, setReady] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void openWorkbook(initial, props.name).then((adapter) => {
      if (disposed || !container.current) return;
      const univer = new Univer({ locale: LocaleType.EN_US, logLevel: LogLevel.WARN, locales: { [LocaleType.EN_US]: enUS }, theme: { ...defaultTheme, primary: { 50: "#f0f5f4", 100: "#dde9e6", 200: "#bdd4cd", 300: "#93b8ad", 400: "#66968a", 500: "#3c7668", 600: "#285e51", 700: "#204c42", 800: "#1c3d35", 900: "#17342d" } } });
      const preset = UniverSheetsCorePreset({ container: container.current, header: true, toolbar: !props.readOnly, formulaBar: true, contextMenu: false, footer: { sheetBar: true, statisticBar: true, addSheetButtonConfig: { show: false } }, menu: Object.fromEntries(hidden.map((id) => [`sheet.command.${id}`, { hidden: true }])) });
      for (const plugin of preset.plugins) {
        if (Array.isArray(plugin)) univer.registerPlugin(plugin[0], plugin[1]);
        else univer.registerPlugin(plugin);
      }
      const univerAPI = FUniver.newAPI(univer);
      adapter.book.id = `legalwork-${workbookId}`;
      const workbook = univerAPI.createWorkbook(adapter.book);
      const before = univerAPI.onBeforeCommandExecute((command, options) => {
        if (command.id.startsWith("sheet.command.") && !supported.has(command.id.slice("sheet.command.".length)) && /(?:insert-|remove-|delete-|move-|reorder|merge|set-(?:worksheet-(?!activate)|row|col|tab|frozen|border|underline|stroke|overline|text-rotation|protection|range-custom)|clear-selection-(?:all|format)|split-text|defined-name)/.test(command.id)) {
          setNotice("Use Excel for sheet structure and advanced formatting. Cell values, formulas, and basic formatting can be edited here.");
          throw new Error("This workbook operation is not supported in Legalwork yet.");
        }
        if (props.readOnly && command.id.startsWith("sheet.mutation.") && !options?.onlyLocal && !options?.applyFormulaCalculationResult) throw new Error("This workbook is read only.");
      });
      const listener = univerAPI.onCommandExecuted((command, options) => { if (!options?.onlyLocal && !options?.applyFormulaCalculationResult && (command.id === "sheet.mutation.set-range-values" || command.id.includes("mutation.set.numfmt"))) state.changed(); });
      let preparing = false;
      const finishOpening = () => {
        if (preparing || univerAPI.getCurrentLifecycleStage() < LifecycleStages.Rendered) return;
        preparing = true;
        void univerAPI.getFormula().onCalculationResultApplied(10000).then(() => {
          if (disposed) return;
          if (props.readOnly) workbook.setEditable(false);
          state.serialize.current = async () => {
            await univerAPI.getFormula().onCalculationResultApplied(10000);
            return adapter.save(workbook.save(), true);
          };
          state.agentTool.current = async (name, rawArgs) => {
            if (name !== "read" && name !== "write") throw new Error("Unknown workbook tool.");
            const args = name === "read" ? xlsxReadSchema.parse(rawArgs) : xlsxWriteSchema.parse(rawArgs);
            const sheet = args.sheet ? workbook.getSheetByName(args.sheet) : workbook.getActiveSheet();
            if (!sheet) throw new Error("Sheet not found. Read the workbook sheet inventory first.");
            const address = args.range ?? "A1:T50";
            const bounds = officeRange(address);
            const range = sheet.getRange(address);
            if (name === "read") {
              await univerAPI.getFormula().onCalculationResultApplied(10000);
              const book = workbook.save();
              return { data: { sheets: book.sheetOrder.map((id) => ({ id, name: book.sheets[id]?.name, hidden: book.sheets[id]?.hidden })), sheet: sheet.getSheetName(), range: address, values: Array.from({ length: bounds.endRow - bounds.startRow + 1 }, (_, r) => Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, c) => book.sheets[sheet.getSheetId()]?.cellData?.[bounds.startRow + r]?.[bounds.startColumn + c]?.v ?? null)), displayValues: range.getValues(), selection: workbook.getActiveRange()?.getA1Notation(), formulas: range.getFormulas() } };
            }
            const write = xlsxWriteSchema.parse(rawArgs);
            if (write.values.length !== bounds.endRow - bounds.startRow + 1 || write.values.some((row) => row.length !== bounds.endColumn - bounds.startColumn + 1)) throw new Error("Value matrix dimensions must match the range exactly.");
            const cells = write.values.map((row) => row.map((value) => typeof value === "string" && value.startsWith("=") ? { f: value, v: null, p: null } : { v: value, f: null, p: null }));
            // Validate preservation constraints before touching the user's draft
            // (array formulas, protected structures and unsupported XML edits).
            const proposed = structuredClone(workbook.save());
            const snapshot = proposed.sheets[sheet.getSheetId()];
            if (!snapshot) throw new Error("Sheet no longer exists.");
            if (bounds.endRow >= (snapshot.rowCount ?? 0) || bounds.endColumn >= (snapshot.columnCount ?? 0)) throw new Error("The range exceeds the current sheet grid. Structural expansion requires Excel.");
            const cellData = snapshot.cellData ??= {};
            cells.forEach((row, r) => row.forEach((cell, c) => {
              const rowIndex = bounds.startRow + r, colIndex = bounds.startColumn + c;
              const data = cellData[rowIndex] ??= {};
              data[colIndex] = { ...data[colIndex], ...cell };
            }));
            await adapter.save(proposed);
            if (disposed) throw new Error("The workbook was closed before the edit could be applied.");
            workbook.setActiveSheet(sheet);
            range.setValues(cells);
            return { mutated: true, data: { sheet: sheet.getSheetName(), range: address, cellsUpdated: cells.length * cells[0]!.length } };
          };
          setAdvanced(adapter.hasAdvancedContent); setReady(true);
        }).catch((error: unknown) => { if (!disposed) state.setError(error instanceof Error ? error.message : "Could not calculate workbook."); });
      };
      const lifecycle = univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, finishOpening);
      finishOpening();
      cleanup = () => { lifecycle.dispose(); listener.dispose(); before.dispose(); state.serialize.current = null; state.agentTool.current = null; queueMicrotask(() => univer.dispose()); };
    }).catch((error: unknown) => { if (!disposed) state.setError(error instanceof Error ? error.message : "Could not open workbook."); });
    return () => { disposed = true; cleanup?.(); };
  }, [initial, workbookId, props.name, props.readOnly, state.changed, state.setError, state.serialize, state.agentTool]);
  return <div ref={state.host} className="office-editor office-sheets relative flex h-full min-h-0 flex-col" aria-label="Workbook editor" aria-busy={state.saving}
    onBeforeInputCapture={(event) => { if (props.readOnly && !(event.target instanceof HTMLInputElement)) event.preventDefault(); }}
    onPasteCapture={(event) => { if (props.readOnly && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); event.stopPropagation(); } }}
    onKeyDownCapture={(event) => {
      if (!props.readOnly) return;
      const shortcut = event.metaKey || event.ctrlKey;
      const edits = shortcut ? ["v", "x", "z", "y"].includes(event.key.toLowerCase()) : event.key.length === 1 || ["Backspace", "Delete", "F2"].includes(event.key);
      // Keep the name box usable for navigation, while preventing typing into
      // the canvas or formula editor. The command guard remains the write gate.
      if (edits && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); event.stopPropagation(); }
    }}>
    {(advanced || notice || props.readOnly) && <div className="office-caption">{props.readOnly ? "Read only" : notice || "Charts and advanced objects are kept in your file. Open in Excel to view or edit them."}</div>}
    {state.error ? <PreviewError message={state.error} /> : <>
      {!ready && <div className="absolute inset-0 z-10 bg-background"><PreviewLoading /></div>}
      <div ref={container} className="min-h-0 flex-1" inert={state.saving} />
    </>}
    {state.saving && <div className="office-saving" role="status">Saving workbook…</div>}
  </div>;
}
