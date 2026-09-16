/** @jsxImportSource react */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

import {
  useTaskNotificationPreferences,
  type TaskNotificationPreferences,
  type TaskNotificationScope,
} from "../../tasks/task-notification-preferences";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type ToggleKey = "arrivals" | "dueToday" | "overdue" | "system";

/**
 * A switch row's content. The row itself (LayoutSectionItem) stays at the
 * call site: the section groups only its direct rows into one card.
 */
function ToggleRow(props: { field: ToggleKey; title: string; description: string }) {
  const checked = useTaskNotificationPreferences((state) => state[props.field]);
  const update = useTaskNotificationPreferences((state) => state.update);
  return (
    <LayoutSectionItemHeader>
      <LayoutSectionItemTitle>{props.title}</LayoutSectionItemTitle>
      <LayoutSectionItemDescription>{props.description}</LayoutSectionItemDescription>
      <LayoutSectionItemHeaderActions>
        <Switch
          aria-label={props.title}
          checked={checked}
          onCheckedChange={(next: boolean) => update({ [props.field]: next } as Partial<TaskNotificationPreferences>)}
        />
      </LayoutSectionItemHeaderActions>
    </LayoutSectionItemHeader>
  );
}

/**
 * Settings > Notifications: what LegalWork announces about tasks while it
 * runs, and whether it uses the system's notifications for it.
 */
export function NotificationsView() {
  const scope = useTaskNotificationPreferences((state) => state.scope);
  const update = useTaskNotificationPreferences((state) => state.update);
  const scopes: Array<{ value: TaskNotificationScope; label: string }> = [
    { value: "mine", label: t("settings.notifications_scope_mine") },
    { value: "unassigned", label: t("settings.notifications_scope_unassigned") },
    { value: "all", label: t("settings.notifications_scope_all") },
  ];

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.notifications_tasks_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.notifications_tasks_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <ToggleRow
            field="arrivals"
            title={t("settings.notifications_arrivals")}
            description={t("settings.notifications_arrivals_desc")}
          />
        </LayoutSectionItem>
        <LayoutSectionItem>
          <ToggleRow
            field="dueToday"
            title={t("settings.notifications_due_today")}
            description={t("settings.notifications_due_today_desc")}
          />
        </LayoutSectionItem>
        <LayoutSectionItem>
          <ToggleRow
            field="overdue"
            title={t("settings.notifications_overdue")}
            description={t("settings.notifications_overdue_desc")}
          />
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.notifications_scope")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.notifications_scope_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Select
                value={scope}
                // Base UI resolves the trigger label from `items`.
                items={scopes}
                onValueChange={(value) => update({ scope: value as TaskNotificationScope })}
              >
                <SelectTrigger size="sm" className="w-[220px]" aria-label={t("settings.notifications_scope")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.notifications_delivery_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.notifications_delivery_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        <LayoutSectionItem>
          <ToggleRow
            field="system"
            title={t("settings.notifications_system")}
            description={t("settings.notifications_system_desc")}
          />
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
