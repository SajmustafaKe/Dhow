import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for scheduled-job-rules.actions.ts, ahead of the
 * port into apps/dhowx.
 *
 * Every export is `authCheck()` then a single controller.execute() call with
 * `caller: 'user'` and `userId` mixed into the caller-supplied request. The
 * contract worth pinning is that auth always runs first (an auth failure
 * must never reach the controller) and the exact argument shape passed
 * through — UI code and the controller layer both depend on it, and nothing
 * in the TS types enforces the object literal shape at the call site.
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

const user = { id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./scheduled-job-rules.actions");
}

const cases: Array<{
    name: string;
    controllerKey: string;
    call: (fns: Record<string, (...args: unknown[]) => unknown>) => unknown;
    expectedArgs: Record<string, unknown>;
}> = [
    {
        name: "createScheduledJobRule",
        controllerKey: "createScheduledJobRuleController",
        call: (fns) => fns.createScheduledJobRule({ projectId: "proj_1", input: { messages: [] }, scheduledTime: "2024-06-01T00:00:00.000Z" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", input: { messages: [] }, scheduledTime: "2024-06-01T00:00:00.000Z" },
    },
    {
        name: "listScheduledJobRules",
        controllerKey: "listScheduledJobRulesController",
        call: (fns) => fns.listScheduledJobRules({ projectId: "proj_1", cursor: "c1", limit: 5 }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", cursor: "c1", limit: 5 },
    },
    {
        name: "fetchScheduledJobRule",
        controllerKey: "fetchScheduledJobRuleController",
        call: (fns) => fns.fetchScheduledJobRule({ ruleId: "rule_1" }),
        expectedArgs: { caller: "user", userId: user.id, ruleId: "rule_1" },
    },
    {
        name: "deleteScheduledJobRule",
        controllerKey: "deleteScheduledJobRuleController",
        call: (fns) => fns.deleteScheduledJobRule({ projectId: "proj_1", ruleId: "rule_1" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", ruleId: "rule_1" },
    },
    {
        name: "updateScheduledJobRule",
        controllerKey: "updateScheduledJobRuleController",
        call: (fns) => fns.updateScheduledJobRule({ projectId: "proj_1", ruleId: "rule_1", input: { messages: [] }, scheduledTime: "2024-06-02T00:00:00.000Z" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", ruleId: "rule_1", input: { messages: [] }, scheduledTime: "2024-06-02T00:00:00.000Z" },
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
