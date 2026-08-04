import { describe, it, expect, vi, beforeEach, afterEach, type Mocked } from "vitest";
import { createHmac } from "crypto";
import type { IComposioTriggerDeploymentsRepository } from "@/src/application/repositories/composio-trigger-deployments.repository.interface";
import type { IJobsRepository } from "@/src/application/repositories/jobs.repository.interface";
import type { IProjectsRepository } from "@/src/application/repositories/projects.repository.interface";
import type { IPubSubService } from "@/src/application/services/pub-sub.service.interface";

/**
 * Characterization tests for HandleCompsioWebhookRequestUseCase (class name
 * misspelled "Compsio" in source — kept verbatim), ahead of the port into
 * apps/dhowx.
 *
 * Three hazards dominate this file:
 *
 * 1. Signature verification is hand-rolled HMAC-SHA256 over headers that are
 *    looked up case-insensitively (Composio's webhook sender is not
 *    guaranteed to normalize casing). A port that reads headers with a plain
 *    `headers["webhook-id"]` instead of the lowercased map silently starts
 *    rejecting legitimate requests.
 *
 * 2. `USE_BILLING` is a module-scope constant frozen at import time
 *    (`@/app/lib/feature_flags`), so both branches are exercised here via
 *    the env-before-dynamic-import pattern: `vi.resetModules()` + set the
 *    env var + `await import(...)` the use-case module fresh, per test. A
 *    static top-level import can only ever observe one value of the flag,
 *    which is why `loadWithBilling` below re-imports on demand instead —
 *    it also re-imports the errors module, because `vi.resetModules()`
 *    creates a fresh module instance of `@/src/entities/errors/common` too,
 *    and `instanceof` against a statically-imported class would silently
 *    fail against errors thrown by the freshly re-imported use-case.
 *
 * 3. When USE_BILLING is on, `logUsage` (which bills the customer) runs
 *    BEFORE the project/live-workflow check. A webhook for a deployment
 *    whose project has no live workflow gets billed and then throws
 *    `BadRequestError` — no job is ever created. That is real, observed
 *    behavior, not a bug this suite fixes; a port "cleaning up" the order
 *    changes what customers get charged for.
 */

process.env.COMPOSIO_TRIGGERS_WEBHOOK_SECRET = "test";

vi.mock("@/app/lib/billing", () => ({
    authorize: vi.fn(),
    logUsage: vi.fn(),
    getCustomerIdForProject: vi.fn(),
    UsageTracker: class { track = vi.fn(); flush = vi.fn(() => []); },
}));

/** Resets the module registry, sets USE_BILLING for the target branch, and
 * re-imports the use-case + billing + errors modules fresh so the
 * module-scope USE_BILLING constant (and WEBHOOK_SECRET) are recomputed
 * against the new env, and thrown errors are `instanceof`-compatible with
 * the classes returned here. Returns properly-typed mock handles via
 * `vi.mocked` — no `any`. */
async function loadWithBilling(useBilling: boolean) {
    vi.resetModules();
    if (useBilling) {
        process.env.USE_BILLING = "true";
    } else {
        delete process.env.USE_BILLING;
        delete process.env.NEXT_PUBLIC_USE_BILLING;
    }
    // Dynamic imports are required here: USE_BILLING is frozen at module
    // import time, and both true/false branches must be observed in one file.
    const { HandleCompsioWebhookRequestUseCase } = await import("./handle-composio-webhook-request.use-case");
    const { BadRequestError, BillingError, NotFoundError } = await import("@/src/entities/errors/common");
    const billingModule = await import("@/app/lib/billing");
    return {
        HandleCompsioWebhookRequestUseCase,
        BadRequestError,
        BillingError,
        NotFoundError,
        authorize: vi.mocked(billingModule.authorize),
        logUsage: vi.mocked(billingModule.logUsage),
        getCustomerIdForProject: vi.mocked(billingModule.getCustomerIdForProject),
    };
}

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

const WEBHOOK_ID = "wh_1";
const WEBHOOK_TIMESTAMP = "1754444983";

function sign(webhookId: string, webhookTimestamp: string, payload: string, secret = "test"): string {
    const digest = createHmac("sha256", secret).update(`${webhookId}.${webhookTimestamp}.${payload}`).digest("base64");
    return `v1,${digest}`;
}

function makeRequest(
    payload: string,
    overrides: {
        webhookId?: string;
        timestamp?: string;
        signature?: string;
        secret?: string;
        headerCase?: "lower" | "mixed";
        omit?: string[];
    } = {},
) {
    const webhookId = overrides.webhookId ?? WEBHOOK_ID;
    const webhookTimestamp = overrides.timestamp ?? WEBHOOK_TIMESTAMP;
    const signature = overrides.signature ?? sign(webhookId, webhookTimestamp, payload, overrides.secret);
    const headers: Record<string, string> = overrides.headerCase === "mixed"
        ? { "Webhook-Id": webhookId, "Webhook-Timestamp": webhookTimestamp, "Webhook-Signature": signature }
        : { "webhook-id": webhookId, "webhook-timestamp": webhookTimestamp, "webhook-signature": signature };
    for (const key of overrides.omit ?? []) {
        delete headers[key];
    }
    return { headers, payload };
}

// Trigger id in the event payload — deliberately distinct from the
// deployment's own `triggerId` fixture value below, so a job's
// `reason.triggerId` field being sourced from the wrong place is caught.
const validEvent = {
    type: "slack_receive_message",
    timestamp: "2025-08-06T01:49:46.008Z",
    data: {
        trigger_nano_id: "ti_dU7LJMfP5KSr",
        channel: "C08PTQKM2DS",
    },
};
const validPayload = JSON.stringify(validEvent);

const deployment = {
    id: "dep_1",
    projectId: "proj_1",
    triggerId: "composio_trg_ext_999", // composio's own external id — distinct from trigger_nano_id above
    toolkitSlug: "slack",
    triggerTypeSlug: "slack_receive_message",
    triggerTypeName: "New Message",
    connectedAccountId: "acc_1",
    triggerConfig: {},
    logo: "logo.png",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
};

const project = {
    id: "proj_1",
    name: "Test Project",
    createdAt: "2025-01-01T00:00:00.000Z",
    createdByUserId: "u1",
    secret: "shh",
    draftWorkflow: {},
    liveWorkflow: { agents: [], startAgent: "a" },
};

const job = {
    id: "job_1",
    reason: {
        type: "composio_trigger" as const,
        triggerId: validEvent.data.trigger_nano_id,
        triggerDeploymentId: deployment.id,
        triggerTypeSlug: deployment.triggerTypeSlug,
        payload: validEvent,
    },
    projectId: deployment.projectId,
    input: {
        messages: [{
            role: "user" as const,
            content: `This chat is being invoked through a trigger. Here is the trigger data:\n\n${JSON.stringify(validEvent, null, 2)}`,
        }],
    },
    workerId: null,
    lastWorkerId: null,
    status: "pending" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
};

function makeDeps() {
    const order: string[] = [];
    // Only the methods this use-case actually calls are given real
    // behavior; `as unknown as Mocked<...>` (not a hand-stubbed full
    // interface) is the typed-mock-helper: it satisfies the constructor's
    // interface parameter at the type level while keeping `deps.x.y` as a
    // real `vi.fn()` Mock instance for `.mockResolvedValue` /
    // `.toHaveBeenCalledWith` assertions below. One cast per collaborator,
    // reused by all 13 tests, instead of a cast per constructor call site.
    const composioTriggerDeploymentsRepository = {
        fetchByComposioTriggerId: vi.fn(async () => { order.push("deployments.fetchByComposioTriggerId"); return deployment; }),
    } as unknown as Mocked<IComposioTriggerDeploymentsRepository>;
    const projectsRepository = {
        fetch: vi.fn(async () => { order.push("projects.fetch"); return project; }),
    } as unknown as Mocked<IProjectsRepository>;
    const jobsRepository = {
        create: vi.fn(async () => { order.push("jobs.create"); return job; }),
    } as unknown as Mocked<IJobsRepository>;
    const pubSubService = {
        publish: vi.fn(async () => { order.push("pubsub.publish"); }),
    } as unknown as Mocked<IPubSubService>;
    return { order, composioTriggerDeploymentsRepository, projectsRepository, jobsRepository, pubSubService };
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.USE_BILLING;
    delete process.env.NEXT_PUBLIC_USE_BILLING;
});

describe("HandleCompsioWebhookRequestUseCase — USE_BILLING=false", () => {
    it("accepts a validly-signed payload with lowercase headers, creates the job, and publishes", async () => {
        const { HandleCompsioWebhookRequestUseCase, authorize, logUsage, getCustomerIdForProject } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        await uc.execute(makeRequest(validPayload));

        expect(deps.order).toEqual([
            "deployments.fetchByComposioTriggerId",
            "projects.fetch",
            "jobs.create",
            "pubsub.publish",
        ]);
        expect(authorize).not.toHaveBeenCalled();
        expect(logUsage).not.toHaveBeenCalled();
        expect(getCustomerIdForProject).not.toHaveBeenCalled();
        expect(deps.composioTriggerDeploymentsRepository.fetchByComposioTriggerId)
            .toHaveBeenCalledWith(validEvent.data.trigger_nano_id);
        expect(deps.projectsRepository.fetch).toHaveBeenCalledWith(deployment.projectId);
        expect(deps.jobsRepository.create).toHaveBeenCalledWith({
            reason: {
                type: "composio_trigger",
                triggerId: validEvent.data.trigger_nano_id, // sourced from the EVENT, not deployment.triggerId
                triggerDeploymentId: deployment.id,
                triggerTypeSlug: deployment.triggerTypeSlug,
                payload: validEvent,
            },
            projectId: deployment.projectId,
            input: {
                messages: [{
                    role: "user",
                    content: `This chat is being invoked through a trigger. Here is the trigger data:\n\n${JSON.stringify(validEvent, null, 2)}`,
                }],
            },
        });
        expect(deps.pubSubService.publish).toHaveBeenCalledWith("new_jobs", job.id);
    });

    it("accepts mixed-case headers identically to lowercase headers", async () => {
        const { HandleCompsioWebhookRequestUseCase } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        await expect(uc.execute(makeRequest(validPayload, { headerCase: "mixed" }))).resolves.toBeUndefined();
    });

    it("rejects a tampered payload whose signature no longer matches", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });
        const req = makeRequest(validPayload);
        req.payload = JSON.stringify({ ...validEvent, type: "tampered_type" });

        const err = await captureRejection(uc.execute(req));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Payload verification failed");
        expect(deps.composioTriggerDeploymentsRepository.fetchByComposioTriggerId).not.toHaveBeenCalled();
    });

    it("rejects a request missing a required webhook header", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload, { omit: ["webhook-signature"] })));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Payload verification failed");
    });

    it("rejects a signature built with the wrong secret", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload, { secret: "wrong-secret" })));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Payload verification failed");
    });

    it("rejects invalid JSON after a valid signature", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });
        const badPayload = "not json";

        const err = await captureRejection(uc.execute(makeRequest(badPayload)));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Invalid webhook payload");
    });

    it("rejects schema-invalid JSON (missing required fields) after a valid signature", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });
        const badPayload = JSON.stringify({ type: "x" }); // missing timestamp/data

        const err = await captureRejection(uc.execute(makeRequest(badPayload)));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Invalid webhook payload");
    });

    it("throws BadRequestError('Trigger not found') when no deployment matches the trigger nano id", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        deps.composioTriggerDeploymentsRepository.fetchByComposioTriggerId.mockResolvedValue(null);
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload)));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Trigger not found");
        expect(deps.projectsRepository.fetch).not.toHaveBeenCalled();
    });

    it("throws NotFoundError('Project not found') when the deployment's project no longer exists", async () => {
        const { HandleCompsioWebhookRequestUseCase, NotFoundError } = await loadWithBilling(false);
        const deps = makeDeps();
        deps.projectsRepository.fetch.mockResolvedValue(null);
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload)));

        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe("Project not found");
        expect(deps.jobsRepository.create).not.toHaveBeenCalled();
    });

    it("throws BadRequestError('Project has no live workflow') when the project has none", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError } = await loadWithBilling(false);
        const deps = makeDeps();
        deps.projectsRepository.fetch.mockResolvedValue({ ...project, liveWorkflow: undefined } as never);
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload)));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Project has no live workflow");
        expect(deps.jobsRepository.create).not.toHaveBeenCalled();
        expect(deps.pubSubService.publish).not.toHaveBeenCalled();
    });
});

describe("HandleCompsioWebhookRequestUseCase — USE_BILLING=true", () => {
    it("checks billing before creating the job: gets the customer id, authorizes, logs usage, then proceeds — in that order", async () => {
        const { HandleCompsioWebhookRequestUseCase, authorize, logUsage, getCustomerIdForProject } = await loadWithBilling(true);
        getCustomerIdForProject.mockResolvedValue("cust_1");
        const deps = makeDeps();
        authorize.mockImplementation(async () => { deps.order.push("billing.authorize"); return { success: true }; });
        logUsage.mockImplementation(async () => { deps.order.push("billing.logUsage"); });
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        await uc.execute(makeRequest(validPayload));

        expect(deps.order).toEqual([
            "deployments.fetchByComposioTriggerId",
            "billing.authorize",
            "billing.logUsage",
            "projects.fetch",
            "jobs.create",
            "pubsub.publish",
        ]);
        expect(getCustomerIdForProject).toHaveBeenCalledWith(deployment.projectId);
        expect(authorize).toHaveBeenCalledWith("cust_1", { type: "use_credits" });
        expect(logUsage).toHaveBeenCalledWith("cust_1", {
            items: [{ type: "COMPOSIO_TRIGGER_USAGE", triggerSlug: deployment.triggerTypeSlug, context: "trigger.composio" }],
        });
    });

    it("throws BillingError('Not enough credits') and creates no job when authorize reports insufficient credits — logUsage never runs", async () => {
        const { HandleCompsioWebhookRequestUseCase, BillingError, authorize, logUsage, getCustomerIdForProject } = await loadWithBilling(true);
        getCustomerIdForProject.mockResolvedValue("cust_1");
        authorize.mockResolvedValue({ success: false, error: "insufficient_credits" });
        const deps = makeDeps();
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload)));

        expect(err).toBeInstanceOf(BillingError);
        expect((err as Error).message).toBe("Not enough credits");
        expect(logUsage).not.toHaveBeenCalled();
        expect(deps.jobsRepository.create).not.toHaveBeenCalled();
        expect(deps.pubSubService.publish).not.toHaveBeenCalled();
    });

    it("HAZARD: bills usage before checking the project has a live workflow — a webhook can be billed and never create a job", async () => {
        const { HandleCompsioWebhookRequestUseCase, BadRequestError, authorize, logUsage, getCustomerIdForProject } = await loadWithBilling(true);
        getCustomerIdForProject.mockResolvedValue("cust_1");
        authorize.mockResolvedValue({ success: true });
        const deps = makeDeps();
        deps.projectsRepository.fetch.mockResolvedValue({ ...project, liveWorkflow: undefined } as never);
        const uc = new HandleCompsioWebhookRequestUseCase({
            composioTriggerDeploymentsRepository: deps.composioTriggerDeploymentsRepository,
            jobsRepository: deps.jobsRepository,
            projectsRepository: deps.projectsRepository,
            pubSubService: deps.pubSubService,
        });

        const err = await captureRejection(uc.execute(makeRequest(validPayload)));

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as Error).message).toBe("Project has no live workflow");
        // The hazard, made concrete: billing already ran by the time this throws.
        expect(logUsage).toHaveBeenCalledTimes(1);
        expect(deps.jobsRepository.create).not.toHaveBeenCalled();
        expect(deps.pubSubService.publish).not.toHaveBeenCalled();
    });
});
