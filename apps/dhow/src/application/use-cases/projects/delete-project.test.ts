import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeleteProjectUseCase } from "./delete-project.use-case";
import { NotFoundError } from "@/src/entities/errors/common";
import { qdrantClient } from "@/app/lib/qdrant";
import { deleteConnectedAccount } from "@/src/application/lib/composio/composio";

const deleteConnectedAccountMock = vi.mocked(deleteConnectedAccount);
const qdrantDeleteMock = vi.mocked(qdrantClient.delete);

/**
 * Characterization tests for DeleteProjectUseCase, ahead of the port into
 * apps/dhowx.
 *
 * This is the largest orchestration in the use-cases directory: authz, a
 * fetch-or-404, then an UNGUARDED sequential cascade across 9 repositories
 * plus Composio and Qdrant, with no try/catch anywhere. That means the exact
 * ORDER is the entire contract for what survives a partial failure: whatever
 * step throws leaves everything after it undeleted, and everything before it
 * already gone, with no compensation/rollback. A port that reorders steps,
 * or wraps any of them in a "continue on error" try/catch, would silently
 * change what's left behind when deletion fails partway through -- e.g. a
 * project record that still exists but with no members, or a project that's
 * gone but still has data sources.
 *
 * `projectsRepository.delete` must be the LAST call of the whole sequence:
 * everything else being an orphan is recoverable by re-running this
 * use-case (idempotent-ish, deletes are all no-op-safe on empty data), but a
 * project deleted before its children would orphan those children with no
 * way to look them up again via projectId.
 */

vi.mock("@/app/lib/qdrant", () => ({
    qdrantClient: { delete: vi.fn() },
}));

vi.mock("@/src/application/lib/composio/composio", () => ({
    composio: { triggers: { create: vi.fn(), delete: vi.fn() } },
    getTriggersType: vi.fn(),
    deleteConnectedAccount: vi.fn(),
}));

// delete-project.use-case.ts imports this via the relative specifier
// "../../lib/composio/composio", which resolves to the same module as the
// "@/..." absolute path above -- mock both specifiers to be safe.
vi.mock("../../lib/composio/composio", () => ({
    composio: { triggers: { create: vi.fn(), delete: vi.fn() } },
    getTriggersType: vi.fn(),
    deleteConnectedAccount: vi.fn(),
}));

const authorize = vi.fn();
const fetch = vi.fn();
const deleteProject = vi.fn();
const deleteByProjectIdMembers = vi.fn();
const deleteAllApiKeys = vi.fn();
const deleteByProjectIdComposioTriggers = vi.fn();
const deleteByProjectIdConversations = vi.fn();
const deleteByProjectIdJobs = vi.fn();
const deleteByProjectIdRecurringRules = vi.fn();
const deleteByProjectIdScheduledRules = vi.fn();
const deleteByProjectIdDocs = vi.fn();
const deleteByProjectIdSources = vi.fn();

const projectsRepository = { fetch, delete: deleteProject } as never;
const projectMembersRepository = { deleteByProjectId: deleteByProjectIdMembers } as never;
const projectActionAuthorizationPolicy = { authorize } as never;
const apiKeysRepository = { deleteAll: deleteAllApiKeys } as never;
const dataSourceDocsRepository = { deleteByProjectId: deleteByProjectIdDocs } as never;
const dataSourcesRepository = { deleteByProjectId: deleteByProjectIdSources } as never;
const composioTriggerDeploymentsRepository = { deleteByProjectId: deleteByProjectIdComposioTriggers } as never;
const conversationsRepository = { deleteByProjectId: deleteByProjectIdConversations } as never;
const jobsRepository = { deleteByProjectId: deleteByProjectIdJobs } as never;
const recurringJobRulesRepository = { deleteByProjectId: deleteByProjectIdRecurringRules } as never;
const scheduledJobRulesRepository = { deleteByProjectId: deleteByProjectIdScheduledRules } as never;

const makeUseCase = () =>
    new DeleteProjectUseCase({
        projectsRepository,
        projectMembersRepository,
        projectActionAuthorizationPolicy,
        apiKeysRepository,
        dataSourceDocsRepository,
        dataSourcesRepository,
        composioTriggerDeploymentsRepository,
        conversationsRepository,
        jobsRepository,
        recurringJobRulesRepository,
        scheduledJobRulesRepository,
    });

const baseProject = (over: Record<string, unknown> = {}) => ({
    id: "proj_1",
    name: "test project",
    createdAt: "2024-01-01T00:00:00.000Z",
    createdByUserId: "user_1",
    secret: "s3cr3t",
    draftWorkflow: {},
    liveWorkflow: {},
    composioConnectedAccounts: undefined,
    ...over,
});

const baseRequest = (over: Record<string, unknown> = {}) => ({
    projectId: "proj_1",
    userId: "user_1",
    caller: "user" as const,
    ...over,
});

const allDeleteMocks = () => [
    deleteProject,
    deleteByProjectIdMembers,
    deleteAllApiKeys,
    deleteByProjectIdComposioTriggers,
    deleteByProjectIdConversations,
    deleteByProjectIdJobs,
    deleteByProjectIdRecurringRules,
    deleteByProjectIdScheduledRules,
    deleteByProjectIdDocs,
    deleteByProjectIdSources,
];

beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(undefined);
    fetch.mockResolvedValue(baseProject());
    deleteProject.mockResolvedValue(true);
    deleteByProjectIdMembers.mockResolvedValue(undefined);
    deleteAllApiKeys.mockResolvedValue(undefined);
    deleteByProjectIdComposioTriggers.mockResolvedValue(undefined);
    deleteByProjectIdConversations.mockResolvedValue(undefined);
    deleteByProjectIdJobs.mockResolvedValue(undefined);
    deleteByProjectIdRecurringRules.mockResolvedValue(undefined);
    deleteByProjectIdScheduledRules.mockResolvedValue(undefined);
    deleteByProjectIdDocs.mockResolvedValue(undefined);
    deleteByProjectIdSources.mockResolvedValue(undefined);
    deleteConnectedAccountMock.mockResolvedValue({ success: true });
    qdrantDeleteMock.mockResolvedValue({ status: "completed" });
});

describe("DeleteProjectUseCase.execute", () => {
    it("authorizes before fetching the project", async () => {
        const order: string[] = [];
        authorize.mockImplementation(async () => {
            order.push("authorize");
        });
        fetch.mockImplementation(async () => {
            order.push("fetch");
            return baseProject();
        });

        await makeUseCase().execute(baseRequest());

        expect(order[0]).toBe("authorize");
        expect(order[1]).toBe("fetch");
    });

    it("404s when project not found, and none of the 9 deletion calls happen", async () => {
        fetch.mockResolvedValue(null);

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(NotFoundError);

        for (const mock of allDeleteMocks()) {
            expect(mock).not.toHaveBeenCalled();
        }
        expect(deleteConnectedAccount).not.toHaveBeenCalled();
        expect(qdrantClient.delete).not.toHaveBeenCalled();
    });

    it("deletes composio connected accounts before projectMembersRepository.deleteByProjectId", async () => {
        fetch.mockResolvedValue(
            baseProject({
                composioConnectedAccounts: {
                    slack: { id: "acct_1", authConfigId: "cfg_1", status: "ACTIVE", createdAt: "2024-01-01T00:00:00.000Z", lastUpdatedAt: "2024-01-01T00:00:00.000Z" },
                    github: { id: "acct_2", authConfigId: "cfg_2", status: "ACTIVE", createdAt: "2024-01-01T00:00:00.000Z", lastUpdatedAt: "2024-01-01T00:00:00.000Z" },
                },
            }),
        );
        const order: string[] = [];
        deleteConnectedAccountMock.mockImplementation(async (id: string) => {
            order.push(`deleteConnectedAccount:${id}`);
            return { success: true };
        });
        deleteByProjectIdMembers.mockImplementation(async () => {
            order.push("members");
        });

        await makeUseCase().execute(baseRequest());

        expect(deleteConnectedAccount).toHaveBeenCalledTimes(2);
        expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_1");
        expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_2");
        const membersIdx = order.indexOf("members");
        const accountIdxs = order
            .map((entry, i) => (entry.startsWith("deleteConnectedAccount") ? i : -1))
            .filter((i) => i >= 0);
        expect(accountIdxs.length).toBe(2);
        expect(Math.max(...accountIdxs)).toBeLessThan(membersIdx);
    });

    it("undefined composioConnectedAccounts does not throw and calls deleteConnectedAccount zero times", async () => {
        fetch.mockResolvedValue(baseProject({ composioConnectedAccounts: undefined }));

        await expect(makeUseCase().execute(baseRequest())).resolves.toBeUndefined();

        expect(deleteConnectedAccount).not.toHaveBeenCalled();
    });

    it("empty composioConnectedAccounts object does not throw and calls deleteConnectedAccount zero times", async () => {
        fetch.mockResolvedValue(baseProject({ composioConnectedAccounts: {} }));

        await expect(makeUseCase().execute(baseRequest())).resolves.toBeUndefined();

        expect(deleteConnectedAccount).not.toHaveBeenCalled();
    });

    it("runs the full deletion cascade in the exact pinned order, ending with projectsRepository.delete", async () => {
        const order: string[] = [];
        const push = <T = void>(name: string, result?: T) => async () => {
            order.push(name);
            return result as T;
        };
        deleteConnectedAccountMock.mockImplementation(push("deleteConnectedAccount", { success: true }));
        deleteByProjectIdMembers.mockImplementation(push("projectMembersRepository.deleteByProjectId"));
        deleteAllApiKeys.mockImplementation(push("apiKeysRepository.deleteAll"));
        deleteByProjectIdComposioTriggers.mockImplementation(push("composioTriggerDeploymentsRepository.deleteByProjectId"));
        deleteByProjectIdConversations.mockImplementation(push("conversationsRepository.deleteByProjectId"));
        deleteByProjectIdJobs.mockImplementation(push("jobsRepository.deleteByProjectId"));
        deleteByProjectIdRecurringRules.mockImplementation(push("recurringJobRulesRepository.deleteByProjectId"));
        deleteByProjectIdScheduledRules.mockImplementation(push("scheduledJobRulesRepository.deleteByProjectId"));
        deleteByProjectIdDocs.mockImplementation(push("dataSourceDocsRepository.deleteByProjectId"));
        deleteByProjectIdSources.mockImplementation(push("dataSourcesRepository.deleteByProjectId"));
        qdrantDeleteMock.mockImplementation(push("qdrantClient.delete", { status: "completed" as const }));
        deleteProject.mockImplementation(async () => {
            order.push("projectsRepository.delete");
            return true;
        });

        fetch.mockResolvedValue(
            baseProject({
                composioConnectedAccounts: {
                    slack: { id: "acct_1", authConfigId: "cfg_1", status: "ACTIVE", createdAt: "2024-01-01T00:00:00.000Z", lastUpdatedAt: "2024-01-01T00:00:00.000Z" },
                },
            }),
        );

        await makeUseCase().execute(baseRequest());

        expect(order).toEqual([
            "deleteConnectedAccount",
            "projectMembersRepository.deleteByProjectId",
            "apiKeysRepository.deleteAll",
            "composioTriggerDeploymentsRepository.deleteByProjectId",
            "conversationsRepository.deleteByProjectId",
            "jobsRepository.deleteByProjectId",
            "recurringJobRulesRepository.deleteByProjectId",
            "scheduledJobRulesRepository.deleteByProjectId",
            "dataSourceDocsRepository.deleteByProjectId",
            "dataSourcesRepository.deleteByProjectId",
            "qdrantClient.delete",
            "projectsRepository.delete",
        ]);
        expect(order[order.length - 1]).toBe("projectsRepository.delete");
    });

    it("qdrant delete uses the exact filter shape keyed on projectId", async () => {
        await makeUseCase().execute(baseRequest({ projectId: "proj_special" }));

        expect(qdrantClient.delete).toHaveBeenCalledWith("embeddings", {
            filter: {
                must: [{ key: "projectId", match: { value: "proj_special" } }],
            },
        });
    });

    it("if projectMembersRepository.deleteByProjectId rejects, none of steps (3)-(11) run and the project is not deleted", async () => {
        deleteByProjectIdMembers.mockRejectedValue(new Error("members delete failed"));

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow("members delete failed");

        // Step (1), connected accounts, already ran (it's before the failing step).
        // Everything from step (3) onward, including the terminal project
        // delete, must NOT have run -- there is no try/catch anywhere in
        // this method, so a rejection propagates uncaught and halts the
        // cascade exactly where it failed.
        expect(deleteAllApiKeys).not.toHaveBeenCalled();
        expect(deleteByProjectIdComposioTriggers).not.toHaveBeenCalled();
        expect(deleteByProjectIdConversations).not.toHaveBeenCalled();
        expect(deleteByProjectIdJobs).not.toHaveBeenCalled();
        expect(deleteByProjectIdRecurringRules).not.toHaveBeenCalled();
        expect(deleteByProjectIdScheduledRules).not.toHaveBeenCalled();
        expect(deleteByProjectIdDocs).not.toHaveBeenCalled();
        expect(deleteByProjectIdSources).not.toHaveBeenCalled();
        expect(qdrantClient.delete).not.toHaveBeenCalled();
        expect(deleteProject).not.toHaveBeenCalled();
    });

    it("if a connected account delete rejects, the whole Promise.all rejects and no downstream deletion step runs", async () => {
        fetch.mockResolvedValue(
            baseProject({
                composioConnectedAccounts: {
                    slack: { id: "acct_1", authConfigId: "cfg_1", status: "ACTIVE", createdAt: "2024-01-01T00:00:00.000Z", lastUpdatedAt: "2024-01-01T00:00:00.000Z" },
                },
            }),
        );
        deleteConnectedAccountMock.mockRejectedValue(new Error("composio down"));

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow("composio down");

        expect(deleteByProjectIdMembers).not.toHaveBeenCalled();
        expect(deleteProject).not.toHaveBeenCalled();
    });

    it("all deletion calls (except connected accounts) receive the request's projectId", async () => {
        await makeUseCase().execute(baseRequest({ projectId: "proj_44" }));

        expect(deleteByProjectIdMembers).toHaveBeenCalledWith("proj_44");
        expect(deleteAllApiKeys).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdComposioTriggers).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdConversations).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdJobs).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdRecurringRules).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdScheduledRules).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdDocs).toHaveBeenCalledWith("proj_44");
        expect(deleteByProjectIdSources).toHaveBeenCalledWith("proj_44");
        expect(deleteProject).toHaveBeenCalledWith("proj_44");
    });
});
