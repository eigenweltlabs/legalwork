import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, Plus, Search } from "lucide-react";
import { legalResearchCountries, legalResearchProviders, researchWebsite, type ResearchProvider } from "@legalwork/types/legal-research";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { currentLocale, t } from "@/i18n";
import { BrowserPasswordForm } from "../session/modals/browser-password-form";
import { CoverBackButton, CoverSkipButton, OnboardingCover, StepDots } from "./onboarding-cover";

type Database = Pick<ResearchProvider, "name" | "researchUrl" | "loginUrl"> & { providerId?: string; needsLoginUrl?: boolean };
export type ResearchDatabasesProps = {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  initialCountry: string;
  onCountryChange: (country: string) => void;
  onDone: () => void;
  onBack?: () => void;
  totalSteps: number;
};

/** The existing vault card owns all credential state. This flow sees only a saved ID. */
export function ResearchDatabasesStep(props: ResearchDatabasesProps) {
  const id = useId(), cache = useQueryClient();
  const [country, setCountry] = useState(props.initialCountry);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [queue, setQueue] = useState<Database[]>([]);
  const [index, setIndex] = useState(0);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ name: "", researchUrl: "", loginUrl: "" });
  const [loginAddress, setLoginAddress] = useState("");
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const submitting = useRef(false);
  const { client, workspaceId } = props;
  const available = Boolean(client?.canApprove && workspaceId);
  const installed = useQuery({
    queryKey: ["browser-passwords", client?.baseUrl], enabled: available,
    queryFn: () => {
      if (!client || !workspaceId) throw new Error(t("research.unavailable"));
      return client.listBrowserPasswords();
    },
  });
  const names = new Intl.DisplayNames([currentLocale()], { type: "region" });
  const countries = [...legalResearchCountries].sort((a, b) => (names.of(a) ?? a).localeCompare(names.of(b) ?? b, currentLocale()));
  const query = search.trim().toLocaleLowerCase();
  const providers = legalResearchProviders.filter(provider => query
    ? [provider.name, ...provider.aliases].some(value => value.toLocaleLowerCase().includes(query))
    : provider.countries.includes(country));
  const current = queue[index];
  const configured = (providerId: string) => Boolean(installed.data?.items.some(entry => entry.websites?.some(site => site.providerId === providerId || site.url === legalResearchProviders.find(item => item.id === providerId)?.researchUrl)));
  const begin = (items: Database[]) => { setQueue(items); setIndex(0); setError(""); setCustom(false); setLoginAddress(""); };
  const configure = async (passwordId: string) => {
    if (!client || !workspaceId || !current?.loginUrl || submitting.current) return;
    submitting.current = true; setSaving(true); setError("");
    try {
      const result = await client.configureResearchDatabase(workspaceId, current.providerId
        ? { providerId: current.providerId, country, passwordId, ...(current.needsLoginUrl ? { loginUrl: current.loginUrl } : {}) }
        : { name: current.name, researchUrl: current.researchUrl, loginUrl: current.loginUrl, country, passwordId });
      cache.setQueryData<Awaited<ReturnType<LegalworkServerClient["listBrowserPasswords"]>>>(["browser-passwords", client.baseUrl], previous => ({
        items: [...(previous?.items ?? []).filter(item => item.id !== result.item.id), result.item],
      }));
      setAdded(previous => [...new Set([...previous, current.name])]);
      setSelected(previous => previous.filter(value => value !== current.providerId));
      if (index + 1 < queue.length) { setIndex(value => value + 1); setLoginAddress(""); }
      else { setQueue([]); setDraft({ name: "", researchUrl: "", loginUrl: "" }); }
    } catch {
      // Do not echo arbitrary server diagnostics next to a password form.
      setError(t("research.setup_failed"));
    } finally { submitting.current = false; setSaving(false); }
  };

  const footerLeft = props.onBack ? <CoverBackButton label={t("onboarding.back")} onClick={props.onBack} /> : null;
  const footerRight = added.length
    ? <Button size="sm" disabled={selected.length > 0} onClick={props.onDone}>{t("onboarding.continue")}</Button>
    : <CoverSkipButton label={t("research.skip")} disabled={selected.length > 0} onClick={props.onDone} />;
  const content = <div className="flex w-full max-w-md flex-col gap-7" data-testid="research-databases">
    <div>
      <StepDots step={props.totalSteps} total={props.totalSteps} />
      <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.04em] text-foreground">{t(current ? "research.connect_title" : "research.title", { name: current?.name ?? "" })}</h1>
      <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">{t(current ? "research.connect_description" : "research.description")}</p>
    </div>
    {current ? <>
      <p className="text-xs text-muted-foreground" role="status">{t("research.progress", { current: index + 1, total: queue.length })}</p>
      <div className="rounded-lg border border-border px-4 py-3 text-sm">
        <div className="text-xs text-muted-foreground">{t("research.research_url")}</div>
        <div className="mt-1 break-all">{current.researchUrl}</div>
      </div>
      {current.loginUrl ? <BrowserPasswordForm key={`${current.providerId ?? current.researchUrl}:${current.loginUrl}`} client={client ?? undefined}
        request={{ website: new URL(current.loginUrl).origin, label: current.name, username: "", startUrl: current.researchUrl }} busy={saving}
        onComplete={passwordId => void configure(passwordId)} onCancel={() => { setQueue([]); setError(""); }} />
        : <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={event => {
          event.preventDefault();
          const result = researchWebsite.safeParse(loginAddress);
          if (!result.success) { setError(t("research.invalid_url")); return; }
          setQueue(previous => previous.map((item, position) => position === index ? { ...item, loginUrl: result.data } : item)); setError("");
        }}>
          <p className="text-sm leading-6 text-muted-foreground">{t("research.confirm_login")}</p>
          <label className="block space-y-2 text-sm">{t("research.sign_in_address")}<Input type="url" required maxLength={2000} placeholder="https://" value={loginAddress} onChange={event => setLoginAddress(event.currentTarget.value)} /></label>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => { setQueue([]); setError(""); }}>{t("settings.environment.cancel")}</Button><Button type="submit">{t("onboarding.continue")}</Button></div>
        </form>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </> : <>
      <div className="space-y-2">
        <label htmlFor={`${id}-country`} className="text-sm font-medium">{t("research.country")}</label>
        <select id={`${id}-country`} value={country} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" onChange={event => {
          const value = event.currentTarget.value; setCountry(value); props.onCountryChange(value); setSearch(""); setSelected([]); setCustom(false); setError("");
        }}>
          <option value="">{t("research.choose_country")}</option>
          {countries.map(value => <option key={value} value={value}>{names.of(value)}</option>)}
          <option value="OTHER">{t("research.other_country")}</option>
        </select>
      </div>
      {!available ? <p role="status" className="text-sm text-muted-foreground">{t("research.unavailable")}</p> : null}
      {country && available ? <>
        <div className="space-y-3">
          <h2 className="text-sm font-medium">{t("research.select")}</h2>
          {country === "MT" && !query ? <p className="text-xs leading-5 text-muted-foreground">{t("research.malta")}</p> : null}
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input aria-label={t("research.search")} placeholder={t("research.search")} value={search} onChange={event => setSearch(event.currentTarget.value)} className="h-10 pl-9" />
          </div>
          {installed.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p>
            : installed.isError ? <p role="alert" className="text-sm text-destructive">{t("research.load_failed")} <Button variant="link" onClick={() => void installed.refetch()}>{t("common.refresh")}</Button></p>
            : <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
              {providers.map(provider => <label key={provider.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/40">
                <Checkbox checked={selected.includes(provider.id)} onCheckedChange={checked => setSelected(previous => checked ? [...previous, provider.id] : previous.filter(value => value !== provider.id))} />
                <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{provider.name}</span><span className="block truncate text-xs text-muted-foreground">{new URL(provider.researchUrl).hostname}{provider.freeAccount ? ` · ${t("research.free_account")}` : ""}</span></span>
                {configured(provider.id) ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" />{t("research.configured")}</span> : null}
              </label>)}
              {!providers.length ? <p className="px-4 py-5 text-sm text-muted-foreground">{t("research.no_matches")}</p> : null}
            </div>}
          <Button variant="outline" className="w-full" onClick={() => { setCustom(value => !value); setError(""); }}><Plus className="size-4" />{t("research.other_database")}</Button>
        </div>
        {custom ? <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={event => {
          event.preventDefault();
          const researchUrl = researchWebsite.safeParse(draft.researchUrl), loginUrl = researchWebsite.safeParse(draft.loginUrl || draft.researchUrl);
          if (!researchUrl.success || !loginUrl.success || !draft.name.trim() || /[\r\n\x00-\x1f]/.test(draft.name)) { setError(t("research.invalid_url")); return; }
          begin([{ name: draft.name.trim(), researchUrl: researchUrl.data, loginUrl: loginUrl.data }]);
        }}>
          <label className="block space-y-2 text-sm">{t("research.name")}<Input required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
          <label className="block space-y-2 text-sm">{t("research.research_url")}<Input required type="url" maxLength={2000} placeholder="https://" value={draft.researchUrl} onChange={event => setDraft({ ...draft, researchUrl: event.currentTarget.value })} /></label>
          <label className="block space-y-2 text-sm">{t("research.login_url")}<Input type="url" maxLength={2000} placeholder={draft.researchUrl || "https://"} value={draft.loginUrl} onChange={event => setDraft({ ...draft, loginUrl: event.currentTarget.value })} /></label>
          <p className="text-xs leading-5 text-muted-foreground">{t("research.login_hint")}</p>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit">{t("research.set_up")}</Button>
        </form> : null}
        {selected.length ? <Button className="w-full" disabled={!installed.data} onClick={() => begin(legalResearchProviders.filter(provider => selected.includes(provider.id)).map(provider => ({ ...provider, providerId: provider.id, needsLoginUrl: !provider.loginUrl })))}>{t("research.configure_selected", { count: selected.length })}</Button> : null}
      </> : null}
      {added.length ? <div role="status" className="rounded-lg bg-muted/40 p-4 text-sm"><p className="flex items-center gap-2 font-medium"><Check className="size-4" />{t("research.saved")}</p><p className="mt-1 text-muted-foreground">{added.join(", ")}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{t("research.saved_hint")}</p></div> : null}
    </>}
  </div>;
  return <OnboardingCover compact footerLeft={current ? null : footerLeft} footerRight={current ? null : footerRight}>{content}</OnboardingCover>;
}
