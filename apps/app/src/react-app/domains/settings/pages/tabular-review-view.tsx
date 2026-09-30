import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ReviewSettingsForm } from "../../reviews/review-settings";
import { LayoutStack } from "../settings-layout";

export function TabularReviewSettingsView({ client, workspaceId, onManageProviders }: {
  client: LegalworkServerClient | null; workspaceId: string | null; onManageProviders: () => void;
}) {
  return <LayoutStack>
    {client && workspaceId ? <ReviewSettingsForm key={workspaceId} client={client} workspaceId={workspaceId} page />
      : <p className="text-sm text-muted-foreground">{t("review.defaults_connect")}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
      <p className="text-sm text-muted-foreground">{t("review.defaults_providers_hint")}</p>
      <Button variant="outline" onClick={onManageProviders}>{t("settings.tab_ai")}</Button>
    </div>
  </LayoutStack>;
}
