import { setWorkdaySurfaces } from "../../../shell/workday-surfaces";
import { interactionSessionsKey, type InteractionSessions } from "../sync/interaction-state";
import { useQueryClient } from "@tanstack/react-query";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "../sync/session-sync";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createClient } from "@/app/lib/opencode";
import { useSessionInteractions } from "../sync/use-session-interactions";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";
import { useModelPicker } from "../modals/use-model-picker";
import { ModelPickerModal } from "../modals/model-picker-modal";
import { useModelBehavior } from "../surface/use-model-behavior";
import { useProviderListQuery, isModelAvailableInConnectedProviders } from "@/react-app/infra/provider-list-query";
import { chatModelKey, isOnDeviceTimekeepingModel, resolveTimekeepingChatModel, useSessionModelStore } from "./session-model-store";
import { resolveModelDisplayName } from "@/app/utils";
import type { ModelRef } from "@/app/types";
import { useChatModelPreferences } from "@/react-app/kernel/use-chat-model-preferences";
import { t } from "@/i18n";

type ModelSettings = Pick<SessionSurfaceProps, "selectedModel" | "modelSelectorLocked" | "modelPickerOpen" | "onModelPickerOpenChange" | "onModelChange" | "modelVariant" | "modelVariantLabel" | "modelBehaviorOptions" | "onModelVariantChange">;

/** Each open chat owns its approvals, questions and todos. Focusing a different
 * tab changes navigation, never the session to which an action is addressed. */
export function WorkspaceChat(props: SessionSurfaceProps & { renderAssistantHeader?: (settings: ModelSettings) => ReactNode }) {
  const client = useMemo(() => createClient(props.opencodeBaseUrl, props.workspaceRoot || undefined,
    { token: props.legalworkToken, hostToken: props.legalworkHostToken, mode: "legalwork" }), [props.opencodeBaseUrl, props.workspaceRoot, props.legalworkToken, props.legalworkHostToken]);
  const cache = useQueryClient();
  const surfaceKey = useRef(Symbol("chat"));
  useEffect(() => {
    if (props.active === false || props.timekeeping || !props.legalworkHostToken) return;
    const key = surfaceKey.current;
    const info = cache.getQueryData<InteractionSessions>(interactionSessionsKey(props.workspaceId))?.[props.sessionId];
    setWorkdaySurfaces(key, [{ type: "chat", projectId: props.workspaceId, id: props.sessionId,
      title: info?.title || props.assistantName || t("session.default_title"), focused: true }]);
    return () => setWorkdaySurfaces(key, []);
  }, [cache, props.workspaceId, props.sessionId, props.active, props.timekeeping, props.legalworkHostToken, props.assistantName]);
  useEffect(() => {
    const input = { workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl, legalworkToken: props.legalworkToken, legalworkHostToken: props.legalworkHostToken };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, props.sessionId);
    return () => { releaseSession(); releaseWorkspace(); };
  }, [props.workspaceId, props.opencodeBaseUrl, props.legalworkToken, props.legalworkHostToken, props.sessionId]);
  const interactions = useSessionInteractions({ client, serverClient: props.client, workspaceId: props.workspaceId, sessionId: props.sessionId, workspaceRoot: props.workspaceRoot });
  const key = chatModelKey(props.opencodeBaseUrl, props.workspaceId, props.sessionId);
  const stored = useSessionModelStore(state => state.selections[key]);
  const providers = useProviderListQuery({ client, baseUrl: props.opencodeBaseUrl, directory: props.workspaceRoot || undefined });
  const assistant = useChatModelPreferences(Boolean(props.assistantDate), providers.data);
  const defaults = useMemo(() => ({ model: props.selectedModel, variant: props.modelVariant }), [props.selectedModel, props.modelVariant]);
  const timekeeping = Boolean(props.timekeeping);
  const savedModel = props.timekeeping?.model;
  const foreignModel = Boolean(savedModel?.workspaceId && savedModel.workspaceId !== props.workspaceId);
  const savedChoiceKey = JSON.stringify([key, savedModel?.workspaceId, savedModel?.providerID, savedModel?.modelID]);
  const changingFrom = useRef<string | null>(null);
  const selection = useMemo(() => {
    if (props.assistantDate) return { model: assistant.model ?? { providerID: "", modelID: "" }, variant: assistant.variant };
    if (foreignModel && savedModel) return { model: savedModel, variant: null };
    return timekeeping ? resolveTimekeepingChatModel(providers.data, stored, savedModel, defaults) : stored ?? defaults;
  }, [props.assistantDate, assistant.model, assistant.variant, foreignModel, timekeeping, providers.data, stored, savedModel, defaults]);
  useEffect(() => {
    if (!props.assistantDate && !timekeeping && defaults.model.providerID && defaults.model.modelID)
      useSessionModelStore.getState().initialize(key, defaults);
  }, [key, props.assistantDate, timekeeping, defaults]);
  const picker = useModelPicker({ client, baseUrl: props.opencodeBaseUrl, workspaceRoot: props.workspaceRoot, listenForDefaults: false });
  // Matching IDs can refer to different endpoints in different projects.
  const unavailable = foreignModel || Boolean(providers.data && !isModelAvailableInConnectedProviders(providers.data, selection.model));
  const behavior = useModelBehavior({ providerList: providers.data, defaultModel: selection.model, modelVariant: selection.variant });
  useEffect(() => {
    // Let an explicit picker change reach the profile before running recovery.
    if (changingFrom.current === savedChoiceKey) return;
    changingFrom.current = null;
    if (!props.active || !props.timekeeping || !providers.data || unavailable || !selection.model.providerID || !selection.model.modelID || isOnDeviceTimekeepingModel(savedModel)) return;
    if (stored && (stored.model.providerID !== selection.model.providerID || stored.model.modelID !== selection.model.modelID))
      useSessionModelStore.getState().select(key, selection);
    props.timekeeping.modelChanged(selection.model);
  }, [props.active, props.timekeeping, providers.data, unavailable, selection, stored, key, savedModel, savedChoiceKey]);
  const chooseSessionModel = (model: ModelRef, variant: string | null, picked: boolean) => {
    if (props.timekeeping) {
      if (!picked && (foreignModel || (savedModel && model.providerID !== savedModel.providerID))) return;
      if (!providers.data || !model.providerID || !model.modelID || !isModelAvailableInConnectedProviders(providers.data, model)) return;
    }
    useSessionModelStore.getState().select(key, { model, variant });
    if (props.timekeeping) {
      changingFrom.current = foreignModel || model.providerID !== savedModel?.providerID || model.modelID !== savedModel?.modelID ? savedChoiceKey : null;
      props.timekeeping.modelChanged(model, picked && foreignModel);
    }
  };
  const select = (model: ModelRef) => {
    if (props.assistantDate) assistant.onModelChange(model);
    else {
      chooseSessionModel(model, selection.model.providerID === model.providerID && selection.model.modelID === model.modelID ? selection.variant : null, true);
      if (!props.timekeeping) props.onModelChange(model);
    }
    picker.setCompactOpen(false); picker.setOpen(false);
  };
  const selectBehavior = (model: ModelRef, variant: string | null) => {
    if (props.assistantDate) assistant.onSelectionChange({ model, variant });
    else chooseSessionModel(model, variant, false);
  };
  const modelSettings: ModelSettings = {
    selectedModel: selection.model,
    modelSelectorLocked: props.modelSelectorLocked && !unavailable,
    modelPickerOpen: picker.compactOpen,
    onModelPickerOpenChange: picker.setCompactOpen,
    onModelChange: select,
    modelVariant: behavior.modelVariantValue,
    modelVariantLabel: behavior.modelVariantLabel,
    modelBehaviorOptions: behavior.modelBehaviorOptions,
    onModelVariantChange: variant => selectBehavior(selection.model, variant),
  };
  return <div className="h-full min-h-0" data-workspace-chat={props.sessionId} data-workspace-tab-active={props.active !== false}>
    <SessionSurface {...props} {...interactions} {...modelSettings}
      assistantHeader={props.renderAssistantHeader?.(modelSettings) ?? props.assistantHeader}
      modelLabel={resolveModelDisplayName(selection.model.modelID)} modelUnavailable={unavailable}
      onModelClick={() => picker.setOpen(true)} onChangeModel={select}
      onSendDraft={(draft, id, options) => {
        if (props.timekeeping && (unavailable || !providers.data || !selection.model.providerID || !selection.model.modelID)) throw new Error(t("session_route.model_unavailable"));
        return props.onSendDraft(props.timekeeping ? { ...draft, modelContext: [draft.modelContext, props.timekeeping.context].filter(Boolean).join("\n\n") } : draft, id, { ...options, modelSelection: { model: selection.model, variant: behavior.modelVariantValue } });
      }}
    />
    <ModelPickerModal open={picker.open} options={picker.options} query={picker.query} setQuery={picker.setQuery}
      target="session" current={selection.model} onSelect={select} onBehaviorChange={selectBehavior}
      onOpenSettings={() => { picker.setOpen(false); props.onOpenSettingsSection?.("providers"); }} onClose={() => picker.setOpen(false)} />
  </div>;
}
