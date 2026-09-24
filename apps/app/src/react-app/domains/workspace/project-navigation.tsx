import { Files, House, MessageSquare, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function ProjectNavigation(props: {
  home: boolean;
  files: boolean;
  onHome: () => void;
  onAgents: () => void;
  onFiles: () => void;
}) {
  return (
    <nav
      aria-label={t("projects.navigation")}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-2"
    >
      <Button
        size="sm"
        variant={props.home ? "secondary" : "ghost"}
        onClick={props.onHome}
        aria-current={props.home ? "page" : undefined}
      >
        <House className="size-4" />
        {t("projects.home")}
      </Button>
      <Button
        size="sm"
        variant={!props.home ? "secondary" : "ghost"}
        onClick={props.onAgents}
      >
        <MessageSquare className="size-4" />
        {t("projects.agents")}
      </Button>
      <Button
        size="sm"
        variant={props.files ? "secondary" : "ghost"}
        onClick={props.onFiles}
        aria-pressed={props.files}
      >
        <Files className="size-4" />
        {t("projects.files")}
      </Button>
      <span title={t("projects.tab_review_pending")}>
        <Button size="sm" variant="ghost" disabled>
          <Table2 className="size-4" />
          {t("projects.tab_review")}
        </Button>
      </span>
    </nav>
  );
}
