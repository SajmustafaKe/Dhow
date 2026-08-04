import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for project.actions.ts, ahead of the port into
 * apps/dhowx.
 *
 * This file is a controller-dispatch layer: almost every export is
 * `authCheck()` then a single `container.resolve(...).execute(...)` call.
 * The wiring itself is the contract worth pinning — which controller key
 * gets resolved, the exact argument shape (`caller: 'user'`, `userId`,
 * `projectId`, ...), and that auth always runs *before* the controller.
 *
 * Two things get deeper treatment:
 *   - `listTemplates()` is the one export in this file that never calls
 *     authCheck at all, yet reaches MongoDB directly via
 *     `MongoDBAssistantTemplatesRepository`. Flagged in the report as a
 *     tenant-boundary finding (see the "no auth check" test below).
 *   - `projectAuthCheck()` is the project-scoped auth gate reused by
 *     twilio.actions.ts and copilot.actions.ts. It has its own USE_AUTH
 *     branch (module-scope constant), so — like auth.actions.test.ts — the
 *     USE_AUTH cases use `vi.resetModules()` + dynamic re-import.
 *
 * `next/navigation`'s `redirect()` is deliberately NOT mocked: it has no I/O
 * (it just throws an Error carrying a `digest` string encoding the
 * destination), so using the real implementation gives a faithful pin of
 * `deleteProject`'s actual behavior — the promise it returns always rejects,
 * even on success, because that's how Next.js server actions signal
 * navigation.
 */

type Controller = { execute: ReturnType<typeof vi.fn>; authorize: ReturnType<typeof vi.fn> };
const controllers: Record<string, Controller> = {};

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((key: string) => {
            controllers[key] ??= { execute: vi.fn(), authorize: vi.fn() };
            return controllers[key];
        }),
    },
}));

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const repoList = vi.fn();
vi.mock("@/src/infrastructure/repositories/mongodb.assistant-templates.repository", () => ({
    MongoDBAssistantTemplatesRepository: vi.fn().mockImplementation(function (this: unknown) {
        return { list: repoList };
    }),
}));

const user = { id: "u1", auth0Id: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./project.actions");
}

describe("listTemplates — NO AUTH CHECK, reaches MongoDB directly", () => {
    it("never calls authCheck, yet queries the templates repository for public library content", async () => {
        repoList.mockResolvedValue({
            items: [
                { id: "t1", name: "Template 1", description: "d1", category: "c1", workflow: { tools: [{ name: "search" }] }, copilotPrompt: "p1" },
            ],
            nextCursor: null,
        });
        const { listTemplates } = await loadActions();

        const result = await listTemplates();

        // TENANT/AUTH FINDING: authCheck is never invoked on this path.
        expect(authCheck).not.toHaveBeenCalled();
        expect(repoList).toHaveBeenCalledWith({ source: "library", isPublic: true }, undefined, 100);
        expect(result).toEqual([
            { id: "t1", name: "Template 1", description: "d1", category: "c1", tools: [{ name: "search" }], copilotPrompt: "p1" },
        ]);
    });

    it("defaults `tools` to an empty array when the item has no workflow", async () => {
        repoList.mockResolvedValue({
            items: [{ id: "t2", name: "T2", description: "d", category: "c", copilotPrompt: undefined }],
            nextCursor: null,
        });
        const { listTemplates } = await loadActions();

        const [item] = await listTemplates();
        expect(item.tools).toEqual([]);
    });
});

describe("projectAuthCheck", () => {
    async function loadWithAuth(useAuth: boolean) {
        vi.resetModules();
        process.env.USE_AUTH = useAuth ? "true" : "false";
        return await import("./project.actions");
    }

    it("USE_AUTH=false: no-ops — never calls authCheck or the authorization policy", async () => {
        const { projectAuthCheck } = await loadWithAuth(false);
        const policy = controllers["projectActionAuthorizationPolicy"];
        policy.authorize = vi.fn();

        await expect(projectAuthCheck("proj_1")).resolves.toBeUndefined();
        expect(authCheck).not.toHaveBeenCalled();
        expect(policy.authorize).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true: authenticates, then authorizes {caller:'user', userId, projectId} against the policy", async () => {
        const { projectAuthCheck } = await loadWithAuth(true);
        const policy = controllers["projectActionAuthorizationPolicy"];
        policy.authorize = vi.fn().mockResolvedValue(undefined);

        await projectAuthCheck("proj_1");

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(policy.authorize).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
        });
    });

    it("USE_AUTH=true: an authCheck failure propagates and the policy is never consulted", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { projectAuthCheck } = await loadWithAuth(true);
        const policy = controllers["projectActionAuthorizationPolicy"];
        policy.authorize = vi.fn();

        await expect(projectAuthCheck("proj_1")).rejects.toThrow("User not authenticated");
        expect(policy.authorize).not.toHaveBeenCalled();
    });

});

describe("createProject", () => {
    function formData(fields: Record<string, string>) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        return fd;
    }

    it("authenticates before building the controller request; missing name/template default to '' and 'default'", async () => {
        const { createProject } = await loadActions();
        controllers["createProjectController"].execute.mockResolvedValue({ id: "proj_1" });

        const result = await createProject(formData({}));

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["createProjectController"].execute).toHaveBeenCalledWith({
            userId: user.id,
            data: { name: "", mode: { template: "default" } },
        });
        expect(result).toEqual({ id: "proj_1" });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { createProject } = await loadActions();

        await expect(createProject(formData({}))).rejects.toThrow("User not authenticated");
        expect(controllers["createProjectController"].execute).not.toHaveBeenCalled();
    });

    it("BillingError from the controller is caught and returned as {billingError}, not thrown", async () => {
        const { BillingError } = await import("@/src/entities/errors/common");
        const { createProject } = await loadActions();
        controllers["createProjectController"].execute.mockRejectedValue(new BillingError("plan limit reached"));

        await expect(createProject(formData({ name: "x" }))).resolves.toEqual({ billingError: "plan limit reached" });
    });

    it("a non-BillingError from the controller rethrows instead of becoming {billingError}", async () => {
        const { createProject } = await loadActions();
        controllers["createProjectController"].execute.mockRejectedValue(new Error("db down"));

        await expect(createProject(formData({ name: "x" }))).rejects.toThrow("db down");
    });
});

describe("createProjectFromWorkflowJson", () => {
    function formData(fields: Record<string, string>) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        return fd;
    }

    it("fills blank agent models with PROVIDER_DEFAULT_MODEL, defaulting to 'gpt-4o' when unset", async () => {
        delete process.env.PROVIDER_DEFAULT_MODEL;
        const { createProjectFromWorkflowJson } = await loadActions();
        controllers["createProjectController"].execute.mockResolvedValue({ id: "proj_1" });
        const workflow = { agents: [{ name: "a1", model: "" }, { name: "a2", model: "gpt-3.5" }] };

        await createProjectFromWorkflowJson(formData({ name: "x", workflowJson: JSON.stringify(workflow) }));

        const call = controllers["createProjectController"].execute.mock.calls[0][0];
        const sentWorkflow = JSON.parse(call.data.mode.workflowJson);
        expect(sentWorkflow.agents[0].model).toBe("gpt-4o");
        expect(sentWorkflow.agents[1].model).toBe("gpt-3.5"); // untouched
    });

    it("malformed workflowJson throws the raw JSON.parse SyntaxError — not wrapped, not a {billingError}", async () => {
        const { createProjectFromWorkflowJson } = await loadActions();

        await expect(
            createProjectFromWorkflowJson(formData({ name: "x", workflowJson: "{not valid json" }))
        ).rejects.toThrow(SyntaxError);
        expect(controllers["createProjectController"].execute).not.toHaveBeenCalled();
    });

    it("BillingError from the controller becomes {billingError}", async () => {
        const { BillingError } = await import("@/src/entities/errors/common");
        const { createProjectFromWorkflowJson } = await loadActions();
        controllers["createProjectController"].execute.mockRejectedValue(new BillingError("no seats"));

        await expect(
            createProjectFromWorkflowJson(formData({ name: "x", workflowJson: JSON.stringify({ agents: [] }) }))
        ).resolves.toEqual({ billingError: "no seats" });
    });
});

describe("fetchProject", () => {
    it("throws 'Project not found' when the controller resolves null/undefined", async () => {
        const { fetchProject } = await loadActions();
        controllers["fetchProjectController"].execute.mockResolvedValue(null);

        await expect(fetchProject("proj_1")).rejects.toThrow("Project not found");
    });

    it("returns the project and passes {caller:'user', userId, projectId}", async () => {
        const { fetchProject } = await loadActions();
        const project = { id: "proj_1", name: "P" };
        controllers["fetchProjectController"].execute.mockResolvedValue(project);

        await expect(fetchProject("proj_1")).resolves.toBe(project);
        expect(controllers["fetchProjectController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
        });
    });
});

describe("listProjects", () => {
    it("pages through the controller until nextCursor is falsy, accumulating items across pages", async () => {
        const { listProjects } = await loadActions();
        controllers["listProjectsController"].execute
            .mockResolvedValueOnce({ items: [{ id: "p1" }], nextCursor: "cursor_2" })
            .mockResolvedValueOnce({ items: [{ id: "p2" }], nextCursor: null });

        const result = await listProjects();

        expect(result).toEqual([{ id: "p1" }, { id: "p2" }]);
        expect(controllers["listProjectsController"].execute).toHaveBeenCalledTimes(2);
        expect(controllers["listProjectsController"].execute).toHaveBeenNthCalledWith(1, { userId: user.id, cursor: undefined });
        expect(controllers["listProjectsController"].execute).toHaveBeenNthCalledWith(2, { userId: user.id, cursor: "cursor_2" });
    });
});

describe("simple authenticated pass-through actions", () => {
    const cases: Array<{
        name: string;
        controllerKey: string;
        call: (fns: Record<string, (...args: unknown[]) => unknown>) => unknown;
        expectedArgs: Record<string, unknown>;
    }> = [
        {
            name: "rotateSecret",
            controllerKey: "rotateSecretController",
            call: (fns) => fns.rotateSecret("proj_1"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1" },
        },
        {
            name: "updateWebhookUrl",
            controllerKey: "updateWebhookUrlController",
            call: (fns) => fns.updateWebhookUrl("proj_1", "https://hook"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", url: "https://hook" },
        },
        {
            name: "createApiKey",
            controllerKey: "createApiKeyController",
            call: (fns) => fns.createApiKey("proj_1"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1" },
        },
        {
            name: "deleteApiKey",
            controllerKey: "deleteApiKeyController",
            call: (fns) => fns.deleteApiKey("proj_1", "key_1"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", id: "key_1" },
        },
        {
            name: "listApiKeys",
            controllerKey: "listApiKeysController",
            call: (fns) => fns.listApiKeys("proj_1"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1" },
        },
        {
            name: "updateProjectName",
            controllerKey: "updateProjectNameController",
            call: (fns) => fns.updateProjectName("proj_1", "New Name"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", name: "New Name" },
        },
        {
            name: "saveWorkflow",
            controllerKey: "updateDraftWorkflowController",
            call: (fns) => fns.saveWorkflow("proj_1", { startAgent: "a" }),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", workflow: { startAgent: "a" } },
        },
        {
            name: "publishWorkflow",
            controllerKey: "updateLiveWorkflowController",
            call: (fns) => fns.publishWorkflow("proj_1", { startAgent: "a" }),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1", workflow: { startAgent: "a" } },
        },
        {
            name: "revertToLiveWorkflow",
            controllerKey: "revertToLiveWorkflowController",
            call: (fns) => fns.revertToLiveWorkflow("proj_1"),
            expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1" },
        },
    ];

    for (const { name, controllerKey, call, expectedArgs } of cases) {
        it(`${name}: authenticates first, then calls ${controllerKey}.execute with the expected shape`, async () => {
            const fns = await loadActions();
            controllers[controllerKey].execute.mockResolvedValue("ok");

            await call(fns as never);

            expect(authCheck).toHaveBeenCalledTimes(1);
            expect(controllers[controllerKey].execute).toHaveBeenCalledWith(expectedArgs);
        });

        it(`${name}: an authCheck failure prevents ${controllerKey}.execute from ever running`, async () => {
            authCheck.mockRejectedValue(new Error("User not authenticated"));
            const fns = await loadActions();

            await expect(call(fns as never)).rejects.toThrow("User not authenticated");
            expect(controllers[controllerKey].execute).not.toHaveBeenCalled();
        });
    }
});

describe("deleteProject", () => {
    it("deletes via the controller, THEN redirects — redirect() throws, so the action's promise always rejects even on success", async () => {
        const { deleteProject } = await loadActions();
        controllers["deleteProjectController"].execute.mockResolvedValue(undefined);

        const rejection = await deleteProject("proj_1").then(
            () => { throw new Error("expected deleteProject to reject via redirect()"); },
            (err) => err
        );

        // Real next/navigation redirect(): throws an Error whose `.digest`
        // encodes the destination. Callers (or Next's own machinery) must
        // read `.digest`, not the message, to detect this is a redirect and
        // not a real failure.
        expect(rejection).toBeInstanceOf(Error);
        expect(rejection.digest).toBe("NEXT_REDIRECT;replace;/projects;307;");
        expect(controllers["deleteProjectController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
        });
    });

    it("an authCheck failure prevents both the delete and the redirect", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { deleteProject } = await loadActions();

        await expect(deleteProject("proj_1")).rejects.toThrow("User not authenticated");
        expect(controllers["deleteProjectController"].execute).not.toHaveBeenCalled();
    });

    it("a controller failure propagates and never reaches redirect()", async () => {
        const { deleteProject } = await loadActions();
        controllers["deleteProjectController"].execute.mockRejectedValue(new Error("db down"));

        const rejection = await deleteProject("proj_1").then(
            () => { throw new Error("expected rejection"); },
            (err) => err
        );
        expect(rejection.message).toBe("db down");
        expect(rejection.digest).toBeUndefined();
    });
});
