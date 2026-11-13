import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  Folder,
  Paperclip,
  Upload,
  X,
} from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Chip } from "twenty-ui/primitives/data-display";
import { ListItem } from "twenty-ui/primitives/navigation";
import {
  BackOfficeFileSchema,
  BackOfficeFilesSchema,
  BACK_OFFICE_FILE_LIMIT,
  z,
  type BackOfficeField,
  type BackOfficeFile,
  type BackOfficeRecord,
  type BackOfficeValue,
} from "@legalwork/types/back-office";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { t } from "@/i18n";
import { DirectoryDialog, DirectorySelect } from "./twenty-controls";

import { PreviewUnavailable } from "../session/artifacts/preview";

const AttachmentViewer = lazy(() =>
  import("../session/artifacts/artifact-panel").then((module) => ({
    default: module.ArtifactPanelView,
  })),
);
type FilesContext = {
  client: LegalworkServerClient;
  projects: { id: string; name: string }[];
  open: (file: BackOfficeFile) => void;
  upload: (
    record: BackOfficeRecord,
    field: BackOfficeField,
    name: string,
    data: ArrayBuffer,
  ) => Promise<BackOfficeFile>;
};
const Context = createContext<FilesContext | null>(null);
export function RecordFilesProvider({
  client,
  projects,
  records,
  children,
}: {
  client: LegalworkServerClient;
  projects: { id: string; name: string }[];
  records: BackOfficeRecord[];
  children: ReactNode;
}) {
  const [preview, setPreview] = useState<BackOfficeFile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!preview) return;
    const record = records.find((item) => item.id === preview.recordId);
    const files = BackOfficeFilesSchema.safeParse(record?.values[preview.fieldId]);
    if (!files.success || !files.data.some((item) => item.id === preview.id)) setPreview(null);
  }, [records, preview]);
  const download = async (file: BackOfficeFile) => {
    try {
      const result = await client.downloadBackOfficeFile(
        file.recordId,
        file.fieldId,
        file.id,
      );
      const url = URL.createObjectURL(
        new Blob([result.data], { type: file.contentType }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("back_office.files.failed"),
      );
    }
  };
  return (
    <Context.Provider
      value={{
        client,
        projects,
        open: (file) => {
          setError("");
          setPreview(file);
        },
        upload: async (record, field, name, data) =>
          z
            .object({ file: BackOfficeFileSchema })
            .parse(
              await client.uploadBackOfficeFile(
                record.id,
                field.id,
                name,
                data,
                record.objectId,
              ),
            ).file,
      }}
    >
      {children}
      {preview && (
        <DirectoryDialog
          title={preview.name}
          wide
          onClose={() => setPreview(null)}
        >
          <div className="bo-file-preview">
            <div className="bo-file-preview-toolbar">
              <span className="bo-muted">
                {t("back_office.files.immutable")}
              </span>
              <Button
                size="sm"
                startIcon={<Download size={14} />}
                onClick={() => void download(preview)}
              >
                {t("back_office.files.download")}
              </Button>
            </div>
            {error && (
              <p className="bo-error" role="alert">
                {error}
              </p>
            )}
            <Suspense
              fallback={
                <p className="bo-muted">{t("back_office.files.loading")}</p>
              }
            >
              {["html", "view", "browser", "external"].includes(
                classifyOpenTarget(preview.name, "file"),
              ) ? (
                <PreviewUnavailable />
              ) : (
                <AttachmentViewer
                  key={preview.id}
                  client={client}
                  workspaceId={`back-office:${preview.recordId}`}
                  workspaceRoot=""
                  sessionId={`back-office:${preview.recordId}`}
                  isRemoteWorkspace
                  localReadOnly
                  target={{
                    id: preview.id,
                    kind: "file",
                    value: preview.name,
                    name: preview.name,
                    preview: classifyOpenTarget(preview.name, "file"),
                    exists: true,
                    confidence: 100,
                    reason: "Back Office attachment",
                    size: preview.size,
                  }}
                  loadFile={() =>
                    client.downloadBackOfficeFile(
                      preview.recordId,
                      preview.fieldId,
                      preview.id,
                    )
                  }
                  onClose={() => setPreview(null)}
                />
              )}
            </Suspense>
          </div>
        </DirectoryDialog>
      )}
    </Context.Provider>
  );
}
export function FileValue({ value }: { value: BackOfficeValue }) {
  const context = useContext(Context);
  const parsed = BackOfficeFilesSchema.safeParse(value);
  if (!parsed.success) return null;
  return (
    <div className="bo-relation-values">
      {parsed.data.map((file) => (
        <Chip
          key={file.id}
          size="sm"
          variant="soft"
          maxWidth={220}
          clickable={Boolean(context)}
          startElement={<Paperclip size={13} />}
          onClick={(event) => {
            event.stopPropagation();
            context?.open(file);
          }}
        >
          {file.name}
        </Chip>
      ))}
    </div>
  );
}
export function FileCellEditor({
  record,
  field,
  value,
  onSave,
  onCancel,
}: {
  record?: BackOfficeRecord;
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  onSave: (value: BackOfficeValue) => Promise<void>;
  onCancel: () => void;
}) {
  const context = useContext(Context);
  const input = useRef<HTMLInputElement>(null);
  const parsed = BackOfficeFilesSchema.safeParse(value ?? []);
  const [files, setFiles] = useState(parsed.success ? parsed.data : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chooseProject, setChooseProject] = useState(false);
  const [project, setProject] = useState("");
  const [path, setPath] = useState("");
  const directory = useQuery({
    queryKey: ["bo-file-picker", context?.client.baseUrl, project, path],
    enabled: Boolean(context && chooseProject && project),
    queryFn: async () => {
      if (!context) throw new Error(t("back_office.files.failed"));
      return context.client.listWorkspaceDirectory(project, path);
    },
  });
  const save = async (next: BackOfficeFile[]) => {
    await onSave(next);
    onCancel();
  };
  const attach = async (
    selected: { name: string; data: () => Promise<ArrayBuffer> }[],
  ) => {
    if (!context || !record) return;
    setBusy(true);
    setError("");
    try {
      const next = field.multiple ? [...files] : [];
      if (
        (!field.multiple && selected.length > 1) ||
        next.length + selected.length > 20
      )
        throw new Error(t("back_office.files.count"));
      for (const item of selected) {
        const data = await item.data();
        if (!data.byteLength || data.byteLength > BACK_OFFICE_FILE_LIMIT)
          throw new Error(t("back_office.files.size"));
        next.push(await context.upload(record, field, item.name, data));
      }
      setFiles(next);
      await save(next);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("back_office.files.failed"),
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="bo-file-editor">
      <p className="bo-muted">{t("back_office.files.copy_notice")}</p>
      {files.map((file) => (
        <div key={file.id} className="bo-file-row">
          <Button
            size="sm"
            variant="ghost"
            startIcon={<Paperclip size={13} />}
            onClick={() => context?.open(file)}
          >
            {file.name}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("back_office.files.remove")}
            startIcon={<X size={13} />}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void save(files.filter((item) => item.id !== file.id))
                .catch((error) => setError(error.message))
                .finally(() => setBusy(false));
            }}
          />
        </div>
      ))}
      <input
        ref={input}
        type="file"
        hidden
        multiple={field.multiple}
        aria-label={t("back_office.files.attach")}
        disabled={busy || !context || !record}
        onChange={(event) =>
          void attach(
            Array.from(event.target.files ?? []).map((file) => ({
              name: file.name,
              data: () => file.arrayBuffer(),
            })),
          )
        }
      />
      <Button
        size="sm"
        startIcon={<Upload size={14} />}
        disabled={busy || !context || !record}
        onClick={() => input.current?.click()}
      >
        {busy
          ? t("back_office.files.uploading")
          : t("back_office.files.attach")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        startIcon={<Folder size={14} />}
        disabled={busy || !context || !record}
        onClick={() => setChooseProject(!chooseProject)}
      >
        {t("back_office.files.from_project")}
      </Button>
      {chooseProject && context && (
        <div className="bo-file-project-picker">
          <DirectorySelect
            label={t("back_office.files.project")}
            value={project}
            options={[
              { value: "", label: t("back_office.files.project") },
              ...context.projects.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(id) => {
              setProject(id);
              setPath("");
            }}
          />
          {path && (
            <Button
              size="sm"
              variant="ghost"
              startIcon={<ArrowLeft size={13} />}
              onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
            >
              {t("back_office.files.back")}
            </Button>
          )}
          <div className="bo-file-project-list">
            {directory.isFetching && (
              <p className="bo-muted">{t("back_office.files.loading")}</p>
            )}
            {directory.error && (
              <p role="alert" className="bo-error">
                {directory.error.message}
              </p>
            )}
            {directory.data?.entries.map((entry) => (
              <ListItem
                key={entry.path}
                render={<button />}
                startIcon={
                  entry.kind === "dir" ? (
                    <Folder size={14} />
                  ) : (
                    <FileIcon size={14} />
                  )
                }
                disabled={busy || (entry.size ?? 0) > BACK_OFFICE_FILE_LIMIT}
                onClick={() => {
                  if (entry.kind === "dir") setPath(entry.path);
                  else
                    void attach([
                      {
                        name: entry.name,
                        data: async () =>
                          (
                            await context.client.downloadWorkspaceFile(
                              project,
                              entry.path,
                            )
                          ).data,
                      },
                    ]);
                }}
              >
                {entry.name}
              </ListItem>
            ))}
            {directory.data?.entries.length === 0 && (
              <p className="bo-muted">{t("back_office.files.empty")}</p>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="bo-error" role="alert">
          {error}
        </p>
      )}
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
        {t("back_office.files.cancel")}
      </Button>
    </div>
  );
}
