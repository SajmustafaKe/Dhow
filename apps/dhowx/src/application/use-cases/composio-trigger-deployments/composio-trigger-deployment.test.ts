import { describe, it, expect, vi } from "vitest";
import {
    BadRequestError,
    NotFoundError,
    NotAuthorizedError,
    QuotaExceededError,
} from "@/src/entities/errors/common";
import { CreateComposioTriggerDeploymentUseCase } from "./create-composio-trigger-deployment.use-case";
import { DeleteComposioTriggerDeploymentUseCase } from "./delete-composio-trigger-deployment.use-case";
import { composio, getTriggersType } from "@/src/application/lib/composio/composio";
import { z } from "zod";
import { ComposioConnectedAccount } from "@/src/entities/models/project";

/**
 * Characterization tests for the Composio trigger deployment create/delete
 * use-cases, ahead of the port into apps/dhowx.
 *
 * Two hazards dominate this pair:
 *
 * 1. Create spends the project's action quota BEFORE any of its own
 *    validation (trigger-type lookup, connected-account match, duplicate
 *    check) runs. A request that ultimately fails with a 400 still consumes
 *    quota — a silent-cost bug if a port moves the quota call "down" next to
 *    the actual mutation because that reads more natural in isolation.
 *
 * 2. Delete reports a deployment that doesn't exist and a deployment that
 *    belongs to someone else's project through the exact same NotFoundError
 *    and message — an intentional info-leak-avoidance pattern (never confirm
 *    "yes, that id exists, just not for you"). A port that "fixes" the
 *    wrong-project case into a 403/NotAuthorizedError silently changes an
 *    authorization posture, not just an implementation detail.
 *
 * Delete also calls the external composio.triggers.delete with the
 * deployment's *external* triggerId, never its own internal deploymentId —
 * fixtures below use visibly distinct id shapes so an inverted port fails
 * loud instead of "working" against a coincidentally-matching test id.
 *
 * The relative import `../../lib/composio/composio` used by both source
 * files resolves to the same module as the `@/src/application/lib/...`
 * absolute specifier mocked below; Vite's resolver dedupes them.
 */

vi.mock("@/src/application/lib/composio/composio", () => ({
    composio: { triggers: { create: vi.fn(), delete: vi.fn() } },
    getTriggersType: vi.fn(),
    deleteConnectedAccount: vi.fn(),
}));

/** Awaits a promise expected to reject and returns the caught error, so a
 * single invocation can be asserted on (instanceof + message + call counts)
 * without re-running side-effecting mocks a second time. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error("expected the promise to reject");
}

describe("CreateComposioTriggerDeploymentUseCase", () => {
    const projectId = "proj_1";
    const toolkitSlug = "gmail";
    const triggerTypeSlug = "gmail_new_email";
    const connectedAccountId = "acc_123";
    const triggerConfig = { labelIds: ["INBOX"] };

    const triggerType = {
        name: "New Email",
        toolkit: { slug: toolkitSlug, logo: "https://logo.example/gmail.png" },
    };

    const baseProject = {
        id: projectId,
        name: "Test Project",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdByUserId: "u1",
        secret: "shh",
        draftWorkflow: {},
        liveWorkflow: {},
        composioConnectedAccounts: {
            [toolkitSlug]: {
                id: connectedAccountId,
                authConfigId: "authcfg_1",
                status: "ACTIVE" as const,
                createdAt: "2025-01-01T00:00:00.000Z",
                lastUpdatedAt: "2025-01-01T00:00:00.000Z",
            },
        } as Record<string, z.infer<typeof ComposioConnectedAccount>>,
    };

    const request = {
        caller: "user" as const,
        userId: "u1",
        projectId,
        data: { triggerTypeSlug, connectedAccountId, triggerConfig },
    };

    function makeDeps() {
        const order: string[] = [];
        const authPolicy = { authorize: vi.fn(async () => { order.push("authorize"); }) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn(async () => { order.push("quota"); }),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const projectsRepository = {
            fetch: vi.fn<() => Promise<typeof baseProject | null>>(async () => { order.push("projects.fetch"); return baseProject; }),
        };
        const composioTriggerDeploymentsRepository = {
            fetchBySlugAndConnectedAccountId: vi.fn(async () => { order.push("fetchBySlugAndConnectedAccountId"); return null; }),
            create: vi.fn(async (data: unknown) => {
                order.push("repo.create");
                return { id: "dep_1", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", ...(data as object) };
            }),
        };
        return { order, authPolicy, quotaPolicy, projectsRepository, composioTriggerDeploymentsRepository };
    }

    /** Wires the shared composio module mocks fresh, pushing onto the given
     * order array; must be called per-test since `restoreMocks: true` strips
     * any previously-set mockImplementation before each test. */
    function configureComposio(
        order: string[],
        opts: { triggerType?: typeof triggerType; createResult?: { triggerId: string } } = {},
    ) {
        vi.mocked(getTriggersType).mockImplementation((async () => {
            order.push("getTriggersType");
            return opts.triggerType ?? triggerType;
        }) as never);
        vi.mocked(composio.triggers.create).mockImplementation(async () => {
            order.push("composio.triggers.create");
            return opts.createResult ?? { triggerId: "composio_trg_999" };
        });
    }

    it("runs authz -> quota -> trigger-type lookup -> project fetch -> duplicate check -> composio create -> repo create, in that order", async () => {
        const deps = makeDeps();
        configureComposio(deps.order);
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const result = await uc.execute(request);

        expect(deps.order).toEqual([
            "authorize",
            "quota",
            "getTriggersType",
            "projects.fetch",
            "fetchBySlugAndConnectedAccountId",
            "composio.triggers.create",
            "repo.create",
        ]);
        expect(getTriggersType).toHaveBeenCalledWith(triggerTypeSlug);
        expect(deps.projectsRepository.fetch).toHaveBeenCalledWith(projectId);
        expect(deps.composioTriggerDeploymentsRepository.fetchBySlugAndConnectedAccountId)
            .toHaveBeenCalledWith(triggerTypeSlug, connectedAccountId);
        expect(composio.triggers.create).toHaveBeenCalledWith(projectId, triggerTypeSlug, {
            connectedAccountId,
            triggerConfig,
        });
        expect(deps.composioTriggerDeploymentsRepository.create).toHaveBeenCalledWith({
            projectId,
            toolkitSlug,
            logo: triggerType.toolkit.logo,
            triggerId: "composio_trg_999",
            connectedAccountId,
            triggerTypeSlug,
            triggerTypeName: triggerType.name,
            triggerConfig,
        });
        expect(result.triggerId).toBe("composio_trg_999");
        expect(result.toolkitSlug).toBe(toolkitSlug);
    });

    it("throws BadRequestError('Invalid connected account') when the toolkit has no connected account at all — quota already consumed, composio never called", async () => {
        const deps = makeDeps();
        configureComposio(deps.order);
        deps.projectsRepository.fetch.mockResolvedValue({ ...baseProject, composioConnectedAccounts: {} });
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Invalid connected account");
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledTimes(1);
        expect(deps.composioTriggerDeploymentsRepository.fetchBySlugAndConnectedAccountId).not.toHaveBeenCalled();
        expect(composio.triggers.create).not.toHaveBeenCalled();
    });

    it("throws BadRequestError('Invalid connected account') when the connected account exists but its id does not match the request — quota already consumed", async () => {
        const deps = makeDeps();
        configureComposio(deps.order);
        deps.projectsRepository.fetch.mockResolvedValue({
            ...baseProject,
            composioConnectedAccounts: {
                [toolkitSlug]: { ...baseProject.composioConnectedAccounts[toolkitSlug], id: "some-other-account" },
            },
        });
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Invalid connected account");
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledTimes(1);
        expect(composio.triggers.create).not.toHaveBeenCalled();
    });

    it("throws BadRequestError('Trigger deployment already exists') when a deployment already exists for this slug + connected account", async () => {
        const deps = makeDeps();
        configureComposio(deps.order);
        deps.composioTriggerDeploymentsRepository.fetchBySlugAndConnectedAccountId.mockResolvedValue({
            id: "dep_existing",
        } as never);
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Trigger deployment already exists");
        expect(composio.triggers.create).not.toHaveBeenCalled();
        expect(deps.composioTriggerDeploymentsRepository.create).not.toHaveBeenCalled();
    });

    it("throws NotFoundError('Project not found') when the project does not exist — quota was already consumed and the trigger type was already looked up", async () => {
        const deps = makeDeps();
        configureComposio(deps.order);
        deps.projectsRepository.fetch.mockResolvedValue(null);
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe("Project not found");
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledTimes(1);
        expect(getTriggersType).toHaveBeenCalledTimes(1);
    });

    it("does not consume quota when authz rejects", async () => {
        const deps = makeDeps();
        deps.authPolicy.authorize.mockRejectedValue(new NotAuthorizedError("nope"));
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(NotAuthorizedError);
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).not.toHaveBeenCalled();
        expect(getTriggersType).not.toHaveBeenCalled();
    });

    it("propagates QuotaExceededError before the trigger-type lookup ever runs", async () => {
        const deps = makeDeps();
        deps.quotaPolicy.assertAndConsumeProjectAction.mockRejectedValue(new QuotaExceededError("over quota"));
        const uc = new CreateComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(QuotaExceededError);
        expect(getTriggersType).not.toHaveBeenCalled();
        expect(deps.projectsRepository.fetch).not.toHaveBeenCalled();
    });
});

describe("DeleteComposioTriggerDeploymentUseCase", () => {
    const projectId = "proj_1";
    const deploymentId = "dep_1"; // internal id
    const externalTriggerId = "composio_trg_ext_999"; // composio's own id — deliberately distinct shape

    const deployment = {
        id: deploymentId,
        projectId,
        triggerId: externalTriggerId,
        toolkitSlug: "gmail",
        triggerTypeSlug: "gmail_new_email",
        triggerTypeName: "New Email",
        connectedAccountId: "acc_1",
        triggerConfig: {},
        logo: "logo.png",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const request = { caller: "user" as const, userId: "u1", projectId, deploymentId };

    function makeDeps() {
        const order: string[] = [];
        const authPolicy = { authorize: vi.fn(async () => { order.push("authorize"); }) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn(async () => { order.push("quota"); }),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const composioTriggerDeploymentsRepository = {
            fetch: vi.fn<() => Promise<typeof deployment | null>>(async () => { order.push("repo.fetch"); return deployment; }),
            delete: vi.fn(async () => { order.push("repo.delete"); return true; }),
        };
        const projectsRepository = { fetch: vi.fn() };
        vi.mocked(composio.triggers.delete).mockResolvedValue(undefined as never);
        return { order, authPolicy, quotaPolicy, composioTriggerDeploymentsRepository, projectsRepository };
    }

    it("runs authz -> quota -> fetch -> composio delete(triggerId) -> repo delete(deploymentId), returning the repo's result", async () => {
        const deps = makeDeps();
        vi.mocked(composio.triggers.delete).mockImplementation((async () => {
            deps.order.push("composio.triggers.delete");
        }) as never);
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const result = await uc.execute(request);

        expect(deps.order).toEqual(["authorize", "quota", "repo.fetch", "composio.triggers.delete", "repo.delete"]);
        // The load-bearing pin: composio gets the deployment's EXTERNAL
        // triggerId, never the internal deploymentId used to look it up.
        expect(composio.triggers.delete).toHaveBeenCalledWith(externalTriggerId);
        expect(composio.triggers.delete).not.toHaveBeenCalledWith(deploymentId);
        expect(deps.composioTriggerDeploymentsRepository.delete).toHaveBeenCalledWith(deploymentId);
        expect(deps.composioTriggerDeploymentsRepository.delete).not.toHaveBeenCalledWith(externalTriggerId);
        expect(result).toBe(true);
    });

    it("propagates the repository's delete result even when it resolves false", async () => {
        const deps = makeDeps();
        deps.composioTriggerDeploymentsRepository.delete.mockResolvedValue(false);
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        await expect(uc.execute(request)).resolves.toBe(false);
    });

    it("throws NotFoundError('Deployment not found') when the deployment does not exist — quota already consumed, composio never called", async () => {
        const deps = makeDeps();
        deps.composioTriggerDeploymentsRepository.fetch.mockResolvedValue(null);
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe("Deployment not found");
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledTimes(1);
        expect(composio.triggers.delete).not.toHaveBeenCalled();
        expect(deps.composioTriggerDeploymentsRepository.delete).not.toHaveBeenCalled();
    });

    it("throws the exact same NotFoundError (not a 403) when the deployment belongs to a different project", async () => {
        const deps = makeDeps();
        deps.composioTriggerDeploymentsRepository.fetch.mockResolvedValue({
            ...deployment,
            projectId: "someone-elses-project",
        });
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).not.toBeInstanceOf(NotAuthorizedError);
        expect((err as Error).message).toBe("Deployment not found");
        expect(composio.triggers.delete).not.toHaveBeenCalled();
    });

    it("does not consume quota when authz rejects", async () => {
        const deps = makeDeps();
        deps.authPolicy.authorize.mockRejectedValue(new NotAuthorizedError("nope"));
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(NotAuthorizedError);
        expect(deps.quotaPolicy.assertAndConsumeProjectAction).not.toHaveBeenCalled();
        expect(deps.composioTriggerDeploymentsRepository.fetch).not.toHaveBeenCalled();
    });

    it("propagates QuotaExceededError before ever fetching the deployment", async () => {
        const deps = makeDeps();
        deps.quotaPolicy.assertAndConsumeProjectAction.mockRejectedValue(new QuotaExceededError("over quota"));
        const uc = new DeleteComposioTriggerDeploymentUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository as never,
            projectsRepository: deps.projectsRepository as never,
            usageQuotaPolicy: deps.quotaPolicy as never,
            projectActionAuthorizationPolicy: deps.authPolicy as never,
        });

        const err = await captureRejection(uc.execute(request));

        expect(err).toBeInstanceOf(QuotaExceededError);
        expect(deps.composioTriggerDeploymentsRepository.fetch).not.toHaveBeenCalled();
    });
});
