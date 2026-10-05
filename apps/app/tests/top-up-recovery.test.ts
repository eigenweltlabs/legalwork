import { describe, expect, test } from "bun:test";
import { checkConfirmedTopUp } from "../src/react-app/domains/connections/usage-control/usage-recovery";
import { usageLimitFixture } from "../src/react-app/design-system/usage-limit-fixture";

const operationId = "confirmed-payment";
const applied = async () => ({ card: null, pendingTopUps: [] });

describe("confirmed top-up recovery", () => {
  test("waits for the verified credit grant even if old funds are already available", async () => {
    let usageReads = 0;
    const result = await checkConfirmedTopUp(operationId, async () => ({
      card: null, pendingTopUps: [{ operationId, amountCents: 2000 }],
    }), async () => { usageReads++; return usageLimitFixture("pro", true, "eigenwelt").usage; });
    expect(result.status).toBe("checking");
    expect(result.refreshFailed).toBe(false);
    expect(usageReads).toBe(0);
  });

  test("reads the member's allowance after fulfillment, then confirms usable extra credits", async () => {
    const { usage } = usageLimitFixture("pro", true, "eigenwelt");
    usage.me.extraUsedCents = 0;
    usage.me.extraRemainingCents = 2000;
    usage.me.blockedReason = "wallet_empty";
    const order: string[] = [];
    const result = await checkConfirmedTopUp(operationId, async () => {
      order.push("fulfillment");
      usage.me.blockedReason = null;
      return applied();
    }, async () => { order.push("usage"); return usage; });
    expect(order).toEqual(["fulfillment", "usage"]);
    expect(result.status).toBe("ready");
    expect(result.view).toBe(usage);
  });

  test("does not treat funding as raising a personal limit, team cap, or enabling extra usage", async () => {
    const { usage } = usageLimitFixture("sync", true, "eigenwelt");
    usage.walletCents = 2000;
    for (const reason of ["member_limit", "organization_limit", "extra_disabled", "seat_required"]) {
      usage.me.blockedReason = reason;
      const result = await checkConfirmedTopUp(operationId, applied, async () => usage);
      expect(result.status).toBe("blocked");
      expect(result.view?.me.blockedReason).toBe(reason);
    }
  });

  test("a refresh failure remains a confirmed payment awaiting a read, never a payment retry", async () => {
    const unavailable = async (): Promise<never> => { throw new Error("Offline"); };
    const failedDetails = await checkConfirmedTopUp(operationId, unavailable, async () => usageLimitFixture("pro", true, "eigenwelt").usage);
    const failedUsage = await checkConfirmedTopUp(operationId, applied, unavailable);
    expect(failedDetails).toEqual({ status: "checking", view: null, refreshFailed: true });
    expect(failedUsage).toEqual({ status: "checking", view: null, refreshFailed: true });
  });

  test("cannot claim readiness with no available allowance or a disabled usage response", async () => {
    const { usage } = usageLimitFixture("pro", true, "eigenwelt");
    usage.me.blockedReason = null;
    expect((await checkConfirmedTopUp(operationId, applied, async () => usage)).status).toBe("blocked");
    usage.enabled = false;
    expect((await checkConfirmedTopUp(operationId, applied, async () => usage)).status).toBe("checking");
  });
});
