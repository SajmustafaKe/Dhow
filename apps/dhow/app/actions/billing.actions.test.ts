import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for billing.actions.ts, ahead of the port into
 * apps/dhowx.
 *
 * Every function here guards on `USE_BILLING` first — a module-scope const
 * read from `process.env` at import time — so scenarios that flip it use
 * `vi.resetModules()` + dynamic re-import, same as auth.actions.test.ts.
 *
 * The two things worth pinning hardest:
 *   1. `getCustomer()` is the auth+entitlement gate every other function in
 *      this file routes through (it calls `authCheck()` internally). Any
 *      function that skips it is reachable by an authenticated user with no
 *      billing customer record, or — worse — skips authentication entirely.
 *   2. `getPrices()` is the one exception: when USE_BILLING is true it calls
 *      the billing lib directly with **no auth call at all**, unlike every
 *      sibling in this file. That's pinned explicitly below and flagged in
 *      the report — it's not a DB write, but it is an inconsistency with the
 *      auth discipline the rest of the file follows.
 */

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const lib = {
    authorize: vi.fn(),
    logUsage: vi.fn(),
    getBillingCustomer: vi.fn(),
    createCustomerPortalSession: vi.fn(),
    getPrices: vi.fn(),
    updateSubscriptionPlan: vi.fn(),
    getEligibleModels: vi.fn(),
};
vi.mock("../lib/billing", () => lib);

async function loadWithBilling(useBilling: boolean) {
    vi.resetModules();
    process.env.USE_BILLING = useBilling ? "true" : "false";
    return await import("./billing.actions");
}

const user = { id: "u1", supabaseId: "s1", createdAt: "2024-01-01T00:00:00.000Z", billingCustomerId: "cus_1" };

beforeEach(() => {
    vi.clearAllMocks();
});

describe("getCustomer", () => {
    it("authenticates, then throws if the user has no billingCustomerId — never calls getBillingCustomer", async () => {
        authCheck.mockResolvedValue({ ...user, billingCustomerId: undefined });
        const { getCustomer } = await loadWithBilling(true);

        await expect(getCustomer()).rejects.toThrow("Customer not found");
        expect(lib.getBillingCustomer).not.toHaveBeenCalled();
    });

    it("throws the same 'Customer not found' when the billing API returns null (masks the distinction)", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue(null);
        const { getCustomer } = await loadWithBilling(true);

        await expect(getCustomer()).rejects.toThrow("Customer not found");
        expect(lib.getBillingCustomer).toHaveBeenCalledWith("cus_1");
    });

    it("propagates an authCheck failure without calling the billing API", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { getCustomer } = await loadWithBilling(true);

        await expect(getCustomer()).rejects.toThrow("User not authenticated");
        expect(lib.getBillingCustomer).not.toHaveBeenCalled();
    });

    it("returns the customer on success", async () => {
        authCheck.mockResolvedValue(user);
        const customer = { id: "cus_1" };
        lib.getBillingCustomer.mockResolvedValue(customer);
        const { getCustomer } = await loadWithBilling(true);

        await expect(getCustomer()).resolves.toBe(customer);
    });
});

describe("authorizeUserAction", () => {
    it("USE_BILLING=false: short-circuits to {success:true} without calling authCheck or the billing API", async () => {
        const { authorizeUserAction } = await loadWithBilling(false);

        await expect(authorizeUserAction({ type: "use_credits" } as never)).resolves.toEqual({ success: true });
        expect(authCheck).not.toHaveBeenCalled();
        expect(lib.authorize).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: requires a billing customer, then passes the request through to authorize() by customer id", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue({ id: "cus_1" });
        lib.authorize.mockResolvedValue({ success: false, error: "quota exceeded" });
        const { authorizeUserAction } = await loadWithBilling(true);

        const result = await authorizeUserAction({ type: "use_credits" } as never);

        // Exact pass-through of the billing API's response shape, including
        // the failure case — UI branches on `.success`.
        expect(result).toEqual({ success: false, error: "quota exceeded" });
        expect(lib.authorize).toHaveBeenCalledWith("cus_1", { type: "use_credits" });
    });
});

describe("logUsage", () => {
    it("USE_BILLING=false: no-ops, no auth call", async () => {
        const { logUsage } = await loadWithBilling(false);

        await expect(logUsage({ items: [] } as never)).resolves.toBeUndefined();
        expect(authCheck).not.toHaveBeenCalled();
        expect(lib.logUsage).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: authenticates, forwards to lib.logUsage by customer id, resolves undefined", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue({ id: "cus_1" });
        const { logUsage } = await loadWithBilling(true);
        const request = { items: [{ type: "credits", amount: 5 }] } as never;

        await expect(logUsage(request)).resolves.toBeUndefined();
        expect(lib.logUsage).toHaveBeenCalledWith("cus_1", request);
    });
});

describe("getCustomerPortalUrl", () => {
    it("USE_BILLING=false: throws 'Billing is not enabled' without any auth call", async () => {
        const { getCustomerPortalUrl } = await loadWithBilling(false);

        await expect(getCustomerPortalUrl("https://app/return")).rejects.toThrow("Billing is not enabled");
        expect(authCheck).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: authenticates via getCustomer, then returns the portal URL", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue({ id: "cus_1" });
        lib.createCustomerPortalSession.mockResolvedValue("https://billing/portal/xyz");
        const { getCustomerPortalUrl } = await loadWithBilling(true);

        await expect(getCustomerPortalUrl("https://app/return")).resolves.toBe("https://billing/portal/xyz");
        expect(lib.createCustomerPortalSession).toHaveBeenCalledWith("cus_1", "https://app/return");
    });
});

describe("getPrices — the one action in this file with no auth check", () => {
    it("USE_BILLING=false: throws 'Billing is not enabled'", async () => {
        const { getPrices } = await loadWithBilling(false);

        await expect(getPrices()).rejects.toThrow("Billing is not enabled");
    });

    it("USE_BILLING=true: calls the billing API directly — authCheck is never invoked", async () => {
        const prices = { plans: [{ id: "free", price: 0 }] };
        lib.getPrices.mockResolvedValue(prices);
        const { getPrices } = await loadWithBilling(true);

        await expect(getPrices()).resolves.toBe(prices);
        // TENANT/AUTH FINDING: unlike every other USE_BILLING=true action in
        // this file, getPrices() never calls authCheck() or getCustomer().
        expect(authCheck).not.toHaveBeenCalled();
    });
});

describe("updateSubscriptionPlan", () => {
    it("USE_BILLING=false: throws without an auth call", async () => {
        const { updateSubscriptionPlan } = await loadWithBilling(false);

        await expect(updateSubscriptionPlan("pro" as never, "https://app/return")).rejects.toThrow("Billing is not enabled");
        expect(authCheck).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: authenticates, then sends {plan, returnUrl} to the billing API", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue({ id: "cus_1" });
        lib.updateSubscriptionPlan.mockResolvedValue("https://billing/checkout/xyz");
        const { updateSubscriptionPlan } = await loadWithBilling(true);

        await expect(updateSubscriptionPlan("pro" as never, "https://app/return")).resolves.toBe("https://billing/checkout/xyz");
        expect(lib.updateSubscriptionPlan).toHaveBeenCalledWith("cus_1", { plan: "pro", returnUrl: "https://app/return" });
    });
});

describe("getEligibleModels", () => {
    it("USE_BILLING=false: returns the literal string '*' (not an object, not a list)", async () => {
        const { getEligibleModels } = await loadWithBilling(false);

        await expect(getEligibleModels()).resolves.toBe("*");
        expect(authCheck).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: authenticates, then passes through the billing API's model list", async () => {
        authCheck.mockResolvedValue(user);
        lib.getBillingCustomer.mockResolvedValue({ id: "cus_1" });
        const models = { models: ["gpt-4o"] };
        lib.getEligibleModels.mockResolvedValue(models);
        const { getEligibleModels } = await loadWithBilling(true);

        await expect(getEligibleModels()).resolves.toBe(models);
        expect(lib.getEligibleModels).toHaveBeenCalledWith("cus_1");
    });
});
