import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "../sync/session-sync";
import { useEffect, useMemo } from "react";
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

/** Each open chat owns its approvals, questions and todos. Focusing a different
 * tab changes navigation, never the session to which an action is addressed. */
export function WorkspaceChat(props: SessionSurfaceProps) {
  const client = useMemo(() => createClient(props.opencodeBaseUrl, props.workspaceRoot || undefined,
    { token: props.legalworkToken, mode: "legalwork" }), [props.opencodeBaseUrl, props.workspaceRoot, props.legalworkToken]);
  useEffect(() => {
    const input = { workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl, legalworkToken: props.legalworkToken };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, props.sessionId);
    return () => { releaseSession(); releaseWorkspace(); };
  }, [props.workspaceId, props.opencodeBaseUrl, props.legalworkToken, props.sessionId]);
  const interactions = useSessionInteractions({ client, workspaceId: props.workspaceId, sessionId: props.sessionId, workspaceRoot: props.workspaceRoot });
  const key = chatModelKey(props.opencodeBaseUrl, props.workspaceId, props.sessionId);
  const stored = useSessionModelStore(state => state.selections[key]);
  const selection = stored ?? { model: props.selectedModel, variant: props.modelVariant };
  useEffect(() => {
    if (props.selectedModel.providerID && props.selectedModel.modelID) useSessionModelStore.getState().initialize(key, { model: props.selectedModel, variant: props.modelVariant });
  }, [key, props.selectedModel, props.modelVariant]);
  const picker = useModelPicker({ client, baseUrl: props.opencodeBaseUrl, workspaceRoot: props.workspaceRoot, listenForDefaults: false });
  const providers = useProviderListQuery({ client, baseUrl: props.opencodeBaseUrl, directory: props.workspaceRoot || undefined });
  const unavailable = Boolean(providers.data && !isModelAvailableInConnectedProviders(providers.data, selection.model));
  const behavior = useModelBehavior({ providerList: providers.data, defaultModel: selection.model, modelVariant: selection.variant });
  const select = (model: ModelRef) => {
    useSessionModelStore.getState().select(key, { model, variant: selection.model.providerID === model.providerID && selection.model.modelID === model.modelID ? selection.variant : null });
    picker.setCompactOpen(false); picker.setOpen(false);
  };
  return <div className="h-full min-h-0" data-workspace-chat={props.sessionId} data-workspace-tab-active={props.active !== false}>
    <SessionSurface {...props} {...interactions}
      selectedModel={selection.model} modelLabel={resolveModelDisplayName(selection.model.modelID)}
      modelUnavailable={unavailable} modelSelectorLocked={props.modelSelectorLocked && !unavailable}
      modelPickerOpen={picker.compactOpen} onModelPickerOpenChange={picker.setCompactOpen}
      onModelClick={() => picker.setOpen(true)} onModelChange={select} onChangeModel={select}
      modelVariant={behavior.modelVariantValue} modelVariantLabel={behavior.modelVariantLabel} modelBehaviorOptions={behavior.modelBehaviorOptions}
      onModelVariantChange={variant => useSessionModelStore.getState().select(key, { model: selection.model, variant })}
      onSendDraft={(draft, id, options) => props.onSendDraft(draft, id, { ...options, modelSelection: { model: selection.model, variant: behavior.modelVariantValue } })}
    />
    <ModelPickerModal open={picker.open} options={picker.options} query={picker.query} setQuery={picker.setQuery}
      target="session" current={selection.model} onSelect={select} onBehaviorChange={(model, variant) => useSessionModelStore.getState().select(key, { model, variant })}
      onOpenSettings={() => { picker.setOpen(false); props.onOpenSettingsSection?.("providers"); }} onClose={() => picker.setOpen(false)} />
  </div>;
}
