import { useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import {
  starterInvoiceWord,
  type InvoiceTemplate,
} from "@legalwork/types/invoice-template";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { t } from "@/i18n";
import { useProjectFiles } from "../workspace/project-file-context";

const mime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function decode(base64: string) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
function encode(data: ArrayBuffer) {
  if (data.byteLength > 1_048_576) throw new Error(t("timesheets.word_limit"));
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export type PreviewTemplate = (
  template: InvoiceTemplate,
) => Promise<{ data: ArrayBuffer }>;
export function BillingWordTemplate({
  template,
  onChange,
  account,
  previewWord,
}: {
  previewWord?: PreviewTemplate;
  template: InvoiceTemplate;
  onChange: (value: InvoiceTemplate) => void;
  account: string;
}) {
  const files = useProjectFiles();
  const [projectId, selectProject] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = "legalwork.invoice-template-draft." + account;
  const [source, setSource] = useState<ProjectFileSource | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  });
  const bytes = () =>
    decode(template.word?.contentBase64 ?? starterInvoiceWord);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = async () => {
    if (!files) return;
    const owner = files.project(projectId);
    const path =
      "Invoice-template-" + crypto.randomUUID().slice(0, 8) + ".docx";
    await owner.client.writeWorkspaceBinaryFile(owner.workspaceId, {
      path,
      data: new Blob([bytes()], { type: mime }),
      createOnly: true,
    });
    const reference = {
      projectId,
      workspaceId: owner.workspaceId,
      path,
      name: path,
    };
    sessionStorage.setItem(key, JSON.stringify(reference));
    setSource(reference);
    await files.newChat(projectId, reference, t("timesheets.word_prompt"));
  };
  return (
    <fieldset disabled={busy} className="bo-billing-rules">
      <legend>{t("timesheets.word_template")}</legend>
      <label>
        {t("timesheets.word_upload")}
        <input
          type="file"
          accept=".docx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void run(async () => {
                if (file.size > 1_048_576 || !/\.docx$/i.test(file.name))
                  throw new Error(t("timesheets.word_limit"));
                onChange({
                  ...template,
                  word: {
                    name: file.name,
                    contentBase64: encode(await file.arrayBuffer()),
                  },
                });
              });
          }}
        />
      </label>
      <a
        download={template.word?.name ?? "Invoice-template.docx"}
        href={
          "data:" +
          mime +
          ";base64," +
          (template.word?.contentBase64 ?? starterInvoiceWord)
        }
      >
        {template.word?.name ?? t("timesheets.word_starter")}
      </a>
      {previewWord && (
        <Button
          type="button"
          size="sm"
          onClick={() =>
            void run(async () => {
              const { data } = await previewWord(template);
              const a = document.createElement("a");
              const url = URL.createObjectURL(
                new Blob([data], { type: "application/pdf" }),
              );
              a.href = url;
              a.download = "Invoice-preview.pdf";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 30_000);
            })
          }
        >
          {t("timesheets.word_preview")}
        </Button>
      )}
      {files && (
        <>
          <label>
            {t("timesheets.word_project")}
            <select
              value={projectId}
              onChange={(e) => selectProject(e.target.value)}
            >
              <option value="">{t("timesheets.word_select")}</option>
              {files.projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!projectId || busy}
            onClick={() => void run(edit)}
          >
            {t("timesheets.word_setup")}
          </Button>
        </>
      )}
      {source && files && (
        <Button
          type="button"
          size="sm"
          onClick={() =>
            void run(async () => {
              const file = await files.readSaved(source);
              onChange({
                ...template,
                word: { name: source.name, contentBase64: encode(file.data) },
              });
            })
          }
        >
          {t("timesheets.word_load")}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
