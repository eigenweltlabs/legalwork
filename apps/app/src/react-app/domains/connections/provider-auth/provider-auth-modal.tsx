/** @jsxImportSource react */
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
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
import { isDesktopRuntime } from "@/app/utils";
import { compareProviders } from "@/app/utils/providers";
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
import type {
  CustomProviderApiType,
  CustomProviderEditData,
  CustomProviderInstallInput,
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderOAuthStartResult,
} from "./store";
import {
  LOCAL_RUNTIME_TEMPLATES,
  resolveTemplateName,
  slugifyProviderId,
  type LocalRuntimeTemplate,
} from "./local-templates";

/** Base URLs that default to the Responses API (`@ai-sdk/openai`). */
function inferCustomApiType(baseURL: string): CustomProviderApiType {
  return /(^|\.)openai\.com|\.openai\.azure\.com|azure/i.test(baseURL) ? "responses" : "chat";
}

/** Per-model draft edited in the form before install. Each model carries its
 * own capability flags — reasoning/tool support are model properties, not
 * provider-wide ones. */
type CustomModelDraft = {
  id: string;
  toolCall: boolean;
  reasoning: boolean;
  contextLimit: string;
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

function makeCustomModelDraft(id: string): CustomModelDraft {
  return { id, toolCall: true, reasoning: inferReasoningFromId(id), contextLimit: "" };
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

const BRANDED_CUSTOM_PROVIDERS: BrandedCustomProvider[] = [
  {
    id: "apertus",
    name: "Apertus AI",
    apiType: "chat",
    baseUrlPlaceholder: "https://<your-gateway>.apertus.ai/v1",
    description: "Connect your managed Apertus gateway — European open-source models, your own endpoint and key.",
  },
  {
    id: "aki",
    name: "Aki Cloud",
    apiType: "chat",
    baseUrlPlaceholder: "https://api.aki.io/v1",
    baseUrlDefault: "https://api.aki.io/v1",
    description: "Connect Aki Cloud — EU-hosted, GDPR-compliant inference for open-source models. Add your API key and connect.",
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
  eigenwelt: "Eigenwelt Model API",
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
// Note: `ollama` / `lmstudio` labels are kept so opencode's auto-detected
// local providers still render with a friendly name in the provider list.

export type ProviderAuthModalProps = {
  open: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  preferredProviderId?: string | null;
  workerType?: "local" | "remote";
  providers: ProviderAuthProvider[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onSubmitCustomProvider?: (input: CustomProviderInstallInput) => Promise<string | void>;
  /** Starts the server-owned "Sign in with Eigenwelt" flow. */
  onEigenweltSignIn?: () => Promise<{ authorizeUrl: string; sessionId: string }>;
  /** Long-polls the Eigenwelt sign-in session until the connection is finalized. */
  onEigenweltWait?: (
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ) => Promise<{ connected: boolean; cancelled?: boolean; message?: string }>;
  /** When set, the modal opens straight into the custom form to edit this provider. */
  customEdit?: CustomProviderEditData | null;
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
  const [customFetchedModels, setCustomFetchedModels] = useState<string[]>([]);
  const [customFetching, setCustomFetching] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const providerPollRef = useRef<number | null>(null);
  const oauthAutoPollRef = useRef<number | null>(null);
  const oauthCodeCopiedResetRef = useRef<number | null>(null);
  const pollingBusyRef = useRef(false);
  const oauthSubmitBusyRef = useRef(false);
  const oauthAutoBusyRef = useRef(false);
  const oauthStartBusyRef = useRef(false);
  const autoOpenedPreferredProviderIdRef = useRef<string | null>(null);
  const customEditPrefilledRef = useRef<string | null>(null);
  // Bumped when the modal closes / navigates back / restarts the flow so the
  // store's Eigenwelt sign-in long-poll for a stale attempt stops instead of
  // finalizing. Each attempt captures the token at start and cancels itself
  // once the ref moves on.
  const eigenweltWaitTokenRef = useRef(0);

  const isEditingCustomProvider = customEditMode;
  const activeBrandedProvider =
    !customEditMode && customBrandName
      ? BRANDED_CUSTOM_PROVIDERS.find((provider) => provider.id === customFixedProviderId) ?? null
      : null;
  const activeLocalTemplate = customShowLocalTemplates
    ? LOCAL_RUNTIME_TEMPLATES.find((template) => template.id === customTemplateId) ?? null
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

  const openExternalUrl = async (url: string) => {
    if (!url) return;
    if (isDesktopRuntime()) {
      await openDesktopUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

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
        name: "Eigenwelt Model API",
        methods: [{ type: "oauth" as const, label: "Sign in with Eigenwelt" }],
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
      for (const branded of BRANDED_CUSTOM_PROVIDERS) {
        if (existingIds.has(branded.id)) continue;
        nextEntries.push({
          id: branded.id,
          name: branded.name,
          methods: [{ type: "api", label: "OpenAI-compatible" }],
          connected: connected.has(branded.id),
          env: [],
        });
      }
      // Re-sort so pinned providers keep their order; the synthetic
      // Local/Custom entries below stay pinned at the bottom.
      nextEntries.sort(compareProviders);

      // One consolidated "Local model" entry with per-runtime templates
      // (llama.cpp, vLLM, LocalAI, …). Ollama / LM Studio on the default host
      // are auto-detected by the engine and appear via auth methods above.
      nextEntries.push({
        id: LOCAL_PROVIDER_ENTRY_ID,
        name: "Local model",
        methods: [{ type: "api", label: "Ollama · LM Studio · llama.cpp · vLLM" }],
        connected: false,
        env: [],
      });

      // Generic user-defined option, pinned at the very bottom.
      nextEntries.push({
        id: CUSTOM_PROVIDER_ENTRY_ID,
        name: "Custom (OpenAI-compatible)",
        methods: [{ type: "api", label: "OpenAI-compatible" }],
        connected: false,
        env: [],
      });
    }

    return nextEntries;
  }, [
    isRemoteWorker,
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
  const errorMessage = localError ?? props.error;

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const methodText = entry.methods.map((method) => method.label || (method.type === "oauth" ? "OAuth" : "API key")).join(" ");
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

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = props.loading || props.submitting;

  const resetState = () => {
    if (oauthCodeCopiedResetRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
      oauthCodeCopiedResetRef.current = null;
    }
    eigenweltWaitTokenRef.current += 1;
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
    setCustomFetchedModels([]);
    setCustomFetching(false);
    setCustomBusy(false);
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

  // Open straight into the custom form, pre-filled, when asked to edit an
  // existing custom provider. Guarded by a ref so it prefills once per open
  // (and never clobbers in-progress edits on re-render).
  useEffect(() => {
    if (!props.open) return;
    const edit = props.customEdit;
    if (!edit || customEditPrefilledRef.current === edit.providerId) return;
    customEditPrefilledRef.current = edit.providerId;
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
        toolCall: model.toolCall,
        reasoning: model.reasoning,
        contextLimit: model.contextLimit != null ? String(model.contextLimit) : "",
      })),
    );
    setCustomFetchedModels([]);
    setLocalError(null);
    setSelectedProviderId(CUSTOM_PROVIDER_ENTRY_ID);
    setView("custom");
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
    if (!props.open || props.loading || resolvedView !== "list") return;

    const preferredId = props.preferredProviderId?.trim().toLowerCase() ?? "";
    if (!preferredId || autoOpenedPreferredProviderIdRef.current === preferredId) return;

    const entry = entries.find((item) => item.id.trim().toLowerCase() === preferredId);
    if (!entry) return;

    autoOpenedPreferredProviderIdRef.current = preferredId;
    queueMicrotask(() => {
      handleEntrySelect(entry);
    });
  }, [
    entries,
    props.loading,
    props.open,
    props.preferredProviderId,
    resolvedView,
  ]);

  useEffect(() => {
    return () => {
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
    if (isDesktopRuntime()) {
      await openDesktopUrl(url);
      setOauthBrowserOpened(true);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
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
      const message = error instanceof Error ? error.message : "Failed to complete OAuth";
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
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    try {
      const started = await props.onSelect(entry.id, methodIndex);
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
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
    } finally {
      oauthStartBusyRef.current = false;
    }
  };

  /**
   * "Sign in with Eigenwelt": the LegalWork server owns the OAuth loopback +
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
        methodLabel: "Sign in with Eigenwelt",
        authorization: { url: started.authorizeUrl, method: "auto" } as ProviderAuthAuthorization,
      });
      await openOauthUrl(started.authorizeUrl);
      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
      return;
    } finally {
      // Release before the (potentially minutes-long) wait so Back + retry —
      // or connecting a different provider — is never blocked by this flow.
      oauthStartBusyRef.current = false;
    }
    try {
      await props.onEigenweltWait?.(sessionId, {
        cancelled: () => eigenweltWaitTokenRef.current !== waitToken,
      });
      // Success: the provider flips connected; the oauth-view provider
      // polling picks it up and closes the modal.
    } catch (error) {
      if (eigenweltWaitTokenRef.current === waitToken) {
        setLocalError(
          error instanceof Error ? error.message : "Failed to complete the Eigenwelt sign-in.",
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

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
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

    const branded = BRANDED_CUSTOM_PROVIDERS.find((provider) => provider.id === entry.id);
    if (branded) {
      startCustomProvider(branded);
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
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setLocalError(message);
    }
  };

  const addCustomModelId = (rawId: string) => {
    const id = rawId.trim();
    if (!id) return;
    setCustomModels((current) =>
      current.some((model) => model.id === id) ? current : [...current, makeCustomModelDraft(id)],
    );
    if (localError) setLocalError(null);
  };

  const removeCustomModelId = (id: string) => {
    setCustomModels((current) => current.filter((model) => model.id !== id));
  };

  const updateCustomModel = (id: string, patch: Partial<CustomModelDraft>) => {
    setCustomModels((current) =>
      current.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    );
  };

  const customModelExists = (id: string) => customModels.some((model) => model.id === id);

  const handleAddCustomModelFromInput = () => {
    const ids = customModelInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) addCustomModelId(id);
    setCustomModelInput("");
  };

  const fetchCustomModels = async () => {
    const base = customBaseURL.trim().replace(/\/+$/, "");
    if (!base) {
      setLocalError("Enter a base URL first.");
      return;
    }
    setCustomFetching(true);
    setLocalError(null);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      const key = customApiKey.trim();
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetch(`${base}/models`, { headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(payload?.data)
        ? payload.data
            .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
            .filter((id): id is string => Boolean(id))
        : [];
      if (!ids.length) {
        throw new Error("No models returned.");
      }
      setCustomFetchedModels(ids);
    } catch (error) {
      setCustomFetchedModels([]);
      const detail = error instanceof Error ? error.message : "request failed";
      setLocalError(`Couldn't list models — enter IDs manually. (${detail})`);
    } finally {
      setCustomFetching(false);
    }
  };

  // Open the custom form fresh — blank for the generic entry, pre-branded
  // (fixed id, name, API type, Base-URL hint) for a branded provider.
  const startCustomProvider = (branded?: BrandedCustomProvider) => {
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
    setCustomFetchedModels([]);
    setLocalError(null);
    setSelectedProviderId(LOCAL_PROVIDER_ENTRY_ID);
    setView("custom");
  };

  // Apply a runtime template: prefill Base URL, API type, and (when the name is
  // still blank or matches another template's name) the display name.
  const applyLocalTemplate = (template: LocalRuntimeTemplate) => {
    setCustomTemplateId(template.id);
    setCustomBaseURL(template.baseURL);
    setCustomBaseUrlPlaceholder(template.placeholder);
    setCustomApiType(template.apiType);
    setCustomApiTypeTouched(true);
    setCustomName((current) => resolveTemplateName(current, template));
    if (localError) setLocalError(null);
  };

  const handleCustomSubmit = async () => {
    if (!props.onSubmitCustomProvider || actionDisabled || customBusy) return;

    const name = customName.trim();
    const baseURL = customBaseURL.trim();
    const apiKey = customApiKey.trim();

    // Fold any not-yet-added text in the input into the model list.
    const pendingDrafts = customModelInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((id) => !customModelExists(id))
      .map(makeCustomModelDraft);
    const drafts = [...customModels, ...pendingDrafts];

    if (!name) {
      setLocalError("Name is required.");
      return;
    }
    if (!baseURL) {
      setLocalError("Base URL is required.");
      return;
    }
    if (!drafts.length) {
      setLocalError("Add at least one model ID.");
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
        models: drafts.map((model) => {
          const parsed = Number.parseInt(model.contextLimit.trim(), 10);
          return {
            id: model.id,
            toolCall: model.toolCall,
            reasoning: model.reasoning,
            contextLimit: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
          };
        }),
      });
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add provider";
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
    if (resolvedView === "api") return "Saving API key...";
    if (resolvedView === "oauth-code") return "Verifying authorization code...";
    if (resolvedView === "oauth-auto") return "Waiting for OAuth confirmation...";
    return "Opening authentication...";
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
        ? "Use OpenAI's device flow for remote workers, where the browser callback may not resolve on your local machine."
        : "Use OpenAI's device flow when the local browser callback is unreliable.";
    }
    if (isAnthropicProvider(entry.id, entry.name) && isClaudeSubscriptionMethod(method)) {
      return "Sign in with your Claude Pro/Max subscription. See the warning above — third-party subscription use may violate Anthropic's terms.";
    }
    if (method.type === "oauth") {
      return "Continue in the browser and let LegalWork finish the connection automatically.";
    }
    if (isOpencodeZenProvider(entry.id)) {
      return "Sign in to OpenCode Zen with an API key to unlock paid models alongside the free tier.";
    }
    return "Paste a secret key that LegalWork stores locally on this device.";
  };

  const anthropicSubscriptionWarning = (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-6/40 bg-amber-2/30 px-3.5 py-3 text-[12px] leading-relaxed text-amber-11">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        Claude Pro/Max sign-in uses your personal Claude subscription. Anthropic&apos;s Consumer Terms
        limit this OAuth to Claude Code and claude.ai, so third-party use may violate those terms and
        can be blocked without notice. For reliable, permitted access, use &ldquo;Create an API Key&rdquo;
        or enter an Anthropic API key instead.
      </span>
    </div>
  );

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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect providers</DialogTitle>
          <DialogDescription>
            Sign in to services or use providers managed by your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {errorMessage ? (
            <div className={errorBannerClass}>{errorMessage}</div>
          ) : props.loading ? (
            <div className="animate-pulse rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-sm text-dls-secondary">
              Loading providers…
            </div>
          ) : null}

          {!props.loading ? (
            <div className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {resolvedView === "list" ? (
                <div className="space-y-1.5" role="presentation" onKeyDown={handleListKeyDown}>
                  <div className="relative mb-2">
                    <Search
                      size={16}
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dls-secondary"
                    />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter providers by name or ID"
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
                          <ProviderIcon providerId={entry.id} size={18} className="text-dls-text" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium tracking-tight text-dls-text">
                                {entry.name}
                              </div>
                              <div className="truncate font-mono text-[11px] text-dls-secondary">
                                {entry.id}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center justify-end">
                              {entry.connected ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-6/40 bg-emerald-3/50 px-2 py-0.5 text-[11px] font-medium text-emerald-11">
                                  <CheckCircle2 size={12} strokeWidth={2.5} />
                                  Connected
                                </span>
                              ) : (
                                <span className="flex items-center gap-0.5 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">
                                  Connect
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
                      {entries.length ? "No providers match your search." : "No providers available."}
                    </div>
                  )}

                  <div className="px-1 pt-1.5 text-[11px] text-dls-secondary">
                    Arrow keys to navigate, Enter to select.
                  </div>
                </div>
              ) : null}

              {resolvedView === "method" && selectedEntry ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">Choose how you'd like to connect.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  {selectedEntryHasClaudeSubscription ? anthropicSubscriptionWarning : null}
                  <div className="grid gap-2">
                    {selectedEntry.methods.map((method) => (
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
                        <div className="text-sm font-medium text-dls-text">{methodLabel(method)}</div>
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
                          ? "Sign in to OpenCode Zen with an API key from opencode.ai/auth."
                          : "Paste your API key to connect."}
                      </div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  {isOpencodeZenProvider(selectedEntry.id) ? (
                    <div className="space-y-1.5 rounded-xl border border-[rgba(var(--dls-accent-rgb),0.2)] bg-[rgba(var(--dls-accent-rgb),0.06)] px-3 py-2.5 text-xs text-dls-text">
                      <div>
                        OpenCode Zen gives you access to the best coding models. Free models keep working without a key.
                      </div>
                      <button
                        type="button"
                        className="font-medium text-dls-accent underline underline-offset-2 hover:opacity-80"
                        onClick={() => void openExternalUrl(OPENCODE_ZEN_KEY_URL)}
                      >
                        Get an API key →
                      </button>
                    </div>
                  ) : null}
                  <TextInput
                    label="API key"
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
                    <div className="text-[11px] text-dls-secondary">Keys are stored locally by OpenCode.</div>
                    <Button
                      onClick={handleApiSubmit}
                      disabled={actionDisabled || !apiKeyInput.trim()}
                    >
                      {props.submitting ? "Saving…" : "Save key"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-code" && selectedEntry && oauthSession ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">Finish OAuth by pasting the authorization code.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="text-xs text-dls-secondary">
                    Complete sign-in in your browser, then paste the code here.
                  </div>
                  {oauthSessionIsClaudeSubscription ? anthropicSubscriptionWarning : null}
                  {oauthInstructions ? (
                    <div className="break-all rounded-xl border border-dls-border bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
                      {oauthInstructions}
                    </div>
                  ) : null}
                  <TextInput
                    label="Authorization code"
                    type="text"
                    placeholder="Paste code"
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
                      Open browser again
                    </Button>
                    <Button
                      onClick={() => void handleOauthCodeSubmit()}
                      disabled={actionDisabled || !oauthCodeInput.trim()}
                    >
                      {props.submitting ? "Verifying..." : "Complete connection"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-auto" && selectedEntry && oauthSession ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">{selectedEntry.name}</div>
                      <div className="mt-1 text-xs text-dls-secondary">Waiting for browser confirmation.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  {isOpenAiHeadlessSession ? (
                    <div className="space-y-2 text-xs text-dls-secondary">
                      <div>You'll need to sign in to your OpenAI account and provide the code below.</div>
                      <div>The first time you do this you'll need to enable Device auth in your account settings.</div>
                      <div>ChatGPT &gt; Account Settings &gt; Security &gt; Enable device code authorization</div>
                      <div>When you're ready, copy the code below, and click &quot;Open Browser&quot;.</div>
                    </div>
                  ) : (
                    <div className="text-xs text-dls-secondary">
                      {isEigenweltOauthSession
                        ? "Complete sign-in in your browser, choose your firm, and return here."
                        : "Sign in in the browser tab we just opened. We will complete the connection automatically."}
                    </div>
                  )}
                  {oauthDisplayCode ? (
                    <div className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-hover p-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wide text-dls-secondary">Confirmation code</div>
                        <div className="break-all font-mono text-sm text-dls-text">{oauthDisplayCode}</div>
                      </div>
                      <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copyOauthDisplayCode()}>
                        {oauthCodeCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  ) : null}
                  {isOpenAiHeadlessSession && !oauthBrowserOpened ? (
                    <div className="flex items-center gap-2 text-xs text-dls-secondary">
                      <span>Authorization checks will start after you click Open Browser.</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-dls-secondary">
                      <Loader2 size={14} className={props.submitting || pollingBusy || oauthAutoBusy ? "animate-spin" : ""} />
                      <span>Checking connection status automatically…</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      {isOpenAiHeadlessSession
                        ? oauthBrowserOpened
                          ? "Reopen Browser"
                          : "Open Browser"
                        : "Open browser again"}
                    </Button>
                    <div className="text-right text-[11px] text-dls-secondary">
                      This window will close once the provider is connected.
                    </div>
                  </div>
                </div>
              ) : null}

              {resolvedView === "custom" ? (
                <div className={`${surfaceCardClass} space-y-4`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-dls-text">
                        {isEditingCustomProvider ? "Edit provider" : customBrandName ?? "Custom provider"}
                      </div>
                      <div className="mt-1 text-xs text-dls-secondary">
                        {isEditingCustomProvider
                          ? "Update this OpenAI-compatible provider."
                          : customShowLocalTemplates
                            ? "Pick a runtime to prefill its endpoint, then fetch its models."
                            : activeBrandedProvider?.description ?? "Connect any endpoint that speaks the OpenAI API spec."}
                      </div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled || customBusy}>
                      Back
                    </Button>
                  </div>

                  {customShowLocalTemplates ? (
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-dls-secondary">Runtime</div>
                      <div className="flex flex-wrap gap-1.5">
                        {LOCAL_RUNTIME_TEMPLATES.map((template) => {
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
                    label="Name"
                    type="text"
                    placeholder="My provider"
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
                    label="Base URL"
                    type="text"
                    placeholder={customBaseUrlPlaceholder}
                    value={customBaseURL}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
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
                    <div className="text-xs font-medium text-dls-secondary">API type</div>
                    <div className="grid grid-cols-2 gap-2">
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
                        ? "Uses @ai-sdk/openai — full tool set and reasoning effort, no 128-tool cap."
                        : "Uses @ai-sdk/openai-compatible. OpenAI caps this at 128 tools; pick Responses API for OpenAI/Azure."}
                    </div>
                  </div>

                  <TextInput
                    label={isEditingCustomProvider ? "API key" : "API key (optional)"}
                    type="password"
                    placeholder={isEditingCustomProvider ? "Leave blank to keep current key" : "sk-..."}
                    value={customApiKey}
                    onChange={(event) => {
                      setCustomApiKey(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled || customBusy}
                  />

                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-dls-text">Models</div>
                      <button
                        type="button"
                        onClick={() => void fetchCustomModels()}
                        disabled={actionDisabled || customBusy || customFetching || !customBaseURL.trim()}
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-dls-accent transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {customFetching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                        {customFetching ? "Fetching…" : "Fetch from endpoint"}
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Add a model ID, e.g. gpt-5.5"
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
                        className="h-9 flex-1 rounded-lg border border-dls-border bg-dls-surface px-3 font-mono text-[13px] text-dls-text transition-colors placeholder:font-sans placeholder:text-dls-secondary focus:border-[rgba(var(--dls-accent-rgb),0.5)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
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

                    {customModels.length ? (
                      <div className="divide-y divide-dls-border overflow-hidden rounded-xl border border-dls-border">
                        {customModels.map((model) => (
                          <div key={model.id} className="group/model px-3 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate font-mono text-[12.5px] text-dls-text">{model.id}</span>
                              <button
                                type="button"
                                onClick={() => removeCustomModelId(model.id)}
                                disabled={actionDisabled || customBusy}
                                aria-label={`Remove ${model.id}`}
                                className="-mr-1 shrink-0 rounded-md p-1 text-dls-secondary opacity-0 transition-all hover:bg-dls-hover hover:text-dls-text focus-visible:opacity-100 group-hover/model:opacity-100 disabled:opacity-0"
                              >
                                <X size={14} />
                              </button>
                            </div>
                            <div className="mt-2 flex items-center gap-5">
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
                              <div className="ml-auto flex items-center gap-1.5">
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
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-dls-border px-3 py-4 text-center text-[11px] leading-relaxed text-dls-secondary">
                        No models yet — custom endpoints have no catalog.
                        <br />
                        Add an ID above, or fetch the list from your endpoint.
                      </div>
                    )}

                    {customFetchedModels.length ? (
                      <div className="space-y-1.5 pt-0.5">
                        <div className="text-[10px] font-medium uppercase tracking-wide text-dls-secondary">
                          From endpoint — click to add
                        </div>
                        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                          {customFetchedModels.map((id) => {
                            const added = customModelExists(id);
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => addCustomModelId(id)}
                                disabled={actionDisabled || customBusy || added}
                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                                  added
                                    ? "cursor-default border-transparent bg-dls-hover text-dls-secondary"
                                    : "border-dls-border text-dls-text hover:border-[rgba(var(--dls-accent-rgb),0.4)] hover:bg-[rgba(var(--dls-accent-rgb),0.06)]"
                                }`}
                              >
                                {added ? <Check size={11} /> : <Plus size={11} />}
                                {id}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {customModels.length ? (
                      <div className="text-[11px] text-dls-secondary">
                        Reasoning is auto-detected from the model id — toggle per model if needed.
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-dls-secondary">Keys are stored locally by OpenCode.</div>
                    <Button
                      onClick={() => void handleCustomSubmit()}
                      disabled={
                        actionDisabled ||
                        customBusy ||
                        !customName.trim() ||
                        !customBaseURL.trim() ||
                        (customModels.length === 0 && !customModelInput.trim())
                      }
                    >
                      {customBusy
                        ? isEditingCustomProvider
                          ? "Saving…"
                          : "Adding…"
                        : isEditingCustomProvider
                          ? "Save changes"
                          : "Add provider"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3">
          <div className="min-h-[16px] text-xs text-dls-secondary">
            {props.submitting ? submittingLabel() : null}
          </div>
          <DialogClose
            disabled={actionDisabled}
            render={<Button variant="outline" disabled={actionDisabled} />}
          >
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
