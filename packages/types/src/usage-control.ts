/** Versioned wire contract shared by the platform and LegalWork. Money is EUR cents. */
export type UsageRequestKind = "temporary" | "recurring" | "upgrade";
export type UsageRequestView = {
  id: string;
  userId: string;
  name: string;
  kind: UsageRequestKind;
  amountCents: number;
  approvedCents: number | null;
  reason: string;
  status: string;
  month: string;
  decisionNote: string | null;
  createdAt: string;
};
export type MemberUsageView = {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  plan: "plus" | "pro" | "none";
  allowanceCents: number;
  remainingCents: number;
  baseExtraLimitCents: number;
  extraLimitCents: number;
  extraUsedCents: number;
  extraRemainingCents: number;
  inheritsLimit: boolean;
  resetsAt: string;
  extraResetsAt: string;
  blockedReason: string | null;
};
export type MemberPlanTarget =
  | {
      kind: "invite";
      email: string;
      plan: "plus" | "pro";
      role: "org:member" | "org:admin";
    }
  | {
      kind: "plan";
      userId: string;
      plan: "plus" | "pro" | "none";
      limitCents?: number | null;
      requestId?: string;
      note?: string;
    }
  | { kind: "remove"; userId: string }
  | { kind: "revoke"; invitationId: string };
export type MemberPlanQuote = {
  quoteId: string;
  amountCents: number;
  recurringAmountCents: number;
  billingInterval: "month" | "year";
};
export type UsageControlView = {
  invitations?: {
    id: string;
    email: string;
    role: string;
    plan: "plus" | "pro" | "none";
    createdAt: string;
  }[];
  pendingMemberChanges?: (MemberPlanQuote & { target: MemberPlanTarget })[];
  version: 1;
  enabled: boolean;
  isAdmin: boolean;
  me: MemberUsageView;
  members: MemberUsageView[];
  requests: UsageRequestView[];
  walletCents: number | null;
  orgExtraUsedCents: number | null;
  orgExtraLimitCents: number | null;
  extraEnabled: boolean;
  defaultExtraLimitCents: number;
  seats: { plus: number; pro: number };
  billingInterval: "month" | "year";
};
export type UsageControlAction =
  | { action: "paymentDetails" }
  | { action: "paymentSetup" }
  | {
      action: "topUp";
      operationId: string;
      amountCents: number;
      paymentMethodId: string;
    }
  | { action: "cancelTopUp"; operationId: string }
  | { action: "resumeTopUp"; operationId: string }
  | {
      action: "memberChange";
      target: MemberPlanTarget;
      preview: boolean;
      quoteId?: string;
      expectedAmountCents?: number;
    }
  | { action: "memberRole"; userId: string; role: "org:member" | "org:admin" }
  | {
      action: "request";
      kind: UsageRequestKind;
      amountCents: number;
      reason: string;
    }
  | {
      action: "decide";
      requestId: string;
      approve: boolean;
      amountCents: number;
      note: string;
    }
  | { action: "budget"; userId: string; limitCents: number | null }
  | { action: "seat"; userId: string; plan: "plus" | "pro" | "none" }
  | {
      action: "settings";
      enabled: boolean;
      monthlyLimitCents: number | null;
      defaultLimitCents: number;
    }
  | { action: "checkout"; amountCents: number }
  | {
      action: "purchaseSeats";
      plan: "plus" | "pro";
      quantity: number;
      preview: boolean;
      expectedAmountCents?: number;
      quoteId?: string;
    };

export type SavedCard = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};
export type BillingPaymentDetails = {
  card: SavedCard | null;
  pendingTopUps: { operationId: string; amountCents: number }[];
};
export type TopUpResult =
  | {
      status: "paid" | "canceled" | "failed" | "processing";
      operationId: string;
    }
  | { status: "requires_action"; operationId: string; url: string };
