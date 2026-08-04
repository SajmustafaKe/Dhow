import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for composio.actions.ts, ahead of the port into
 * apps/dhowx. Every export is `authCheck()` then a single controller.execute()
 * call — with one exception, isolated in its own describe block below:
 *
 * `listComposioTriggerTypes` calls `authCheck()` (so it still requires *a*
 * logged-in session) but discards the returned user entirely — the
 * controller call carries only `{toolkitSlug, cursor}`, no `userId` or
 * `caller`. Every sibling function in this file passes `caller: 'user'` and
 * `userId`. Pinned explicitly: this is the one action whose result cannot be
 * scoped to the calling user/project by the controller, because it was never
 * told who's asking.
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
    return await import("./composio.actions");
}

const cases: Array<{
    name: string;
    controllerKey: string;
    call: (fns: Record<string, (...args: unknown[]) => unknown>) => unknown;
    expectedArgs: Record<string, unknown>;
}> = [
    {
        name: "listToolkits",
        controllerKey: "listComposioToolkitsController",
        call: (fns) => fns.listToolkits("proj_1", "cursor_1"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", cursor: "cursor_1" },
    },
    {
        name: "getToolkit",
        controllerKey: "getComposioToolkitController",
        call: (fns) => fns.getToolkit("proj_1", "github"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", toolkitSlug: "github" },
    },
    {
        name: "listTools",
        controllerKey: "listComposioToolsController",
        call: (fns) => fns.listTools("proj_1", "github", "issue", "cursor_1"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", toolkitSlug: "github", searchQuery: "issue", cursor: "cursor_1" },
    },
    {
        name: "createComposioManagedOauth2ConnectedAccount",
        controllerKey: "createComposioManagedConnectedAccountController",
        call: (fns) => fns.createComposioManagedOauth2ConnectedAccount("proj_1", "github", "https://cb"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", toolkitSlug: "github", callbackUrl: "https://cb" },
    },
    {
        name: "createCustomConnectedAccount",
        controllerKey: "createCustomConnectedAccountController",
        call: (fns) =>
            fns.createCustomConnectedAccount("proj_1", {
                toolkitSlug: "github",
                authConfig: { authScheme: "OAUTH2" as never, credentials: {} as never },
                callbackUrl: "https://cb",
            }),
        expectedArgs: {
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            toolkitSlug: "github",
            authConfig: { authScheme: "OAUTH2", credentials: {} },
            callbackUrl: "https://cb",
        },
    },
    {
        name: "syncConnectedAccount",
        controllerKey: "syncConnectedAccountController",
        call: (fns) => fns.syncConnectedAccount("proj_1", "github", "acct_1"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", toolkitSlug: "github", connectedAccountId: "acct_1" },
    },
    {
        name: "createComposioTriggerDeployment",
        controllerKey: "createComposioTriggerDeploymentController",
        call: (fns) => fns.createComposioTriggerDeployment({ projectId: "proj_1", triggerTypeSlug: "GITHUB_ISSUE", connectedAccountId: "acct_1" }),
        // triggerConfig defaults to {} when omitted
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", data: { triggerTypeSlug: "GITHUB_ISSUE", connectedAccountId: "acct_1", triggerConfig: {} } },
    },
    {
        name: "listComposioTriggerDeployments",
        controllerKey: "listComposioTriggerDeploymentsController",
        call: (fns) => fns.listComposioTriggerDeployments({ projectId: "proj_1", cursor: "c1", limit: 10 }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", cursor: "c1", limit: 10 },
    },
    {
        name: "deleteComposioTriggerDeployment",
        controllerKey: "deleteComposioTriggerDeploymentController",
        call: (fns) => fns.deleteComposioTriggerDeployment({ projectId: "proj_1", deploymentId: "dep_1" }),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", deploymentId: "dep_1" },
    },
    {
        name: "fetchComposioTriggerDeployment",
        controllerKey: "fetchComposioTriggerDeploymentController",
        call: (fns) => fns.fetchComposioTriggerDeployment({ deploymentId: "dep_1" }),
        expectedArgs: { caller: "user", userId: user.id, deploymentId: "dep_1" },
    },
];

for (const { name, controllerKey, call, expectedArgs } of cases) {
    describe(name, () => {
        it("authenticates first, then forwards the exact request shape to the controller", async () => {
            const fns = await loadActions();
            controllers[controllerKey].execute.mockResolvedValue("ok");

            await call(fns as never);

            expect(authCheck).toHaveBeenCalledTimes(1);
            expect(controllers[controllerKey].execute).toHaveBeenCalledWith(expectedArgs);
        });

        it("propagates an authCheck failure and never reaches the controller", async () => {
            authCheck.mockRejectedValue(new Error("User not authenticated"));
            const fns = await loadActions();

            await expect(call(fns as never)).rejects.toThrow("User not authenticated");
            expect(controllers[controllerKey].execute).not.toHaveBeenCalled();
        });
    });
}

describe("deleteConnectedAccount", () => {
    it("authenticates, calls the controller, and always returns true — even when the controller resolves a falsy value", async () => {
        const { deleteConnectedAccount } = await loadActions();
        controllers["deleteComposioConnectedAccountController"].execute.mockResolvedValue(undefined);

        await expect(deleteConnectedAccount("proj_1", "github")).resolves.toBe(true);
        expect(controllers["deleteComposioConnectedAccountController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            toolkitSlug: "github",
        });
    });

    it("propagates a controller failure instead of returning true", async () => {
        const { deleteConnectedAccount } = await loadActions();
        controllers["deleteComposioConnectedAccountController"].execute.mockRejectedValue(new Error("not found"));

        await expect(deleteConnectedAccount("proj_1", "github")).rejects.toThrow("not found");
    });
});

describe("listComposioTriggerTypes — auth checked but the user is discarded", () => {
    it("authenticates (a session is required) but forwards only {toolkitSlug, cursor} — no userId, no caller", async () => {
        const { listComposioTriggerTypes } = await loadActions();
        controllers["listComposioTriggerTypesController"].execute.mockResolvedValue({ items: [] });

        await listComposioTriggerTypes("github", "cursor_1");

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["listComposioTriggerTypesController"].execute).toHaveBeenCalledWith({
            toolkitSlug: "github",
            cursor: "cursor_1",
        });
    });

    it("still propagates an authCheck failure — logged-out callers are rejected even though the user is otherwise unused", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { listComposioTriggerTypes } = await loadActions();

        await expect(listComposioTriggerTypes("github")).rejects.toThrow("User not authenticated");
        expect(controllers["listComposioTriggerTypesController"].execute).not.toHaveBeenCalled();
    });
});
