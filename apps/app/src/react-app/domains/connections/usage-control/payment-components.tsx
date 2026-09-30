/** @jsxImportSource react */
"use client";
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Loader2, Plus, ShieldCheck } from "lucide-react";
import type {
  BillingPaymentDetails,
  SavedCard,
  TopUpResult,
} from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Run, Text, UsageTransport } from "./panel";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const detailsSchema = {
  parse(value: unknown): BillingPaymentDetails {
    if (!record(value) || !Array.isArray(value.pendingTopUps))
      throw new Error("response");
    function parseCard(card: unknown): SavedCard | null {
      if (card === null) return null;
      if (
        !record(card) ||
        typeof card.id !== "string" ||
        typeof card.brand !== "string" ||
        typeof card.last4 !== "string" ||
        typeof card.expMonth !== "number" ||
        typeof card.expYear !== "number"
      )
        throw new Error("response");
      return {
        id: card.id,
        brand: card.brand,
        last4: card.last4,
        expMonth: card.expMonth,
        expYear: card.expYear,
      };
    }
    return {
      card: parseCard(value.card),
      pendingTopUps: value.pendingTopUps.map((item: unknown) => {
        if (
          !record(item) ||
          typeof item.operationId !== "string" ||
          typeof item.amountCents !== "number"
        )
          throw new Error("response");
        return { operationId: item.operationId, amountCents: item.amountCents };
      }),
    };
  },
};
const resultSchema = {
  parse(value: unknown): TopUpResult {
    if (!record(value) || typeof value.operationId !== "string")
      throw new Error("response");
    if (
      value.status === "paid" ||
      value.status === "canceled" ||
      value.status === "failed" ||
      value.status === "processing"
    )
      return { status: value.status, operationId: value.operationId };
    if (value.status === "requires_action" && typeof value.url === "string")
      return {
        status: value.status,
        operationId: value.operationId,
        url: value.url,
      };
    throw new Error("response");
  },
};
const money = (cents: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
type Props = { t: Text; run: Run; busy: boolean; transport: UsageTransport };
function usePaymentDetails(transport: UsageTransport, refreshSignal?: unknown) {
  const [details, setDetails] = useState<BillingPaymentDetails | null>(null),
    [failed, setFailed] = useState(false);
  const reload = useCallback(
    () =>
      transport
        .write({ action: "paymentDetails" })
        .then((value) => {
          setDetails(detailsSchema.parse(value));
          setFailed(false);
        })
        .catch(() => {
          setFailed(true);
        }),
    [transport],
  );
  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);
  return { details, failed, reload };
}
function CardLabel({ card, t }: { card: SavedCard; t: Text }) {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-background">
        <CreditCard className="size-6 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">
          <span className="capitalize">{card.brand}</span> ···· {card.last4}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("limits.card_expires")} {String(card.expMonth).padStart(2, "0")}/
          {card.expYear}
        </p>
      </div>
    </div>
  );
}
function PaymentState({
  failed,
  t,
  reload,
}: {
  failed: boolean;
  t: Text;
  reload: () => Promise<void>;
}) {
  return failed ? (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-muted-foreground">
        {t("limits.payment_load_error")}
      </p>
      <Button variant="outline" onClick={() => void reload()}>
        {t("limits.refresh")}
      </Button>
    </div>
  ) : (
    <p
      role="status"
      className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
      {t("limits.payment_loading")}
    </p>
  );
}
export function PaymentMethods(props: Props & { refreshSignal?: unknown }) {
  const { t, run, busy, transport } = props;
  const { details, failed, reload } = usePaymentDetails(
    transport,
    props.refreshSignal,
  );
  return (
    <div className="max-w-3xl space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-medium">{t("limits.payment_tab")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("limits.payment_description")}
        </p>
      </div>
      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        <div className="p-6">
          {!details ? (
            <PaymentState failed={failed} t={t} reload={reload} />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-5">
              {details.card ? (
                <CardLabel card={details.card} t={t} />
              ) : (
                <p className="text-sm">{t("limits.no_saved_card")}</p>
              )}
              {details.card && (
                <Badge variant="secondary">{t("limits.default_payment")}</Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t bg-muted/20 px-6 py-4">
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {t("limits.payment_update_hint")}
          </p>
          <Button
            variant="outline"
            disabled={busy || !details}
            onClick={() => void run({ action: "paymentSetup" }).catch(() => {})}
          >
            {details?.card ? t("limits.change_card") : t("limits.add_card")}
          </Button>
        </div>
      </Card>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        {t("limits.card_security")}
      </p>
    </div>
  );
}
export function CardTopUp(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!props.busy) setOpen(value);
      }}
    >
      <DialogTrigger render={<Button className="self-start" />}>
        <Plus />
        {props.t("limits.topup")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.t("limits.topup")}</DialogTitle>
          <DialogDescription>{props.t("limits.topup_hint")}</DialogDescription>
        </DialogHeader>
        {open && <TopUpForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}
function TopUpForm({ t, run, busy, transport }: Props) {
  const { details, failed, reload } = usePaymentDetails(transport);
  const [value, setValue] = useState("100"),
    [operationId, setOperationId] = useState(() => crypto.randomUUID()),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<TopUpResult | null>(null);
  async function execute(action: Parameters<Run>[0]) {
    setError("");
    setSubmitted(true);
    try {
      const next = resultSchema.parse(await run(action));
      setResult(next);
      if (next.status === "canceled") {
        setSubmitted(false);
        setOperationId(crypto.randomUUID());
      }
      await reload();
    } catch (err) {
      setError(
        t(
          err instanceof Error && err.message.includes("payment_method_changed")
            ? "limits.payment_changed"
            : "limits.topup_retry_hint",
        ),
      );
      setSubmitted(false);
      await reload();
    }
  }
  if (!details) return <PaymentState failed={failed} t={t} reload={reload} />;
  if (result?.status === "paid")
    return (
      <div role="status" className="space-y-2 rounded-xl bg-muted/40 p-5">
        <p className="font-medium">{t("limits.topup_paid")}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("limits.topup_paid_hint")}
        </p>
      </div>
    );
  if (result?.status === "failed" || result?.status === "processing")
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="text-sm leading-relaxed text-muted-foreground"
        >
          {t(
            result.status === "failed"
              ? "limits.card_declined"
              : "limits.payment_processing",
          )}
        </p>
        <Button
          disabled={busy}
          className="w-full"
          onClick={() =>
            void execute({
              action: "resumeTopUp",
              operationId: result.operationId,
            })
          }
        >
          {t("limits.check_payment")}
        </Button>
        <Button
          disabled={busy}
          variant="outline"
          className="w-full"
          onClick={() =>
            void execute({
              action: "cancelTopUp",
              operationId: result.operationId,
            })
          }
        >
          {t("limits.cancel_topup")}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  if (result?.status === "requires_action")
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("limits.topup_verify_hint")}
        </p>
        <Button
          className="w-full"
          onClick={() => {
            const url = new URL(result.url);
            if (
              url.protocol === "https:" &&
              ["invoice.stripe.com", "hooks.stripe.com"].includes(url.hostname)
            )
              void transport.open(url.toString());
          }}
        >
          {t("limits.complete_payment")}
        </Button>
        <Button
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() =>
            void execute({
              action: "resumeTopUp",
              operationId: result.operationId,
            })
          }
        >
          {t("limits.check_payment")}
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          disabled={busy}
          onClick={() =>
            void execute({
              action: "cancelTopUp",
              operationId: result.operationId,
            })
          }
        >
          {t("limits.cancel_topup")}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t("limits.cancel_topup_hint")}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  if (details.pendingTopUps.length)
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("limits.pending_topup_hint")}
        </p>
        {details.pendingTopUps.map((pending) => (
          <div key={pending.operationId} className="grid gap-2">
            <Button
              disabled={busy}
              className="w-full"
              onClick={() =>
                void execute({
                  action: "resumeTopUp",
                  operationId: pending.operationId,
                })
              }
            >
              {t("limits.resume_topup")} · {money(pending.amountCents)}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void execute({
                  action: "cancelTopUp",
                  operationId: pending.operationId,
                })
              }
            >
              {t("limits.cancel_topup")}
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          {t("limits.cancel_topup_hint")}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const raw = value.trim().replace(",", ".");
        const amountCents = Math.round(Number(raw) * 100);
        if (
          !/^\d+(\.\d{1,2})?$/.test(raw) ||
          amountCents < 2000 ||
          amountCents > 5_000_000
        ) {
          setError(t("limits.invalid_topup"));
          return;
        }
        if (details.card)
          void execute({
            action: "topUp",
            operationId,
            amountCents,
            paymentMethodId: details.card.id,
          });
        else
          void run({ action: "checkout", amountCents }).catch(() =>
            setError(t("limits.action_error")),
          );
      }}
    >
      <fieldset disabled={busy || submitted} className="space-y-4">
        <div className="flex gap-2">
          {[20, 50, 100].map((preset) => (
            <Button
              key={preset}
              type="button"
              variant={value === String(preset) ? "secondary" : "outline"}
              className="flex-1"
              onClick={() => {
                setValue(String(preset));
                setOperationId(crypto.randomUUID());
              }}
            >
              {money(preset * 100)}
            </Button>
          ))}
        </div>
        <label className="grid gap-2 text-sm font-medium">
          {t("limits.topup_amount")}
          <Input
            name="amount"
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setOperationId(crypto.randomUUID());
            }}
            required
          />
        </label>
      </fieldset>
      {details.card ? (
        <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
          <CardLabel card={details.card} t={t} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("limits.saved_card_charge_hint")}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("limits.no_card_checkout")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="w-full">
        <CreditCard />
        {details.card
          ? t("limits.confirm_topup")
          : t("limits.continue_checkout")}
        {details.card &&
          ` · ${money(Math.round(Number(value.replace(",", ".")) * 100) || 0)}`}
      </Button>
      {details.card && !submitted && (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={busy}
          onClick={() => {
            const raw = value.trim().replace(",", ".");
            const amountCents = Math.round(Number(raw) * 100);
            if (
              !/^\d+(\.\d{1,2})?$/.test(raw) ||
              amountCents < 2000 ||
              amountCents > 5_000_000
            ) {
              setError(t("limits.invalid_topup"));
              return;
            }
            void run({ action: "checkout", amountCents }).catch(() =>
              setError(t("limits.action_error")),
            );
          }}
        >
          {t("limits.other_payment")}
        </Button>
      )}
      <p className="text-center text-xs text-muted-foreground">
        {t("limits.card_security")}
      </p>
    </form>
  );
}
