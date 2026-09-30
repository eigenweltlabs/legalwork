/** @jsxImportSource react */
import {useState} from "react";
import type {MemberPlanTarget,MemberPlanQuote} from "@legalwork/types/usage-control";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import type {UsageTransport,UsageTextKey} from "./panel";
type Text=(key:UsageTextKey)=>string;
const money=(cents:number)=>new Intl.NumberFormat(undefined,{style:"currency",currency:"EUR"}).format(cents/100);
const fieldClass="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
export function MemberPlanChange({transport,refresh,t,target,invite=false}:{transport:UsageTransport;refresh:()=>Promise<void>;t:Text;target?:MemberPlanTarget;invite?:boolean}){
 const [quote,setQuote]=useState<MemberPlanQuote|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const reset=()=>{setQuote(null);setError("");};
 return <form className="space-y-3" onChange={reset} onSubmit={event=>{
   event.preventDefault();const form=new FormData(event.currentTarget);const plan=form.get("plan")==="pro"?"pro":"plus";
   const actionTarget:MemberPlanTarget=invite?{kind:"invite",email:String(form.get("email")??"").trim().toLowerCase(),plan,role:"org:member"}:target?.kind==="plan"?{...target,plan:target.requestId?target.plan:plan}:target??{kind:"invite",email:"",plan,role:"org:member"};
   setBusy(true);setError("");
   void transport.write({action:"memberChange",target:actionTarget,preview:quote===null,...(quote?{quoteId:quote.quoteId,expectedAmountCents:quote.amountCents}:{})}).then(async result=>{
     if(quote){reset();await refresh();return;}
     if(typeof result!=="object"||result===null||!("quoteId"in result)||typeof result.quoteId!=="string"||!("amountCents"in result)||typeof result.amountCents!=="number"||!("recurringAmountCents"in result)||typeof result.recurringAmountCents!=="number"||!("billingInterval"in result)||(result.billingInterval!=="month"&&result.billingInterval!=="year"))throw new Error("quote");
     setQuote({quoteId:result.quoteId,amountCents:result.amountCents,recurringAmountCents:result.recurringAmountCents,billingInterval:result.billingInterval});
   }).catch(err=>{if(err instanceof Error&&/preview_again|quote_expired/.test(err.message))setQuote(null);setError(t("limits.member_change_error"));}).finally(()=>setBusy(false));
 }}>
  <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
   {invite&&<label className="grid gap-1 text-sm">{t("limits.email")}<Input name="email" type="email" required/></label>}
   {(!target||target.kind==="plan"&&!target.requestId)&&<label className="grid gap-1 text-sm">{t("limits.seat")}<select name="plan" className={fieldClass} defaultValue={target?.kind==="plan"?target.plan:"plus"}><option value="plus">Plus</option><option value="pro">Pro</option></select></label>}
   <Button type="submit">{quote?(invite?t("limits.confirm_invite"):t("limits.confirm_change")):t("limits.preview_purchase")}</Button>
  </fieldset>
  {quote&&<div className="space-y-1 rounded-lg border p-3 text-sm"><p>{t("limits.due_today")}: {money(quote.amountCents)}</p><p>{t("limits.organization_total")}: {money(quote.recurringAmountCents)} {t(quote.billingInterval==="year"?"limits.per_year":"limits.per_month")}</p><p className="text-xs text-muted-foreground">{t("limits.quote_hint")}</p></div>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </form>;
}
