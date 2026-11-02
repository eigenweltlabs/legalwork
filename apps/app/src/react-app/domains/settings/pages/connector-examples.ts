import { t } from "@/i18n";

export type ConnectorExampleKind = "files" | "research" | "website" | "mail" | "calendar";

// Use source-appropriate tasks, not a claim about search-volume rankings.
// Beck: https://rsw.beck.de/docs/librariesprovider138/default-document-library/bo_kurz_2021_13.pdf
// juris: https://www.juris.de/jportal/portal/page/fshelp.psml?cmsuri=%2Fhilfe%2Fde%2Fep%2Fjuris_recherche%2Fsuche_recht.jsp
// Files: https://help.dropbox.com/view-edit/search and https://support.google.com/drive/answer/2375114
// Mail/calendar: https://support.google.com/mail/answer/7190 and https://support.microsoft.com/en-us/outlook/training/search-for-calendar-items-in-outlook
export function connectorExamples(kind: ConnectorExampleKind, name: string, providerId?: string): string[] {
  const keys = kind === "research" && providerId === "beck-online"
    ? ["catalog.example_beck_commentary", "catalog.example_beck_case"]
    : kind === "research" && providerId === "juris"
      ? ["catalog.example_juris_case", "catalog.example_juris_topic"]
      : {
        files: ["catalog.files_example_find", "catalog.files_example_review"],
        research: ["catalog.browser_example_search", "catalog.browser_example_read"],
        website: ["catalog.example_website_search", "catalog.example_website_read"],
        mail: ["catalog.example_mail_attachment", "catalog.example_mail_unread"],
        calendar: ["catalog.example_calendar_week", "catalog.example_calendar_topic"],
      }[kind];
  return keys.map(key => t(key, { name }));
}
