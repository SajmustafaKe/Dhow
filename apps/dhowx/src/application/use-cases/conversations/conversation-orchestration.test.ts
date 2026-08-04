import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { CreateConversationUseCase } from "@/src/application/use-cases/conversations/create-conversation.use-case";
import { RunConversationTurnUseCase } from "@/src/application/use-cases/conversations/run-conversation-turn.use-case";
import { NotFoundError, BadRequestError } from "@/src/entities/errors/common";
import * as billing from "@/app/lib/billing";
import * as agentsRuntime from "@/src/application/lib/agents-runtime/agents";
import { Message } from "@/app/lib/types/types";
import { Workflow } from "@/app/lib/types/workflow_types";
import { z } from "zod";

type MessageT = z.infer<typeof Message>;
type WorkflowT = z.infer<typeof Workflow>;

/**
 * Characterization tests for conversation orchestration, ahead of the port
 * into apps/dhowx.
 *
 * RunConversationTurnUseCase.execute is the highest-consequence file in this
 * slice: it's the paid agent-turn orchestrator, an async generator that mixes
 * three concerns nothing in its type signature (`AsyncGenerator<TurnEvent>`)
 * hints at: authz/quota gating, a two-stage billing check (credits, then a
 * *second* check keyed off the agent models actually in play for this turn),
 * and streaming assistant output while accumulating a UsageTracker that MUST
 * be flushed exactly once regardless of how the generator exits. A billing
 * failure is a yielded `{type:'error'}` event that ends the generator
 * cleanly, NOT a thrown error -- a port that turns it into a throw changes
 * how every caller (SSE handlers, job workers) has to react. And the billing
 * check block sits entirely OUTSIDE the try/finally that wraps
 * streamResponse/addTurn, so a billing rejection never reaches `logUsage` at
 * all -- that's easy to lose in a rewrite that "cleans up" the function by
 * wrapping everything in one try/finally.
 *
 * USE_BILLING is a module-scope constant frozen at import time
 * (`@/app/lib/feature_flags.ts`). Exercising both branches without either
 * `resetModules()` + a second dynamic import (which races here: the real,
 * unmocked agent runtime transitively imports `di/container.ts`, which
 * eagerly imports THIS SAME use-case module for DI registration -- an
 * intermittent circular-import crash, not a clean test failure) OR an env var
 * set before the process starts requires making `USE_BILLING` itself a live,
 * test-controllable binding: `@/app/lib/feature_flags` is mocked with a
 * getter backed by a plain mutable flag, flipped per describe block in
 * `beforeEach`. Every other dependency is a single, ordinary hoisted
 * `vi.mock` -- no module-registry resets anywhere in this file.
 *
 * CreateConversationUseCase is smaller but has its own hazard: quota is
 * consumed BEFORE the fallback fetch that can still throw BadRequestError,
 * and the `isLiveWorkflow` flag the caller sends is silently overridden to
 * `true` whenever no explicit workflow is supplied -- both pinned as current
 * behaviour, not fixed, here.
 */

let useBillingFlag = false;

vi.mock("@/app/lib/feature_flags", () => ({
    get USE_BILLING() {
        return useBillingFlag;
    },
}));

vi.mock("@/app/lib/billing", () => ({
    authorize: vi.fn(),
    logUsage: vi.fn(),
    getCustomerIdForProject: vi.fn(),
    UsageTracker: class {
        track = vi.fn();
        flush = vi.fn(() => []);
    },
}));

vi.mock("@/src/application/lib/agents-runtime/agents", () => ({
    streamResponse: vi.fn(),
}));

// vi.mock factories swap these exports for vi.fn() mocks at runtime; the
// module's declared (non-mock) type is all TS sees through the real module's
// exported types, so every test needs the mock-only methods
// (mockResolvedValue, mockImplementation, ...) reached through this one,
// centralized, documented cast rather than scattered inline ones.
const asMock = (fn: unknown): Mock => fn as Mock;

// ---------------- shared fixtures (pure, no dependency on mocked modules) ----------------

const agentFixture = (over: Record<string, unknown> = {}) => ({
    name: "main",
    type: "conversation",
    description: "the main agent",
    instructions: "be helpful",
    model: "gpt-4o",
    ragReturnType: "chunks",
    ragK: 3,
    ...over,
});

const workflowFixture = (agents: unknown[] = [agentFixture()], over: Record<string, unknown> = {}): WorkflowT => ({
    agents,
    prompts: [],
    tools: [],
    startAgent: "main",
    lastUpdatedAt: new Date().toISOString(),
    ...over,
}) as never; // test fixture: only the fields the use-cases under test actually read are filled in

const conversationFixture = (over: Record<string, unknown> = {}) => ({
    id: "conv-1",
    projectId: "proj-1",
    workflow: workflowFixture(),
    reason: { type: "chat" },
    isLiveWorkflow: true,
    turns: [],
    createdAt: new Date().toISOString(),
    ...over,
});

const turnFixture = (over: Record<string, unknown> = {}) => ({
    id: "turn-1",
    reason: { type: "chat" },
    input: { messages: [] },
    output: [],
    createdAt: new Date().toISOString(),
    ...over,
});

const assistantMsg = (over: Record<string, unknown> = {}) => ({
    role: "assistant",
    content: "hi",
    agentName: "main",
    responseType: "external",
    ...over,
});

// ---------------- shared mock builders ----------------

const makeConversationsRepo = () => ({
    create: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(),
    addTurn: vi.fn(),
    deleteByProjectId: vi.fn(),
});

const makeQuotaPolicy = () => ({
    assertAndConsumeProjectAction: vi.fn().mockResolvedValue(undefined),
    assertAndConsumeRunJobAction: vi.fn(),
});

const makeAuthzPolicy = () => ({
    authorize: vi.fn().mockResolvedValue(undefined),
});

// records the relative order in which independently-mocked collaborators ran
const trackOrder = () => {
    const order: string[] = [];
    return { order, mark: (label: string) => order.push(label) };
};

// drains an async generator, surfacing a thrown/rejected step as a rejected promise
async function drain<T>(gen: AsyncGenerator<T, void, unknown>): Promise<T[]> {
    const out: T[] = [];
    for await (const event of gen) out.push(event);
    return out;
}

describe("RunConversationTurnUseCase", () => {
    describe("USE_BILLING=false", () => {
        beforeEach(() => {
            useBillingFlag = false;
        });

        it("happy path: authz -> quota -> streamResponse in order; yields stamped message events then addTurn then done; no billing calls at all", async () => {
            const { order, mark } = trackOrder();
            const conversation = conversationFixture();
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            const savedTurn = turnFixture({ id: "turn-99" });
            conversationsRepo.addTurn.mockImplementation(async () => {
                mark("addTurn");
                return savedTurn;
            });

            const quotaPolicy = makeQuotaPolicy();
            quotaPolicy.assertAndConsumeProjectAction.mockImplementation(async () => {
                mark("quota");
            });

            const authzPolicy = makeAuthzPolicy();
            authzPolicy.authorize.mockImplementation(async () => {
                mark("authz");
            });

            asMock(agentsRuntime.streamResponse).mockImplementation(async function* () {
                mark("stream");
                yield assistantMsg({ content: "hello there" });
                yield assistantMsg({ content: "how can I help" });
            });

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const data = {
                caller: "user" as const,
                userId: "user-1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [{ role: "user" as const, content: "hi" }] },
            };

            const events = await drain(uc.execute(data as never));

            expect(order).toEqual(["authz", "quota", "stream", "addTurn"]);
            expect(events).toHaveLength(3);
            expect(events[0]).toEqual({
                type: "message",
                data: expect.objectContaining({ content: "hello there", timestamp: expect.any(String) }),
            });
            expect(events[1]).toEqual({
                type: "message",
                data: expect.objectContaining({ content: "how can I help", timestamp: expect.any(String) }),
            });
            expect(events[2]).toEqual({ type: "done", turn: savedTurn, conversationId: conversation.id });

            expect(conversationsRepo.addTurn).toHaveBeenCalledWith(conversation.id, {
                reason: data.reason,
                input: data.input,
                output: [
                    expect.objectContaining({ content: "hello there" }),
                    expect.objectContaining({ content: "how can I help" }),
                ],
            });

            expect(authzPolicy.authorize).toHaveBeenCalledWith({
                caller: "user",
                userId: "user-1",
                apiKey: undefined,
                projectId: conversation.projectId,
            });

            expect(billing.authorize).not.toHaveBeenCalled();
            expect(billing.getCustomerIdForProject).not.toHaveBeenCalled();
            expect(billing.logUsage).not.toHaveBeenCalled();
        });

        it("conversationId not found -> throws NotFoundError before authz/quota run (short-circuit)", async () => {
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(null);
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const data = {
                caller: "user" as const,
                userId: "user-1",
                conversationId: "missing-conv",
                reason: { type: "chat" as const },
                input: { messages: [] },
            };

            await expect(drain(uc.execute(data as never))).rejects.toThrow(NotFoundError);
            expect(authzPolicy.authorize).not.toHaveBeenCalled();
            expect(quotaPolicy.assertAndConsumeProjectAction).not.toHaveBeenCalled();
            expect(conversationsRepo.addTurn).not.toHaveBeenCalled();
        });

        it("caller === 'job_worker' skips authz entirely but still consumes quota", async () => {
            const conversation = conversationFixture();
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            conversationsRepo.addTurn.mockResolvedValue(turnFixture());
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* () {
                yield assistantMsg();
            });

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const data = {
                caller: "job_worker" as const,
                conversationId: conversation.id,
                reason: { type: "job" as const, jobId: "job-1" },
                input: { messages: [] },
            };

            await drain(uc.execute(data as never));

            expect(authzPolicy.authorize).not.toHaveBeenCalled();
            expect(quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledWith(conversation.projectId);
        });

        it("stamps a timestamp onto input messages missing one, in place; leaves existing timestamps untouched", async () => {
            const conversation = conversationFixture();
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            conversationsRepo.addTurn.mockResolvedValue(turnFixture());
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();

            let captured: MessageT[] = [];
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* (
                _p: string,
                _w: WorkflowT,
                messages: MessageT[],
            ) {
                captured = messages;
            });

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const withTs = { role: "user" as const, content: "already stamped", timestamp: "2020-01-01T00:00:00.000Z" };
            const withoutTs = { role: "user" as const, content: "needs a stamp" };

            const data = {
                caller: "user" as const,
                userId: "u1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [withTs, withoutTs] },
            };

            await drain(uc.execute(data as never));

            expect(captured).toHaveLength(2);
            expect(captured[0].timestamp).toBe("2020-01-01T00:00:00.000Z");
            expect(captured[1].timestamp).toEqual(expect.any(String));
        });

        it("flattens previous turns into inputMessages ahead of the new input: input.messages then output, per turn, in order", async () => {
            const turn1 = turnFixture({
                id: "t1",
                input: { messages: [{ role: "user", content: "t1-in" }] },
                output: [{ role: "assistant", content: "t1-out", agentName: "main", responseType: "external" }],
            });
            const turn2 = turnFixture({
                id: "t2",
                input: { messages: [{ role: "user", content: "t2-in" }] },
                output: [{ role: "assistant", content: "t2-out", agentName: "main", responseType: "external" }],
            });
            const conversation = conversationFixture({ turns: [turn1, turn2] });
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            conversationsRepo.addTurn.mockResolvedValue(turnFixture());
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();

            let captured: MessageT[] = [];
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* (
                _p: string,
                _w: WorkflowT,
                messages: MessageT[],
            ) {
                captured = messages;
            });

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const data = {
                caller: "user" as const,
                userId: "u1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [{ role: "user" as const, content: "new-in" }] },
            };

            await drain(uc.execute(data as never));

            expect(captured.map((m) => m.content)).toEqual(["t1-in", "t1-out", "t2-in", "t2-out", "new-in"]);
        });

        it("data.input.mockTools overwrites conversation.workflow.mockTools before it reaches streamResponse", async () => {
            const conversation = conversationFixture({
                workflow: workflowFixture([agentFixture()], { mockTools: { toolA: "orig" } }),
            });
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            conversationsRepo.addTurn.mockResolvedValue(turnFixture());
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();

            let capturedWorkflow!: WorkflowT;
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* (_p: string, workflow: WorkflowT) {
                capturedWorkflow = workflow;
            });

            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });

            const data = {
                caller: "user" as const,
                userId: "u1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [], mockTools: { toolB: "override" } },
            };

            await drain(uc.execute(data as never));

            expect(capturedWorkflow.mockTools).toEqual({ toolB: "override" });
        });
    });

    describe("USE_BILLING=true", () => {
        beforeEach(() => {
            useBillingFlag = true;
        });

        const baseSetup = () => {
            const conversation = conversationFixture();
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            conversationsRepo.addTurn.mockResolvedValue(turnFixture());
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();
            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });
            const data = {
                caller: "user" as const,
                userId: "u1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [{ role: "user" as const, content: "hi" }] },
            };
            return { conversation, conversationsRepo, quotaPolicy, authzPolicy, uc, data };
        };

        it("happy path: quota -> getCustomerIdForProject -> authorize(use_credits) -> authorize(agent_response) -> streamResponse, in order; finally flushes usage via logUsage", async () => {
            const { order, mark } = trackOrder();
            const { uc, data, quotaPolicy } = baseSetup();

            quotaPolicy.assertAndConsumeProjectAction.mockImplementation(async () => {
                mark("quota");
            });
            asMock(billing.getCustomerIdForProject).mockImplementation(async () => {
                mark("getCustomerId");
                return "cust-1";
            });
            asMock(billing.authorize).mockImplementation(async (_id: string, req: { type: string }) => {
                mark(`authorize:${req.type}`);
                return { success: true };
            });
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* () {
                mark("stream");
                yield assistantMsg();
            });

            await drain(uc.execute(data as never));

            expect(order).toEqual(["quota", "getCustomerId", "authorize:use_credits", "authorize:agent_response", "stream"]);
            expect(billing.logUsage).toHaveBeenCalledWith("cust-1", { items: [] });
        });

        it("authorize(use_credits) failure yields a single {type:'error', isBillingError:true} event and returns without calling streamResponse/addTurn/logUsage", async () => {
            const { uc, data, conversationsRepo } = baseSetup();

            asMock(billing.getCustomerIdForProject).mockResolvedValue("cust-1");
            asMock(billing.authorize).mockResolvedValue({ success: false, error: "insufficient credits" });

            const events = await drain(uc.execute(data as never));

            expect(events).toEqual([{ type: "error", error: "insufficient credits", isBillingError: true }]);
            expect(agentsRuntime.streamResponse).not.toHaveBeenCalled();
            expect(conversationsRepo.addTurn).not.toHaveBeenCalled();
            expect(billing.logUsage).not.toHaveBeenCalled();
            expect(billing.authorize).toHaveBeenCalledTimes(1);
        });

        it("second authorize check (agent_response) is built from agentModels = workflow.agents.map(a => a.model); failure behaves the same way as the first check", async () => {
            const conversation = conversationFixture({
                workflow: workflowFixture([
                    agentFixture({ name: "a1", model: "gpt-4o" }),
                    agentFixture({ name: "a2", model: "claude-3-opus" }),
                ]),
            });
            const conversationsRepo = makeConversationsRepo();
            conversationsRepo.fetch.mockResolvedValue(conversation);
            const quotaPolicy = makeQuotaPolicy();
            const authzPolicy = makeAuthzPolicy();
            const uc = new RunConversationTurnUseCase({
                conversationsRepository: conversationsRepo as never,
                usageQuotaPolicy: quotaPolicy as never,
                projectActionAuthorizationPolicy: authzPolicy as never,
            });
            const data = {
                caller: "user" as const,
                userId: "u1",
                conversationId: conversation.id,
                reason: { type: "chat" as const },
                input: { messages: [] },
            };

            asMock(billing.getCustomerIdForProject).mockResolvedValue("cust-2");
            asMock(billing.authorize).mockImplementation(async (_id: string, req: { type: string }) => {
                if (req.type === "use_credits") return { success: true };
                return { success: false, error: "model not eligible" };
            });

            const events = await drain(uc.execute(data as never));

            expect(events).toEqual([{ type: "error", error: "model not eligible", isBillingError: true }]);
            expect(billing.authorize).toHaveBeenNthCalledWith(2, "cust-2", {
                type: "agent_response",
                data: { agentModels: ["gpt-4o", "claude-3-opus"] },
            });
            expect(agentsRuntime.streamResponse).not.toHaveBeenCalled();
            expect(conversationsRepo.addTurn).not.toHaveBeenCalled();
            expect(billing.logUsage).not.toHaveBeenCalled();
        });

        it("finally still calls logUsage with whatever was tracked when streamResponse throws mid-stream, and the thrown error propagates out of the generator", async () => {
            const { uc, data, conversationsRepo } = baseSetup();

            asMock(billing.getCustomerIdForProject).mockResolvedValue("cust-3");
            asMock(billing.authorize).mockResolvedValue({ success: true });
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* (
                _p: string,
                _w: WorkflowT,
                _m: MessageT[],
                usageTracker: { flush: Mock },
            ) {
                usageTracker.flush.mockReturnValue([{ item: "partial-usage" }]);
                yield assistantMsg({ content: "before-throw" });
                throw new Error("stream exploded");
            });

            const events: unknown[] = [];
            let caught: unknown;
            try {
                for await (const event of uc.execute(data as never)) events.push(event);
            } catch (err) {
                caught = err;
            }

            if (!(caught instanceof Error)) throw new Error("expected uc.execute to throw an Error");
            expect(caught.message).toBe("stream exploded");
            expect(events).toEqual([{ type: "message", data: expect.objectContaining({ content: "before-throw" }) }]);
            expect(conversationsRepo.addTurn).not.toHaveBeenCalled();
            expect(billing.logUsage).toHaveBeenCalledWith("cust-3", { items: [{ item: "partial-usage" }] });
        });

        it("finally does NOT call logUsage when billingCustomerId is falsy, even though USE_BILLING is true", async () => {
            const { uc, data } = baseSetup();

            // getCustomerIdForProject's real signature returns Promise<string>; forcing
            // a falsy resolution is the whole point of this test, hence the cast.
            asMock(billing.getCustomerIdForProject).mockResolvedValue(null);
            asMock(billing.authorize).mockResolvedValue({ success: true });
            asMock(agentsRuntime.streamResponse).mockImplementation(async function* () {
                yield assistantMsg();
            });

            const events = await drain(uc.execute(data as never));

            expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }));
            expect(billing.logUsage).not.toHaveBeenCalled();
        });
    });
});

describe("CreateConversationUseCase", () => {
    const makeProjectsRepo = (over: Record<string, unknown> = {}) => ({
        fetch: vi.fn(),
        ...over,
    });

    it("happy path with an explicit workflow: authz -> quota -> create, in order, using the caller-supplied isLiveWorkflow", async () => {
        const { order, mark } = trackOrder();
        const conversationsRepo = makeConversationsRepo();
        const created = conversationFixture({ id: "conv-created" });
        conversationsRepo.create.mockImplementation(async () => {
            mark("create");
            return created;
        });
        const quotaPolicy = makeQuotaPolicy();
        quotaPolicy.assertAndConsumeProjectAction.mockImplementation(async () => {
            mark("quota");
        });
        const authzPolicy = makeAuthzPolicy();
        authzPolicy.authorize.mockImplementation(async () => {
            mark("authz");
        });
        const projectsRepo = makeProjectsRepo();

        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: quotaPolicy as never,
            projectActionAuthorizationPolicy: authzPolicy as never,
            projectsRepository: projectsRepo as never,
        });

        const workflow = workflowFixture();
        const result = await uc.execute({
            caller: "user",
            userId: "u1",
            projectId: "proj-1",
            reason: { type: "chat" },
            workflow,
            isLiveWorkflow: true,
        });

        expect(order).toEqual(["authz", "quota", "create"]);
        expect(result).toBe(created);
        expect(conversationsRepo.create).toHaveBeenCalledWith({
            projectId: "proj-1",
            reason: { type: "chat" },
            workflow,
            isLiveWorkflow: true,
        });
        expect(projectsRepo.fetch).not.toHaveBeenCalled();
    });

    it("explicit workflow with isLiveWorkflow omitted defaults to false", async () => {
        const conversationsRepo = makeConversationsRepo();
        conversationsRepo.create.mockResolvedValue(conversationFixture());
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: makeQuotaPolicy() as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: makeProjectsRepo() as never,
        });
        const workflow = workflowFixture();
        await uc.execute({ caller: "user", userId: "u1", projectId: "p1", reason: { type: "chat" }, workflow });
        expect(conversationsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ isLiveWorkflow: false }));
    });

    it("no workflow supplied: falls back to projectsRepository.fetch(projectId).liveWorkflow and forces isLiveWorkflow=true regardless of caller value", async () => {
        const liveWorkflow = workflowFixture([agentFixture({ name: "live-agent" })]);
        const projectsRepo = makeProjectsRepo({ fetch: vi.fn().mockResolvedValue({ id: "p1", liveWorkflow }) });
        const conversationsRepo = makeConversationsRepo();
        conversationsRepo.create.mockResolvedValue(conversationFixture());
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: makeQuotaPolicy() as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: projectsRepo as never,
        });

        await uc.execute({
            caller: "user",
            userId: "u1",
            projectId: "p1",
            reason: { type: "chat" },
            isLiveWorkflow: false, // caller explicitly asks for false; the use-case must override it
        });

        expect(conversationsRepo.create).toHaveBeenCalledWith({
            projectId: "p1",
            reason: { type: "chat" },
            workflow: liveWorkflow,
            isLiveWorkflow: true,
        });
    });

    it("no workflow supplied and project not found -> NotFoundError", async () => {
        const projectsRepo = makeProjectsRepo({ fetch: vi.fn().mockResolvedValue(null) });
        const conversationsRepo = makeConversationsRepo();
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: makeQuotaPolicy() as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: projectsRepo as never,
        });

        await expect(
            uc.execute({ caller: "user", userId: "u1", projectId: "p1", reason: { type: "chat" } }),
        ).rejects.toThrow(NotFoundError);
        expect(conversationsRepo.create).not.toHaveBeenCalled();
    });

    it("no workflow supplied and project.liveWorkflow key is entirely absent -> BadRequestError", async () => {
        const projectsRepo = makeProjectsRepo({ fetch: vi.fn().mockResolvedValue({ id: "p1" }) });
        const conversationsRepo = makeConversationsRepo();
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: makeQuotaPolicy() as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: projectsRepo as never,
        });

        await expect(
            uc.execute({ caller: "user", userId: "u1", projectId: "p1", reason: { type: "chat" } }),
        ).rejects.toThrow(BadRequestError);
        expect(conversationsRepo.create).not.toHaveBeenCalled();
    });

    it("no workflow supplied and project.liveWorkflow is present but falsy (explicit undefined) -> BadRequestError -- pins !project.liveWorkflow, not key-existence", async () => {
        const project = { id: "p1", liveWorkflow: undefined };
        expect("liveWorkflow" in project).toBe(true); // sanity: the key IS present, only its value is falsy
        const projectsRepo = makeProjectsRepo({ fetch: vi.fn().mockResolvedValue(project) });
        const conversationsRepo = makeConversationsRepo();
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: makeQuotaPolicy() as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: projectsRepo as never,
        });

        await expect(
            uc.execute({ caller: "user", userId: "u1", projectId: "p1", reason: { type: "chat" } }),
        ).rejects.toThrow(BadRequestError);
        expect(conversationsRepo.create).not.toHaveBeenCalled();
    });

    it("caller === 'job_worker' skips authz but still consumes quota (same asymmetry as RunConversationTurnUseCase)", async () => {
        const conversationsRepo = makeConversationsRepo();
        conversationsRepo.create.mockResolvedValue(conversationFixture());
        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = makeQuotaPolicy();
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: quotaPolicy as never,
            projectActionAuthorizationPolicy: authzPolicy as never,
            projectsRepository: makeProjectsRepo() as never,
        });

        await uc.execute({
            caller: "job_worker",
            projectId: "p1",
            reason: { type: "job", jobId: "j1" },
            workflow: workflowFixture(),
        });

        expect(authzPolicy.authorize).not.toHaveBeenCalled();
        expect(quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledWith("p1");
    });

    it("quota is consumed BEFORE the workflow-fallback fetch -- spent even though the call ultimately throws BadRequestError (ordering hazard, pinned as-is)", async () => {
        const { order, mark } = trackOrder();
        const quotaPolicy = makeQuotaPolicy();
        quotaPolicy.assertAndConsumeProjectAction.mockImplementation(async () => {
            mark("quota");
        });
        const projectsRepo = makeProjectsRepo({
            fetch: vi.fn().mockImplementation(async () => {
                mark("project-fetch");
                return { id: "p1", liveWorkflow: undefined };
            }),
        });
        const conversationsRepo = makeConversationsRepo();
        const uc = new CreateConversationUseCase({
            conversationsRepository: conversationsRepo as never,
            usageQuotaPolicy: quotaPolicy as never,
            projectActionAuthorizationPolicy: makeAuthzPolicy() as never,
            projectsRepository: projectsRepo as never,
        });

        await expect(
            uc.execute({ caller: "user", userId: "u1", projectId: "p1", reason: { type: "chat" } }),
        ).rejects.toThrow(BadRequestError);

        expect(order).toEqual(["quota", "project-fetch"]);
        expect(quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledTimes(1);
    });
});
