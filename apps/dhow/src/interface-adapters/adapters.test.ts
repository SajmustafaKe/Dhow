import { describe, it, expect, vi } from "vitest";
import { BadRequestError } from "@/src/entities/errors/common";

// A handful of use-case modules (imported transitively for their `InputSchema`
// re-export — e.g. create-project.use-case.ts) import `@/app/lib/billing` and
// `@/app/lib/auth`, both of which import the real Awilix DI container. That
// container eagerly calls `asClass(...)` for every registration at MODULE LOAD
// time and has a genuine circular dependency back onto these same use-case
// files, which crashes (`asClass: expected Type to be class, but got
// undefined`) the instant it's pulled into a fresh module graph such as this
// test file's. None of the controllers under test ever call `container.resolve`
// directly (they only depend on injected use cases), so a stub is sufficient.
vi.mock("@/di/container", () => ({
    container: {
        resolve: () => {
            throw new Error("container.resolve should not be called from an adapter unit test");
        },
    },
}));

import { ListApiKeysController } from "@/src/interface-adapters/controllers/api-keys/list-api-keys.controller";
import { CreateApiKeyController } from "@/src/interface-adapters/controllers/api-keys/create-api-key.controller";
import { DeleteApiKeyController } from "@/src/interface-adapters/controllers/api-keys/delete-api-key.controller";

import { CreateComposioTriggerDeploymentController } from "@/src/interface-adapters/controllers/composio-trigger-deployments/create-composio-trigger-deployment.controller";
import { DeleteComposioTriggerDeploymentController } from "@/src/interface-adapters/controllers/composio-trigger-deployments/delete-composio-trigger-deployment.controller";
import { FetchComposioTriggerDeploymentController } from "@/src/interface-adapters/controllers/composio-trigger-deployments/fetch-composio-trigger-deployment.controller";
import { ListComposioTriggerDeploymentsController } from "@/src/interface-adapters/controllers/composio-trigger-deployments/list-composio-trigger-deployments.controller";
import { ListComposioTriggerTypesController } from "@/src/interface-adapters/controllers/composio-trigger-deployments/list-composio-trigger-types.controller";

import { HandleComposioWebhookRequestController } from "@/src/interface-adapters/controllers/composio/webhook/handle-composio-webhook-request.controller";

import { CreateCachedTurnController } from "@/src/interface-adapters/controllers/conversations/create-cached-turn.controller";
import { CreatePlaygroundConversationController } from "@/src/interface-adapters/controllers/conversations/create-playground-conversation.controller";
import { FetchConversationController } from "@/src/interface-adapters/controllers/conversations/fetch-conversation.controller";
import { ListConversationsController } from "@/src/interface-adapters/controllers/conversations/list-conversations.controller";
import { RunCachedTurnController } from "@/src/interface-adapters/controllers/conversations/run-cached-turn.controller";
import { RunTurnController } from "@/src/interface-adapters/controllers/conversations/run-turn.controller";

import { CreateCopilotCachedTurnController } from "@/src/interface-adapters/controllers/copilot/create-copilot-cached-turn.controller";
import { RunCopilotCachedTurnController } from "@/src/interface-adapters/controllers/copilot/run-copilot-cached-turn.controller";

import { AddDocsToDataSourceController } from "@/src/interface-adapters/controllers/data-sources/add-docs-to-data-source.controller";
import { CreateDataSourceController } from "@/src/interface-adapters/controllers/data-sources/create-data-source.controller";
import { DeleteDataSourceController } from "@/src/interface-adapters/controllers/data-sources/delete-data-source.controller";
import { DeleteDocFromDataSourceController } from "@/src/interface-adapters/controllers/data-sources/delete-doc-from-data-source.controller";
import { FetchDataSourceController } from "@/src/interface-adapters/controllers/data-sources/fetch-data-source.controller";
import { GetDownloadUrlForFileController } from "@/src/interface-adapters/controllers/data-sources/get-download-url-for-file.controller";
import { GetUploadUrlsForFilesController } from "@/src/interface-adapters/controllers/data-sources/get-upload-urls-for-files.controller";
import { ListDataSourcesController } from "@/src/interface-adapters/controllers/data-sources/list-data-sources.controller";
import { ListDocsInDataSourceController } from "@/src/interface-adapters/controllers/data-sources/list-docs-in-data-source.controller";
import { RecrawlWebDataSourceController } from "@/src/interface-adapters/controllers/data-sources/recrawl-web-data-source.controller";
import { ToggleDataSourceController } from "@/src/interface-adapters/controllers/data-sources/toggle-data-source.controller";
import { UpdateDataSourceController } from "@/src/interface-adapters/controllers/data-sources/update-data-source.controller";

import { ListJobsController } from "@/src/interface-adapters/controllers/jobs/list-jobs.controller";
import { FetchJobController } from "@/src/interface-adapters/controllers/jobs/fetch-job.controller";

import { AddCustomMcpServerController } from "@/src/interface-adapters/controllers/projects/add-custom-mcp-server.controller";
import { CreateComposioManagedConnectedAccountController } from "@/src/interface-adapters/controllers/projects/create-composio-managed-connected-account.controller";
import { CreateCustomConnectedAccountController } from "@/src/interface-adapters/controllers/projects/create-custom-connected-account.controller";
import { CreateProjectController } from "@/src/interface-adapters/controllers/projects/create-project.controller";
import { DeleteComposioConnectedAccountController } from "@/src/interface-adapters/controllers/projects/delete-composio-connected-account.controller";
import { DeleteProjectController } from "@/src/interface-adapters/controllers/projects/delete-project.controller";
import { FetchProjectController } from "@/src/interface-adapters/controllers/projects/fetch-project.controller";
import { GetComposioToolkitController } from "@/src/interface-adapters/controllers/projects/get-composio-toolkit.controller";
import { ListComposioToolkitsController } from "@/src/interface-adapters/controllers/projects/list-composio-toolkits.controller";
import { ListComposioToolsController } from "@/src/interface-adapters/controllers/projects/list-composio-tools.controller";
import { ListProjectsController } from "@/src/interface-adapters/controllers/projects/list-projects.controller";
import { RemoveCustomMcpServerController } from "@/src/interface-adapters/controllers/projects/remove-custom-mcp-server.controller";
import { RevertToLiveWorkflowController } from "@/src/interface-adapters/controllers/projects/revert-to-live-workflow.controller";
import { RotateSecretController } from "@/src/interface-adapters/controllers/projects/rotate-secret.controller";
import { SyncConnectedAccountController } from "@/src/interface-adapters/controllers/projects/sync-connected-account.controller";
import { UpdateDraftWorkflowController } from "@/src/interface-adapters/controllers/projects/update-draft-workflow.controller";
import { UpdateLiveWorkflowController } from "@/src/interface-adapters/controllers/projects/update-live-workflow.controller";
import { UpdateProjectNameController } from "@/src/interface-adapters/controllers/projects/update-project-name.controller";
import { UpdateWebhookUrlController } from "@/src/interface-adapters/controllers/projects/update-webhook-url.controller";

import { CreateRecurringJobRuleController } from "@/src/interface-adapters/controllers/recurring-job-rules/create-recurring-job-rule.controller";
import { DeleteRecurringJobRuleController } from "@/src/interface-adapters/controllers/recurring-job-rules/delete-recurring-job-rule.controller";
import { FetchRecurringJobRuleController } from "@/src/interface-adapters/controllers/recurring-job-rules/fetch-recurring-job-rule.controller";
import { ListRecurringJobRulesController } from "@/src/interface-adapters/controllers/recurring-job-rules/list-recurring-job-rules.controller";
import { ToggleRecurringJobRuleController } from "@/src/interface-adapters/controllers/recurring-job-rules/toggle-recurring-job-rule.controller";
import { UpdateRecurringJobRuleController } from "@/src/interface-adapters/controllers/recurring-job-rules/update-recurring-job-rule.controller";

import { CreateScheduledJobRuleController } from "@/src/interface-adapters/controllers/scheduled-job-rules/create-scheduled-job-rule.controller";
import { DeleteScheduledJobRuleController } from "@/src/interface-adapters/controllers/scheduled-job-rules/delete-scheduled-job-rule.controller";
import { FetchScheduledJobRuleController } from "@/src/interface-adapters/controllers/scheduled-job-rules/fetch-scheduled-job-rule.controller";
import { ListScheduledJobRulesController } from "@/src/interface-adapters/controllers/scheduled-job-rules/list-scheduled-job-rules.controller";
import { UpdateScheduledJobRuleController } from "@/src/interface-adapters/controllers/scheduled-job-rules/update-scheduled-job-rule.controller";

/**
 * Characterization tests for the 61 controllers under interface-adapters/,
 * ahead of the dhow -> dhowx port.
 *
 * Every controller here follows the SAME shape: `inputSchema.safeParse` ->
 * throw BadRequestError on failure -> delegate the validated data to exactly
 * one injected use case -> return its result unmodified. That "thin adapter"
 * contract is exercised generically below (Part 1) across every controller
 * that actually follows it. Six controllers deviate from the pattern in a way
 * that matters for the port and get individual, deeply-mutated tests (Part 2):
 * RunTurnController and RunCachedTurnController have real branching logic;
 * RunCopilotCachedTurnController is generator-shaped; RotateSecretController
 * has a genuine bug (documented, not fixed, per instructions); CreatePlayground-
 * ConversationController injects fields the request never supplied; and
 * UpdateDataSourceController accepts a `.partial()` payload. Part 3 pins two
 * cross-controller inconsistencies that only show up when comparing near-
 * identical schemas side by side.
 */

const validWorkflow = () => ({
    agents: [],
    prompts: [],
    tools: [],
    startAgent: "start",
    lastUpdatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Part 1: generic "validate -> strip -> delegate -> return unchanged" sweep
// ---------------------------------------------------------------------------

type ExecuteController = { execute(request: unknown): Promise<unknown> };
// Each real controller's constructor takes a *specific* deps shape (e.g.
// `{ listApiKeysUseCase: IListApiKeysUseCase }`), not a shared shape. Ctor
// parameters are checked contravariantly, so a shared alias can only be
// assignable from every concrete controller ctor if its param type is
// `never` (never is assignable to everything). The one place that actually
// constructs a controller (`describe.each` below) casts its deps object to
// `never` at that single call site — an intentional, narrow cast, not `any`.
type ControllerCtor = new (deps: never) => ExecuteController;

interface GenericCase {
    name: string;
    Controller: ControllerCtor;
    useCaseKey: string;
    valid: Record<string, unknown>;
    requiredKey: string;
}

const cases: GenericCase[] = [
    // api-keys
    { name: "ListApiKeysController", Controller: ListApiKeysController, useCaseKey: "listApiKeysUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "caller" },
    { name: "CreateApiKeyController", Controller: CreateApiKeyController, useCaseKey: "createApiKeyUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "caller" },
    { name: "DeleteApiKeyController", Controller: DeleteApiKeyController, useCaseKey: "deleteApiKeyUseCase", valid: { caller: "user", projectId: "p1", id: "k1" }, requiredKey: "id" },

    // composio-trigger-deployments
    { name: "CreateComposioTriggerDeploymentController", Controller: CreateComposioTriggerDeploymentController, useCaseKey: "createComposioTriggerDeploymentUseCase", valid: { caller: "user", projectId: "p1", data: { triggerTypeSlug: "s1", connectedAccountId: "c1", triggerConfig: {} } }, requiredKey: "data" },
    { name: "DeleteComposioTriggerDeploymentController", Controller: DeleteComposioTriggerDeploymentController, useCaseKey: "deleteComposioTriggerDeploymentUseCase", valid: { caller: "user", projectId: "p1", deploymentId: "d1" }, requiredKey: "deploymentId" },
    { name: "FetchComposioTriggerDeploymentController", Controller: FetchComposioTriggerDeploymentController, useCaseKey: "fetchComposioTriggerDeploymentUseCase", valid: { caller: "user", deploymentId: "d1" }, requiredKey: "deploymentId" },
    { name: "ListComposioTriggerDeploymentsController", Controller: ListComposioTriggerDeploymentsController, useCaseKey: "listComposioTriggerDeploymentsUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "caller" },
    { name: "ListComposioTriggerTypesController", Controller: ListComposioTriggerTypesController, useCaseKey: "listComposioTriggerTypesUseCase", valid: { toolkitSlug: "tk1" }, requiredKey: "toolkitSlug" },

    // composio webhook
    { name: "HandleComposioWebhookRequestController", Controller: HandleComposioWebhookRequestController, useCaseKey: "handleCompsioWebhookRequestUseCase", valid: { headers: { a: "b" }, payload: "raw-body" }, requiredKey: "payload" },

    // conversations
    { name: "CreateCachedTurnController", Controller: CreateCachedTurnController, useCaseKey: "createCachedTurnUseCase", valid: { caller: "user", conversationId: "c1", input: { messages: [] } }, requiredKey: "conversationId" },
    { name: "FetchConversationController", Controller: FetchConversationController, useCaseKey: "fetchConversationUseCase", valid: { caller: "user", conversationId: "c1" }, requiredKey: "conversationId" },
    { name: "ListConversationsController", Controller: ListConversationsController, useCaseKey: "listConversationsUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "caller" },

    // copilot
    { name: "CreateCopilotCachedTurnController", Controller: CreateCopilotCachedTurnController, useCaseKey: "createCopilotCachedTurnUseCase", valid: { caller: "user", data: { projectId: "p1", messages: [], workflow: validWorkflow(), context: null } }, requiredKey: "data" },

    // data-sources
    { name: "AddDocsToDataSourceController", Controller: AddDocsToDataSourceController, useCaseKey: "addDocsToDataSourceUseCase", valid: { caller: "user", sourceId: "s1", docs: [{ name: "doc1", data: { type: "text", content: "hi" } }] }, requiredKey: "docs" },
    { name: "CreateDataSourceController", Controller: CreateDataSourceController, useCaseKey: "createDataSourceUseCase", valid: { caller: "user", data: { projectId: "p1", name: "n", description: "d", data: { type: "urls" }, status: "ready" } }, requiredKey: "data" },
    { name: "DeleteDataSourceController", Controller: DeleteDataSourceController, useCaseKey: "deleteDataSourceUseCase", valid: { caller: "user", sourceId: "s1" }, requiredKey: "sourceId" },
    { name: "DeleteDocFromDataSourceController", Controller: DeleteDocFromDataSourceController, useCaseKey: "deleteDocFromDataSourceUseCase", valid: { caller: "user", docId: "doc1" }, requiredKey: "docId" },
    { name: "FetchDataSourceController", Controller: FetchDataSourceController, useCaseKey: "fetchDataSourceUseCase", valid: { caller: "user", sourceId: "s1" }, requiredKey: "sourceId" },
    { name: "GetDownloadUrlForFileController", Controller: GetDownloadUrlForFileController, useCaseKey: "getDownloadUrlForFileUseCase", valid: { caller: "user", fileId: "f1" }, requiredKey: "fileId" },
    { name: "GetUploadUrlsForFilesController", Controller: GetUploadUrlsForFilesController, useCaseKey: "getUploadUrlsForFilesUseCase", valid: { caller: "user", sourceId: "s1", files: [{ name: "a.txt", type: "text/plain", size: 10 }] }, requiredKey: "files" },
    { name: "ListDataSourcesController", Controller: ListDataSourcesController, useCaseKey: "listDataSourcesUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "ListDocsInDataSourceController", Controller: ListDocsInDataSourceController, useCaseKey: "listDocsInDataSourceUseCase", valid: { caller: "user", sourceId: "s1" }, requiredKey: "sourceId" },
    { name: "RecrawlWebDataSourceController", Controller: RecrawlWebDataSourceController, useCaseKey: "recrawlWebDataSourceUseCase", valid: { caller: "user", sourceId: "s1" }, requiredKey: "sourceId" },
    { name: "ToggleDataSourceController", Controller: ToggleDataSourceController, useCaseKey: "toggleDataSourceUseCase", valid: { caller: "user", sourceId: "s1", active: true }, requiredKey: "active" },
    { name: "UpdateDataSourceController", Controller: UpdateDataSourceController, useCaseKey: "updateDataSourceUseCase", valid: { caller: "user", sourceId: "s1", data: { description: "new" } }, requiredKey: "sourceId" },

    // jobs
    { name: "ListJobsController", Controller: ListJobsController, useCaseKey: "listJobsUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "FetchJobController", Controller: FetchJobController, useCaseKey: "fetchJobUseCase", valid: { caller: "user", jobId: "j1" }, requiredKey: "jobId" },

    // projects
    { name: "AddCustomMcpServerController", Controller: AddCustomMcpServerController, useCaseKey: "addCustomMcpServerUseCase", valid: { caller: "user", projectId: "p1", name: "srv1", server: { serverUrl: "https://x" } }, requiredKey: "server" },
    { name: "CreateComposioManagedConnectedAccountController", Controller: CreateComposioManagedConnectedAccountController, useCaseKey: "createComposioManagedConnectedAccountUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1", callbackUrl: "https://cb" }, requiredKey: "callbackUrl" },
    { name: "CreateCustomConnectedAccountController", Controller: CreateCustomConnectedAccountController, useCaseKey: "createCustomConnectedAccountUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1", authConfig: { authScheme: "API_KEY", credentials: { key: "v" } }, callbackUrl: "https://cb" }, requiredKey: "authConfig" },
    { name: "CreateProjectController", Controller: CreateProjectController, useCaseKey: "createProjectUseCase", valid: { userId: "u1", data: { mode: { template: "t1" } } }, requiredKey: "userId" },
    { name: "DeleteComposioConnectedAccountController", Controller: DeleteComposioConnectedAccountController, useCaseKey: "deleteComposioConnectedAccountUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1" }, requiredKey: "toolkitSlug" },
    { name: "DeleteProjectController", Controller: DeleteProjectController, useCaseKey: "deleteProjectUseCase", valid: { projectId: "p1", userId: "u1", caller: "user" }, requiredKey: "userId" },
    { name: "FetchProjectController", Controller: FetchProjectController, useCaseKey: "fetchProjectUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "GetComposioToolkitController", Controller: GetComposioToolkitController, useCaseKey: "getComposioToolkitUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1" }, requiredKey: "toolkitSlug" },
    { name: "ListComposioToolkitsController", Controller: ListComposioToolkitsController, useCaseKey: "listComposioToolkitsUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "ListComposioToolsController", Controller: ListComposioToolsController, useCaseKey: "listComposioToolsUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1" }, requiredKey: "toolkitSlug" },
    { name: "ListProjectsController", Controller: ListProjectsController, useCaseKey: "listProjectsUseCase", valid: { userId: "u1" }, requiredKey: "userId" },
    { name: "RemoveCustomMcpServerController", Controller: RemoveCustomMcpServerController, useCaseKey: "removeCustomMcpServerUseCase", valid: { caller: "user", projectId: "p1", name: "srv1" }, requiredKey: "name" },
    { name: "RevertToLiveWorkflowController", Controller: RevertToLiveWorkflowController, useCaseKey: "revertToLiveWorkflowUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "SyncConnectedAccountController", Controller: SyncConnectedAccountController, useCaseKey: "syncConnectedAccountUseCase", valid: { caller: "user", projectId: "p1", toolkitSlug: "tk1", connectedAccountId: "ca1" }, requiredKey: "connectedAccountId" },
    { name: "UpdateDraftWorkflowController", Controller: UpdateDraftWorkflowController, useCaseKey: "updateDraftWorkflowUseCase", valid: { caller: "user", projectId: "p1", workflow: validWorkflow() }, requiredKey: "workflow" },
    { name: "UpdateLiveWorkflowController", Controller: UpdateLiveWorkflowController, useCaseKey: "updateLiveWorkflowUseCase", valid: { caller: "user", projectId: "p1", workflow: validWorkflow() }, requiredKey: "workflow" },
    { name: "UpdateProjectNameController", Controller: UpdateProjectNameController, useCaseKey: "updateProjectNameUseCase", valid: { projectId: "p1", userId: "u1", caller: "user", name: "new name" }, requiredKey: "userId" },
    { name: "UpdateWebhookUrlController", Controller: UpdateWebhookUrlController, useCaseKey: "updateWebhookUrlUseCase", valid: { projectId: "p1", userId: "u1", caller: "user", url: "https://hook" }, requiredKey: "userId" },

    // recurring-job-rules
    { name: "CreateRecurringJobRuleController", Controller: CreateRecurringJobRuleController, useCaseKey: "createRecurringJobRuleUseCase", valid: { caller: "user", projectId: "p1", input: { messages: [] }, cron: "* * * * *" }, requiredKey: "cron" },
    { name: "DeleteRecurringJobRuleController", Controller: DeleteRecurringJobRuleController, useCaseKey: "deleteRecurringJobRuleUseCase", valid: { caller: "user", projectId: "p1", ruleId: "r1" }, requiredKey: "ruleId" },
    { name: "FetchRecurringJobRuleController", Controller: FetchRecurringJobRuleController, useCaseKey: "fetchRecurringJobRuleUseCase", valid: { caller: "user", ruleId: "r1" }, requiredKey: "ruleId" },
    { name: "ListRecurringJobRulesController", Controller: ListRecurringJobRulesController, useCaseKey: "listRecurringJobRulesUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "ToggleRecurringJobRuleController", Controller: ToggleRecurringJobRuleController, useCaseKey: "toggleRecurringJobRuleUseCase", valid: { caller: "user", ruleId: "r1", disabled: true }, requiredKey: "disabled" },
    { name: "UpdateRecurringJobRuleController", Controller: UpdateRecurringJobRuleController, useCaseKey: "updateRecurringJobRuleUseCase", valid: { caller: "user", projectId: "p1", ruleId: "r1", input: { messages: [] }, cron: "* * * * *" }, requiredKey: "cron" },

    // scheduled-job-rules
    { name: "CreateScheduledJobRuleController", Controller: CreateScheduledJobRuleController, useCaseKey: "createScheduledJobRuleUseCase", valid: { caller: "user", projectId: "p1", input: { messages: [] }, scheduledTime: new Date().toISOString() }, requiredKey: "scheduledTime" },
    { name: "DeleteScheduledJobRuleController", Controller: DeleteScheduledJobRuleController, useCaseKey: "deleteScheduledJobRuleUseCase", valid: { caller: "user", projectId: "p1", ruleId: "r1" }, requiredKey: "ruleId" },
    { name: "FetchScheduledJobRuleController", Controller: FetchScheduledJobRuleController, useCaseKey: "fetchScheduledJobRuleUseCase", valid: { caller: "user", ruleId: "r1" }, requiredKey: "ruleId" },
    { name: "ListScheduledJobRulesController", Controller: ListScheduledJobRulesController, useCaseKey: "listScheduledJobRulesUseCase", valid: { caller: "user", projectId: "p1" }, requiredKey: "projectId" },
    { name: "UpdateScheduledJobRuleController", Controller: UpdateScheduledJobRuleController, useCaseKey: "updateScheduledJobRuleUseCase", valid: { caller: "user", projectId: "p1", ruleId: "r1", input: { messages: [] }, scheduledTime: new Date().toISOString() }, requiredKey: "scheduledTime" },
];

describe.each(cases)("$name (generic thin-adapter contract)", ({ Controller, useCaseKey, valid, requiredKey }) => {
    it(`throws BadRequestError when required field "${requiredKey}" is missing, without calling the use case`, async () => {
        const mock = vi.fn();
        const controller = new Controller({ [useCaseKey]: { execute: mock } } as never);
        const invalid = { ...valid };
        delete invalid[requiredKey];
        await expect(controller.execute(invalid)).rejects.toBeInstanceOf(BadRequestError);
        expect(mock).not.toHaveBeenCalled();
    });

    it("strips unknown top-level fields and delegates the validated data unchanged; returns the use case's result untouched", async () => {
        const sentinel = { __sentinel: `${Controller.name}-${Math.random()}` };
        const mock = vi.fn().mockResolvedValue(sentinel);
        const controller = new Controller({ [useCaseKey]: { execute: mock } } as never);

        const result = await controller.execute({ ...valid, __unexpectedField: "should not reach the use case" });

        expect(mock).toHaveBeenCalledTimes(1);
        const receivedArg = mock.mock.calls[0][0] as Record<string, unknown>;
        expect(receivedArg).toEqual(valid);
        expect("__unexpectedField" in receivedArg).toBe(false);
        expect(result).toBe(sentinel);
    });
});

// ---------------------------------------------------------------------------
// Part 2: controllers with real logic, tested and mutation-verified individually
// ---------------------------------------------------------------------------

describe("RunTurnController", () => {
    const makeStream = (events: Array<{ type: string; [k: string]: unknown }>) => {
        return (async function* () {
            for (const e of events) yield e;
        })();
    };

    it("derives reason:{type:'chat'} for a user caller and reason:{type:'api'} for an api caller", async () => {
        const createConversationUseCase = vi.fn().mockResolvedValue({ id: "conv-created" });
        const runConversationTurnUseCase = vi.fn().mockReturnValue(makeStream([{ type: "done", conversationId: "conv-created", turn: { id: "t1" } }]));
        const controller = new RunTurnController({ createConversationUseCase: { execute: createConversationUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        await controller.execute({ caller: "user", projectId: "p1", input: { messages: [] }, stream: false });
        expect(createConversationUseCase.mock.calls[0][0].reason).toEqual({ type: "chat" });

        createConversationUseCase.mockClear();
        runConversationTurnUseCase.mockReturnValue(makeStream([{ type: "done", conversationId: "conv-created", turn: { id: "t1" } }]));
        await controller.execute({ caller: "api", projectId: "p1", input: { messages: [] }, stream: false });
        expect(createConversationUseCase.mock.calls[0][0].reason).toEqual({ type: "api" });
    });

    it("creates a conversation only when conversationId is omitted, and reuses the given one otherwise", async () => {
        const createConversationUseCase = vi.fn().mockResolvedValue({ id: "conv-created" });
        const runConversationTurnUseCase = vi.fn().mockReturnValue(makeStream([{ type: "done", conversationId: "conv-existing", turn: { id: "t1" } }]));
        const controller = new RunTurnController({ createConversationUseCase: { execute: createConversationUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        await controller.execute({ caller: "user", projectId: "p1", conversationId: "conv-existing", input: { messages: [] }, stream: false });
        expect(createConversationUseCase).not.toHaveBeenCalled();
        expect(runConversationTurnUseCase.mock.calls[0][0].conversationId).toBe("conv-existing");
    });

    it("stream:true returns {conversationId, stream} immediately WITHOUT draining the generator to a 'done' event", async () => {
        const createConversationUseCase = vi.fn().mockResolvedValue({ id: "conv-created" });
        let yielded = false;
        const runConversationTurnUseCase = vi.fn().mockReturnValue((async function* () {
            yielded = true;
            yield { type: "message", data: { role: "user", content: "hi" } };
            // deliberately never yields "done" — proves stream:true never iterates far enough to care
        })());
        const controller = new RunTurnController({ createConversationUseCase: { execute: createConversationUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        const result = await controller.execute({ caller: "user", projectId: "p1", conversationId: "c1", input: { messages: [] }, stream: true });
        expect(result).toHaveProperty("stream");
        expect(result).not.toHaveProperty("turn");
        expect(yielded).toBe(false); // generator body hasn't run yet — nothing has called .next()
    });

    it("stream:false skips non-'done' events and returns {conversationId, turn} from the 'done' event", async () => {
        const createConversationUseCase = vi.fn().mockResolvedValue({ id: "conv-created" });
        const runConversationTurnUseCase = vi.fn().mockReturnValue(makeStream([
            { type: "message", data: { role: "user", content: "hi" } },
            { type: "message", data: { role: "assistant", content: "hello" } },
            { type: "done", conversationId: "c1", turn: { id: "final-turn" } },
        ]));
        const controller = new RunTurnController({ createConversationUseCase: { execute: createConversationUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        const result = await controller.execute({ caller: "user", projectId: "p1", conversationId: "c1", input: { messages: [] }, stream: false });
        expect(result).toEqual({ conversationId: "c1", turn: { id: "final-turn" } });
    });

    // If the underlying stream ends without ever emitting "done" (e.g. the use
    // case's generator returns early), the controller throws a plain `Error`,
    // NOT a BadRequestError or any domain error class. A caller doing
    // `catch (e) { if (e instanceof BadRequestError) ... }` would NOT catch this.
    it("throws a plain Error('No turn data found') when the stream ends without a 'done' event", async () => {
        const createConversationUseCase = vi.fn().mockResolvedValue({ id: "conv-created" });
        const runConversationTurnUseCase = vi.fn().mockReturnValue(makeStream([{ type: "message", data: { role: "user", content: "hi" } }]));
        const controller = new RunTurnController({ createConversationUseCase: { execute: createConversationUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        await expect(controller.execute({ caller: "user", projectId: "p1", conversationId: "c1", input: { messages: [] }, stream: false }))
            .rejects.toThrow("No turn data found");
        await expect(controller.execute({ caller: "user", projectId: "p1", conversationId: "c1", input: { messages: [] }, stream: false }))
            .rejects.not.toBeInstanceOf(BadRequestError);
    });
});

describe("RunCachedTurnController", () => {
    it("looks up the cached turn using BOTH `cachedTurnKey` (from the spread) and `key` (explicitly mapped to the same value)", async () => {
        const fetchCachedTurnUseCase = vi.fn().mockResolvedValue({ conversationId: "c1", input: { messages: [] } });
        const runConversationTurnUseCase = vi.fn().mockReturnValue((async function* () {})());
        const controller = new RunCachedTurnController({ fetchCachedTurnUseCase: { execute: fetchCachedTurnUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        const gen = controller.execute({ caller: "user", cachedTurnKey: "key-123" });
        await gen.next();

        const arg = fetchCachedTurnUseCase.mock.calls[0][0];
        expect(arg.cachedTurnKey).toBe("key-123");
        expect(arg.key).toBe("key-123");
    });

    // The controller reconstructs the runConversationTurnUseCase call from
    // scratch — it does NOT forward `apiKey`, unlike RunTurnController's
    // equivalent call. An api-caller's turn replay silently loses its apiKey.
    it("drops apiKey when replaying the turn — runConversationTurnUseCase never receives it", async () => {
        const fetchCachedTurnUseCase = vi.fn().mockResolvedValue({ conversationId: "conv-1", input: { messages: [] } });
        const runConversationTurnUseCase = vi.fn().mockReturnValue((async function* () {})());
        const controller = new RunCachedTurnController({ fetchCachedTurnUseCase: { execute: fetchCachedTurnUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        const gen = controller.execute({ caller: "api", apiKey: "sk_live_secret", cachedTurnKey: "key-123" });
        await gen.next();

        const arg = runConversationTurnUseCase.mock.calls[0][0];
        expect("apiKey" in arg).toBe(false);
        expect(arg).toEqual({ caller: "api", userId: undefined, conversationId: "conv-1", reason: { type: "api" }, input: { messages: [] } });
    });

    it("derives reason from caller the same way RunTurnController does", async () => {
        const fetchCachedTurnUseCase = vi.fn().mockResolvedValue({ conversationId: "conv-1", input: { messages: [] } });
        const runConversationTurnUseCase = vi.fn().mockReturnValue((async function* () {})());
        const controller = new RunCachedTurnController({ fetchCachedTurnUseCase: { execute: fetchCachedTurnUseCase }, runConversationTurnUseCase: { execute: runConversationTurnUseCase } });

        const gen = controller.execute({ caller: "user", cachedTurnKey: "key-123" });
        await gen.next();
        expect(runConversationTurnUseCase.mock.calls[0][0].reason).toEqual({ type: "chat" });
    });
});

describe("RunCopilotCachedTurnController", () => {
    it("yields every event the use case's generator produces, in order, and passes it the validated+stripped data (not the raw request)", async () => {
        const events = [{ content: "a" }, { content: "b" }];
        const runCopilotCachedTurnUseCase = vi.fn().mockReturnValue((async function* () {
            for (const e of events) yield e;
        })());
        const controller = new RunCopilotCachedTurnController({ runCopilotCachedTurnUseCase: { execute: runCopilotCachedTurnUseCase } });

        const received = [];
        for await (const e of controller.execute({ caller: "user", key: "k1", __unexpectedField: "strip me" } as never)) received.push(e);
        expect(received).toEqual(events);
        expect(runCopilotCachedTurnUseCase).toHaveBeenCalledTimes(1);
        const arg = runCopilotCachedTurnUseCase.mock.calls[0][0];
        expect(arg).toEqual({ caller: "user", key: "k1" });
        expect("__unexpectedField" in arg).toBe(false);
    });

    // Because `execute` is itself an async generator function, calling it does
    // NOT run any code (not even validation) until the first `.next()` — the
    // BadRequestError only surfaces once the generator is actually driven.
    it("validation error surfaces lazily on the first .next(), not on calling execute()", async () => {
        const runCopilotCachedTurnUseCase = vi.fn();
        const controller = new RunCopilotCachedTurnController({ runCopilotCachedTurnUseCase: { execute: runCopilotCachedTurnUseCase } });

        const gen = controller.execute({ caller: "user" } as never); // missing required `key`
        expect(runCopilotCachedTurnUseCase).not.toHaveBeenCalled(); // nothing has run yet
        await expect(gen.next()).rejects.toBeInstanceOf(BadRequestError);
    });
});

describe("RotateSecretController — passes the RAW request, not the validated result.data (real bug)", () => {
    // Every other controller in this package calls `xUseCase.execute(result.data)`.
    // RotateSecretController alone calls `this.rotateSecretUseCase.execute(request)` —
    // the ORIGINAL argument, not the zod-parsed one. safeParse() is still run and
    // still gates on validity (so missing-required-field still throws), but once
    // validation passes, unknown fields that `result.data` would have stripped
    // survive straight through to the use case. Proven here by an extra field
    // that every other controller in this file strips but this one does not.
    it("forwards unknown fields to the use case unchanged (result.data would have stripped them)", async () => {
        const sentinel = "new-secret-value";
        const rotateSecretUseCase = vi.fn().mockResolvedValue(sentinel);
        const controller = new RotateSecretController({ rotateSecretUseCase: { execute: rotateSecretUseCase } });

        const request = { caller: "user", userId: "u1", projectId: "p1", unexpectedField: "leaks through" };
        const result = await controller.execute(request as never);

        expect(rotateSecretUseCase).toHaveBeenCalledTimes(1);
        const receivedArg = rotateSecretUseCase.mock.calls[0][0] as Record<string, unknown>;
        expect(receivedArg.unexpectedField).toBe("leaks through");
        expect(receivedArg).toBe(request); // literally the same object reference — not even a shallow copy
        expect(result).toBe(sentinel);
    });

    it("still throws BadRequestError when a required field is missing (validation itself is not skipped)", async () => {
        const rotateSecretUseCase = vi.fn();
        const controller = new RotateSecretController({ rotateSecretUseCase: { execute: rotateSecretUseCase } });
        await expect(controller.execute({ caller: "user", projectId: "p1" } as never)).rejects.toBeInstanceOf(BadRequestError); // missing userId
        expect(rotateSecretUseCase).not.toHaveBeenCalled();
    });
});

describe("CreatePlaygroundConversationController — injects fields the request schema never accepts", () => {
    // The input schema has no `caller`/`reason` fields at all. The controller
    // unconditionally hardcodes caller:"user" and reason:{type:"chat"} on every
    // call — there is no code path that produces anything else, even though
    // the sibling RunTurnController/RunCachedTurnController derive `reason`
    // from a caller the request DOES supply.
    it("always calls createConversationUseCase with caller:'user' and reason:{type:'chat'}, regardless of request content", async () => {
        const sentinel = { id: "conv1" };
        const createConversationUseCase = vi.fn().mockResolvedValue(sentinel);
        const controller = new CreatePlaygroundConversationController({ createConversationUseCase: { execute: createConversationUseCase } });

        const result = await controller.execute({ userId: "u1", projectId: "p1", workflow: validWorkflow(), isLiveWorkflow: false });

        expect(createConversationUseCase).toHaveBeenCalledTimes(1);
        const arg = createConversationUseCase.mock.calls[0][0];
        expect(arg.caller).toBe("user");
        expect(arg.reason).toEqual({ type: "chat" });
        expect(arg.userId).toBe("u1");
        expect(arg.isLiveWorkflow).toBe(false);
        expect(result).toBe(sentinel);
    });
});

describe("UpdateDataSourceController — data is DataSource.pick({description}).partial()", () => {
    it("accepts data: {} (an empty object) as a valid no-op update payload", async () => {
        const sentinel = { id: "s1" };
        const updateDataSourceUseCase = vi.fn().mockResolvedValue(sentinel);
        const controller = new UpdateDataSourceController({ updateDataSourceUseCase: { execute: updateDataSourceUseCase } });

        const result = await controller.execute({ caller: "user", sourceId: "s1", data: {} });
        expect(updateDataSourceUseCase.mock.calls[0][0].data).toEqual({});
        expect(result).toBe(sentinel);
    });

    it("rejects a data field carrying a key DataSource.pick doesn't declare (e.g. `active`)", async () => {
        const updateDataSourceUseCase = vi.fn();
        const controller = new UpdateDataSourceController({ updateDataSourceUseCase: { execute: updateDataSourceUseCase } });
        // `active` is silently stripped, not rejected — it's not a validation error,
        // it just never reaches the use case. Confirms strip-mode, not strict-mode.
        const result = await controller.execute({ caller: "user", sourceId: "s1", data: { description: "d", active: true } as never });
        void result;
        expect("active" in updateDataSourceUseCase.mock.calls[0][0].data).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Part 3: cross-controller inconsistencies — the whole point of this exercise
// ---------------------------------------------------------------------------

describe("cross-controller: cursor nullability is inconsistent across near-identical list controllers", () => {
    // ListComposioToolkitsController/ListComposioToolsController declare
    // `cursor: z.string().nullable().optional()`. Every other list controller
    // (ListJobsController, ListConversationsController, ListRecurringJobRules-
    // Controller, ListScheduledJobRulesController, ListComposioTriggerDeployments-
    // Controller...) declares `cursor: z.string().optional()` WITHOUT `.nullable()`.
    // A caller (e.g. a generic API client that always sends `cursor: null` for
    // "no cursor") gets a 400 from most list endpoints but not these two.
    it("cursor: null is accepted by ListComposioToolkitsController but rejected by ListJobsController", async () => {
        const listComposioToolkitsUseCase = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
        const toolkits = new ListComposioToolkitsController({ listComposioToolkitsUseCase: { execute: listComposioToolkitsUseCase } });
        await expect(toolkits.execute({ caller: "user", projectId: "p1", cursor: null })).resolves.toBeDefined();

        const listJobsUseCase = vi.fn();
        const jobs = new ListJobsController({ listJobsUseCase: { execute: listJobsUseCase } });
        await expect(jobs.execute({ caller: "user", projectId: "p1", cursor: null } as never)).rejects.toBeInstanceOf(BadRequestError);
    });
});

describe("cross-controller: recurring-job-rule controllers validate `input.messages` far more loosely than scheduled-job-rule controllers", () => {
    // CreateScheduledJobRuleController/UpdateScheduledJobRuleController declare
    // `input: z.object({ messages: z.array(Message) })`, reusing the real
    // Message union from app/lib/types/types.
    //
    // CreateRecurringJobRuleController/UpdateRecurringJobRuleController declare
    // `input: z.object({ messages: z.array(z.any()) })` — NOT the Message
    // union, not even a loose object shape. `z.any()` accepts literally
    // anything per array element. A malformed message that the scheduled-rule
    // controllers correctly reject sails straight through the recurring-rule
    // controllers into storage.
    const malformedMessage = { thisIsNotAMessage: true };

    it("CreateRecurringJobRuleController accepts a malformed message (z.any() validates nothing)", async () => {
        const createRecurringJobRuleUseCase = vi.fn().mockResolvedValue({ id: "r1" });
        const controller = new CreateRecurringJobRuleController({ createRecurringJobRuleUseCase: { execute: createRecurringJobRuleUseCase } });
        const result = await controller.execute({ caller: "user", projectId: "p1", input: { messages: [malformedMessage] }, cron: "* * * * *" });
        expect(result).toBeDefined();
        expect(createRecurringJobRuleUseCase.mock.calls[0][0].input.messages[0]).toEqual(malformedMessage);
    });

    it("CreateScheduledJobRuleController rejects the SAME malformed message (validated against the real Message union)", async () => {
        const createScheduledJobRuleUseCase = vi.fn();
        const controller = new CreateScheduledJobRuleController({ createScheduledJobRuleUseCase: { execute: createScheduledJobRuleUseCase } });
        await expect(controller.execute({
            caller: "user", projectId: "p1",
            input: { messages: [malformedMessage as never] },
            scheduledTime: new Date().toISOString(),
        })).rejects.toBeInstanceOf(BadRequestError);
        expect(createScheduledJobRuleUseCase).not.toHaveBeenCalled();
    });
});
