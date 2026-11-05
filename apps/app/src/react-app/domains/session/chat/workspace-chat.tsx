import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "../sync/session-sync";
import { useEffect, useMemo, type ReactNode } from "react";
import { createClient } from "@/app/lib/opencode";
import { useSessionInteractions } from "../sync/use-session-interactions";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";
import { useModelPicker } from "../modals/use-model-picker";
import { ModelPickerModal } from "../modals/model-picker-modal";
import { useModelBehavior } from "../surface/use-model-behavior";
import { useProviderListQuery, isModelAvailableInConnectedProviders } from "@/react-app/infra/provider-list-query";
import { chatModelKey, useSessionModelStore } from "./session-model-store";
import { resolveModelDisplayName } from "@/app/utils";
import type { ModelRef } from "@/app/types";
import { useChatModelPreferences } from "@/react-app/kernel/use-chat-model-preferences";

type ModelSettings = Pick<SessionSurfaceProps, "selectedModel" | "modelSelectorLocked" | "modelPickerOpen" | "onModelPickerOpenChange" | "onModelChange" | "modelVariant" | "modelVariantLabel" | "modelBehaviorOptions" | "onModelVariantChange">;

/** Each open chat owns its approvals, questions and todos. Focusing a different
 * tab changes navigation, never the session to which an action is addressed. */
export function WorkspaceChat(props: SessionSurfaceProps & { renderAssistantHeader?: (settings: ModelSettings) => ReactNode }) {
  const client = useMemo(() => createClient(props.opencodeBaseUrl, props.workspaceRoot || undefined,
    { token: props.legalworkToken, hostToken: props.legalworkHostToken, mode: "legalwork" }), [props.opencodeBaseUrl, props.workspaceRoot, props.legalworkToken, props.legalworkHostToken]);
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
  const selection = props.assistantDate
    ? { model: assistant.model ?? { providerID: "", modelID: "" }, variant: assistant.variant }
    : stored ?? { model: props.selectedModel, variant: props.modelVariant };
  useEffect(() => {
    if (!props.assistantDate && props.selectedModel.providerID && props.selectedModel.modelID) useSessionModelStore.getState().initialize(key, { model: props.selectedModel, variant: props.modelVariant });
  }, [key, props.assistantDate, props.selectedModel, props.modelVariant]);
  const picker = useModelPicker({ client, baseUrl: props.opencodeBaseUrl, workspaceRoot: props.workspaceRoot, listenForDefaults: false });
  const unavailable = Boolean(providers.data && !isModelAvailableInConnectedProviders(providers.data, selection.model));
  const behavior = useModelBehavior({ providerList: providers.data, defaultModel: selection.model, modelVariant: selection.variant });
  const select = (model: ModelRef) => {
    if (props.assistantDate) assistant.onModelChange(model);
    else {
      useSessionModelStore.getState().select(key, { model, variant: selection.model.providerID === model.providerID && selection.model.modelID === model.modelID ? selection.variant : null });
      props.onModelChange(model);
    }
    picker.setCompactOpen(false); picker.setOpen(false);
  };
  const selectBehavior = (model: ModelRef, variant: string | null) => {
    if (props.assistantDate) assistant.onSelectionChange({ model, variant });
    else useSessionModelStore.getState().select(key, { model, variant });
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
      onSendDraft={(draft, id, options) => props.onSendDraft(draft, id, { ...options, modelSelection: { model: selection.model, variant: behavior.modelVariantValue } })}
    />
    <ModelPickerModal open={picker.open} options={picker.options} query={picker.query} setQuery={picker.setQuery}
      target="session" current={selection.model} onSelect={select} onBehaviorChange={selectBehavior}
      onOpenSettings={() => { picker.setOpen(false); props.onOpenSettingsSection?.("providers"); }} onClose={() => picker.setOpen(false)} />
  </div>;
}
