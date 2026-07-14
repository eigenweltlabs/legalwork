/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import {
  Blocks,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit2,
  FileArchive,
  FolderOpen,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { captureAnalyticsEvent } from "@/app/lib/analytics";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import type {
  HubSkillCard,
  HubSkillRepo,
  SkillCard,
} from "@/app/types";
import {
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
} from "@/react-app/domains/workspace/modal-styles";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { Spinner } from "../settings-section";
import { syncAttachedFilesSection } from "@/app/utils/skill-resources";
import {
  dismissTemplateWorkflowRun,
  retryTemplateWorkflowImport,
  useTemplateWorkflowRun,
} from "../state/template-workflow-generation";
import {
  SkillResourcesPanel,
  StagedResourcesField,
  flushStagedResources,
  type SkillResourcesStore,
  type StagedResourceFile,
} from "./skill-resources-panel";

type InstallResult = { ok: boolean; message: string };
type SkillsFilter = "all" | "installed" | "hub";
const SKILLS_HUB_UI_ENABLED = false;
// Workflows grid: 2 columns × 4 rows of compact cards before paging.
const WORKFLOWS_PER_PAGE = 8;

const pageTitleClass = "text-[34px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text";
const sectionTitleClass = "text-[15px] font-medium tracking-[-0.2px] text-dls-text";
const panelCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 transition-all hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]";

// Card styles for the Skills / Workflows index — soft-bordered tiles in a
// 2-column grid, mono type tags, hover-revealed actions. (Eigenwelt design language.)
const typeTagClass = "shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary/70";
const rowIconBtnClass =
  "inline-flex size-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40";
const ghostActionClass =
  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50";

const LEGALWORK_DEFAULT_SKILL_NAMES = new Set([
  "workspace-guide",
  "get-started",
  "skill-creator",
  "command-creator",
  "agent-creator",
  "plugin-creator",
]);

export type ImportedCloudSkillRecord = {
  installedName: string;
  updatedAt?: string | null;
};

export type GithubSkillItem = { dir: string; name: string; description: string };

export type SkillsExtensionsStore = SkillResourcesStore & {
  skills: () => SkillCard[];
  skillsStatus: () => string | null;
  hubSkills: () => HubSkillCard[];
  hubSkillsStatus: () => string | null;
  hubRepo: () => HubSkillRepo | null;
  hubRepos: () => HubSkillRepo[];
  ensureHubSkillsFresh: () => void | Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => void | Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => void | Promise<void>;
  setHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  addHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  removeHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  installSkillCreator: () => Promise<InstallResult>;
  installHubSkill: (name: string) => Promise<InstallResult>;
  importLocalSkill: (opts?: { asWorkflow?: boolean }) => void | Promise<void>;
  importLocalSkillZip: (opts?: { asWorkflow?: boolean }) => void | Promise<void>;
  scanGithubSkills: (url: string, ref?: string) => Promise<{ ref: string; skills: GithubSkillItem[] }>;
  importGithubSkills: (input: {
    url: string;
    ref?: string;
    paths: string[];
    asWorkflow?: boolean;
  }) => Promise<{ ok: boolean; message: string }>;
  revealSkillsFolder: () => void | Promise<void>;
  readSkill: (name: string) => Promise<{ content: string } | null>;
  saveSkill: (input: {
    name: string;
    content: string;
    description?: string;
  }) => void | Promise<void>;
  createSkill: (input: {
    name: string;
    content: string;
    description?: string;
  }) => Promise<{ ok: boolean; message: string }>;
  uninstallSkill: (name: string) => void | Promise<void>;
  // Zips the skill folder (SKILL.md + resources/) to a user-picked path.
  // Resolves with an empty message when the user cancels the save dialog.
  exportSkillZip: (name: string) => Promise<{ ok: boolean; message: string }>;
};

export type SkillsViewProps = {
  workspaceName: string;
  busy: boolean;
  showHeader?: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  extensions: SkillsExtensionsStore;
  onOpenLink: (url: string) => void;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
  /**
   * "skills" (default) shows ordinary skills; "workflows" shows only workflow skills
   * (legal-task templates). They share the same .opencode/skills storage but are kept
   * in separate views — workflows are marked by a `workflow-<type>-` name prefix.
   */
  kind?: "skills" | "workflows";
  /**
   * Workflows view only: picks a templates folder and starts the local
   * template-to-workflow generation agent. Resolves ok:false with a message on
   * failure; a cancelled folder pick resolves ok:true with no message.
   */
  onGenerateFromTemplates?: () => Promise<{ ok: boolean; message?: string }>;
  /** Opens the running/finished generation session in the normal chat view. */
  onOpenTemplateGenerationSession?: () => void;
};

// Workflows are ordinary skills tagged with `kind: workflow` frontmatter (surfaced on the
// SkillCard), so the two views filter the same list. The legacy `workflow-` name prefix is
// still recognized as a fallback for anything created before the switch.
export type WorkflowType = "tabular" | "assistant";
const WORKFLOW_PREFIX = "workflow-";
function isWorkflowCard(card: SkillCard): boolean {
  return card.kind === "workflow" || card.name.startsWith(WORKFLOW_PREFIX);
}
function cardWorkflowType(card: SkillCard): WorkflowType {
  if (card.workflowType === "tabular" || card.name.startsWith("workflow-tabular-")) return "tabular";
  return "assistant";
}
function workflowDisplayName(name: string): string {
  const slug = name.replace(/^workflow-(?:tabular|assistant)-/, "").replace(/^workflow-/, "");
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type SkillsViewLocalState = {
  uninstallTarget: SkillCard | null;
  searchQuery: string;
  activeFilter: SkillsFilter;
  customRepoOpen: boolean;
  customRepoOwner: string;
  customRepoName: string;
  customRepoRef: string;
  customRepoError: string | null;
  selectedSkill: SkillCard | null;
  selectedContent: string;
  selectedLoading: boolean;
  selectedDirty: boolean;
  selectedError: string | null;
  installingSkillCreator: boolean;
  installingHubSkill: string | null;
};

type SkillsViewLocalAction<K extends keyof SkillsViewLocalState = keyof SkillsViewLocalState> =
  { type: "set"; key: K; value: SetStateAction<any> };

const initialSkillsViewLocalState: SkillsViewLocalState = {
  uninstallTarget: null,
  searchQuery: "",
  activeFilter: "all",
  customRepoOpen: false,
  customRepoOwner: "",
  customRepoName: "",
  customRepoRef: "main",
  customRepoError: null,
  selectedSkill: null,
  selectedContent: "",
  selectedLoading: false,
  selectedDirty: false,
  selectedError: null,
  installingSkillCreator: false,
  installingHubSkill: null,
};

function skillsViewLocalReducer(
  state: SkillsViewLocalState,
  action: SkillsViewLocalAction,
): SkillsViewLocalState {
  switch (action.type) {
    case "set": {
      const current = state[action.key];
      const next =
        typeof action.value === "function"
          ? (action.value as (value: typeof current) => typeof current)(current)
          : action.value;
      if (Object.is(current, next)) return state;
      return { ...state, [action.key]: next };
    }
  }
}

export function SkillsView(props: SkillsViewProps) {
  const { extensions } = props;
  const [localState, dispatchLocal] = useReducer(
    skillsViewLocalReducer,
    initialSkillsViewLocalState,
  );
  const {
    uninstallTarget,
    searchQuery,
    activeFilter,
    customRepoOpen,
    customRepoOwner,
    customRepoName,
    customRepoRef,
    customRepoError,
    selectedSkill,
    selectedContent,
    selectedLoading,
    selectedDirty,
    selectedError,
    installingSkillCreator,
    installingHubSkill,
  } = localState;
  const setLocal = <K extends keyof SkillsViewLocalState>(
    key: K,
    value: SetStateAction<SkillsViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setUninstallTarget = (value: SetStateAction<SkillCard | null>) => setLocal("uninstallTarget", value);
  const setSearchQuery = (value: SetStateAction<string>) => setLocal("searchQuery", value);
  const setActiveFilter = (value: SetStateAction<SkillsFilter>) => setLocal("activeFilter", value);
  const setCustomRepoOpen = (value: SetStateAction<boolean>) => setLocal("customRepoOpen", value);
  const setCustomRepoOwner = (value: SetStateAction<string>) => setLocal("customRepoOwner", value);
  const setCustomRepoName = (value: SetStateAction<string>) => setLocal("customRepoName", value);
  const setCustomRepoRef = (value: SetStateAction<string>) => setLocal("customRepoRef", value);
  const setCustomRepoError = (value: SetStateAction<string | null>) => setLocal("customRepoError", value);
  const setSelectedSkill = (value: SetStateAction<SkillCard | null>) => setLocal("selectedSkill", value);
  const setSelectedContent = (value: SetStateAction<string>) => setLocal("selectedContent", value);
  const setSelectedLoading = (value: SetStateAction<boolean>) => setLocal("selectedLoading", value);
  const setSelectedDirty = (value: SetStateAction<boolean>) => setLocal("selectedDirty", value);
  const setSelectedError = (value: SetStateAction<string | null>) => setLocal("selectedError", value);
  const setInstallingSkillCreator = (value: SetStateAction<boolean>) => setLocal("installingSkillCreator", value);
  const setInstallingHubSkill = (value: SetStateAction<string | null>) => setLocal("installingHubSkill", value);

  const maskError = useCallback(
    (value: unknown) =>
      value instanceof Error ? value.message : t("common.something_went_wrong"),
    [],
  );

  useEffect(() => {
    if (SKILLS_HUB_UI_ENABLED) void extensions.ensureHubSkillsFresh();
  }, [extensions]);

  useEffect(() => {
    if (!SKILLS_HUB_UI_ENABLED && activeFilter === "hub") setActiveFilter("all");
  }, [activeFilter]);



  const isWorkflowsView = props.kind === "workflows";
  // Template-to-workflow generation run (module store shared with onboarding).
  const templateRun = useTemplateWorkflowRun();
  const templateRunActive = templateRun?.status === "running";
  // The generated workflows land on disk as the agent goes — pull them into the
  // list the moment the run completes.
  useEffect(() => {
    if (isWorkflowsView && templateRun?.status === "done") {
      void extensions.refreshSkills({ force: true });
    }
  }, [extensions, isWorkflowsView, templateRun?.status]);
  const allSkills = extensions.skills();
  // Each view shows only its own kind; both live in the same skill store.
  const skills = useMemo(
    () => allSkills.filter((skill) => isWorkflowCard(skill) === isWorkflowsView),
    [allSkills, isWorkflowsView],
  );
  const hubSkills = extensions.hubSkills();
  const hubRepo = extensions.hubRepo();
  const hubRepos = extensions.hubRepos();
  const skillsStatus = extensions.skillsStatus();
  const hubSkillsStatus = extensions.hubSkillsStatus();

  const skillCreatorInstalled = useMemo(
    () => skills.some((skill) => skill.name === "skill-creator"),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => {
      const description = skill.description ?? "";
      return skill.name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
    });
  }, [searchQuery, skills]);

  // Workflows render as a paginated 2-column card grid (6 per page); skills keep
  // the hairline ledger. Page resets whenever the filtered set shrinks or search changes.
  const [workflowPage, setWorkflowPage] = useState(0);
  const workflowPageCount = Math.max(1, Math.ceil(filteredSkills.length / WORKFLOWS_PER_PAGE));
  useEffect(() => {
    if (workflowPage > workflowPageCount - 1) setWorkflowPage(workflowPageCount - 1);
  }, [workflowPage, workflowPageCount]);
  useEffect(() => {
    setWorkflowPage(0);
  }, [searchQuery]);
  const pagedWorkflows = useMemo(
    () => filteredSkills.slice(workflowPage * WORKFLOWS_PER_PAGE, (workflowPage + 1) * WORKFLOWS_PER_PAGE),
    [filteredSkills, workflowPage],
  );

  const installedNames = useMemo(() => new Set(allSkills.map((skill) => skill.name)), [allSkills]);

  const filteredHubSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const items = hubSkills.filter((skill) => !installedNames.has(skill.name));
    if (!query) return items;
    return items.filter((skill) => {
      const description = skill.description ?? "";
      const trigger = skill.trigger ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        trigger.toLowerCase().includes(query)
      );
    });
  }, [hubSkills, installedNames, searchQuery]);






  const activeHubRepoLabel = useMemo(
    () => (hubRepo ? `${hubRepo.owner}/${hubRepo.repo}@${hubRepo.ref}` : t("skills.no_hub_repo_label")),
    [hubRepo],
  );

  // Workflows are local-authored only — no Hub/Cloud catalogs.
  const effectiveActiveFilter = !SKILLS_HUB_UI_ENABLED && activeFilter === "hub" ? "all" : activeFilter;
  const showInstalledSection = effectiveActiveFilter === "all" || effectiveActiveFilter === "installed";
  const showHubSection = SKILLS_HUB_UI_ENABLED && !isWorkflowsView && (effectiveActiveFilter === "all" || effectiveActiveFilter === "hub");
  const canCreateInChat = !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools);



  const runDesktopAction = useCallback(
    (action: () => void | Promise<void>) => {
      if (props.busy) return;
      if (!props.canUseDesktopTools) {
        toast.warning(t("skills.desktop_required"));
        return;
      }
      void Promise.resolve(action());
    },
    [props.busy, props.canUseDesktopTools],
  );

  const refreshCatalogs = useCallback(() => {
    if (props.busy) return;
    void extensions.refreshSkills({ force: true });
    if (SKILLS_HUB_UI_ENABLED) void extensions.refreshHubSkills({ force: true });
  }, [extensions, props.busy]);

  const generateFromTemplates = useCallback(async () => {
    const start = props.onGenerateFromTemplates;
    if (props.busy || !start || templateRunActive) return;
    if (!props.canUseDesktopTools) {
      toast.warning(t("skills.desktop_required"));
      return;
    }
    const result = await start();
    if (!result.ok && result.message) toast.error(result.message);
  }, [props.busy, props.canUseDesktopTools, props.onGenerateFromTemplates, templateRunActive]);

  const installSkillCreator = useCallback(async () => {
    if (props.busy || installingSkillCreator) return;
    if (!props.canInstallSkillCreator) {
      toast.warning(props.accessHint ?? t("skills.host_only_error"));
      return;
    }
    setInstallingSkillCreator(true);
    toast.info(t("skills.installing_skill_creator"));
    try {
      const result = await extensions.installSkillCreator();
      toast.success(result.message);
    } catch (error) {
      toast.error(maskError(error));
    } finally {
      setInstallingSkillCreator(false);
    }
  }, [extensions, installingSkillCreator, maskError, props.accessHint, props.busy, props.canInstallSkillCreator]);


  const installFromHub = useCallback(
    async (skill: HubSkillCard) => {
      if (props.busy || installingHubSkill) return;
      setInstallingHubSkill(skill.name);
      toast.info(`${t("skills.installing_prefix")} ${skill.name}...`);
      try {
        const result = await extensions.installHubSkill(skill.name);
        toast.success(result.message);
      } catch (error) {
        toast.error(maskError(error));
      } finally {
        setInstallingHubSkill(null);
      }
    },
    [extensions, installingHubSkill, maskError, props.busy],
  );

  const handleNewSkill = useCallback(async () => {
    if (props.busy) return;
    if (props.canInstallSkillCreator && !skillCreatorInstalled) {
      await installSkillCreator();
    }
    await Promise.resolve(props.createSessionAndOpen("/skill-creator"));
  }, [installSkillCreator, props, skillCreatorInstalled]);





  const openSkill = useCallback(
    async (skill: SkillCard) => {
      if (props.busy) return;
      setSelectedSkill(skill);
      setSelectedContent("");
      setSelectedDirty(false);
      setSelectedError(null);
      setSelectedLoading(true);
      try {
        const result = await extensions.readSkill(skill.name);
        if (!result) {
          setSelectedError(t("skills.skill_load_failed"));
          return;
        }
        setSelectedContent(result.content);
      } catch (error) {
        setSelectedError(maskError(error));
      } finally {
        setSelectedLoading(false);
      }
    },
    [extensions, maskError, props.busy],
  );

  const exportSkill = useCallback(
    async (skill: SkillCard) => {
      if (props.busy) return;
      if (!props.canUseDesktopTools) {
        toast.warning(t("skills.desktop_required"));
        return;
      }
      const result = await extensions.exportSkillZip(skill.name);
      if (!result.ok) toast.error(result.message);
      else if (result.message) toast.success(result.message);
    },
    [extensions, props.busy, props.canUseDesktopTools],
  );

  // Attaching/removing a file rewrites the managed "Attached resources" section
  // in the SKILL.md on disk. Pull the regenerated section into the editor:
  // replace the content wholesale when it has no unsaved edits, otherwise
  // splice just the managed block so the edits survive.
  const syncEditorAfterResourceChange = useCallback(async () => {
    const skill = selectedSkill;
    if (!skill) return;
    const result = await extensions.readSkill(skill.name);
    if (!result) return;
    setSelectedContent((current) =>
      selectedDirty ? syncAttachedFilesSection(current, result.content) : result.content,
    );
  }, [extensions, selectedDirty, selectedSkill]);

  const saveSelectedSkill = useCallback(async () => {
    if (!selectedSkill || !selectedDirty) return;
    setSelectedError(null);
    try {
      await Promise.resolve(
        extensions.saveSkill({
          name: selectedSkill.name,
          content: selectedContent,
          description: selectedSkill.description,
        }),
      );
      setSelectedDirty(false);
    } catch (error) {
      setSelectedError(maskError(error));
    }
  }, [extensions, maskError, selectedContent, selectedDirty, selectedSkill]);

  const selectHubRepo = useCallback(
    (repo: HubSkillRepo) => {
      void Promise.resolve(extensions.setHubRepo(repo)).then(() => {
        void extensions.refreshHubSkills({ force: true });
      });
    },
    [extensions],
  );

  const openCustomRepoModal = useCallback(() => {
    if (props.busy) return;
    setCustomRepoOpen(true);
    setCustomRepoOwner(hubRepo?.owner ?? "");
    setCustomRepoName(hubRepo?.repo ?? "");
    setCustomRepoRef(hubRepo?.ref || "main");
    setCustomRepoError(null);
  }, [hubRepo, props.busy]);

  const closeCustomRepoModal = useCallback(() => {
    setCustomRepoOpen(false);
    setCustomRepoError(null);
  }, []);

  const saveCustomRepo = useCallback(() => {
    const owner = customRepoOwner.trim();
    const repo = customRepoName.trim();
    const ref = customRepoRef.trim() || "main";
    if (!owner || !repo) {
      setCustomRepoError(t("skills.owner_repo_required"));
      return;
    }
    void Promise.resolve(extensions.addHubRepo({ owner, repo, ref })).then(() => {
      void extensions.refreshHubSkills({ force: true });
    });
    closeCustomRepoModal();
  }, [closeCustomRepoModal, customRepoName, customRepoOwner, customRepoRef, extensions]);

  const isLegalworkInjectedSkill = (skill: SkillCard) => {
    const normalizedName = skill.name.trim().toLowerCase();
    const normalizedPath = skill.path.replace(/\\/g, "/").toLowerCase();
    return normalizedPath.includes("/.opencode/skills/") &&
      (LEGALWORK_DEFAULT_SKILL_NAMES.has(normalizedName) || normalizedName.endsWith("-creator"));
  };

  const handleSkillCardKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    skill: SkillCard,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openSkill(skill);
  };

  return (
    <section className="space-y-8 w-full max-w-5xl">
      <div className="space-y-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {props.showHeader !== false ? (
              <>
                <span className="lw-section-eyebrow uppercase text-dls-secondary">
                  {isWorkflowsView ? "Automation" : "Worker profile"}
                </span>
                <h2 className={`mt-3 ${pageTitleClass}`}>{isWorkflowsView ? "Workflows" : t("skills.title")}</h2>
                <p className="mt-3 max-w-xl text-[14px] leading-[1.65] text-dls-secondary">
                  {isWorkflowsView
                    ? "Reusable templates for the firm's recurring legal tasks. Assistant workflows run like a skill; tabular workflows drive a review grid through the tabular-review skill."
                    : t("skills.worker_profile_desc")}
                </p>
              </>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isWorkflowsView ? (
              <>
                <ImportSkillsButton
                  asWorkflow
                  busy={props.busy}
                  canUseDesktopTools={props.canUseDesktopTools}
                  existingNames={installedNames}
                  extensions={extensions}
                />
                <WorkflowCreatorButton
                  disabled={props.busy}
                  existingNames={installedNames}
                  onCreate={extensions.createSkill}
                  saveSkillResource={extensions.saveSkillResource}
                />
                {props.onGenerateFromTemplates ? (
                  // The flagship action: brand-primary treatment (accent fill,
                  // light-catching inner glow, layered accent shadow, hover
                  // lift + light sweep) so it outranks the plain pills.
                  <button
                    type="button"
                    onClick={() => void generateFromTemplates()}
                    disabled={props.busy || !props.canUseDesktopTools || templateRunActive}
                    className="group relative inline-flex items-center justify-center gap-1.5 overflow-hidden rounded-full border border-white/30 bg-dls-accent px-4 py-2 text-[13px] font-medium tracking-[-0.01em] text-[var(--dls-accent-fg)] shadow-[inset_0_0_8px_4px_rgba(255,255,255,0.18),0_8px_20px_-8px_rgba(var(--dls-accent-rgb),0.7)] transition-all duration-200 hover:-translate-y-px hover:bg-[var(--dls-accent-hover)] hover:shadow-[inset_0_0_8px_4px_rgba(255,255,255,0.22),0_12px_26px_-8px_rgba(var(--dls-accent-rgb),0.8)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.3)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:hover:translate-y-0"
                    title="Point a local agent at a folder of firm templates; it drafts one workflow per template."
                  >
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 -translate-x-[110%] bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[110%]"
                    />
                    {templateRunActive ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                    Generate from templates
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <ImportSkillsButton
                  asWorkflow={false}
                  busy={props.busy}
                  canUseDesktopTools={props.canUseDesktopTools}
                  existingNames={installedNames}
                  extensions={extensions}
                />
                <button
                  type="button"
                  onClick={() => runDesktopAction(extensions.revealSkillsFolder)}
                  disabled={props.busy || !props.canUseDesktopTools}
                  className={ghostActionClass}
                >
                  <FolderOpen size={14} />
                  {t("skills.reveal_folder")}
                </button>
                <SkillCreatorButton
                  disabled={props.busy}
                  existingNames={installedNames}
                  onCreate={extensions.createSkill}
                  saveSkillResource={extensions.saveSkillResource}
                />
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-dls-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-[300px]">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("skills.catalog_search_placeholder")}
              className="w-full rounded-lg border border-dls-border bg-transparent py-2 pl-9 pr-3 text-[13px] text-dls-text placeholder:text-dls-secondary focus:border-[rgba(var(--dls-accent-rgb),0.4)] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-4 text-[13px]">
            {isWorkflowsView
              ? null
              : (SKILLS_HUB_UI_ENABLED ? (["all", "installed", "hub"] as SkillsFilter[]) : (["all", "installed"] as SkillsFilter[])).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setActiveFilter(filter)}
                    className={
                      effectiveActiveFilter === filter
                        ? "font-medium text-dls-text transition-colors"
                        : "text-dls-secondary transition-colors hover:text-dls-text"
                    }
                  >
                    {filter === "all"
                      ? t("skills.filter_all")
                      : filter === "installed"
                        ? t("skills.filter_installed")
                        : t("skills.filter_hub")}
                  </button>
                ))}
            <button
              type="button"
              onClick={refreshCatalogs}
              disabled={props.busy}
              className={rowIconBtnClass}
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
      </div>

      {props.accessHint ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {props.accessHint}
        </div>
      ) : null}
      {!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {t("skills.host_mode_only")}
        </div>
      ) : null}

      {skillsStatus ? (
        <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {skillsStatus}
        </div>
      ) : null}

      {showInstalledSection ? (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="lw-section-eyebrow uppercase text-dls-secondary">
              {isWorkflowsView ? "Workflows" : "Installed"}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-dls-secondary">
              {filteredSkills.length.toString().padStart(2, "0")}
            </span>
          </div>

          {isWorkflowsView && templateRun ? (
            <TemplateGenerationRow
              status={templateRun.status}
              templatesDir={templateRun.templatesDir}
              error={templateRun.error}
              summary={templateRun.summary}
              onOpen={props.onOpenTemplateGenerationSession}
              onRetry={retryTemplateWorkflowImport}
              onDismiss={dismissTemplateWorkflowRun}
            />
          ) : null}

          {filteredSkills.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-dls-border py-16 text-center text-[14px] text-dls-secondary">
              {isWorkflowsView ? "No workflows yet — use “Add workflow” to create one." : t("skills.no_skills")}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {pagedWorkflows.map((skill) => {
                  const displayName = isWorkflowsView ? workflowDisplayName(skill.name) : skill.name;
                  const workflowType = isWorkflowsView ? cardWorkflowType(skill) : null;
                  const typeLabel = isWorkflowsView
                    ? workflowType === "tabular"
                      ? "Tabular"
                      : "Assistant"
                    : isLegalworkInjectedSkill(skill)
                      ? "LegalWork"
                      : null;
                  const TypeIcon = isWorkflowsView ? (workflowType === "tabular" ? Table2 : Bot) : Blocks;
                  return (
                    <div
                      key={skill.path}
                      role="button"
                      tabIndex={0}
                      onClick={() => void openSkill(skill)}
                      onKeyDown={(event) => handleSkillCardKeyDown(event, skill)}
                      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-[16px] border border-dls-border bg-dls-surface p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgba(var(--dls-accent-rgb),0.3)] hover:shadow-[0_14px_34px_-18px_rgba(8,23,79,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[9px] border border-dls-border bg-dls-hover text-dls-accent transition-colors group-hover:border-[rgba(var(--dls-accent-rgb),0.25)]">
                            <TypeIcon size={14} strokeWidth={1.75} />
                          </span>
                          <h4 className="truncate text-[14px] font-medium tracking-[-0.01em] text-dls-text">{displayName}</h4>
                        </div>
                        {typeLabel ? <span className={typeTagClass}>{typeLabel}</span> : null}
                      </div>
                      <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                        {skill.description || t("skills.no_description")}
                      </p>
                      {/* Actions sit in their own reserved row so they never cover the description text. */}
                      <div className="mt-2.5 flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          type="button"
                          className={rowIconBtnClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void openSkill(skill);
                          }}
                          disabled={props.busy}
                          title={t("common.edit")}
                          aria-label={t("common.edit")}
                        >
                          <Edit2 size={15} />
                        </button>
                        <button
                          type="button"
                          className={rowIconBtnClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void exportSkill(skill);
                          }}
                          disabled={props.busy || !props.canUseDesktopTools}
                          title={t("skill_export.action")}
                          aria-label={t("skill_export.action")}
                        >
                          <Download size={15} />
                        </button>
                        <button
                          type="button"
                          className={rowIconBtnClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (props.busy || !props.canUseDesktopTools) {
                              if (!props.canUseDesktopTools) toast.warning(t("skills.desktop_required"));
                              return;
                            }
                            setUninstallTarget(skill);
                          }}
                          disabled={props.busy || !props.canUseDesktopTools}
                          title={t("skills.uninstall")}
                          aria-label={t("skills.uninstall")}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {workflowPageCount > 1 ? (
                <div className="flex items-center justify-between border-t border-dls-border pt-4">
                  <span className="font-mono text-[11px] tabular-nums text-dls-secondary">
                    Page {workflowPage + 1} / {workflowPageCount}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className={rowIconBtnClass}
                      onClick={() => setWorkflowPage((page) => Math.max(0, page - 1))}
                      disabled={workflowPage === 0}
                      title="Previous page"
                      aria-label="Previous page"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className={rowIconBtnClass}
                      onClick={() => setWorkflowPage((page) => Math.min(workflowPageCount - 1, page + 1))}
                      disabled={workflowPage >= workflowPageCount - 1}
                      title="Next page"
                      aria-label="Next page"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {/* Hub catalog hidden for now; flip SKILLS_HUB_UI_ENABLED to restore. */}
      {showHubSection ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 border-t border-dls-border pt-6 sm:flex-row sm:items-baseline sm:justify-between">
            <div>
              <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("skills.available_from_hub")}</span>
              <p className="mt-2 max-w-md text-[13px] leading-relaxed text-dls-secondary">{t("skills.hub_desc")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={openCustomRepoModal} disabled={props.busy} className={ghostActionClass}>
                <Plus size={14} />
                {t("skills.add_git_repo")}
              </button>
              <button
                type="button"
                onClick={() => void extensions.refreshHubSkills({ force: true })}
                disabled={props.busy}
                className={rowIconBtnClass}
                title={t("skills.refresh_hub")}
                aria-label={t("skills.refresh_hub")}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-[12px] text-dls-secondary">
              {t("skills.source_label")}: <span className="font-mono text-dls-text">{activeHubRepoLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hubRepos.map((repo) => {
                const key = `${repo.owner}/${repo.repo}@${repo.ref}`;
                const active = hubRepo ? key === `${hubRepo.owner}/${hubRepo.repo}@${hubRepo.ref}` : false;
                return (
                  <div key={key} className="inline-flex items-center overflow-hidden rounded-full border border-dls-border bg-dls-surface">
                    <button
                      type="button"
                      onClick={() => selectHubRepo(repo)}
                      className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        active ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                      }`}
                      disabled={props.busy}
                    >
                      {key}
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1.5 text-[12px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-red-11"
                      onClick={() => {
                        void Promise.resolve(extensions.removeHubRepo(repo)).then(() => {
                          void extensions.refreshHubSkills({ force: true });
                        });
                      }}
                      disabled={props.busy}
                      title={t("skills.remove_saved_repo")}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {hubSkillsStatus ? (
            <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
              {hubSkillsStatus}
            </div>
          ) : null}

          {filteredHubSkills.length === 0 ? (
            <div className="border-y border-dls-border py-12 text-center text-[14px] text-dls-secondary">
              {hubRepo ? t("skills.no_hub_skills") : t("skills.no_hub_repo_selected")}
            </div>
          ) : (
            <div className="divide-y divide-dls-border border-y border-dls-border">
              {filteredHubSkills.map((skill) => (
                <div
                  key={`${skill.source.owner}/${skill.source.repo}/${skill.name}`}
                  className="group flex items-center gap-4 py-4 pl-5 pr-3 transition-colors hover:bg-dls-hover/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{skill.name}</h4>
                      <span className={typeTagClass}>
                        {skill.source.owner}/{skill.source.repo}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[13px] leading-relaxed text-dls-secondary">
                      {skill.description || t("skills.from_repo", undefined, { owner: skill.source.owner, repo: skill.source.repo })}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${ghostActionClass} shrink-0`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void installFromHub(skill);
                    }}
                    disabled={props.busy || installingHubSkill === skill.name}
                    title={t("skills.install_name_title", undefined, { name: skill.name })}
                  >
                    {installingHubSkill === skill.name ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    {installingHubSkill === skill.name ? t("skills.installing") : t("common.add")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <Dialog
        open={Boolean(selectedSkill)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkill(null);
            setSelectedContent("");
            setSelectedDirty(false);
            setSelectedError(null);
            setSelectedLoading(false);
          }
        }}
      >
        <DialogContent className="flex max-h-[88vh] min-h-0 w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
            <DialogHeader className="flex-row items-start justify-between gap-4 border-b border-subtle py-4 pl-6 pr-14 space-y-0">
              <div className="min-w-0 space-y-1">
                <span className="lw-section-eyebrow">{selectedSkill?.name?.startsWith("workflow") ? "Automation" : "Skill"}</span>
                <DialogTitle className="min-w-0 truncate text-lg font-semibold text-ink">{selectedSkill?.name}</DialogTitle>
                {selectedSkill?.description ? (
                  <p className="line-clamp-1 text-sm text-subtext">{selectedSkill.description}</p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="default"
                disabled={!selectedDirty || props.busy}
                onClick={() => void saveSelectedSkill()}
              >
                {t("common.save")}
              </Button>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {selectedError ? <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">{selectedError}</div> : null}
              {selectedLoading ? (
                <div className="flex items-center gap-2 text-sm text-subtext"><Spinner className="size-4" /> {t("skills.loading")}</div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-2xs font-semibold uppercase tracking-wide text-tertiary">Definition</span>
                      <span className="text-2xs text-tertiary">Markdown</span>
                    </div>
                    <textarea
                      value={selectedContent}
                      onChange={(event) => {
                        setSelectedContent(event.currentTarget.value);
                        setSelectedDirty(true);
                      }}
                      className="min-h-[380px] w-full resize-none rounded-2xl border border-subtle bg-sunken px-4 py-3.5 text-[13px] font-mono leading-relaxed text-ink transition-[border-color,box-shadow] focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--lw-focus-ring)]"
                      spellCheck={false}
                    />
                  </div>
                  {/* Firm templates/playbooks packaged inside this skill's own folder. */}
                  {selectedSkill ? (
                    <SkillResourcesPanel
                      skillName={selectedSkill.name}
                      busy={props.busy}
                      extensions={extensions}
                      onChanged={() => void syncEditorAfterResourceChange()}
                    />
                  ) : null}
                </>
              )}
            </div>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={Boolean(uninstallTarget)}
        title={t("skills.uninstall_title")}
        message={t("skills.uninstall_warning").replace("{name}", uninstallTarget?.name ?? "")}
        confirmLabel={t("skills.uninstall")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setUninstallTarget(null)}
        onConfirm={() => {
          const target = uninstallTarget;
          setUninstallTarget(null);
          if (!target) return;
          void extensions.uninstallSkill(target.name);
        }}
      />


      {SKILLS_HUB_UI_ENABLED ? (
        <Dialog
          open={customRepoOpen}
          onOpenChange={(open) => {
            if (!open) closeCustomRepoModal();
          }}
        >
          <DialogContent showCloseButton={false} className="w-full max-w-lg overflow-hidden sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("skills.add_custom_repo")}</DialogTitle>
              <DialogDescription>{t("skills.github_repo_hint")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.owner_label")}</div>
                  <input
                    type="text"
                    value={customRepoOwner}
                    onChange={(event) => setCustomRepoOwner(event.currentTarget.value)}
                    placeholder="eigenweltlabs"
                    className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellCheck={false}
                  />
                </label>
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.repo_label")}</div>
                  <input
                    type="text"
                    value={customRepoName}
                    onChange={(event) => setCustomRepoName(event.currentTarget.value)}
                    placeholder="skills-catalog"
                    className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellCheck={false}
                  />
                </label>
              </div>

              <label className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.ref_label")}</div>
                <input
                  type="text"
                  value={customRepoRef}
                  onChange={(event) => setCustomRepoRef(event.currentTarget.value)}
                  placeholder="main"
                  className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                  spellCheck={false}
                />
              </label>

              {customRepoError ? <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{customRepoError}</div> : null}
            </div>
            <DialogFooter>
              <DialogClose
                disabled={props.busy}
                render={<Button variant="outline" disabled={props.busy} />}
              >
                {t("common.cancel")}
              </DialogClose>
              <Button variant="secondary" onClick={saveCustomRepo} disabled={props.busy}>
                {t("skills.save_and_load")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * A real "create a skill" form: name + description + instructions, written
 * straight to .opencode/skills/<name>/SKILL.md via the store's createSkill
 * (installSkillTemplate). No round-trip through chat.
 */
function SkillCreatorButton(props: {
  disabled?: boolean;
  existingNames: Set<string>;
  onCreate: (input: { name: string; content: string; description?: string }) => Promise<{ ok: boolean; message: string }>;
  saveSkillResource: SkillResourcesStore["saveSkillResource"];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [staged, setStaged] = useState<StagedResourceFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = name.trim().toLowerCase();
  const nameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64;
  const nameTaken = nameValid && props.existingNames.has(slug);
  const canSubmit = nameValid && !nameTaken && description.trim().length > 0 && body.trim().length > 0 && !saving;

  const reset = () => {
    setName("");
    setDescription("");
    setBody("");
    setStaged([]);
    setError(null);
    setSaving(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    // SKILL.md = YAML frontmatter (name + description) then the instructions.
    // JSON.stringify gives a valid YAML double-quoted scalar (escapes :, ", newlines).
    const content = `---\nname: ${slug}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body.trim()}\n`;
    try {
      const result = await props.onCreate({ name: slug, content, description: description.trim() });
      if (result.ok) {
        // The skill folder exists now — flush the files staged during creation.
        const failed = await flushStagedResources(props.saveSkillResource, slug, staged);
        if (failed.length > 0) {
          toast.error(t("skill_resources.staged_upload_failed", { names: failed.join(", ") }));
        }
        setOpen(false);
        reset();
      } else {
        setError(result.message || "Could not create the skill.");
        setSaving(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the skill.");
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={props.disabled} className={pillPrimaryClass}>
        <Plus size={14} />
        New skill
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New skill</DialogTitle>
            <DialogDescription>
              Describe when the agent should use this skill and what to do. Saved to your workspace as a SKILL.md.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
            {error ? (
              <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
            ) : null}

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-dls-text">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="contract-summary"
                spellCheck={false}
                className={inputClass}
              />
              <span className="text-[11px] text-dls-secondary">
                {slug.length === 0
                  ? "Lowercase, kebab-case. Becomes the folder name."
                  : nameTaken
                    ? "A skill with this name already exists."
                    : !nameValid
                      ? "Use lowercase letters, numbers, and dashes only."
                      : `.opencode/skills/${slug}/SKILL.md`}
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-dls-text">Description (when to use it)</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                rows={2}
                placeholder="Use when the user wants to summarize a contract's key terms."
                className={`${inputClass} resize-none`}
              />
              <span className="text-[11px] text-dls-secondary">This is the trigger the agent matches on. Be specific.</span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-dls-text">Instructions</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.currentTarget.value)}
                rows={12}
                placeholder={"Step-by-step instructions the agent follows when this skill is active.\n\n1. ...\n2. ..."}
                spellCheck={false}
                className={`${inputClass} min-h-[240px] font-mono text-xs`}
              />
            </label>

            <StagedResourcesField staged={staged} onChange={setStaged} disabled={saving} />
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Creating...
                </>
              ) : (
                "Create skill"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Builds the SKILL.md for a workflow. Both types carry `kind: workflow` + `workflow_type`
// frontmatter; tabular workflows embed the instruction to run via the tabular-review skill
// plus the free-text list of fields the creator typed.
function buildWorkflowContent(input: {
  type: WorkflowType;
  fullName: string;
  title: string;
  description: string;
  body: string;
}): string {
  // Frontmatter stays standard (name + description only) so opencode loads workflows
  // as ordinary skills — non-standard keys like `kind`/`workflow_type` make the engine
  // skip the SKILL.md. The `workflow-<type>-` name prefix is what marks it as a workflow.
  const frontmatter =
    `---\nname: ${input.fullName}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n`;
  if (input.type === "assistant") {
    return `${frontmatter}\n${input.body.trim()}\n`;
  }
  const md = [
    `# ${input.title}`,
    ``,
    "This is a **tabular review workflow**. To run it, load the **`tabular-review`** skill",
    "and build a review grid over the user's documents — one row per document, with a",
    "source citation in every cell — extracting the fields described below.",
    ``,
    `## What to extract`,
    ``,
    input.body.trim(),
    ``,
    `When the user asks to run "${input.title}", use the \`tabular-review\` skill.`,
  ].join("\n");
  return `${frontmatter}\n${md}\n`;
}

// Progress card for a template-to-workflow generation run. Clicking it opens
// the agent's session in the normal chat view so the user can watch (and answer
// any permission prompts); done/error states carry a dismiss control, and a
// failed import can be retried in place (the staged workflows survive it).
function TemplateGenerationRow(props: {
  status: "running" | "done" | "error";
  templatesDir: string;
  error?: string;
  summary?: string;
  onOpen?: () => void;
  onRetry: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const folderName = props.templatesDir.split(/[\/\\]/).filter(Boolean).pop() || props.templatesDir;
  const title =
    props.status === "running"
      ? "Generating workflows from your templates…"
      : props.status === "done"
        ? "Workflows generated from your templates"
        : "Workflow generation failed";
  const subtitle =
    props.status === "running"
      ? `Reading “${folderName}”. Click to watch the agent work`
      : props.status === "done"
        ? `${props.summary ? `${props.summary}. ` : ""}Review them below, or open the session for the full log.`
        : props.error || "Open the session to see what went wrong.";

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await props.onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onOpen?.()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onOpen?.();
      }}
      className="group flex cursor-pointer items-center gap-4 rounded-[16px] border border-dls-border bg-dls-hover/40 px-5 py-4 transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.35)] hover:bg-dls-hover focus-visible:bg-dls-hover focus:outline-none"
    >
      {props.status === "running" ? (
        <Loader2 size={18} className="shrink-0 animate-spin text-dls-accent" />
      ) : props.status === "done" ? (
        <CheckCircle2 size={18} className="shrink-0 text-dls-accent" />
      ) : (
        <Wand2 size={18} className="shrink-0 text-red-500" />
      )}
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[14px] font-medium tracking-[-0.01em] text-dls-text">{title}</h4>
        <p className="mt-0.5 truncate text-[12.5px] leading-relaxed text-dls-secondary">{subtitle}</p>
      </div>
      {props.status === "error" ? (
        <button
          type="button"
          className={ghostActionClass}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void retry();
          }}
          disabled={retrying}
        >
          {retrying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Retry import
        </button>
      ) : null}
      {props.status !== "running" ? (
        <button
          type="button"
          className={rowIconBtnClass}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onDismiss();
          }}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}

function WorkflowCreatorButton(props: {
  disabled?: boolean;
  existingNames: Set<string>;
  onCreate: (input: { name: string; content: string; description?: string }) => Promise<{ ok: boolean; message: string }>;
  saveSkillResource: SkillResourcesStore["saveSkillResource"];
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<WorkflowType | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [staged, setStaged] = useState<StagedResourceFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Workflows are stored with a `workflow-<type>-` name prefix so opencode loads them as
  // standard skills (frontmatter stays just name + description). The UI recognizes them by
  // this prefix — see isWorkflowCard / cardWorkflowType / workflowDisplayName.
  const fullName = type ? `workflow-${type}-${slug}` : slug;
  const nameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && fullName.length <= 64;
  const nameTaken = nameValid && props.existingNames.has(fullName);
  const canSubmit =
    !!type &&
    nameValid &&
    !nameTaken &&
    description.trim().length > 0 &&
    body.trim().length > 0 &&
    !saving;

  const reset = () => {
    setType(null);
    setName("");
    setDescription("");
    setBody("");
    setStaged([]);
    setError(null);
    setSaving(false);
  };

  const submit = async () => {
    if (!canSubmit || !type) return;
    setSaving(true);
    setError(null);
    const title = name.trim() || workflowDisplayName(fullName);
    const content = buildWorkflowContent({ type, fullName, title, description, body });
    try {
      const result = await props.onCreate({ name: fullName, content, description: description.trim() });
      if (result.ok) {
        captureAnalyticsEvent("workflow_created", {});
        // The workflow folder exists now — flush the files staged during creation.
        const failed = await flushStagedResources(props.saveSkillResource, fullName, staged);
        if (failed.length > 0) {
          toast.error(t("skill_resources.staged_upload_failed", { names: failed.join(", ") }));
        }
        setOpen(false);
        reset();
      } else {
        setError(result.message || "Could not create the workflow.");
        setSaving(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the workflow.");
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

  return (
    <>
      {/* Secondary on purpose: "Generate from templates" is the hero action in this toolbar. */}
      <button type="button" onClick={() => setOpen(true)} disabled={props.disabled} className={pillSecondaryClass}>
        <Plus size={14} />
        Add workflow
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{type ? `New ${type} workflow` : "New workflow"}</DialogTitle>
            <DialogDescription>
              {type === "tabular"
                ? "A tabular workflow runs a review grid: it tells the agent to use the tabular-review skill with the columns you define."
                : type === "assistant"
                  ? "An assistant workflow is a normal skill — instructions the agent follows for a legal task."
                  : "Choose how this workflow runs. Saved to your workspace as a SKILL.md."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
            {error ? (
              <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
            ) : null}

            {!type ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setType("tabular")}
                  className="flex flex-col gap-2 rounded-2xl border border-dls-border bg-dls-hover p-4 text-left transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.5)]"
                >
                  <Package size={20} className="text-dls-secondary" />
                  <span className="text-sm font-semibold text-dls-text">Tabular</span>
                  <span className="text-[12px] leading-relaxed text-dls-secondary">
                    Review/extract a defined set of columns across many documents, via the tabular-review skill.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setType("assistant")}
                  className="flex flex-col gap-2 rounded-2xl border border-dls-border bg-dls-hover p-4 text-left transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.5)]"
                >
                  <Bot size={20} className="text-dls-secondary" />
                  <span className="text-sm font-semibold text-dls-text">Assistant</span>
                  <span className="text-[12px] leading-relaxed text-dls-secondary">
                    A normal skill — step-by-step instructions for a legal task.
                  </span>
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-dls-text">
                    {type === "tabular" ? <Package size={14} /> : <Bot size={14} />}
                    {type === "tabular" ? "Tabular workflow" : "Assistant workflow"}
                  </span>
                  <button type="button" onClick={() => setType(null)} className="text-[11px] text-dls-secondary underline">
                    Change type
                  </button>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">Name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="NDA Diligence Review"
                    className={inputClass}
                  />
                  <span className="text-[11px] text-dls-secondary">
                    {slug.length === 0
                      ? "A human name; saved as a kebab-case folder."
                      : nameTaken
                        ? "A workflow with this name already exists."
                        : !nameValid
                          ? "Use letters, numbers, and spaces."
                          : `.opencode/skills/${fullName}/SKILL.md`}
                  </span>
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">Description (when to use it)</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.currentTarget.value)}
                    rows={2}
                    placeholder="Use when reviewing NDAs for diligence."
                    className={`${inputClass} resize-none`}
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">
                    {type === "assistant" ? "Instructions" : "Columns to extract"}
                  </span>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.currentTarget.value)}
                    rows={10}
                    spellCheck={false}
                    placeholder={
                      type === "assistant"
                        ? "Step-by-step instructions the agent follows.\n\n1. ...\n2. ..."
                        : "Describe the columns to extract from each document — one per line.\n\nGoverning law\nTermination notice period\nLiability cap"
                    }
                    className={`${inputClass} min-h-[200px] font-mono text-xs`}
                  />
                  {type === "tabular" ? (
                    <span className="text-[11px] text-dls-secondary">
                      Each line becomes a column the tabular-review skill extracts across your documents.
                    </span>
                  ) : null}
                </label>

                <StagedResourcesField staged={staged} onChange={setStaged} disabled={saving} />
              </>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
            {type ? (
              <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
                {saving ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create workflow"
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ImportSkillsButton(props: {
  asWorkflow: boolean;
  busy: boolean;
  canUseDesktopTools: boolean;
  existingNames: Set<string>;
  extensions: SkillsExtensionsStore;
}) {
  const { extensions, asWorkflow } = props;
  const noun = asWorkflow ? "workflow" : "skill";
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<GithubSkillItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const inputClass =
    "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

  const reset = () => {
    setUrl("");
    setRef("");
    setScanning(false);
    setError(null);
    setScanned(null);
    setSelected(new Set());
    setFilter("");
    setImporting(false);
    setStatus(null);
  };

  const finalNameFor = (item: GithubSkillItem) => {
    const folder = item.dir.split("/").filter(Boolean).pop() ?? "";
    const base = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return asWorkflow ? `workflow-assistant-${base}` : base;
  };

  const runScan = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setScanning(true);
    setError(null);
    setScanned(null);
    setSelected(new Set());
    setStatus(null);
    try {
      const result = await extensions.scanGithubSkills(trimmed, ref.trim() || undefined);
      setScanned(result.skills);
      if (result.skills.length === 0) setError("No skills found — this repo has no SKILL.md folders.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not scan that repo.");
    } finally {
      setScanning(false);
    }
  };

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const items = scanned ?? [];
    if (!query) return items;
    return items.filter(
      (skill) =>
        skill.dir.toLowerCase().includes(query) ||
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query),
    );
  }, [scanned, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, GithubSkillItem[]>();
    for (const skill of filtered) {
      const parent = skill.dir.split("/").slice(0, -1).join("/") || "(root)";
      const list = map.get(parent) ?? [];
      list.push(skill);
      map.set(parent, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const toggle = (dir: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  const toggleGroup = (items: GithubSkillItem[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (on) next.add(item.dir);
        else next.delete(item.dir);
      }
      return next;
    });

  const runImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    setStatus(null);
    try {
      const result = await extensions.importGithubSkills({
        url: url.trim(),
        ref: ref.trim() || undefined,
        paths: [...selected],
        asWorkflow,
      });
      setStatus(result.message);
      if (result.ok) {
        toast.success(result.message);
        setSelected(new Set());
      }
    } finally {
      setImporting(false);
    }
  };

  const runLocal = () => {
    setOpen(false);
    void Promise.resolve(extensions.importLocalSkill({ asWorkflow }));
  };

  const runLocalZip = () => {
    setOpen(false);
    void Promise.resolve(extensions.importLocalSkillZip({ asWorkflow }));
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={props.busy} className={ghostActionClass}>
        <Download size={14} />
        Import
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="flex max-h-[88vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{asWorkflow ? "Import workflows" : "Import skills"}</DialogTitle>
            <DialogDescription>
              Bring in {noun} folders from a GitHub repo or a local folder. Each is a directory containing a SKILL.md.
              {asWorkflow ? " Imported items are added as workflows." : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-px py-1">
            <div className="space-y-2">
              <span className="text-xs font-medium text-dls-text">From GitHub</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://github.com/owner/repo"
                  className={inputClass}
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runScan();
                  }}
                />
                <input
                  value={ref}
                  onChange={(event) => setRef(event.currentTarget.value)}
                  placeholder="branch (optional)"
                  className={`${inputClass} sm:max-w-[36%]`}
                  spellCheck={false}
                />
                <Button type="button" onClick={() => void runScan()} disabled={scanning || !url.trim()}>
                  {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  Scan
                </Button>
              </div>

              {error ? (
                <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
              ) : null}

              {scanned && scanned.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      value={filter}
                      onChange={(event) => setFilter(event.currentTarget.value)}
                      placeholder="Filter…"
                      className={`${inputClass} h-8 py-1`}
                      spellCheck={false}
                    />
                    <span className="shrink-0 text-[11px] tabular-nums text-dls-secondary">
                      {selected.size} selected · {scanned.length} found
                    </span>
                  </div>
                  <div className="max-h-72 space-y-3 overflow-y-auto rounded-xl border border-dls-border p-2">
                    {groups.map(([group, items]) => {
                      const allOn = items.every((item) => selected.has(item.dir));
                      return (
                        <div key={group} className="space-y-0.5">
                          <div className="flex items-center justify-between px-1">
                            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dls-secondary/70">
                              {group}
                            </span>
                            <button
                              type="button"
                              className="text-[11px] text-dls-secondary transition-colors hover:text-dls-text"
                              onClick={() => toggleGroup(items, !allOn)}
                            >
                              {allOn ? "Clear" : "Select all"}
                            </button>
                          </div>
                          {items.map((skill) => {
                            const alreadyInstalled = props.existingNames.has(finalNameFor(skill));
                            return (
                              <label
                                key={skill.dir}
                                className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-dls-hover/60"
                              >
                                <input
                                  type="checkbox"
                                  checked={selected.has(skill.dir)}
                                  onChange={() => toggle(skill.dir)}
                                  className="mt-1 size-3.5 accent-[var(--dls-accent)]"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-[13px] font-medium text-dls-text">{skill.name}</span>
                                    {alreadyInstalled ? (
                                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-dls-secondary/70">
                                        installed
                                      </span>
                                    ) : null}
                                  </div>
                                  {skill.description ? (
                                    <div className="truncate text-[12px] leading-snug text-dls-secondary">
                                      {skill.description}
                                    </div>
                                  ) : null}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  {status ? <div className="text-xs text-dls-secondary">{status}</div> : null}
                  <Button type="button" disabled={selected.size === 0 || importing} onClick={() => void runImport()}>
                    {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {importing ? "Importing…" : selected.size ? `Import ${selected.size} selected` : "Import selected"}
                  </Button>
                </div>
              ) : null}
            </div>

            <Separator />

            <div className="space-y-2">
              <span className="text-xs font-medium text-dls-text">From this machine</span>
              <p className="text-[12px] leading-relaxed text-dls-secondary">
                Pick a folder containing a SKILL.md, or a zip exported from LegalWork.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={props.busy || !props.canUseDesktopTools} onClick={runLocal}>
                  <FolderOpen size={14} />
                  Choose folder…
                </Button>
                <Button type="button" variant="outline" disabled={props.busy || !props.canUseDesktopTools} onClick={runLocalZip}>
                  <FileArchive size={14} />
                  Choose zip…
                </Button>
              </div>
              {!props.canUseDesktopTools ? (
                <p className="text-[11px] text-dls-secondary/70">{t("skills.desktop_required")}</p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SkillsView;
