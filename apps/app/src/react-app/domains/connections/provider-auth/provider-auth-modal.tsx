/** @jsxImportSource react */
import {
  ArrowLeft,
  ChevronDown,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openDesktopUrl } from "@/app/lib/desktop";
import { compareProviders } from "@/app/utils/providers";
import { modelDisplayName } from "@/app/utils/models";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { TextInput } from "../../../design-system/text-input";
import {
  errorBannerClass,
  surfaceCardClass,
} from "../../workspace/modal-styles";

const methodPillToneClass = (type: ProviderAuthMethod["type"]) => {
  if (type === "oauth")
    return "border-[rgba(var(--dls-accent-rgb),0.22)] bg-[rgba(var(--dls-accent-rgb),0.07)] text-dls-accent";
  return "border-dls-border bg-dls-hover text-dls-secondary";
};
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2/client";
import { t } from "@/i18n";
import type {
  CustomProviderApiType,
  CustomProviderEditData,
  CustomProviderInstallInput,
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderOAuthStartResult,
} from "./store";
import {
  localRuntimeTemplates,
  resolveTemplateName,
  slugifyProviderId,
  type LocalRuntimeTemplate,
} from "./local-templates";
import { findCustomModelLimitProblem } from "./custom-provider-config";
import { defaultOutputLimit } from "@legalwork/types/model-limits";
import { ChatGptPlanCard } from "./chatgpt-plan-card";

/** Base URLs that default to the Responses API (`@ai-sdk/openai`). */
function inferCustomApiType(baseURL: string): CustomProviderApiType {
  return /(^|\.)openai\.com|\.openai\.azure\.com|azure/i.test(baseURL) ? "responses" : "chat";
}

/** Per-model draft edited in the form before install. Each model carries its
 * own capability flags — reasoning/tool support are model properties, not
 * provider-wide ones. */
type CustomModelDraft = {
  id: string;
  name?: string;
  toolCall: boolean;
  reasoning: boolean;
  contextLimit: string;
  /** Longest single response in tokens; blank means the default for the context window. */
  outputLimit: string;
};

/**
 * Heuristic guess of whether a model id is a reasoning model, used only as the
 * default for a freshly-added model (the user can toggle it). Covers the common
 * reasoning families: OpenAI o-series + GPT-5, DeepSeek-R, Qwen QwQ, and any id
 * that literally mentions "reason"/"thinking".
 */
function inferReasoningFromId(id: string): boolean {
  const value = id.toLowerCase();
  return (
    /\bo[1-9]\b/.test(value) ||
    value.includes("gpt-5") ||
    value.includes("qwq") ||
    /deepseek-?r\d/.test(value) ||
    /\br1\b/.test(value) ||
    value.includes("reason") ||
    value.includes("thinking")
  );
}

/** A positive whole number of tokens from a form field, or null when blank or invalid. */
function parseTokenCount(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Placeholder for an empty Output field: the default the engine will get for
 * the context window entered, or "auto" when there is none (no limit block is
 * written at all then, and the engine applies its own default).
 */
function outputLimitPlaceholder(contextLimit: string): string {
  const context = parseTokenCount(contextLimit);
  return context === null ? "auto" : String(defaultOutputLimit(context));
}

function makeCustomModelDraft(id: string): CustomModelDraft {
  return { id, toolCall: true, reasoning: inferReasoningFromId(id), contextLimit: "", outputLimit: "" };
}

const DEFAULT_BASE_URL_PLACEHOLDER = "https://api.example.com/v1";

/**
 * First-class OpenAI-spec providers that still need a per-deployment Base URL
 * and key (so they can't ship as a static models.dev entry). They appear as
 * their own entries in the provider list and open the custom form pre-branded
 * with a fixed provider id, name, API type, and a Base-URL hint — the user
 * supplies their endpoint, key, and models.
 */
type BrandedCustomProvider = {
  id: string;
  name: string;
  apiType: CustomProviderApiType;
  baseUrlPlaceholder: string;
  /**
   * Fixed-endpoint runtimes (local model servers) listen on a well-known URL,
   * so we pre-fill the Base URL field instead of only hinting at it — the user
   * just fetches their models and connects. Omit for per-deployment gateways.
   */
  baseUrlDefault?: string;
  description: string;
};

// Built per call, not once at import: `t()` reads the current language, so a
// module-level constant would freeze these descriptions.
const brandedCustomProviders = (): BrandedCustomProvider[] => [
  {
    id: "lmstudio",
    name: "LM Studio",
    apiType: "chat",
    baseUrlPlaceholder: "http://localhost:1234/v1",
    baseUrlDefault: "http://localhost:1234/v1",
    description: t("local_templates.lmstudio_note"),
  },
  {
    id: "apertus",
    name: "Apertus AI",
    apiType: "chat",
    baseUrlPlaceholder: "https://<your-gateway>.apertus.ai/v1",
    description: t("providers.apertus_desc"),
  },
  {
    id: "aki",
    name: "Aki Cloud",
    apiType: "chat",
    baseUrlPlaceholder: "https://api.aki.io/v1",
    baseUrlDefault: "https://api.aki.io/v1",
    description: t("providers.aki_desc"),
  },
];

/**
 * First-class Eigenwelt Model API entry. Unlike branded custom providers it
 * never opens the custom form: sign-in and API-key connect both fetch the
 * model list from the Eigenwelt platform (via the LegalWork server) and write
 * the provider block into the workspace runtime config.
 */
const EIGENWELT_PROVIDER_ID = "eigenwelt";

/** Synthetic list entry id for the user-defined OpenAI-compatible provider. */
const CUSTOM_PROVIDER_ENTRY_ID = "__custom_openai_compatible__";

/** Synthetic list entry id for the templated "Local model" provider. */
const LOCAL_PROVIDER_ENTRY_ID = "__local_model__";

type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
};

type ProviderOAuthSession = ProviderOAuthStartResult & {
  providerId: string;
  methodLabel: string;
};

function normalizeAuthorizationCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const parseCodeParams = (value: string) => {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    const code = params.get("code")?.trim();
    if (!code) return null;
    const state = params.get("state")?.trim();
    return state && !code.includes("#") ? `${code}#${state}` : code;
  };

  try {
    const url = new URL(trimmed);
    const fromSearch = parseCodeParams(url.search);
    if (fromSearch) return fromSearch;
    const fromHash = parseCodeParams(url.hash);
    if (fromHash) return fromHash;
  } catch {
    // Not a URL; fall through to query-string and raw-code handling.
  }

  if (trimmed.includes("code=")) {
    const queryStart = trimmed.indexOf("code=");
    const fromQuery = parseCodeParams(trimmed.slice(queryStart));
    if (fromQuery) return fromQuery;
  }

  return trimmed.replace(/^authorization\s+code:\s*/i, "").trim();
}

const PROVIDER_LABELS: Record<string, string> = {
  legalwork: "LegalWork",
  eigenwelt: "Eigenwelt Subscription",
  opencode: "OpenCode Zen",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
  apertus: "Apertus AI",
  "apertus-ai": "Apertus AI",
  aki: "Aki Cloud",
  "aki-cloud": "Aki Cloud",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  llamacpp: "llama.cpp (local)",
  vllm: "vLLM (local)",
  localai: "LocalAI (local)",
};
// Built-in local providers keep friendly names in the provider list.

export type ProviderAuthModalProps = {
  open: boolean;
  allowChatGptSubscription: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  preferredProviderId?: string | null;
  /** A subscription was already selected; start its OAuth without asking again. */
  startOAuth?: boolean;
  workerType?: "local" | "remote";
  providers: ProviderAuthProvider[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onSubmitCustomProvider?: (input: CustomProviderInstallInput) => Promise<string | void>;
  onFetchCustomModels?: (input: { baseURL: string; apiKey: string; providerId?: string }) => Promise<string[]>;
  onRefreshCustomProvider?: (providerId: string) => Promise<CustomProviderEditData | null>;
  onReadCustomProvider?: (providerId: string) => Promise<CustomProviderEditData | null>;
  /** Starts the server-owned t("provider_auth.sign_in_eigenwelt") flow. */
  onEigenweltSignIn?: () => Promise<{ authorizeUrl: string; sessionId: string }>;
  /** Long-polls the Eigenwelt sign-in session until the connection is finalized. */
  onEigenweltWait?: (
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ) => Promise<{ connected: boolean; cancelled?: boolean; message?: string }>;
  /** When set, the modal opens straight into the custom form to edit this provider. */
  customEdit?: CustomProviderEditData | null;
  customModelsOnly?: boolean;
  onSubmitOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  onRefreshProviders?: () => Promise<unknown>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
  const workerType = props.workerType === "remote" ? "remote" : "local";
  const isRemoteWorker = workerType === "remote";

  const [view, setView] = useState<
    "list" | "method" | "api" | "oauth-code" | "oauth-auto" | "custom"
  >("list");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [oauthSession, setOauthSession] = useState<ProviderOAuthSession | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pollingBusy, setPollingBusy] = useState(false);
  const [oauthAutoBusy, setOauthAutoBusy] = useState(false);
  const [oauthCodeCopied, setOauthCodeCopied] = useState(false);
  const [oauthBrowserOpened, setOauthBrowserOpened] = useState(false);

  // Custom (OpenAI-compatible) provider form state.
  const [customName, setCustomName] = useState("");
  const [customBaseURL, setCustomBaseURL] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customApiType, setCustomApiType] = useState<CustomProviderApiType>("chat");
  const [customApiTypeTouched, setCustomApiTypeTouched] = useState(false);
  const [customBaseUrlPlaceholder, setCustomBaseUrlPlaceholder] = useState(DEFAULT_BASE_URL_PLACEHOLDER);
  // A provider id pinned for this form (set when editing an existing provider,
  // or when adding a branded provider like Apertus). null → derive from name.
  const [customFixedProviderId, setCustomFixedProviderId] = useState<string | null>(null);
  // True only when editing an already-connected provider (vs. a fresh add).
  const [customEditMode, setCustomEditMode] = useState(false);
  // Display name of a branded provider being added (e.g. "Apertus AI"), else null.
  const [customBrandName, setCustomBrandName] = useState<string | null>(null);
  // True when the form is in "Local model" mode — shows the runtime template
  // picker. `customTemplateId` is the currently-selected template, if any.
  const [customShowLocalTemplates, setCustomShowLocalTemplates] = useState(false);
  const [customTemplateId, setCustomTemplateId] = useState<string | null>(null);
  const [customModelInput, setCustomModelInput] = useState("");
  const [customModels, setCustomModels] = useState<CustomModelDraft[]>([]);
  const [customDeselectedModels, setCustomDeselectedModels] = useState<CustomModelDraft[]>([]);
  const [customModelSearch, setCustomModelSearch] = useState("");
  const [customFetchedModels, setCustomFetchedModels] = useState<string[]>([]);
  const [customFetching, setCustomFetching] = useState(false);
  const [customAutoRefresh, setCustomAutoRefresh] = useState(false);
  const [customAutoRefreshTouched, setCustomAutoRefreshTouched] = useState(false);
  const [customSavedBaseURL, setCustomSavedBaseURL] = useState("");
  const [customRefreshStatus, setCustomRefreshStatus] = useState<CustomProviderEditData["modelRefresh"]>();
  const [customBusy, setCustomBusy] = useState(false);
  const customModelChoices = useMemo(() => [...new Set([
    ...customFetchedModels,
    ...customModels.map(model => model.id),
    ...customDeselectedModels.map(model => model.id),
  ])].sort((left, right) => left.localeCompare(right)), [customFetchedModels, customModels, customDeselectedModels]);
  const customModelNames = useMemo(() => new Map([...customDeselectedModels, ...customModels].map(model => [model.id, model.name])), [customDeselectedModels, customModels]);
  const filteredCustomModelChoices = customModelChoices.filter(id => {
    const query = customModelSearch.trim().toLowerCase();
    return id.toLowerCase().includes(query) || modelDisplayName(id, customModelNames.get(id)).toLowerCase().includes(query);
  });

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const providerPollRef = useRef<number | null>(null);
  const oauthAutoPollRef = useRef<number | null>(null);
  const oauthCodeCopiedResetRef = useRef<number | null>(null);
  const pollingBusyRef = useRef(false);
  const oauthSubmitBusyRef = useRef(false);
  const oauthAutoBusyRef = useRef(false);
  const oauthStartBusyRef = useRef(false);
  const oauthStartTokenRef = useRef(0);
  const autoOpenedPreferredProviderIdRef = useRef<string | null>(null);
  const customEditPrefilledRef = useRef<string | null>(null);
  const customRequestRef = useRef(0);
  const customModelsSectionRef = useRef<HTMLDivElement | null>(null);
  const customModelsFocusRef = useRef(false);
  // Bumped when the modal closes / navigates back / restarts the flow so the
  // store's Eigenwelt sign-in long-poll for a stale attempt stops instead of
  // finalizing. Each attempt captures the token at start and cancels itself
  // once the ref moves on.
  const eigenweltWaitTokenRef = useRef(0);

  const isEditingCustomProvider = customEditMode;
  const isLmStudio = customFixedProviderId === "lmstudio" || customFixedProviderId === "lm-studio" || customTemplateId === "lmstudio";
  const activeBrandedProvider =
    !customEditMode && customBrandName
      ? brandedCustomProviders().find((provider) => provider.id === customFixedProviderId) ?? null
      : null;
  const activeLocalTemplate = customShowLocalTemplates
    ? localRuntimeTemplates().find((template) => template.id === customTemplateId) ?? null
    : null;

  const formatProviderName = (id: string, fallback?: string) => {
    const named = fallback?.trim();
    if (named) return named;

    const normalized = id.trim();
    const mapped = PROVIDER_LABELS[normalized.toLowerCase()];
    if (mapped) return mapped;

    const cleaned = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return id;

    return cleaned
      .split(" ")
      .flatMap((word) => {
        if (!word) return [];
        if (/\d/.test(word) || word.length <= 3) {
          return [word.toUpperCase()];
        }
        const lower = word.toLowerCase();
        return [lower.charAt(0).toUpperCase() + lower.slice(1)];
      })
      .join(" ");
  };

  const isOpenAiHeadlessMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && (label.includes("headless") || label.includes("device"));
  };

  const isOpenAiProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "openai" || normalizedName === "openai";
  };

  const isAnthropicProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "anthropic" || normalizedName === "anthropic";
  };

  const isOpencodeZenProvider = (id: string) => id.trim().toLowerCase() === "opencode";

  const OPENCODE_ZEN_KEY_URL = "https://opencode.ai/auth";

  // The "Claude Pro/Max" method signs in with a consumer Claude subscription
  // rather than a Console API key. Anthropic's Consumer Terms restrict that
  // OAuth to Claude Code / claude.ai, so we surface a warning before use.
  const isClaudeSubscriptionMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && label.includes("pro/max");
  };

  const entries = useMemo<ProviderAuthEntry[]>(() => {
    const methods = props.authMethods ?? {};
    const connected = new Set(props.connectedProviderIds ?? []);
    const providers = props.providers ?? [];

    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const nextEntries = Object.keys(methods)
      .flatMap((id) => {
        const provider = providersById.get(id);
        const entryMethods = (methods[id] ?? []).filter((method) => {
          if (!isOpenAiProvider(id, provider?.name)) return true;
          if (method.type !== "oauth") return true;
          if (!props.allowChatGptSubscription) return false;
          if (isRemoteWorker) return isOpenAiHeadlessMethod(method);
          return !isOpenAiHeadlessMethod(method);
        });
        if (entryMethods.length === 0) return [];
        return [{
          id,
          name: formatProviderName(id, provider?.name),
          methods: entryMethods,
          connected: connected.has(id),
          env: Array.isArray(provider?.env) ? provider.env : [],
        } satisfies ProviderAuthEntry];
      })
      .sort(compareProviders);

    // First-class Eigenwelt entry: exactly a sign-in button — OAuth only, no
    // API-key option, no base-URL field, no models fields, no custom form.
    if (
      props.onEigenweltSignIn &&
      !nextEntries.some((entry) => entry.id === EIGENWELT_PROVIDER_ID)
    ) {
      nextEntries.push({
        id: EIGENWELT_PROVIDER_ID,
        name: "Eigenwelt Subscription",
        methods: [{ type: "oauth" as const, label: t("provider_auth.sign_in_eigenwelt") }],
        connected: connected.has(EIGENWELT_PROVIDER_ID),
        env: [],
      });
      // PINNED_PROVIDER_ORDER pins eigenwelt first.
      nextEntries.sort(compareProviders);
    }

    if (props.onSubmitCustomProvider) {
      // First-class branded providers (e.g. Apertus) that open the custom form.
      // Skip any already surfaced via auth methods to avoid duplicate ids.
      const existingIds = new Set(nextEntries.map((entry) => entry.id));
      for (const branded of brandedCustomProviders()) {
        if (existingIds.has(branded.id)) continue;
        nextEntries.push({
          id: branded.id,
          name: branded.name,
          methods: [{ type: "api", label: "OpenAI-compatible" }],
          connected: connected.has(branded.id),
          env: [],
        });
      }
      // Re-sort branded providers before adding the Local and Custom entries.
      nextEntries.sort(compareProviders);

      // One consolidated "Local model" entry with per-runtime templates
      // (llama.cpp, vLLM, LocalAI, …), with endpoint discovery on the worker.
      nextEntries.push({
        id: LOCAL_PROVIDER_ENTRY_ID,
        name: t("providers.local_model_name"),
        methods: [{ type: "api", label: t("providers.local_model_label") }],
        connected: false,
        env: [],
      });

      // Generic user-defined option, pinned at the top.
      nextEntries.unshift({
        id: CUSTOM_PROVIDER_ENTRY_ID,
        name: t("provider_auth.custom_provider"),
        methods: [{ type: "api", label: "OpenAI-compatible" }],
        connected: false,
        env: [],
      });
    }

    return nextEntries;
  }, [
    isRemoteWorker,
    props.allowChatGptSubscription,
    props.authMethods,
    props.connectedProviderIds,
    props.providers,
    props.onSubmitCustomProvider,
    props.onEigenweltSignIn,
  ]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedProviderId) ?? null,
    [entries, selectedProviderId],
  );

  const resolvedView = selectedEntry ? view : "list";
  useEffect(() => {
    if (customFetching || !customModelsFocusRef.current || resolvedView !== "custom") return;
    customModelsFocusRef.current = false;
    customModelsSectionRef.current?.scrollIntoView({ block: "start" });
  }, [customFetching, customFetchedModels, resolvedView]);
  const errorMessage = localError ?? props.error;

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const methodText = entry.methods
        .map((method) => method.label || (method.type === "oauth" ? "OAuth" : t("providers.api_key_label")))
        .join(" ");
      return `${entry.name} ${entry.id} ${methodText}`.toLowerCase().includes(query);
    });
  }, [entries, searchQuery]);

  const oauthInstructions = oauthSession?.authorization.instructions?.trim() ?? "";
  const isOpenAiHeadlessSession = Boolean(
    oauthSession && oauthSession.providerId === "openai" && oauthSession.methodLabel.toLowerCase().includes("headless"),
  );
  // The Eigenwelt session is synthetic (server-owned flow, no engine OAuth
  // method behind it): completion runs via onEigenweltWait, so the generic
  // engine oauth.callback polling must not fire for it.
  const isEigenweltOauthSession = oauthSession?.providerId === EIGENWELT_PROVIDER_ID;
  const shouldStartOauthAutoPolling =
    props.open &&
    resolvedView === "oauth-auto" &&
    oauthSession &&
    !isEigenweltOauthSession &&
    (!isOpenAiHeadlessSession || oauthBrowserOpened);

  const oauthDisplayCode = useMemo(() => {
    if (!oauthInstructions) return "";
    const matched = oauthInstructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0];
    if (matched) return matched;
    if (oauthInstructions.includes(":")) {
      return oauthInstructions.split(":").slice(1).join(":").trim();
    }
    return oauthInstructions;
  }, [oauthInstructions]);

  // `method.label` is upstream OpenCode catalog text and stays as the provider
  // publishes it; only our fallback is translated.
  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : t("providers.api_key_label"));

  const actionDisabled = props.loading || props.submitting;

  const resetState = () => {
    if (oauthCodeCopiedResetRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
      oauthCodeCopiedResetRef.current = null;
    }
    eigenweltWaitTokenRef.current += 1;
    oauthStartTokenRef.current += 1;
    customRequestRef.current += 1;
    setView("list");
    setSelectedProviderId(null);
    setApiKeyInput("");
    setOauthCodeInput("");
    setOauthSession(null);
    setSearchQuery("");
    setActiveEntryIndex(0);
    setLocalError(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    setCustomName("");
    setCustomBaseURL("");
    setCustomApiKey("");
    setCustomApiType("chat");
    setCustomApiTypeTouched(false);
    setCustomBaseUrlPlaceholder(DEFAULT_BASE_URL_PLACEHOLDER);
    setCustomFixedProviderId(null);
    setCustomEditMode(false);
    setCustomBrandName(null);
    setCustomShowLocalTemplates(false);
    setCustomTemplateId(null);
    setCustomModelInput("");
    setCustomModels([]);
    setCustomDeselectedModels([]);
    setCustomModelSearch("");
    setCustomFetchedModels([]);
    setCustomFetching(false);
    setCustomBusy(false);
    setCustomAutoRefresh(false);
    setCustomAutoRefreshTouched(false);
    setCustomSavedBaseURL("");
    setCustomRefreshStatus(undefined);
    customModelsFocusRef.current = false;
    pollingBusyRef.current = false;
    oauthSubmitBusyRef.current = false;
    oauthAutoBusyRef.current = false;
    oauthStartBusyRef.current = false;
    setPollingBusy(false);
    setOauthAutoBusy(false);
  };

  const stopProviderPolling = () => {
    if (providerPollRef.current !== null) {
      window.clearInterval(providerPollRef.current);
      providerPollRef.current = null;
    }
  };

  const stopOauthAutoPolling = () => {
    if (oauthAutoPollRef.current !== null) {
      window.clearInterval(oauthAutoPollRef.current);
      oauthAutoPollRef.current = null;
    }
  };

  const handleClose = () => {
    void props.onRefreshProviders?.();
    stopOauthAutoPolling();
    stopProviderPolling();
    resetState();
    props.onClose();
  };

  useEffect(() => {
    if (!props.open) {
      autoOpenedPreferredProviderIdRef.current = null;
      customEditPrefilledRef.current = null;
      resetState();
    }
  }, [props.open]);

  function applyCustomEdit(edit: CustomProviderEditData) {
    setCustomAutoRefresh(edit.modelRefresh?.enabled === true);
    setCustomAutoRefreshTouched(true);
    setCustomSavedBaseURL(edit.baseURL.trim().replace(/\/+$/, ""));
    setCustomRefreshStatus(edit.modelRefresh);
    setCustomEditMode(true);
    setCustomFixedProviderId(edit.providerId);
    setCustomBrandName(null);
    setCustomName(edit.name);
    setCustomBaseURL(edit.baseURL);
    setCustomBaseUrlPlaceholder(DEFAULT_BASE_URL_PLACEHOLDER);
    setCustomApiType(edit.apiType);
    setCustomApiTypeTouched(true);
    setCustomApiKey("");
    setCustomModelInput("");
    setCustomModels(
      edit.models.map((model) => ({
        id: model.id,
        name: model.name,
        toolCall: model.toolCall,
        reasoning: model.reasoning,
        contextLimit: model.contextLimit != null ? String(model.contextLimit) : "",
        outputLimit: model.outputLimit != null ? String(model.outputLimit) : "",
      })),
    );
    setCustomFetchedModels(edit.modelRefresh?.availableModels ?? []);
    setCustomDeselectedModels([]);
    setCustomModelSearch("");
    setLocalError(null);
    setSelectedProviderId(CUSTOM_PROVIDER_ENTRY_ID);
    setView("custom");
  }

  // Open straight into the custom form, pre-filled, when asked to edit an
  // existing custom provider. Guarded by a ref so it prefills once per open
  // (and never clobbers in-progress edits on re-render).
  useEffect(() => {
    if (!props.open) return;
    const edit = props.customEdit;
    if (!edit || customEditPrefilledRef.current === edit.providerId) return;
    customEditPrefilledRef.current = edit.providerId;
    applyCustomEdit(edit);
  }, [props.open, props.customEdit]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => Math.max(0, Math.min(current, total - 1)));
  }, [filteredEntries.length, props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    queueMicrotask(() => searchInputRef.current?.focus());
  }, [props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || props.loading || props.submitting || resolvedView !== "list") return;

    const preferredId = props.preferredProviderId?.trim().toLowerCase() ?? "";
    if (!preferredId || autoOpenedPreferredProviderIdRef.current === preferredId) return;

    const entry = entries.find((item) => item.id.trim().toLowerCase() === preferredId);
    if (!entry) return;

    autoOpenedPreferredProviderIdRef.current = preferredId;
    queueMicrotask(() => {
      if (props.startOAuth) {
        setSelectedProviderId(entry.id);
        const method = entry.methods.find(item => item.type === "oauth");
        if (!method) {
          setView("method");
          setLocalError(`${t("providers.no_oauth_prefix")} ${entry.name}.`);
          return;
        }
        setView("oauth-auto");
        void startOauth(entry, method.methodIndex);
      } else {
        void handleEntrySelect(entry);
      }
    });
  }, [
    entries,
    props.loading,
    props.submitting,
    props.open,
    props.preferredProviderId,
    props.startOAuth,
    resolvedView,
  ]);

  useEffect(() => {
    return () => {
      oauthStartTokenRef.current += 1;
      stopOauthAutoPolling();
      stopProviderPolling();
      if (oauthCodeCopiedResetRef.current !== null) {
        window.clearTimeout(oauthCodeCopiedResetRef.current);
        oauthCodeCopiedResetRef.current = null;
      }
    };
  }, []);

  const isOauthView = resolvedView === "oauth-code" || resolvedView === "oauth-auto";
  const activeProviderId = oauthSession?.providerId ?? selectedProviderId;
  const isActiveProviderConnected =
    !!activeProviderId && (props.connectedProviderIds ?? []).includes(activeProviderId);

  const pollProviders = async () => {
    const id = activeProviderId;
    if (!id || pollingBusyRef.current) return;
    pollingBusyRef.current = true;
    setPollingBusy(true);
    try {
      await props.onRefreshProviders?.();
    } finally {
      pollingBusyRef.current = false;
      setPollingBusy(false);
    }
    if ((props.connectedProviderIds ?? []).includes(id)) {
      handleClose();
    }
  };

  const startProviderPolling = () => {
    if (typeof window === "undefined") return;
    if (providerPollRef.current !== null) return;
    void pollProviders();
    providerPollRef.current = window.setInterval(() => {
      void pollProviders();
    }, 2000);
  };

  useEffect(() => {
    if (!props.open || !isOauthView) {
      stopProviderPolling();
      return;
    }
    if (isActiveProviderConnected) {
      handleClose();
      return;
    }
    startProviderPolling();
  }, [isActiveProviderConnected, isOauthView, props.open]);

  const openOauthUrl = async (url: string) => {
    if (!url) return;
    await openDesktopUrl(url);
    setOauthBrowserOpened(true);
  };

  const copyOauthDisplayCode = async () => {
    const code = oauthDisplayCode.trim();
    if (!code) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setLocalError("Clipboard is unavailable in this environment.");
      return;
    }
    await navigator.clipboard.writeText(code);
    setOauthCodeCopied(true);
    if (typeof window === "undefined") return;
    if (oauthCodeCopiedResetRef.current !== null) {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
    }
    oauthCodeCopiedResetRef.current = window.setTimeout(() => {
      setOauthCodeCopied(false);
      oauthCodeCopiedResetRef.current = null;
    }, 2000);
  };

  const submitOauth = async (providerId: string, methodIndex: number, code?: string) => {
    if (oauthSubmitBusyRef.current) {
      return { connected: false, pending: true };
    }

    const trimmedCode = code?.trim();
    oauthSubmitBusyRef.current = true;
    setLocalError(null);
    try {
      return await props.onSubmitOAuth(providerId, methodIndex, trimmedCode || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("providers.oauth_failed");
      setLocalError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      oauthSubmitBusyRef.current = false;
    }
  };

  const attemptOauthAutoCompletion = async () => {
    const session = oauthSession;
    if (!session || oauthAutoBusyRef.current || oauthSubmitBusyRef.current) return;
    oauthAutoBusyRef.current = true;
    setOauthAutoBusy(true);
    try {
      const result = await submitOauth(session.providerId, session.methodIndex);
      if (result?.connected) {
        stopOauthAutoPolling();
      }
    } finally {
      oauthAutoBusyRef.current = false;
      setOauthAutoBusy(false);
    }
  };

  const startOauthAutoPolling = () => {
    if (typeof window === "undefined") return;
    if (oauthAutoPollRef.current !== null) return;
    void attemptOauthAutoCompletion();
    oauthAutoPollRef.current = window.setInterval(() => {
      void attemptOauthAutoCompletion();
    }, 2000);
  };

  useEffect(() => {
    if (!shouldStartOauthAutoPolling) {
      stopOauthAutoPolling();
      return;
    }
    startOauthAutoPolling();
  }, [shouldStartOauthAutoPolling]);

  const startOauth = async (entry: ProviderAuthEntry, methodIndex?: number) => {
    if (actionDisabled || oauthStartBusyRef.current) return;
    if (!Number.isInteger(methodIndex) || methodIndex === undefined) {
      setLocalError(`No OAuth flow available for ${entry.name}.`);
      return;
    }
    oauthStartBusyRef.current = true;
    const startToken = ++oauthStartTokenRef.current;
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    try {
      const started = await props.onSelect(entry.id, methodIndex);
      if (startToken !== oauthStartTokenRef.current) return;
      const selectedMethod = entry.methods.find((method) => method.methodIndex === methodIndex);
      if (!selectedMethod) {
        throw new Error(`Selected auth method is unavailable for ${entry.name}.`);
      }
      const nextSession: ProviderOAuthSession = {
        providerId: entry.id,
        methodIndex: started.methodIndex,
        methodLabel: selectedMethod.label,
        authorization: started.authorization,
      };
      setOauthSession(nextSession);

      if (started.authorization.method === "code") {
        await openOauthUrl(started.authorization.url);
        setView("oauth-code");
        return;
      }

      if (!isOpenAiHeadlessMethod(selectedMethod)) {
        await openOauthUrl(started.authorization.url);
      }

      setView("oauth-auto");
    } catch (error) {
      if (startToken !== oauthStartTokenRef.current) return;
      const message = error instanceof Error ? error.message : t("providers.oauth_start_failed");
      setLocalError(message);
      setView("method");
    } finally {
      if (startToken === oauthStartTokenRef.current) oauthStartBusyRef.current = false;
    }
  };

  /**
   * t("provider_auth.sign_in_eigenwelt"): the LegalWork server owns the OAuth loopback +
   * code exchange. We open the authorize URL, show the standard oauth-auto
   * waiting view with a synthetic session, and await the server long-poll.
   * On success the provider flips connected and the existing provider polling
   * closes the modal; on failure the error surfaces in the modal.
   */
  const startEigenweltOauth = async (entry: ProviderAuthEntry) => {
    if (!props.onEigenweltSignIn || actionDisabled || oauthStartBusyRef.current) return;
    oauthStartBusyRef.current = true;
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    const waitToken = ++eigenweltWaitTokenRef.current;
    let sessionId: string;
    try {
      const started = await props.onEigenweltSignIn();
      sessionId = started.sessionId;
      setOauthSession({
        providerId: entry.id,
        // Synthetic session: there is no engine OAuth method behind it.
        methodIndex: -1,
        methodLabel: t("provider_auth.sign_in_eigenwelt"),
        authorization: { url: started.authorizeUrl, method: "auto" } as ProviderAuthAuthorization,
      });
      await openOauthUrl(started.authorizeUrl);
      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("providers.oauth_start_failed");
      setLocalError(message);
      return;
    } finally {
      // Release before the (potentially minutes-long) wait so Back + retry —
      // or connecting a different provider — is never blocked by this flow.
      oauthStartBusyRef.current = false;
    }
    try {
      const result = await props.onEigenweltWait?.(sessionId, {
        cancelled: () => eigenweltWaitTokenRef.current !== waitToken,
      });
      if (eigenweltWaitTokenRef.current !== waitToken) return;
      // Sync can connect its account with an empty hosted-model list. Close
      // on the finalized account result instead of waiting for an AI provider.
      if (result?.connected) props.onClose();
      else if (!result?.cancelled && result?.message) setLocalError(result.message);
    } catch (error) {
      if (eigenweltWaitTokenRef.current === waitToken) {
        setLocalError(
          error instanceof Error ? error.message : t("providers.eigenwelt_signin_failed"),
        );
      }
    }
  };

  const handleMethodSelect = async (method: ProviderAuthMethod) => {
    if (!selectedEntry || actionDisabled) return;
    setLocalError(null);

    if (selectedEntry.id === EIGENWELT_PROVIDER_ID && method.type === "oauth") {
      await startEigenweltOauth(selectedEntry);
      return;
    }

    if (method.type === "oauth") {
      await startOauth(selectedEntry, method.methodIndex);
      return;
    }

    setView("api");
  };

  const handleEntrySelect = async (entry: ProviderAuthEntry) => {
    if (actionDisabled) return;
    setLocalError(null);
    setSelectedProviderId(entry.id);

    if (entry.id === CUSTOM_PROVIDER_ENTRY_ID) {
      startCustomProvider();
      return;
    }

    if (entry.id === LOCAL_PROVIDER_ENTRY_ID) {
      startLocalProvider();
      return;
    }

    const branded = brandedCustomProviders().find((provider) => provider.id === entry.id);
    if (branded) {
      startCustomProvider(branded);
      if (entry.id === "lmstudio" && props.onReadCustomProvider) {
        const request = ++customRequestRef.current;
        setCustomBusy(true);
        try {
          const edit = await props.onReadCustomProvider(entry.id);
          if (request !== customRequestRef.current) return;
          if (edit) applyCustomEdit(edit);
        } catch (error) {
          if (request === customRequestRef.current) {
            setLocalError(error instanceof Error ? error.message : t("providers.add_failed"));
          }
        } finally {
          if (request === customRequestRef.current) setCustomBusy(false);
        }
      }
      return;
    }

    if (entry.methods.length === 1) {
      void handleMethodSelect(entry.methods[0]);
      return;
    }

    if (entry.methods.length > 1) {
      setView("method");
      return;
    }

    setLocalError(`No authentication methods available for ${entry.name}.`);
  };

  const handleApiSubmit = async () => {
    if (!selectedEntry || actionDisabled) return;

    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setLocalError("API key is required.");
      return;
    }

    setLocalError(null);
    try {
      await props.onSubmitApiKey(selectedEntry.id, trimmed);
      // Close the modal after a successful save
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("providers.save_api_key_failed");
      setLocalError(message);
    }
  };

  const addCustomModelId = (rawId: string) => {
    const id = rawId.trim();
    if (!id) return;
    setCustomModels((current) =>
      current.some((model) => model.id === id) ? current : [...current, customDeselectedModels.find(model => model.id === id) ?? makeCustomModelDraft(id)],
    );
    if (localError) setLocalError(null);
  };

  const removeCustomModelId = (id: string) => {
    const model = customModels.find(model => model.id === id);
    if (model) setCustomDeselectedModels(current => [...current.filter(model => model.id !== id), model]);
    setCustomModels((current) => current.filter((model) => model.id !== id));
  };

  const updateCustomModel = (id: string, patch: Partial<CustomModelDraft>) => {
    setCustomModels((current) =>
      current.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    );
  };

  const handleAddCustomModelFromInput = () => {
    const ids = customModelInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) addCustomModelId(id);
    setCustomModelInput("");
    setCustomModelSearch("");
  };

  const fetchCustomModels = async () => {
    const base = customBaseURL.trim().replace(/\/+$/, "");
    if (!base) {
      setLocalError("Enter a base URL first.");
      return;
    }
    const request = ++customRequestRef.current;
    setCustomFetching(true);
    setLocalError(null);
    try {
      if (customEditMode && customFixedProviderId && base === customSavedBaseURL && !customApiKey.trim() && props.onRefreshCustomProvider) {
        const refreshed = await props.onRefreshCustomProvider(customFixedProviderId);
        if (request !== customRequestRef.current || !refreshed) return;
        setCustomRefreshStatus(refreshed.modelRefresh);
        setCustomFetchedModels(refreshed.modelRefresh?.availableModels ?? []);
        if (refreshed.modelRefresh?.lastError) setLocalError(refreshed.modelRefresh.lastError);
        else customModelsFocusRef.current = true;
        return;
      }
      if (!props.onFetchCustomModels) {
        throw new Error("Connect to the LegalWork worker to fetch models.");
      }
      const ids = await props.onFetchCustomModels({ baseURL: base, apiKey: customApiKey.trim(), providerId: customEditMode ? customFixedProviderId ?? undefined : undefined });
      if (request !== customRequestRef.current) return;
      setCustomFetchedModels(ids);
      customModelsFocusRef.current = true;
      if (!customEditMode && !customAutoRefreshTouched) setCustomAutoRefresh(true);
      if (!ids.length) setLocalError(t("providers.no_models_returned"));
    } catch (error) {
      if (request !== customRequestRef.current) return;
      const detail = error instanceof Error ? error.message : "request failed";
      setLocalError(`Couldn't list models — enter IDs manually. (${detail})`);
    } finally {
      if (request === customRequestRef.current) setCustomFetching(false);
    }
  };

  // Open the custom form fresh — blank for the generic entry, pre-branded
  // (fixed id, name, API type, Base-URL hint) for a branded provider.
  const startCustomProvider = (branded?: BrandedCustomProvider) => {
    setCustomAutoRefresh(false);
    setCustomAutoRefreshTouched(false);
    setCustomSavedBaseURL("");
    setCustomRefreshStatus(undefined);
    setCustomEditMode(false);
    setCustomFixedProviderId(branded?.id ?? null);
    setCustomBrandName(branded?.name ?? null);
    setCustomName(branded?.name ?? "");
    // Fixed-endpoint runtimes (Ollama, LM Studio, …) pre-fill their Base URL so
    // the user can fetch models immediately; per-deployment gateways stay blank.
    setCustomBaseURL(branded?.baseUrlDefault ?? "");
    setCustomApiKey("");
    setCustomApiType(branded?.apiType ?? "chat");
    setCustomApiTypeTouched(Boolean(branded));
    setCustomBaseUrlPlaceholder(branded?.baseUrlPlaceholder ?? DEFAULT_BASE_URL_PLACEHOLDER);
    setCustomShowLocalTemplates(false);
    setCustomTemplateId(null);
    setCustomModelInput("");
    setCustomModels([]);
    setCustomDeselectedModels([]);
    setCustomModelSearch("");
    setCustomFetchedModels([]);
    setLocalError(null);
    setSelectedProviderId(branded?.id ?? CUSTOM_PROVIDER_ENTRY_ID);
    setView("custom");
  };

  // Open the custom form in "Local model" mode: a runtime template picker on
  // top of an otherwise-blank custom form. Provider id derives from the name
  // (not fixed), so several local providers can coexist.
  const startLocalProvider = () => {
    setCustomEditMode(false);
    setCustomFixedProviderId(null);
    setCustomBrandName("Local model");
    setCustomShowLocalTemplates(true);
    setCustomTemplateId(null);
    setCustomName("");
    setCustomBaseURL("");
    setCustomApiKey("");
    setCustomApiType("chat");
    setCustomApiTypeTouched(false);
    setCustomBaseUrlPlaceholder(DEFAULT_BASE_URL_PLACEHOLDER);
    setCustomModelInput("");
    setCustomModels([]);
    setCustomDeselectedModels([]);
    setCustomModelSearch("");
    setCustomFetchedModels([]);
    setLocalError(null);
    setSelectedProviderId(LOCAL_PROVIDER_ENTRY_ID);
    setView("custom");
  };

  // Apply a runtime template: prefill Base URL, API type, and (when the name is
  // still blank or matches another template's name) the display name.
  const applyLocalTemplate = (template: LocalRuntimeTemplate) => {
    customRequestRef.current += 1;
    setCustomFetching(false);
    setCustomFetchedModels([]);
    setCustomDeselectedModels([]);
    setCustomModelSearch("");
    if (isLmStudio || template.id === "lmstudio") setCustomModels([]);
    setCustomTemplateId(template.id);
    setCustomBaseURL(template.baseURL);
    setCustomBaseUrlPlaceholder(template.placeholder);
    setCustomApiType(template.apiType);
    setCustomApiTypeTouched(true);
    setCustomName((current) => resolveTemplateName(current, template));
    if (localError) setLocalError(null);
  };

  const handleCustomSubmit = async () => {
    if (!props.onSubmitCustomProvider || actionDisabled || customBusy || customFetching) return;

    const name = customName.trim();
    const baseURL = customBaseURL.trim();
    const apiKey = customApiKey.trim();

    if (!name) {
      setLocalError("Name is required.");
      return;
    }
    if (!baseURL) {
      setLocalError("Base URL is required.");
      return;
    }
    if (!customModels.length) {
      setLocalError(t("provider_auth.select_models_hint"));
      return;
    }

    const models = customModels.map((model) => ({
      id: model.id,
      name: model.name,
      toolCall: model.toolCall,
      reasoning: model.reasoning,
      contextLimit: parseTokenCount(model.contextLimit),
      outputLimit: parseTokenCount(model.outputLimit),
    }));
    const limitProblem = findCustomModelLimitProblem(models);
    if (limitProblem) {
      setLocalError(
        t(
          limitProblem.reason === "output-needs-context"
            ? "providers.output_limit_needs_context"
            : "providers.output_limit_too_large",
          { model: limitProblem.modelId },
        ),
      );
      return;
    }

    setLocalError(null);
    setCustomBusy(true);
    try {
      await props.onSubmitCustomProvider({
        providerId: customFixedProviderId ?? slugifyProviderId(name),
        name,
        baseURL,
        apiKey,
        apiType: customApiType,
        models,
        autoRefresh: customAutoRefresh,
      });
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("providers.add_failed");
      setLocalError(message);
    } finally {
      setCustomBusy(false);
    }
  };

  const handleOauthCodeSubmit = async () => {
    if (!selectedEntry || !oauthSession || actionDisabled) return;

    const trimmed = normalizeAuthorizationCode(oauthCodeInput);
    if (!trimmed) {
      setLocalError("Authorization code is required.");
      return;
    }

    await submitOauth(selectedEntry.id, oauthSession.methodIndex, trimmed);
  };

  const handleBack = () => {
    if (resolvedView === "oauth-code" || resolvedView === "oauth-auto") {
      eigenweltWaitTokenRef.current += 1;
      oauthStartTokenRef.current += 1;
      oauthStartBusyRef.current = false;
      if ((selectedEntry?.methods.length ?? 0) > 1) {
        setView("method");
      } else {
        setView("list");
      }
      setOauthSession(null);
      setOauthCodeInput("");
      setOauthCodeCopied(false);
      setOauthBrowserOpened(false);
      setLocalError(null);
      return;
    }

    if (resolvedView === "api" && (selectedEntry?.methods.length ?? 0) > 1) {
      setView("method");
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    if (resolvedView === "api") return t("providers.saving_api_key");
    if (resolvedView === "oauth-code") return t("providers.verifying_code");
    if (resolvedView === "oauth-auto") return t("providers.waiting_oauth");
    return t("providers.opening_auth");
  };

  const stepEntryIndex = (delta: number) => {
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (resolvedView !== "list") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepEntryIndex(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepEntryIndex(-1);
      return;
    }
    if (event.key === "Enter") {
      const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { keyCode?: number };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      const entry = filteredEntries[activeEntryIndex];
      if (!entry) return;
      event.preventDefault();
      handleEntrySelect(entry);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  };

  const methodDescription = (entry: ProviderAuthEntry, method: ProviderAuthMethod) => {
    const label = methodLabel(method).toLowerCase();
    if (isOpenAiProvider(entry.id, entry.name) && (label.includes("headless") || label.includes("device"))) {
      return isRemoteWorker
        ? t("provider_auth.device_flow_remote")
        : t("provider_auth.device_flow_unreliable");
    }
    if (isAnthropicProvider(entry.id, entry.name) && isClaudeSubscriptionMethod(method)) {
      return t("providers.claude_signin_hint");
    }
    if (method.type === "oauth") {
      return t("providers.browser_continue_hint");
    }
    if (isOpenAiProvider(entry.id, entry.name)) return t("providers.openai_api_billing_hint");
    if (isOpencodeZenProvider(entry.id)) {
      return t("providers.zen_signin_hint");
    }
    return t("providers.secret_key_hint");
  };

  const anthropicSubscriptionWarning = (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-6/40 bg-amber-2/30 px-3.5 py-3 text-[12px] leading-relaxed text-amber-11">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        {t("providers.claude_consumer_terms")}
      </span>
    </div>
  );

  const featuredOpenAI = entries.find(entry => isOpenAiProvider(entry.id, entry.name) && entry.methods.some(method => method.type === "oauth"));
  const featuredChatGptMethod = featuredOpenAI?.methods.find(method => method.type === "oauth");
  const selectedEntryIsOpenAI = Boolean(selectedEntry && isOpenAiProvider(selectedEntry.id, selectedEntry.name));
  const selectedEntryHasClaudeSubscription = Boolean(
    selectedEntry &&
      isAnthropicProvider(selectedEntry.id, selectedEntry.name) &&
      selectedEntry.methods.some(isClaudeSubscriptionMethod),
  );
  const oauthSessionIsClaudeSubscription = Boolean(
    oauthSession &&
      isAnthropicProvider(oauthSession.providerId) &&
      oauthSession.methodLabel.toLowerCase().includes("pro/max"),
  );

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className={`flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden ${resolvedView === "custom" ? "max-w-2xl sm:max-w-2xl" : "max-w-lg sm:max-w-lg"}`}>
        <DialogHeader className="shrink-0 pr-8">
          <div className="flex items-center gap-2">
            {resolvedView === "custom" && !props.customModelsOnly ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-2 shrink-0"
                onClick={handleBack}
                disabled={actionDisabled || customBusy}
                aria-label={t("common.back")}
              >
                <ArrowLeft />
              </Button>
            ) : null}
            <DialogTitle>
              {resolvedView === "custom"
                ? props.customModelsOnly ? t("provider_auth.models_for_provider", { provider: customName })
                  : isEditingCustomProvider ? t("provider_auth.edit_provider") : customBrandName ?? t("provider_auth.custom_provider")
                : selectedEntryIsOpenAI && resolvedView === "method" ? t("providers.connect_openai_title") : t("providers.connect_title")}
            </DialogTitle>
          </div>
          <DialogDescription>
            {resolvedView === "custom"
              ? props.customModelsOnly ? t("provider_auth.select_models_hint")
                : isEditingCustomProvider
                ? t("provider_auth.update_compatible")
                : customShowLocalTemplates
                  ? t("provider_auth.pick_runtime")
                  : isLmStudio ? t("local_templates.lmstudio_note") : activeBrandedProvider?.description ?? t("provider_auth.any_endpoint")
              : selectedEntryIsOpenAI && resolvedView === "method" ? t("providers.choose_connection") : t("providers.connect_subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {errorMessage ? (
            <div className={errorBannerClass}>{errorMessage}</div>
          ) : props.loading ? (
            <div className="animate-pulse rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-sm text-dls-secondary">
              {t("providers.loading")}
            </div>
          ) : null}

          {!props.loading ? (
            <div className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {resolvedView === "list" ? (
                <div className="space-y-1.5" role="presentation" onKeyDown={handleListKeyDown}>
                  {!searchQuery && featuredOpenAI && featuredChatGptMethod && (
                    <div className="mb-4">
                      <ChatGptPlanCard disabled={actionDisabled} onContinue={() => {
                        setSelectedProviderId(featuredOpenAI.id);
                        setView("method");
                        void startOauth(featuredOpenAI, featuredChatGptMethod.methodIndex);
                      }} />
                    </div>
                  )}
                  <div className="relative mb-2">
                    <Search
                      size={16}
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dls-secondary"
                    />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={t("providers.filter_placeholder")}
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveEntryIndex(0);
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={actionDisabled}
                      className="w-full rounded-xl border border-dls-border bg-dls-hover py-2.5 pl-10 pr-3 text-[13px] text-dls-text transition-colors placeholder:text-dls-secondary focus:bg-dls-surface focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>

                  {filteredEntries.length ? (
                    filteredEntries.map((entry, index) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          index === activeEntryIndex
                            ? "border-dls-border bg-dls-hover"
                            : "border-transparent hover:bg-dls-hover"
                        }`}
                        disabled={actionDisabled}
                        onMouseEnter={() => setActiveEntryIndex(index)}
                        onClick={() => handleEntrySelect(entry)}
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
                          {entry.id === CUSTOM_PROVIDER_ENTRY_ID ? (
                            <Plug size={18} className="text-dls-text" aria-hidden="true" />
                          ) : (
                            <ProviderIcon providerId={entry.id} size={18} className="text-dls-text" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium tracking-tight text-dls-text">
                                {entry.name}
                              </div>
                              {entry.id === CUSTOM_PROVIDER_ENTRY_ID ? (
                                <div className="truncate text-[11px] text-dls-secondary">
                                  {t("provider_auth.custom_provider_description")}
                                </div>
                              ) : (
                                <div className="truncate font-mono text-[11px] text-dls-secondary">
                                  {entry.id}
                                </div>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center justify-end">
                              {entry.connected ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-6/40 bg-emerald-3/50 px-2 py-0.5 text-[11px] font-medium text-emerald-11">
                                  <CheckCircle2 size={12} strokeWidth={2.5} />
                                  {t("providers.connected_badge")}
                                </span>
                              ) : (
                                <span className="flex items-center gap-0.5 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">
                                  {t("providers.connect_action")}
                                  <ChevronRight size={14} className="-ml-2 opacity-0 transition-all duration-200 group-hover:ml-0 group-hover:opacity-100" />
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {entry.methods.map((method) => (
                              <span
                                key={`${entry.id}-${method.type}-${method.methodIndex ?? method.label}`}
                                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${methodPillToneClass(method.type)}`}
                              >
                                {methodLabel(method)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="pt-2 text-sm text-dls-secondary">
                      {entries.length ? t("provider_auth.no_match") : t("provider_auth.none_available")}
                    </div>
                  )}

                  <div className="px-1 pt-1.5 text-[11px] text-dls-secondary">
                    {t("providers.keyboard_hint")}
                  </div>
                </div>
              ) : null}

              {resolvedView === "method" && selectedEntry ? (
                <div className={selectedEntryIsOpenAI ? "space-y-4" : `${surfaceCardClass} space-y-4`}>
                  {selectedEntryIsOpenAI ? (
                    <Button variant="ghost" size="sm" onClick={handleBack} disabled={actionDisabled}>
                      <ArrowLeft />{t("common.back")}
                    </Button>
                  ) : <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">{t("providers.choose_connection")}</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      {t("common.back")}
                    </Button>
                  </div>}
                  {selectedEntryHasClaudeSubscription ? anthropicSubscriptionWarning : null}
                  <div className="grid gap-2">
                    {selectedEntry.methods.map((method) => selectedEntryIsOpenAI && method.type === "oauth" ? (
                      <ChatGptPlanCard
                        key={`${selectedEntry.id}-${method.methodIndex}`}
                        disabled={actionDisabled}
                        onContinue={() => void handleMethodSelect(method)}
                      />
                    ) : (
                      <button
                        key={`${selectedEntry.id}-${method.type}-${method.methodIndex ?? method.label}`}
                        type="button"
                        className={`w-full rounded-xl border px-4 py-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          method.type === "oauth"
                            ? "border-[rgba(var(--dls-accent-rgb),0.22)] bg-[rgba(var(--dls-accent-rgb),0.06)] hover:bg-[rgba(var(--dls-accent-rgb),0.1)]"
                            : "border-dls-border bg-dls-hover hover:bg-dls-active"
                        }`}
                        onClick={() => void handleMethodSelect(method)}
                        disabled={actionDisabled}
                      >
                        <div className="text-sm font-medium text-dls-text">{selectedEntryIsOpenAI ? t("providers.use_openai_api_key") : methodLabel(method)}</div>
                        <div className="mt-1 text-xs text-dls-secondary">{methodDescription(selectedEntry, method)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {resolvedView === "api" && selectedEntry ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">
                        {isOpencodeZenProvider(selectedEntry.id)
                          ? t("provider_auth.zen_api_key")
                          : t("provider_auth.paste_api_key")}
                      </div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      {t("common.back")}
                    </Button>
                  </div>
                  {isOpencodeZenProvider(selectedEntry.id) ? (
                    <div className="space-y-1.5 rounded-xl border border-[rgba(var(--dls-accent-rgb),0.2)] bg-[rgba(var(--dls-accent-rgb),0.06)] px-3 py-2.5 text-xs text-dls-text">
                      <div>
                        {t("providers.zen_note")}
                      </div>
                      <button
                        type="button"
                        className="font-medium text-dls-accent underline underline-offset-2 hover:opacity-80"
                        onClick={() => void openDesktopUrl(OPENCODE_ZEN_KEY_URL)}
                      >
                        {t("providers.get_api_key")}
                      </button>
                    </div>
                  ) : null}
                  <TextInput
                    label={t("providers.api_key_label")}
                    type="password"
                    placeholder={isOpencodeZenProvider(selectedEntry.id) ? "ock_..." : "sk-..."}
                    value={apiKeyInput}
                    onChange={(event) => {
                      setApiKeyInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  {selectedEntry.env.length > 0 ? (
                    <div className="text-[11px] text-dls-secondary">
                      Env vars: <span className="font-mono">{selectedEntry.env.join(", ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-dls-secondary">{t("providers.keys_stored_locally")}</div>
                    <Button
                      onClick={handleApiSubmit}
                      disabled={actionDisabled || !apiKeyInput.trim()}
                    >
                      {props.submitting ? "Saving…" : t("provider_auth.save_key")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-auto" && selectedEntry && !oauthSession ? (
                <p role="status" className="flex items-center gap-2 py-4 text-sm text-dls-secondary">
                  <Loader2 className="size-4 animate-spin" />{t("providers.opening_auth")}
                </p>
              ) : null}

              {resolvedView === "oauth-code" && selectedEntry && oauthSession ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">{t("providers.finish_oauth_hint")}</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      {t("common.back")}
                    </Button>
                  </div>
                  <div className="text-xs text-dls-secondary">
                    {t("providers.complete_signin_paste")}
                  </div>
                  {oauthSessionIsClaudeSubscription ? anthropicSubscriptionWarning : null}
                  {oauthInstructions ? (
                    <div className="break-all rounded-xl border border-dls-border bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
                      {oauthInstructions}
                    </div>
                  ) : null}
                  <TextInput
                    label={t("providers.authorization_code")}
                    type="text"
                    placeholder={t("providers.paste_code")}
                    value={oauthCodeInput}
                    onChange={(event) => {
                      setOauthCodeInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void handleOauthCodeSubmit();
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      {t("providers.open_browser_again")}
                    </Button>
                    <Button
                      onClick={() => void handleOauthCodeSubmit()}
                      disabled={actionDisabled || !oauthCodeInput.trim()}
                    >
                      {props.submitting ? "Verifying..." : t("provider_auth.complete_connection")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-auto" && selectedEntry && oauthSession ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">{t("providers.waiting_browser")}</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      {t("common.back")}
                    </Button>
                  </div>
                  {isOpenAiHeadlessSession ? (
                    <div className="space-y-2 text-xs text-dls-secondary">
                      <div>{t("providers.openai_device_intro")}</div>
                      <div>{t("providers.openai_device_enable")}</div>
                      <div>{t("providers.openai_device_path")}</div>
                      <div>{t("providers.openai_device_ready")}</div>
                    </div>
                  ) : (
                    <div className="text-xs text-dls-secondary">
                      {isEigenweltOauthSession
                        ? t("providers.eigenwelt_browser_hint")
                        : t("providers.browser_signin_hint")}
                    </div>
                  )}
                  {oauthDisplayCode ? (
                    <div className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-hover p-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wide text-dls-secondary">{t("providers.confirmation_code")}</div>
                        <div className="break-all font-mono text-sm text-dls-text">{oauthDisplayCode}</div>
                      </div>
                      <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copyOauthDisplayCode()}>
                        {oauthCodeCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  ) : null}
                  {isOpenAiHeadlessSession && !oauthBrowserOpened ? (
                    <div className="flex items-center gap-2 text-xs text-dls-secondary">
                      <span>{t("providers.checks_after_open")}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-dls-secondary">
                      <Loader2 size={14} className={props.submitting || pollingBusy || oauthAutoBusy ? "animate-spin" : ""} />
                      <span>{t("providers.checking_status")}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (isEigenweltOauthSession) void startEigenweltOauth(selectedEntry);
                        else void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      {isOpenAiHeadlessSession
                        ? oauthBrowserOpened
                          ? t("providers.reopen_browser")
                          : t("providers.open_browser")
                        : t("providers.open_browser_again")}
                    </Button>
                    <div className="text-right text-[11px] text-dls-secondary">
                      {t("providers.window_closes")}
                    </div>
                  </div>
                </div>
              ) : null}

              {resolvedView === "custom" ? (
                <div className="space-y-5 pb-1">
                  {!props.customModelsOnly ? (
                    <div className="space-y-5">
                      {customShowLocalTemplates ? (
                        <div className="space-y-1.5">
                          <div className="text-xs font-medium text-dls-secondary">Runtime</div>
                          <div className="flex flex-wrap gap-1.5">
                            {localRuntimeTemplates().map((template) => {
                              const active = customTemplateId === template.id;
                              return (
                                <button
                                  key={template.id}
                                  type="button"
                                  onClick={() => applyLocalTemplate(template)}
                                  disabled={actionDisabled || customBusy}
                                  className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                    active
                                      ? "border-[rgba(var(--dls-accent-rgb),0.4)] bg-[rgba(var(--dls-accent-rgb),0.08)] text-dls-text"
                                      : "border-dls-border bg-dls-hover text-dls-secondary hover:bg-dls-active hover:text-dls-text"
                                  }`}
                                >
                                  {template.label}
                                </button>
                              );
                            })}
                          </div>
                          {activeLocalTemplate ? (
                            <div
                              className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                                activeLocalTemplate.autoDetected
                                  ? "border-amber-7/30 bg-amber-3/30 text-amber-11"
                                  : "border-dls-border bg-dls-hover text-dls-secondary"
                              }`}
                            >
                              {activeLocalTemplate.note}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <TextInput
                        label={t("provider_auth.name")}
                        type="text"
                        placeholder={t("providers.name_placeholder")}
                        value={customName}
                        onChange={(event) => {
                          setCustomName(event.currentTarget.value);
                          if (localError) setLocalError(null);
                        }}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={actionDisabled || customBusy}
                      />
                      {customFixedProviderId ? (
                        <div className="-mt-2 text-[11px] text-dls-secondary">
                          Provider ID: <span className="font-mono">{customFixedProviderId}</span> (fixed)
                        </div>
                      ) : customName.trim() ? (
                        <div className="-mt-2 text-[11px] text-dls-secondary">
                          Provider ID: <span className="font-mono">{slugifyProviderId(customName)}</span>
                        </div>
                      ) : null}

                      <TextInput
                        label={t("provider_auth.base_url")}
                        type="text"
                        placeholder={customBaseUrlPlaceholder}
                        value={customBaseURL}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          customRequestRef.current += 1;
                          setCustomFetching(false);
                          setCustomFetchedModels([]);
                          if (isLmStudio) setCustomModels([]);
                          setCustomBaseURL(value);
                          // Default OpenAI/Azure URLs to the Responses API; the user
                          // can still override. Once they pick manually, stop inferring.
                          if (!customApiTypeTouched) setCustomApiType(inferCustomApiType(value));
                          if (localError) setLocalError(null);
                        }}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={actionDisabled || customBusy}
                      />

                      <div className="space-y-1.5">
                        <div className="text-xs font-medium text-dls-secondary">{t("providers.api_type")}</div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {(
                            [
                              {
                                value: "chat" as const,
                                label: "Chat Completions",
                                hint: "/v1/chat/completions · most endpoints",
                              },
                              {
                                value: "responses" as const,
                                label: "Responses API",
                                hint: "/v1/responses · OpenAI, Azure OpenAI",
                              },
                            ]
                          ).map((option) => {
                            const active = customApiType === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => {
                                  setCustomApiType(option.value);
                                  setCustomApiTypeTouched(true);
                                }}
                                disabled={actionDisabled || customBusy}
                                className={`rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                  active
                                    ? "border-[rgba(var(--dls-accent-rgb),0.4)] bg-[rgba(var(--dls-accent-rgb),0.08)]"
                                    : "border-dls-border bg-dls-hover hover:bg-dls-active"
                                }`}
                              >
                                <div className="text-[13px] font-medium text-dls-text">{option.label}</div>
                                <div className="mt-0.5 font-mono text-[10px] text-dls-secondary">{option.hint}</div>
                              </button>
                            );
                          })}
                        </div>
                        <div className="text-[11px] text-dls-secondary">
                          {customApiType === "responses"
                            ? t("provider_auth.uses_openai_sdk")
                            : t("provider_auth.uses_compatible_sdk")}
                        </div>
                      </div>

                      <TextInput
                        label={isEditingCustomProvider ? "API key" : "API key (optional)"}
                        type="password"
                        placeholder={isEditingCustomProvider ? t("provider_auth.leave_blank_key") : "sk-..."}
                        value={customApiKey}
                        onChange={(event) => {
                          customRequestRef.current += 1;
                          setCustomFetching(false);
                          setCustomFetchedModels([]);
                          setCustomApiKey(event.currentTarget.value);
                          if (localError) setLocalError(null);
                        }}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={actionDisabled || customBusy}
                      />
                    </div>
                  ) : null}

                  <div ref={customModelsSectionRef} className={`space-y-3 ${props.customModelsOnly ? "" : "border-t border-dls-border pt-5"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-dls-text">{t("provider_auth.models_to_use")}</h3>
                        <span className="rounded-full bg-dls-hover px-2 py-0.5 text-[11px] text-dls-secondary">
                          {t("provider_auth.models_selected", { count: customModels.length })}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void fetchCustomModels()}
                        disabled={actionDisabled || customBusy || customFetching || !customBaseURL.trim()}
                      >
                        {customFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {t(customFetching ? "provider_auth.loading_models" : customEditMode ? "provider_auth.refresh_models" : "provider_auth.fetch_from_endpoint")}
                      </Button>
                    </div>
                    {!props.customModelsOnly ? <p className="text-xs text-dls-secondary">{t("provider_auth.select_models_hint")}</p> : null}

                    {customModelChoices.length ? (
                      <TextInput
                        type="search"
                        aria-label={t("provider_auth.search_models")}
                        placeholder={t("provider_auth.search_models")}
                        value={customModelSearch}
                        onChange={event => setCustomModelSearch(event.currentTarget.value)}
                        disabled={actionDisabled || customBusy}
                      />
                    ) : null}
                    {filteredCustomModelChoices.length ? (
                      <div className="divide-y divide-dls-border overflow-hidden rounded-xl border border-dls-border">
                        {filteredCustomModelChoices.map(id => {
                          const model = customModels.find(model => model.id === id);
                          const displayName = modelDisplayName(id, customModelNames.get(id));
                          return (
                            <Collapsible key={id} className="px-3 py-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                  <Checkbox
                                    className="border-dls-border"
                                    checked={Boolean(model)}
                                    onCheckedChange={checked => checked ? addCustomModelId(id) : removeCustomModelId(id)}
                                    disabled={actionDisabled || customBusy}
                                    aria-label={t("provider_auth.use_model", { model: displayName })}
                                  />
                                  <span className="min-w-0" title={id}>
                                    <span className="block truncate text-[13px] font-medium text-dls-text">{displayName}</span>
                                    <span className="mt-0.5 block truncate font-mono text-[11px] text-dls-secondary">{id}</span>
                                  </span>
                                </label>
                                {model ? (
                                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group h-7 shrink-0 gap-1 text-[11px]" />}>
                                    {t("provider_auth.model_settings")}
                                    <ChevronDown size={12} className="transition-transform group-aria-expanded:rotate-180" />
                                  </CollapsibleTrigger>
                                ) : null}
                              </div>
                              {model ? (
                                <CollapsibleContent>
                                  <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-3">
                                    <label className="flex cursor-pointer select-none items-center gap-2">
                                      <Switch
                                        size="sm"
                                        checked={model.toolCall}
                                        onCheckedChange={(checked) => updateCustomModel(model.id, { toolCall: checked })}
                                        disabled={actionDisabled || customBusy}
                                      />
                                      <span className={`text-[11px] ${model.toolCall ? "text-dls-text" : "text-dls-secondary"}`}>
                                        Tools
                                      </span>
                                    </label>
                                    <label className="flex cursor-pointer select-none items-center gap-2">
                                      <Switch
                                        size="sm"
                                        checked={model.reasoning}
                                        onCheckedChange={(checked) => updateCustomModel(model.id, { reasoning: checked })}
                                        disabled={actionDisabled || customBusy}
                                      />
                                      <span className={`text-[11px] ${model.reasoning ? "text-dls-text" : "text-dls-secondary"}`}>
                                        Reasoning
                                      </span>
                                    </label>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto">
                                      <label className="flex items-center gap-1.5">
                                        <span className="text-[11px] text-dls-secondary">Context</span>
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          placeholder="auto"
                                          value={model.contextLimit}
                                          onChange={(event) =>
                                            updateCustomModel(model.id, { contextLimit: event.currentTarget.value })
                                          }
                                          disabled={actionDisabled || customBusy}
                                          className="w-16 rounded-md border border-transparent bg-dls-hover px-2 py-1 text-right font-mono text-[11px] text-dls-text transition-colors placeholder:text-dls-secondary focus:border-dls-border focus:bg-dls-surface focus:outline-none disabled:opacity-60"
                                        />
                                      </label>
                                      <label className="flex items-center gap-1.5">
                                        <span className="text-[11px] text-dls-secondary">Output</span>
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          placeholder={outputLimitPlaceholder(model.contextLimit)}
                                          title={t("providers.output_limit_hint")}
                                          value={model.outputLimit}
                                          onChange={(event) =>
                                            updateCustomModel(model.id, { outputLimit: event.currentTarget.value })
                                          }
                                          disabled={actionDisabled || customBusy}
                                          className="w-16 rounded-md border border-transparent bg-dls-hover px-2 py-1 text-right font-mono text-[11px] text-dls-text transition-colors placeholder:text-dls-secondary focus:border-dls-border focus:bg-dls-surface focus:outline-none disabled:opacity-60"
                                        />
                                      </label>
                                    </div>
                                  </div>
                                  <p className="mt-2 text-[11px] text-dls-secondary">{t("providers.reasoning_autodetect")}</p>
                                </CollapsibleContent>
                              ) : null}
                            </Collapsible>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-dls-border px-3 py-4 text-center text-xs text-dls-secondary">
                        {t(customModelChoices.length ? "provider_auth.no_matching_models" : "provider_auth.load_models_hint")}
                      </div>
                    )}

                    <Collapsible>
                      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group -ml-2 gap-1 text-xs text-dls-secondary" />}>
                        <Plus size={14} />
                        {t("provider_auth.add_model_manually")}
                        <ChevronDown size={12} className="transition-transform group-aria-expanded:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder={t("providers.add_model_placeholder")}
                            value={customModelInput}
                            onChange={(event) => {
                              setCustomModelInput(event.currentTarget.value);
                              if (localError) setLocalError(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              handleAddCustomModelFromInput();
                            }}
                            autoComplete="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            disabled={actionDisabled || customBusy}
                            className="h-9 min-w-0 flex-1 rounded-lg border border-dls-border bg-dls-surface px-3 font-mono text-[13px] text-dls-text transition-colors placeholder:font-sans placeholder:text-dls-secondary focus:border-[rgba(var(--dls-accent-rgb),0.5)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 gap-1"
                            onClick={handleAddCustomModelFromInput}
                            disabled={actionDisabled || customBusy || !customModelInput.trim()}
                          >
                            <Plus size={14} />
                            Add
                          </Button>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>

                    <div className="space-y-2 border-t border-dls-border pt-4">
                      <label className="flex cursor-pointer items-center justify-between gap-3">
                        <span className="text-xs font-medium text-dls-text">{t("provider_auth.auto_refresh_models")}</span>
                        <Switch size="sm" checked={customAutoRefresh} onCheckedChange={(checked) => {
                          setCustomAutoRefresh(checked);
                          setCustomAutoRefreshTouched(true);
                        }} disabled={actionDisabled || customBusy || customFetching} />
                      </label>
                      <p className="text-[11px] text-dls-secondary">{t("provider_auth.auto_refresh_models_hint")}</p>
                      {customRefreshStatus?.lastUpdatedAt ? <p className="text-[11px] text-dls-secondary">{t("provider_auth.models_updated", { time: new Date(customRefreshStatus.lastUpdatedAt).toLocaleString() })}</p> : null}
                      {customRefreshStatus?.pendingReload ? <p className="text-[11px] text-dls-secondary">{t("provider_auth.models_waiting")}</p> : null}
                      {customRefreshStatus?.lastError && !localError ? <p role="status" className="text-[11px] text-dls-secondary">{customRefreshStatus.lastError}</p> : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 items-center gap-3">
          {props.submitting ? <div role="status" className="text-xs text-dls-secondary">{submittingLabel()}</div> : null}
          {resolvedView === "custom" ? <div className="text-[11px] text-dls-secondary sm:mr-auto">{t("providers.keys_stored_locally")}</div> : null}
          <div className="flex w-full justify-end gap-2 sm:w-auto">
            <DialogClose
              disabled={actionDisabled || customBusy}
              render={<Button variant="outline" disabled={actionDisabled || customBusy} />}
            >
              {t(resolvedView === "custom" ? "common.cancel" : "common.close")}
            </DialogClose>
            {resolvedView === "custom" ? (
              <Button
                onClick={() => void handleCustomSubmit()}
                disabled={
                  actionDisabled ||
                  customBusy ||
                  customFetching ||
                  !customName.trim() ||
                  !customBaseURL.trim() ||
                  customModels.length === 0
                }
              >
                {customBusy
                  ? isEditingCustomProvider ? "Saving…" : "Adding…"
                  : isEditingCustomProvider ? t("provider_auth.save_changes") : t("provider_auth.add_provider")}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
