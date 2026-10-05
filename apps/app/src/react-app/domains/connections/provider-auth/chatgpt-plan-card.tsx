/** @jsxImportSource react */
import type { ComponentProps } from "react";
import chatGptBlack from "@/assets/chatgpt-logo-black.svg";
import chatGptWhite from "@/assets/chatgpt-logo-white.svg";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Original OpenAI assets: https://developers.openai.com/siwc/website */
export function ChatGptLogo({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex size-[21px] shrink-0", className)}>
      <img src={chatGptBlack} width={21} height={21} alt="" className="size-full dark:hidden" />
      <img src={chatGptWhite} width={21} height={21} alt="" className="hidden size-full dark:block" />
    </span>
  );
}

/** Approved monochrome format; use only for an action that starts ChatGPT sign-in. */
export function ChatGptSignInButton({ className, ...props }: Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      {...props}
      size="lg"
      className={cn("h-[45px] gap-3 rounded-xl bg-black px-5 font-['Inter_Variable',sans-serif] text-[15px] text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90", className)}
    >
      <span aria-hidden="true" className="inline-flex size-[21px] shrink-0">
        <img src={chatGptWhite} width={21} height={21} alt="" className="size-full dark:hidden" />
        <img src={chatGptBlack} width={21} height={21} alt="" className="hidden size-full dark:block" />
      </span>
      {t("providers.continue_chatgpt")}
    </Button>
  );
}

export function ChatGptPlanCard(props: { disabled: boolean; onContinue: () => void }) {
  return (
    <section className="space-y-4 rounded-2xl border border-dls-border bg-dls-surface p-5">
      <div className="flex items-center gap-2.5">
        <ChatGptLogo className="size-7" />
        <h3 className="text-[15px] font-medium tracking-tight text-dls-text">{t("providers.chatgpt_plan_title")}</h3>
      </div>
      <p className="text-[13px] leading-5 text-dls-secondary">{t("ai_plans.provider_openai_hint")}</p>
      <ChatGptSignInButton className="w-full" disabled={props.disabled} onClick={props.onContinue} />
    </section>
  );
}
