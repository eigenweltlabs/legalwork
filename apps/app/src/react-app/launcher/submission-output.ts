import type { AssistantSubmitInput, LauncherOutputIntent } from "@legalwork/types/launcher";
import { launcherOutputRemember } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";

/** Every sending surface journals the frozen output policy before dispatching a retry. */
export function rememberLauncherSubmissionOutput(serverUrl: string, conversationId: string) {
  return async (input: AssistantSubmitInput, intent?: Pick<LauncherOutputIntent, "output" | "originId">) => {
    if (intent && isDesktopRuntime()) await launcherOutputRemember(serverUrl, { requestId: input.requestId, messageId: input.messageId, conversationId, ...intent });
  };
}
