import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for recurring-job-rules.actions.ts, ahead of the
 * port into apps/dhowx. Mirrors scheduled-job-rules.actions.test.ts: every
 * export is `authCheck()` then a single controller.execute() call, and the
 * contract worth pinning is auth-before-work plus the exact argument shape.
 *
 * `toggleRecurringJobRule` is notable: unlike its siblings it takes no
 * `projectId` at all — the controller must resolve project scope from
 * `ruleId` alone. Pinned explicitly below.
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

const user = { id: "u1", auth0Id: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./recurring-job-rules.actions");
}

const cases: Array<{
    name: string;
    controllerKey: string;
    call: (fns: Record<string, (...args: unknown[]) => unknown>) => unknown;
    expectedArgs: Record<string, unknown>;
}> = [
    {
        name: "createRecurringJobRule",
        controllerKey: "createRecurringJobRuleController",
        call: (fns) => fns.createRecurringJobRule({ projectId: "proj_1", input: { messages: [] }, cron: "0 * * * *" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", input: { messages: [] }, cron: "0 * * * *" },
    },
    {
        name: "listRecurringJobRules",
        controllerKey: "listRecurringJobRulesController",
        call: (fns) => fns.listRecurringJobRules({ projectId: "proj_1", cursor: "c1", limit: 5 }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", cursor: "c1", limit: 5 },
    },
    {
        name: "fetchRecurringJobRule",
        controllerKey: "fetchRecurringJobRuleController",
        call: (fns) => fns.fetchRecurringJobRule({ ruleId: "rule_1" }),
        expectedArgs: { caller: "user", userId: user.id, ruleId: "rule_1" },
    },
    {
        name: "toggleRecurringJobRule",
        controllerKey: "toggleRecurringJobRuleController",
        call: (fns) => fns.toggleRecurringJobRule({ ruleId: "rule_1", disabled: true }),
        // No projectId — only rule-scoped identity is forwarded.
        expectedArgs: { caller: "user", userId: user.id, ruleId: "rule_1", disabled: true },
    },
    {
        name: "deleteRecurringJobRule",
        controllerKey: "deleteRecurringJobRuleController",
        call: (fns) => fns.deleteRecurringJobRule({ projectId: "proj_1", ruleId: "rule_1" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", ruleId: "rule_1" },
    },
    {
        name: "updateRecurringJobRule",
        controllerKey: "updateRecurringJobRuleController",
        call: (fns) => fns.updateRecurringJobRule({ projectId: "proj_1", ruleId: "rule_1", input: { messages: [] }, cron: "0 0 * * *" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", ruleId: "rule_1", input: { messages: [] }, cron: "0 0 * * *" },
    },
];

for (const { name, controllerKey, call, expectedArgs } of cases) {
    describe(name, () => {
        it("authenticates first, then forwards the exact request shape to the controller", async () => {
            const fns = await loadActions();
            controllers[controllerKey].execute.mockResolvedValue({ id: "result_1" });

            const result = await call(fns as never);

            expect(authCheck).toHaveBeenCalledTimes(1);
            expect(controllers[controllerKey].execute).toHaveBeenCalledWith(expectedArgs);
            expect(result).toEqual({ id: "result_1" });
        });

        it("propagates an authCheck failure and never reaches the controller", async () => {
            authCheck.mockRejectedValue(new Error("User not authenticated"));
            const fns = await loadActions();

            await expect(call(fns as never)).rejects.toThrow("User not authenticated");
            expect(controllers[controllerKey].execute).not.toHaveBeenCalled();
        });
    });
}
