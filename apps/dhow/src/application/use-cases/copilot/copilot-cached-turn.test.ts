import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Characterization tests for the copilot cached-turn pair, ahead of the port
 * into apps/dhowx.
 *
 * These two use-cases exist to let a slow/expensive copilot turn be created
 * by one request (`CreateCopilotCachedTurnUseCase`, writes the serialized
 * request into the cache under `copilot-stream-<nanoid>` and hands back the
 * key) and consumed by a second, streaming request
 * (`RunCopilotCachedTurnUseCase`, reads + immediately deletes that cache
 * entry, then streams the turn). Three things are pinned that a naive port
 * could silently change:
 *
 * 1. Ordering on the write side: authz -> quota -> billing check -> cache
 *    write, in that order. A billing decline must never leave a cache entry
 *    behind (nothing to consume later).
 *
 * 2. Single-use semantics on the read side: the cache entry is deleted
 *    immediately after `get`, BEFORE authz/quota/billing run. If those later
 *    checks fail, the cached turn is still gone -- there is no "put it back"
 *    path. A port that moves the delete after the checks (e.g. "only consume
 *    on success") would change real behaviour.
 *
 * 3. Error shape on billing failure. `run-conversation-turn.use-case.ts` --
 *    structurally the closest sibling to `run-copilot-cached-turn` (both are
 *    async generators with the identical authz -> quota -> billing -> stream
 *    -> finally/logUsage skeleton) -- handles a billing decline by `yield`ing
 *    a `{type:"error", isBillingError:true}` event and returning cleanly.
 *    Both copilot use-cases here instead `throw new BillingError(...)`
 *    directly: a caller iterating the generator with `for await` gets an
 *    uncaught rejection, not a terminal event in the stream. That is a real
 *    inconsistency between two look-alike use-cases, not a deliberate
 *    contrast -- pinned here, not fixed.
 *
 * `USE_BILLING` (`@/app/lib/feature_flags`) is a module-scope constant frozen
 * at import time, so each billing state gets its own `describe` block that
 * resets the module registry and sets `process.env.USE_BILLING` in
 * `beforeEach`, then dynamically imports the SUT and its `@/app/lib/billing`
 * / `@/src/application/lib/copilot/copilot` mocks fresh inside each test --
 * a stale top-level `import` would only ever observe one flag value.
 *
 * `nanoid()` in the create use-case is left to run for real (not mocked):
 * tests only assert the returned `key` matches what was written to the
 * cache, never a specific value, so a real random id is sufficient and
 * avoids one more module to keep in sync with the resetModules dance above.
 */

vi.mock("@/app/lib/billing", () => ({
    authorize: vi.fn(),
    logUsage: vi.fn(),
    getCustomerIdForProject: vi.fn(),
    UsageTracker: class {
        track = vi.fn();
        flush = vi.fn(() => [{ kind: "test-usage-item" }]);
    },
}));

vi.mock("@/src/application/lib/copilot/copilot", () => ({
    streamMultiAgentResponse: vi.fn(),
}));

// vi.mock factories swap these exports for vi.fn() mocks at runtime; the
// module's declared (non-mock) type is all TS sees through the real module's
// exported types (including dynamic `await import(...)` re-fetches inside
// each test), so every test needs the mock-only methods (mockResolvedValue,
// mockImplementation, ...) reached through this one, centralized cast.
const asMock = (fn: unknown): Mock => fn as Mock;

// ---- fixtures -------------------------------------------------------------

const workflow = () => ({
    agents: [],
    prompts: [],
    tools: [],
    startAgent: "assistant",
    lastUpdatedAt: "2026-08-03T12:00:00.000Z",
});

/** Shape validated for real by `CopilotAPIRequest.parse` in run-copilot-cached-turn. */
const cachedPayload = (over: Record<string, unknown> = {}) => ({
    projectId: "proj_1",
    messages: [{ role: "user", content: "hi" }],
    workflow: workflow(),
    context: null,
    ...over,
});

const makeAuthzPolicy = () => ({ authorize: vi.fn().mockResolvedValue(undefined) });
const makeQuotaPolicy = () => ({
    assertAndConsumeProjectAction: vi.fn().mockResolvedValue(undefined),
    assertAndConsumeRunJobAction: vi.fn(),
});
const makeCacheService = () => ({
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
});

afterEach(() => {
    delete process.env.USE_BILLING;
    delete process.env.NEXT_PUBLIC_USE_BILLING;
});

// =====================================================================
// CreateCopilotCachedTurnUseCase
// =====================================================================

describe("CreateCopilotCachedTurnUseCase — USE_BILLING=false", () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.USE_BILLING;
        delete process.env.NEXT_PUBLIC_USE_BILLING;
    });

    it("authorizes, consumes quota, then caches the JSON-serialized data.data payload with a 600s TTL", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = makeQuotaPolicy();
        const cacheService = makeCacheService();
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        const requestData = cachedPayload();
        const result = await uc.execute({ caller: "user", userId: "user_1", data: requestData as never });

        expect(authzPolicy.authorize).toHaveBeenCalledWith({
            projectId: "proj_1",
            caller: "user",
            userId: "user_1",
            apiKey: undefined,
        });
        expect(quotaPolicy.assertAndConsumeProjectAction).toHaveBeenCalledWith("proj_1");

        expect(cacheService.set).toHaveBeenCalledTimes(1);
        const [key, payload, ttl] = cacheService.set.mock.calls[0];
        expect(typeof result.key).toBe("string");
        expect(result.key.length).toBeGreaterThan(0);
        expect(key).toBe(`copilot-stream-${result.key}`);
        expect(ttl).toBe(600); // pin the exact TTL constant (60 * 10)
        expect(JSON.parse(payload)).toEqual(requestData);
    });

    it("orders authz -> quota -> cache write", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const order: string[] = [];
        const authzPolicy = { authorize: vi.fn().mockImplementation(async () => { order.push("authz"); }) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn().mockImplementation(async () => { order.push("quota"); }),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const cacheService = {
            get: vi.fn(),
            set: vi.fn().mockImplementation(async () => { order.push("cache"); }),
            delete: vi.fn(),
        };
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        await uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never });

        expect(order).toEqual(["authz", "quota", "cache"]);
    });

    it("propagates QuotaExceededError from the quota policy uncaught, and never writes to cache", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const { QuotaExceededError } = await import("@/src/entities/errors/common");
        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn().mockRejectedValue(new QuotaExceededError("no quota left")),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const cacheService = makeCacheService();
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        await expect(
            uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never })
        ).rejects.toThrow(QuotaExceededError);
        expect(cacheService.set).not.toHaveBeenCalled();
    });
});

describe("CreateCopilotCachedTurnUseCase — USE_BILLING=true", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.USE_BILLING = "true";
    });

    it("looks up the billing customer for the project and authorizes use_credits before caching", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: true });

        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = makeQuotaPolicy();
        const cacheService = makeCacheService();
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        await uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never });

        expect(billing.getCustomerIdForProject).toHaveBeenCalledWith("proj_1");
        expect(billing.authorize).toHaveBeenCalledWith("cus_1", { type: "use_credits" });
        expect(cacheService.set).toHaveBeenCalledTimes(1);
    });

    it("throws BillingError (not a yielded event -- this is a plain async function) and never writes to cache when billing declines", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const { BillingError } = await import("@/src/entities/errors/common");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: false, error: "insufficient credits" });

        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = makeQuotaPolicy();
        const cacheService = makeCacheService();
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        await expect(
            uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never })
        ).rejects.toThrow(BillingError);
        expect(cacheService.set).not.toHaveBeenCalled();
    });

    it("uses the raw billing error message, defaulting to 'Billing error' when none is given", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: false });

        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService: makeCacheService(),
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        await expect(
            uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never })
        ).rejects.toThrow("Billing error");
    });

    it("orders authz -> quota -> billing check -> cache write", async () => {
        const { CreateCopilotCachedTurnUseCase } = await import("./create-copilot-cached-turn.use-case");
        const billing = await import("@/app/lib/billing");
        const order: string[] = [];
        asMock(billing.getCustomerIdForProject).mockImplementation(async () => { order.push("billing-lookup"); return "cus_1"; });
        asMock(billing.authorize).mockImplementation(async () => { order.push("billing-authorize"); return { success: true }; });

        const authzPolicy = { authorize: vi.fn().mockImplementation(async () => { order.push("authz"); }) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn().mockImplementation(async () => { order.push("quota"); }),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const cacheService = {
            get: vi.fn(),
            set: vi.fn().mockImplementation(async () => { order.push("cache"); }),
            delete: vi.fn(),
        };
        const uc = new CreateCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        await uc.execute({ caller: "user", userId: "user_1", data: cachedPayload() as never });

        expect(order).toEqual(["authz", "quota", "billing-lookup", "billing-authorize", "cache"]);
    });
});

// =====================================================================
// RunCopilotCachedTurnUseCase
// =====================================================================

describe("RunCopilotCachedTurnUseCase — USE_BILLING=false", () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.USE_BILLING;
        delete process.env.NEXT_PUBLIC_USE_BILLING;
    });

    it("gets the cache entry, deletes it, parses it, then authorizes and consumes quota, in that order", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");
        const order: string[] = [];

        const cacheService = {
            get: vi.fn().mockImplementation(async () => { order.push("get"); return JSON.stringify(cachedPayload()); }),
            delete: vi.fn().mockImplementation(async () => { order.push("delete"); return true; }),
            set: vi.fn(),
        };
        const authzPolicy = { authorize: vi.fn().mockImplementation(async () => { order.push("authz"); }) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn().mockImplementation(async () => { order.push("quota"); }),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            order.push("stream");
            yield { content: "hi" };
        });

        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        const received: unknown[] = [];
        for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
            received.push(event);
        }

        expect(order).toEqual(["get", "delete", "authz", "quota", "stream"]);
        expect(cacheService.get).toHaveBeenCalledWith("copilot-stream-key1");
        expect(cacheService.delete).toHaveBeenCalledWith("copilot-stream-key1");
    });

    it("deletes the cache entry before authz runs, and keeps it deleted even when authz then rejects", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { NotAuthorizedError } = await import("@/src/entities/errors/common");

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const authzPolicy = { authorize: vi.fn().mockRejectedValue(new NotAuthorizedError("nope")) };
        const quotaPolicy = {
            assertAndConsumeProjectAction: vi.fn(),
            assertAndConsumeRunJobAction: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        const gen = uc.execute({ caller: "user", userId: "user_1", key: "key1" });
        await expect(gen.next()).rejects.toThrow(NotAuthorizedError);

        // Single-use: the entry is gone even though the request ultimately failed.
        expect(cacheService.delete).toHaveBeenCalledWith("copilot-stream-key1");
        expect(quotaPolicy.assertAndConsumeProjectAction).not.toHaveBeenCalled();
    });

    it("throws NotFoundError without ever deleting or checking authz/quota when the cache entry is missing", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { NotFoundError } = await import("@/src/entities/errors/common");

        const cacheService = { get: vi.fn().mockResolvedValue(null), delete: vi.fn(), set: vi.fn() };
        const authzPolicy = { authorize: vi.fn() };
        const quotaPolicy = { assertAndConsumeProjectAction: vi.fn(), assertAndConsumeRunJobAction: vi.fn() };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        const gen = uc.execute({ caller: "user", userId: "user_1", key: "missing" });
        await expect(gen.next()).rejects.toThrow(NotFoundError);

        expect(cacheService.delete).not.toHaveBeenCalled();
        expect(authzPolicy.authorize).not.toHaveBeenCalled();
        expect(quotaPolicy.assertAndConsumeProjectAction).not.toHaveBeenCalled();
    });

    it("streams events from streamMultiAgentResponse verbatim through the generator, called with the parsed cached fields", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");

        const events = [
            { content: "part one" },
            { type: "tool-call", toolName: "lookup_invoice", toolCallId: "tc_1", args: {} },
            { type: "tool-result", toolCallId: "tc_1", result: { ok: true } },
        ];
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            for (const e of events) yield e;
        });

        const payload = cachedPayload();
        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(payload)),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const authzPolicy = makeAuthzPolicy();
        const quotaPolicy = makeQuotaPolicy();
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: quotaPolicy,
            projectActionAuthorizationPolicy: authzPolicy,
        });

        const received: unknown[] = [];
        for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
            received.push(event);
        }

        expect(received).toEqual(events); // verbatim pass-through, not wrapped or transformed
        expect(streamMultiAgentResponse).toHaveBeenCalledWith(
            expect.anything(), // usageTracker
            payload.projectId,
            payload.context,
            payload.messages,
            payload.workflow,
            [], // dataSources defaults to [] when omitted from the cached payload
            [], // triggers defaults to [] when omitted from the cached payload
        );
    });

    it("never logs usage when USE_BILLING is false, even when the stream throws mid-way", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");
        const billing = await import("@/app/lib/billing");

        const streamError = new Error("stream blew up");
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            yield { content: "partial" };
            throw streamError;
        });

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        const drain = async () => {
            const received: unknown[] = [];
            for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
                received.push(event);
            }
            return received;
        };

        await expect(drain()).rejects.toThrow(streamError);
        expect(billing.logUsage).not.toHaveBeenCalled();
    });
});

describe("RunCopilotCachedTurnUseCase — USE_BILLING=true", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.USE_BILLING = "true";
    });

    it("looks up billing customer, authorizes use_credits, streams, and logs the flushed usage tracker in finally", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: true });
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            yield { content: "hi" };
        });

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        const received: unknown[] = [];
        for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
            received.push(event);
        }

        expect(billing.getCustomerIdForProject).toHaveBeenCalledWith("proj_1");
        expect(billing.authorize).toHaveBeenCalledWith("cus_1", { type: "use_credits" });
        expect(billing.logUsage).toHaveBeenCalledWith("cus_1", { items: [{ kind: "test-usage-item" }] });
    });

    it("throws BillingError (thrown, not yielded -- contrasts with run-conversation-turn's yield-based error handling) on decline, and the entry is already consumed", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { BillingError } = await import("@/src/entities/errors/common");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: false, error: "no credits" });

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        const gen = uc.execute({ caller: "user", userId: "user_1", key: "key1" });
        const first = gen.next();
        await expect(first).rejects.toThrow(BillingError);
        await expect(gen.next()).resolves.toEqual({ done: true, value: undefined }); // generator already finished (threw); re-driving is a no-op, not a hang

        expect(cacheService.delete).toHaveBeenCalledWith("copilot-stream-key1");
        // The billing check happens before the try/finally that owns logUsage, so
        // a decline here never creates a UsageTracker and never logs anything.
        expect(billing.logUsage).not.toHaveBeenCalled();
    });

    it("does not log usage when the resolved billing customer id is falsy, even though USE_BILLING is true", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue(""); // falsy, but USE_BILLING branch still ran
        asMock(billing.authorize).mockResolvedValue({ success: true });
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            yield { content: "hi" };
        });

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        const received: unknown[] = [];
        for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
            received.push(event);
        }

        expect(billing.authorize).toHaveBeenCalledWith("", { type: "use_credits" });
        expect(billing.logUsage).not.toHaveBeenCalled();
    });

    it("logs usage in `finally` even when streamMultiAgentResponse throws mid-stream (same pattern as run-conversation-turn)", async () => {
        const { RunCopilotCachedTurnUseCase } = await import("./run-copilot-cached-turn.use-case");
        const { streamMultiAgentResponse } = await import("@/src/application/lib/copilot/copilot");
        const billing = await import("@/app/lib/billing");
        asMock(billing.getCustomerIdForProject).mockResolvedValue("cus_1");
        asMock(billing.authorize).mockResolvedValue({ success: true });

        const streamError = new Error("stream blew up");
        asMock(streamMultiAgentResponse).mockImplementation(async function* () {
            yield { content: "partial" };
            throw streamError;
        });

        const cacheService = {
            get: vi.fn().mockResolvedValue(JSON.stringify(cachedPayload())),
            delete: vi.fn().mockResolvedValue(true),
            set: vi.fn(),
        };
        const uc = new RunCopilotCachedTurnUseCase({
            cacheService,
            usageQuotaPolicy: makeQuotaPolicy(),
            projectActionAuthorizationPolicy: makeAuthzPolicy(),
        });

        const received: unknown[] = [];
        const drain = async () => {
            for await (const event of uc.execute({ caller: "user", userId: "user_1", key: "key1" })) {
                received.push(event);
            }
        };

        await expect(drain()).rejects.toThrow(streamError);
        expect(received).toEqual([{ content: "partial" }]);
        expect(billing.logUsage).toHaveBeenCalledWith("cus_1", { items: [{ kind: "test-usage-item" }] });
    });
});
