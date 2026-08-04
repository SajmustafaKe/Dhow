import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for copilot.actions.ts, ahead of the port into
 * apps/dhowx.
 *
 * `getCopilotAgentInstructions` is the one action in this directory with a
 * four-step auth/billing gate, and the ORDER is the contract:
 *   projectAuthCheck -> usageQuotaPolicy.assertAndConsumeProjectAction
 *     -> authorizeUserAction({type:'use_credits'})
 *     -> (only if authorized) getEditAgentInstructionsResponse
 *     -> (only if USE_BILLING) logUsage
 * A quota failure must short-circuit before authorizeUserAction; an
 * unauthorized billing response must short-circuit before the copilot call
 * ever runs (and returns a `{billingError}` object, not a throw). Each step
 * is pinned in isolation below.
 *
 * `../lib/billing` is imported only for the real `UsageTracker` class
 * (in-memory array push/flush, no I/O) — left unmocked deliberately, since
 * mocking it would hide whether `usageTracker.flush()` is actually called.
 */

type Controller = { execute: ReturnType<typeof vi.fn> };
const controllers: Record<string, Controller> = {};

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((key: string) => {
            controllers[key] ??= { execute: vi.fn() };
            return controllers[key];
        }),
    },
}));

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const projectAuthCheck = vi.fn();
vi.mock("./project.actions", () => ({ projectAuthCheck }));

const authorizeUserAction = vi.fn();
const logUsage = vi.fn();
vi.mock("./billing.actions", () => ({ authorizeUserAction, logUsage }));

const getEditAgentInstructionsResponse = vi.fn();
vi.mock("../../src/application/lib/copilot/copilot", () => ({ getEditAgentInstructionsResponse }));

const user = { id: "u1", supabaseId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };
const workflow = { startAgent: "a", agents: [], prompts: [], tools: [], lastUpdatedAt: "2024-01-01T00:00:00.000Z" } as never;

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
    projectAuthCheck.mockReset();
    projectAuthCheck.mockResolvedValue(undefined);
    authorizeUserAction.mockReset();
    authorizeUserAction.mockResolvedValue({ success: true });
    logUsage.mockReset();
    getEditAgentInstructionsResponse.mockReset();
    getEditAgentInstructionsResponse.mockResolvedValue("do the thing");
});

async function loadActions() {
    return await import("./copilot.actions");
}

describe("getCopilotResponseStream", () => {
    it("authenticates, then returns {streamId} unwrapped from the controller's {key}", async () => {
        const { getCopilotResponseStream } = await loadActions();
        controllers["createCopilotCachedTurnController"].execute.mockResolvedValue({ key: "stream_key_1" });

        const result = await getCopilotResponseStream("proj_1", [], workflow, null);

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["createCopilotCachedTurnController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            data: { projectId: "proj_1", messages: [], workflow, context: null, dataSources: undefined, triggers: undefined },
        });
        expect(result).toEqual({ streamId: "stream_key_1" });
    });

    it("BillingError from the controller becomes {billingError}, not a throw", async () => {
        const { BillingError } = await import("@/src/entities/errors/common");
        const { getCopilotResponseStream } = await loadActions();
        controllers["createCopilotCachedTurnController"].execute.mockRejectedValue(new BillingError("quota exceeded"));

        await expect(getCopilotResponseStream("proj_1", [], workflow, null)).resolves.toEqual({ billingError: "quota exceeded" });
    });

    it("a non-BillingError rethrows", async () => {
        const { getCopilotResponseStream } = await loadActions();
        controllers["createCopilotCachedTurnController"].execute.mockRejectedValue(new Error("db down"));

        await expect(getCopilotResponseStream("proj_1", [], workflow, null)).rejects.toThrow("db down");
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { getCopilotResponseStream } = await loadActions();

        await expect(getCopilotResponseStream("proj_1", [], workflow, null)).rejects.toThrow("User not authenticated");
        expect(controllers["createCopilotCachedTurnController"].execute).not.toHaveBeenCalled();
    });
});

describe("getCopilotAgentInstructions — ordered auth/billing/quota gate", () => {
    async function loadWithBilling(useBilling: boolean) {
        vi.resetModules();
        process.env.USE_BILLING = useBilling ? "true" : "false";
        return await import("./copilot.actions");
    }

    it("gate order: projectAuthCheck -> quota -> billing authorize -> copilot call", async () => {
        const order: string[] = [];
        projectAuthCheck.mockImplementation(async () => { order.push("projectAuthCheck"); });
        authorizeUserAction.mockImplementation(async () => { order.push("authorize"); return { success: true }; });
        getEditAgentInstructionsResponse.mockImplementation(async () => { order.push("copilot"); return "instructions"; });
        const { getCopilotAgentInstructions } = await loadWithBilling(false);
        const quotaPolicy = controllers["usageQuotaPolicy"];
        quotaPolicy.execute = undefined as never; // policy exposes assertAndConsumeProjectAction, not execute
        (quotaPolicy as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> }).assertAndConsumeProjectAction =
            vi.fn().mockImplementation(async () => { order.push("quota"); });

        await getCopilotAgentInstructions("proj_1", [], workflow, "agent_1");

        expect(order).toEqual(["projectAuthCheck", "quota", "authorize", "copilot"]);
    });

    it("a quota failure short-circuits before billing authorization ever runs", async () => {
        const { getCopilotAgentInstructions } = await loadWithBilling(false);
        const quotaPolicy = controllers["usageQuotaPolicy"] as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> };
        quotaPolicy.assertAndConsumeProjectAction = vi.fn().mockRejectedValue(new Error("quota exceeded"));

        await expect(getCopilotAgentInstructions("proj_1", [], workflow, "agent_1")).rejects.toThrow("quota exceeded");
        expect(authorizeUserAction).not.toHaveBeenCalled();
        expect(getEditAgentInstructionsResponse).not.toHaveBeenCalled();
    });

    it("an unauthorized billing response returns {billingError} and never calls the copilot lib", async () => {
        const { getCopilotAgentInstructions } = await loadWithBilling(false);
        const quotaPolicy = controllers["usageQuotaPolicy"] as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> };
        quotaPolicy.assertAndConsumeProjectAction = vi.fn().mockResolvedValue(undefined);
        authorizeUserAction.mockResolvedValue({ success: false, error: "no credits" });

        const result = await getCopilotAgentInstructions("proj_1", [], workflow, "agent_1");

        expect(result).toEqual({ billingError: "no credits" });
        expect(getEditAgentInstructionsResponse).not.toHaveBeenCalled();
    });

    it("an unauthorized billing response with no error message defaults to 'Billing error'", async () => {
        const { getCopilotAgentInstructions } = await loadWithBilling(false);
        const quotaPolicy = controllers["usageQuotaPolicy"] as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> };
        quotaPolicy.assertAndConsumeProjectAction = vi.fn().mockResolvedValue(undefined);
        authorizeUserAction.mockResolvedValue({ success: false });

        await expect(getCopilotAgentInstructions("proj_1", [], workflow, "agent_1")).resolves.toEqual({ billingError: "Billing error" });
    });

    it("USE_BILLING=false: succeeds without ever calling logUsage", async () => {
        const { getCopilotAgentInstructions } = await loadWithBilling(false);
        const quotaPolicy = controllers["usageQuotaPolicy"] as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> };
        quotaPolicy.assertAndConsumeProjectAction = vi.fn().mockResolvedValue(undefined);

        const result = await getCopilotAgentInstructions("proj_1", [], workflow, "agent_1");

        expect(result).toBe("do the thing");
        expect(logUsage).not.toHaveBeenCalled();
    });

    it("USE_BILLING=true: logs usage with the tracker's flushed items after a successful copilot call", async () => {
        const { getCopilotAgentInstructions } = await loadWithBilling(true);
        const quotaPolicy = controllers["usageQuotaPolicy"] as unknown as { assertAndConsumeProjectAction: ReturnType<typeof vi.fn> };
        quotaPolicy.assertAndConsumeProjectAction = vi.fn().mockResolvedValue(undefined);

        await getCopilotAgentInstructions("proj_1", [], workflow, "agent_1");

        // The tracker instance is created fresh inside the action and never
        // tracked anything in this test (no track() calls), so it flushes
        // empty — but logUsage must still be invoked because USE_BILLING=true.
        expect(logUsage).toHaveBeenCalledWith({ items: [] });
    });

    it("propagates a projectAuthCheck failure before touching quota, billing, or the copilot lib", async () => {
        projectAuthCheck.mockRejectedValue(new Error("not a project member"));
        const { getCopilotAgentInstructions } = await loadWithBilling(false);

        await expect(getCopilotAgentInstructions("proj_1", [], workflow, "agent_1")).rejects.toThrow("not a project member");
        expect(authorizeUserAction).not.toHaveBeenCalled();
        expect(getEditAgentInstructionsResponse).not.toHaveBeenCalled();
    });
});
