import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Characterization tests for `apps/dhow/app/lib/billing.ts` and
 * `app/lib/types/billing_types.ts`, ahead of the dhowx port.
 *
 * Plan item 6 replaces the real billing service; the acceptance bar is that
 * every existing call site in apps/dhow keeps working UNCHANGED against the
 * new implementation. That means the *exact* request/response shape, and the
 * *exact* failure behaviour (throw vs. silently proceed) of every exported
 * function here is the contract a real server must be built against. Nothing
 * in this file asserts what billing.ts *should* do -- only what it does.
 *
 * Three module variants are imported (env read into module-scope constants
 * at import time, so each variant needs `vi.resetModules()` + a fresh
 * dynamic import -- the module specifier is fixed and known at author time,
 * so this is the one deliberate exception to static-import-only: it is the
 * same env-before-dynamic-import technique agent-loop.test.ts uses, for the
 * same reason -- module-scope `const`s frozen at import time make a static
 * import unable to see a second env value):
 *   - `billingOn`          USE_BILLING=true,  BILLING_API_URL -> live local mock
 *   - `billingOff`         USE_BILLING=false, BILLING_API_URL -> live local mock (unused)
 *   - `billingUnreachable` USE_BILLING=true,  BILLING_API_URL -> a port nothing listens on
 *
 * `@/di/container`, `next/navigation` and `@/app/lib/auth` are mocked so the
 * DI graph (real Mongo/Redis-backed repositories) and Next's request-scoped
 * redirect machinery never run. `@/app/lib/auth` in particular is mocked
 * rather than exercised for real: `requireAuth`'s own contract belongs to
 * auth.ts, out of this file's scope; billing.ts just calls it and reacts to
 * what it returns.
 */

// ---------------------------------------------------------------------------
// Mocks. vi.hoisted() keeps these vi.fn() references stable across the
// vi.resetModules() calls below -- resetModules() forces the vi.mock()
// factories to re-run and would otherwise hand billing.ts a *different*
// container/redirect/auth mock object per variant.
// ---------------------------------------------------------------------------

const containerMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/di/container", () => ({
    container: { resolve: containerMocks.resolve },
}));

const navMocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({
    redirect: navMocks.redirect,
}));

const authMocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/app/lib/auth", () => ({
    requireAuth: authMocks.requireAuth,
    getUserFromSessionId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Local node:http stand-in for the billing service. One handler is swapped
// per test; every request it receives is captured for shape assertions.
// ---------------------------------------------------------------------------

type Captured = {
    method: string;
    url: string;
    auth: string | undefined;
    contentType: string | undefined;
    body: unknown;
};
type MockResult = { status: number; body?: unknown; raw?: string };

let handler: (c: Captured) => MockResult = () => ({ status: 200, body: {} });
const requests: Captured[] = [];

function addressInfo(s: http.Server): AddressInfo {
    const addr = s.address();
    if (addr === null || typeof addr === "string") {
        throw new Error("expected server to be listening on a TCP port");
    }
    return addr;
}

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        let body: unknown = undefined;
        if (raw) {
            try {
                body = JSON.parse(raw);
            } catch {
                body = raw;
            }
        }
        const captured: Captured = {
            method: req.method ?? "",
            url: req.url ?? "",
            auth: req.headers["authorization"],
            contentType: req.headers["content-type"],
            body,
        };
        requests.push(captured);
        const result = handler(captured);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.raw ?? JSON.stringify(result.body ?? {}));
    });
});

const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(addressInfo(server).port));
});

// A port guaranteed to refuse connections: bind an ephemeral port, then
// release it immediately. Confirmed locally to produce a fetch rejection
// (TypeError "fetch failed", cause.code === "ECONNREFUSED") fast, unlike
// e.g. port 1 which can behave inconsistently across OSes.
const deadServer = http.createServer();
const deadPort = await new Promise<number>((resolve) => {
    deadServer.listen(0, "127.0.0.1", () => resolve(addressInfo(deadServer).port));
});
await new Promise<void>((resolve) => deadServer.close(() => resolve()));

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---------------------------------------------------------------------------
// The three module variants. See file header for why dynamic import is
// required here.
// ---------------------------------------------------------------------------

process.env.BILLING_API_URL = `http://127.0.0.1:${port}`;
process.env.BILLING_API_KEY = "test-key";
process.env.USE_BILLING = "true";
const billingOn = await import("@/app/lib/billing");

vi.resetModules();
process.env.USE_BILLING = "false";
const billingOff = await import("@/app/lib/billing");

vi.resetModules();
process.env.USE_BILLING = "true";
process.env.BILLING_API_URL = `http://127.0.0.1:${deadPort}`;
const billingUnreachable = await import("@/app/lib/billing");

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const validCustomer = (over: Record<string, unknown> = {}) => ({
    id: "cust_1",
    userId: "user_1",
    email: "user@x.com",
    stripeCustomerId: "cus_stripe1",
    createdAt: new Date().toISOString(),
    ...over,
});

function withRepos(repos: Record<string, unknown>) {
    containerMocks.resolve.mockImplementation((token: string) => {
        if (token in repos) return repos[token];
        throw new Error(`test did not stub container.resolve("${token}")`);
    });
}

beforeEach(() => {
    requests.length = 0;
    handler = () => ({ status: 200, body: {} });
    // restoreMocks:true (vitest.config.ts) strips vi.fn() implementations
    // before every test, so defaults are re-established here rather than in
    // the vi.hoisted() factories above.
    navMocks.redirect.mockImplementation((url: string) => {
        throw new Error(`REDIRECT:${url}`);
    });
    authMocks.requireAuth.mockResolvedValue({
        id: "user_1",
        supabaseId: "user_1",
        email: "user@x.com",
        createdAt: new Date().toISOString(),
    });
    containerMocks.resolve.mockImplementation(() => ({}));
});

// =============================================================================
// UsageTracker
// =============================================================================

describe("UsageTracker", () => {
    // The port replaces this with something durable (a queue, a DB row per
    // item, whatever) -- these pin the in-memory buffer semantics every
    // caller (agent-tools.ts, copilot.ts, rag-worker.ts, the use-cases) is
    // written against today.

    it("flush on a tracker that was never tracked into returns an empty array", () => {
        const t = new billingOn.UsageTracker();
        expect(t.flush()).toEqual([]);
    });

    it("track() buffers items in insertion order; flush() returns exactly them", () => {
        const t = new billingOn.UsageTracker();
        const a = { type: "LLM_USAGE", modelName: "gpt-4", inputTokens: 1, outputTokens: 2, context: "a" } as const;
        const b = { type: "FIRECRAWL_SCRAPE_USAGE", context: "b" } as const;
        t.track(a);
        t.track(b);
        expect(t.flush()).toEqual([a, b]);
    });

    it("flush() empties the buffer -- a second flush returns [], not the same items again", () => {
        const t = new billingOn.UsageTracker();
        t.track({ type: "FIRECRAWL_SCRAPE_USAGE", context: "once" });
        expect(t.flush()).toHaveLength(1);
        expect(t.flush()).toEqual([]);
    });

    it("items tracked after a flush land in the *next* flush only, not retroactively in the last one", () => {
        const t = new billingOn.UsageTracker();
        t.track({ type: "FIRECRAWL_SCRAPE_USAGE", context: "first-batch" });
        const firstFlush = t.flush();
        t.track({ type: "FIRECRAWL_SCRAPE_USAGE", context: "second-batch" });
        expect(firstFlush).toEqual([{ type: "FIRECRAWL_SCRAPE_USAGE", context: "first-batch" }]);
        expect(t.flush()).toEqual([{ type: "FIRECRAWL_SCRAPE_USAGE", context: "second-batch" }]);
    });

    it("track() performs no runtime validation -- a malformed item is buffered and flushed as-is", () => {
        // TypeScript's UsageItem discriminated union is a compile-time-only
        // guard here; nothing in the class calls .parse()/.safeParse(). A
        // server-side reimplementation that validates on `track()` would
        // reject input this file accepts today. `as never` deliberately
        // bypasses the compiler to construct that invalid input for the
        // test -- there's no runtime-checked way to do it, which is exactly
        // the behaviour under test.
        const t = new billingOn.UsageTracker();
        const malformed = { type: "NOT_A_REAL_TYPE", whatever: 123 } as never;
        t.track(malformed);
        expect(t.flush()).toEqual([{ type: "NOT_A_REAL_TYPE", whatever: 123 }]);
    });
});

// =============================================================================
// Direct billing-service calls (USE_BILLING=true, live local mock)
// =============================================================================

describe("getBillingCustomer(id)", () => {
    it("GETs /api/customers/:id with bearer auth, no body, and returns the parsed Customer", async () => {
        const customer = validCustomer();
        handler = () => ({ status: 200, body: customer });

        const result = await billingOn.getBillingCustomer("cust_1");

        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("GET");
        expect(requests[0].url).toBe("/api/customers/cust_1");
        expect(requests[0].auth).toBe("Bearer test-key");
        expect(requests[0].contentType).toBe("application/json");
        expect(requests[0].body).toBeUndefined();
        expect(result).toEqual(customer);
    });

    it("non-2xx: throws, does not return null -- despite the `Customer | null` return type", async () => {
        // The signature promises `Promise<Customer | null>` but the function
        // body has no code path that returns null: on any failure it throws
        // before ever reaching a `return`. Downstream `if (!customer)`
        // guards (getCustomerForUserId, requireBillingCustomer) are
        // therefore unreachable today -- a straight port must not "fix"
        // this by making them reachable, since nothing exercises that path.
        handler = () => ({ status: 404, raw: "customer not found" });
        await expect(billingOn.getBillingCustomer("missing")).rejects.toThrow(
            /Failed to fetch billing customer: 404 Not Found customer not found/
        );
    });

    it("2xx with a body that fails Customer schema validation: throws a distinct parse error", async () => {
        handler = () => ({ status: 200, body: { id: "cust_1" } }); // missing required fields
        await expect(billingOn.getBillingCustomer("cust_1")).rejects.toThrow(
            /Failed to parse billing customer:/
        );
    });
});

describe("syncWithStripe(customerId)", () => {
    it("POSTs /api/customers/:id/sync-with-stripe with no body and resolves void, ignoring the response body entirely", async () => {
        handler = () => ({ status: 200, raw: "not even json" }); // would blow up .json() if it were called
        await expect(billingOn.syncWithStripe("cust_1")).resolves.toBeUndefined();
        expect(requests[0].method).toBe("POST");
        expect(requests[0].url).toBe("/api/customers/cust_1/sync-with-stripe");
        expect(requests[0].body).toBeUndefined();
    });

    it("non-2xx: throws formatted error", async () => {
        handler = () => ({ status: 500, raw: "stripe down" });
        await expect(billingOn.syncWithStripe("cust_1")).rejects.toThrow(
            /Failed to sync with stripe: 500 Internal Server Error stripe down/
        );
    });
});

describe("authorize(customerId, request)", () => {
    it("POSTs the AuthorizeRequest verbatim and returns {success:true} unchanged", async () => {
        handler = () => ({ status: 200, body: { success: true } });
        const result = await billingOn.authorize("cust_1", { type: "use_credits" });

        expect(requests[0].method).toBe("POST");
        expect(requests[0].url).toBe("/api/customers/cust_1/authorize");
        expect(requests[0].body).toEqual({ type: "use_credits" });
        expect(result).toEqual({ success: true });
    });

    it("passes through the discriminated union's `data` payload for the 'agent_response' variant", async () => {
        handler = () => ({ status: 200, body: { success: true } });
        await billingOn.authorize("cust_1", {
            type: "agent_response",
            data: { agentModels: ["gpt-4.1", "gpt-4o-mini"] },
        });
        expect(requests[0].body).toEqual({
            type: "agent_response",
            data: { agentModels: ["gpt-4.1", "gpt-4o-mini"] },
        });
    });

    it("a 2xx {success:false, error} response resolves normally -- it is NOT thrown as an exception", async () => {
        // This is the credit-denial path every call site branches on via
        // `if (!result.success)`. It only works because authorize() treats
        // "denied" as a successful HTTP call with a false-y payload, not as
        // a rejection.
        handler = () => ({ status: 200, body: { success: false, error: "Not enough credits" } });
        const result = await billingOn.authorize("cust_1", { type: "use_credits" });
        expect(result).toEqual({ success: false, error: "Not enough credits" });
    });

    it("non-2xx: THROWS (fails closed) -- the credit gate does not silently let the caller proceed", async () => {
        handler = () => ({ status: 503, raw: "billing service overloaded" });
        await expect(billingOn.authorize("cust_1", { type: "use_credits" })).rejects.toThrow(
            /Failed to authorize billing: 503 Service Unavailable billing service overloaded/
        );
    });

    it("2xx with a body missing the required `success` boolean: throws a parse error, distinct from the HTTP-failure message", async () => {
        handler = () => ({ status: 200, body: { error: "weird shape" } });
        await expect(billingOn.authorize("cust_1", { type: "use_credits" })).rejects.toThrow(
            /Failed to parse authorize billing response:/
        );
    });

    it("billing service unreachable: THROWS (fails closed) -- with a raw network error, not the formatted 'Failed to authorize billing' message", async () => {
        // *** This is the revenue-bug check the assignment calls out. ***
        // authorize() has no try/catch around fetch(): a connection failure
        // (ECONNREFUSED here, equally DNS failure / timeout / TLS failure in
        // production) makes the underlying fetch() promise reject, and that
        // rejection propagates to the caller UNCHANGED. Nothing in this repo
        // catches it and lets the request through -- verified by reading
        // every call site (billing.actions.ts, copilot.actions.ts,
        // create-copilot-cached-turn/run-copilot-cached-turn/
        // run-conversation-turn/create-project use-cases,
        // handle-composio-webhook-request use-case, rag-worker.ts): none of
        // them wrap `authorize(...)` in a try/catch that swallows the
        // rejection. So: billing.ts fails CLOSED, both at the non-2xx layer
        // (thrown Error with a formatted message, above) and the network
        // layer (thrown TypeError, here) -- not a revenue bug in this file.
        await expect(billingUnreachable.authorize("cust_1", { type: "use_credits" })).rejects.toSatisfy(
            (e: unknown) => e instanceof TypeError && !/Failed to authorize billing/.test(e.message)
        );
    });
});

describe("logUsage(customerId, request)", () => {
    it("POSTs LogUsageRequest verbatim (items array preserved in order) and resolves void, ignoring the response body", async () => {
        const items = [
            { type: "LLM_USAGE" as const, modelName: "gpt-4", inputTokens: 10, outputTokens: 20, context: "turn-1" },
            { type: "COMPOSIO_TOOL_USAGE" as const, toolSlug: "slack_send", context: "tool-call" },
        ];
        handler = () => ({ status: 200, raw: "" }); // empty body: would throw on .json() if parsed
        const result = await billingOn.logUsage("cust_1", { items });

        expect(requests[0].method).toBe("POST");
        expect(requests[0].url).toBe("/api/customers/cust_1/log-usage");
        expect(requests[0].body).toEqual({ items });
        expect(result).toBeUndefined();
    });

    it("an empty items array is still POSTed (not skipped)", async () => {
        handler = () => ({ status: 200, body: {} });
        await billingOn.logUsage("cust_1", { items: [] });
        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({ items: [] });
    });

    it("non-2xx: throws (fails closed) -- usage logging failures are not silently dropped", async () => {
        handler = () => ({ status: 500, raw: "db write failed" });
        await expect(billingOn.logUsage("cust_1", { items: [] })).rejects.toThrow(
            /Failed to log usage: 500 Internal Server Error db write failed/
        );
    });

    it("billing service unreachable: throws a raw network error (same fail-closed shape as authorize)", async () => {
        await expect(billingUnreachable.logUsage("cust_1", { items: [] })).rejects.toBeInstanceOf(TypeError);
    });
});

describe("getUsage(customerId)", () => {
    it("GETs /api/customers/:id/usage and returns the parsed UsageResponse", async () => {
        const usage = { sanctionedCredits: 1000, availableCredits: 250, usage: { LLM_USAGE: 750 } };
        handler = () => ({ status: 200, body: usage });
        const result = await billingOn.getUsage("cust_1");
        expect(requests[0].method).toBe("GET");
        expect(requests[0].url).toBe("/api/customers/cust_1/usage");
        expect(result).toEqual(usage);
    });

    it("non-2xx: throws", async () => {
        handler = () => ({ status: 401, raw: "unauthorized" });
        await expect(billingOn.getUsage("cust_1")).rejects.toThrow(
            /Failed to get usage: 401 Unauthorized unauthorized/
        );
    });
});

describe("createCustomerPortalSession(customerId, returnUrl)", () => {
    it("POSTs {returnUrl} and unwraps the response to a bare url string (not the {url} object)", async () => {
        handler = () => ({ status: 200, body: { url: "https://billing.example/portal/abc" } });
        const result = await billingOn.createCustomerPortalSession("cust_1", "https://app.example/return");
        expect(requests[0].url).toBe("/api/customers/cust_1/customer-portal-session");
        expect(requests[0].body).toEqual({ returnUrl: "https://app.example/return" });
        expect(result).toBe("https://billing.example/portal/abc");
        expect(typeof result).toBe("string");
    });

    it("non-2xx: throws", async () => {
        handler = () => ({ status: 500, raw: "boom" });
        await expect(billingOn.createCustomerPortalSession("cust_1", "https://x")).rejects.toThrow(
            /Failed to get customer portal url: 500 Internal Server Error boom/
        );
    });
});

describe("getPrices()", () => {
    it("GETs /api/prices (no customer id in the path) and returns the parsed PricesResponse", async () => {
        const prices = { prices: { free: { monthly: 0 }, starter: { monthly: 19 }, pro: { monthly: 49 } } };
        handler = () => ({ status: 200, body: prices });
        const result = await billingOn.getPrices();
        expect(requests[0].method).toBe("GET");
        expect(requests[0].url).toBe("/api/prices");
        expect(result).toEqual(prices);
    });

    it("non-2xx: throws", async () => {
        handler = () => ({ status: 500, raw: "boom" });
        await expect(billingOn.getPrices()).rejects.toThrow(/Failed to get prices: 500 Internal Server Error boom/);
    });
});

describe("updateSubscriptionPlan(customerId, request)", () => {
    it("POSTs {plan, returnUrl} and unwraps the response to a bare url string", async () => {
        handler = () => ({ status: 200, body: { url: "https://billing.example/checkout/xyz" } });
        const result = await billingOn.updateSubscriptionPlan("cust_1", { plan: "pro", returnUrl: "https://app.example/return" });
        expect(requests[0].url).toBe("/api/customers/cust_1/update-sub-session");
        expect(requests[0].body).toEqual({ plan: "pro", returnUrl: "https://app.example/return" });
        expect(result).toBe("https://billing.example/checkout/xyz");
    });

    it("non-2xx: throws", async () => {
        handler = () => ({ status: 400, raw: "invalid plan" });
        await expect(
            billingOn.updateSubscriptionPlan("cust_1", { plan: "pro", returnUrl: "https://x" })
        ).rejects.toThrow(/Failed to update subscription plan: 400 Bad Request invalid plan/);
    });
});

describe("getEligibleModels(customerId)", () => {
    it("GETs /api/customers/:id/models and returns the parsed ModelsResponse", async () => {
        const models = { agentModels: [{ name: "gpt-4.1", eligible: true, plan: "free" }] };
        handler = () => ({ status: 200, body: models });
        const result = await billingOn.getEligibleModels("cust_1");
        expect(requests[0].method).toBe("GET");
        expect(requests[0].url).toBe("/api/customers/cust_1/models");
        expect(result).toEqual(models);
    });

    it("non-2xx: throws", async () => {
        handler = () => ({ status: 500, raw: "boom" });
        await expect(billingOn.getEligibleModels("cust_1")).rejects.toThrow(
            /Failed to get eligible models: 500 Internal Server Error boom/
        );
    });
});

// =============================================================================
// getCustomerForUserId / getCustomerIdForProject
// =============================================================================

describe("getCustomerForUserId(userId)", () => {
    it("user not found in usersRepository: throws 'User not found'", async () => {
        withRepos({ usersRepository: { fetch: vi.fn().mockResolvedValue(null) } });
        await expect(billingOn.getCustomerForUserId("u1")).rejects.toThrow("User not found");
    });

    it("user found but has no billingCustomerId: returns null WITHOUT calling the billing service", async () => {
        withRepos({ usersRepository: { fetch: vi.fn().mockResolvedValue({ id: "u1" }) } });
        const result = await billingOn.getCustomerForUserId("u1");
        expect(result).toBeNull();
        expect(requests).toHaveLength(0);
    });

    it("user found with billingCustomerId: fetches and returns the Customer from the billing service", async () => {
        const customer = validCustomer({ id: "cust_from_user" });
        withRepos({ usersRepository: { fetch: vi.fn().mockResolvedValue({ id: "u1", billingCustomerId: "cust_from_user" }) } });
        handler = () => ({ status: 200, body: customer });
        const result = await billingOn.getCustomerForUserId("u1");
        expect(requests[0].url).toBe("/api/customers/cust_from_user");
        expect(result).toEqual(customer);
    });
});

describe("getCustomerIdForProject(projectId)", () => {
    it("project not found: throws 'Project not found'", async () => {
        withRepos({ projectsRepository: { fetch: vi.fn().mockResolvedValue(null) } });
        await expect(billingOn.getCustomerIdForProject("p1")).rejects.toThrow("Project not found");
    });

    it("project's creator has no billing customer id: throws 'User has no billing customer id'", async () => {
        containerMocks.resolve.mockImplementation((token: string) => {
            if (token === "projectsRepository") return { fetch: vi.fn().mockResolvedValue({ createdByUserId: "u1" }) };
            if (token === "usersRepository") return { fetch: vi.fn().mockResolvedValue({ id: "u1" }) }; // no billingCustomerId
            throw new Error(`unexpected token ${token}`);
        });
        await expect(billingOn.getCustomerIdForProject("p1")).rejects.toThrow("User has no billing customer id");
    });

    it("resolves through project -> creator -> billing customer, returning just the id string", async () => {
        containerMocks.resolve.mockImplementation((token: string) => {
            if (token === "projectsRepository") return { fetch: vi.fn().mockResolvedValue({ createdByUserId: "u1" }) };
            if (token === "usersRepository") return { fetch: vi.fn().mockResolvedValue({ id: "u1", billingCustomerId: "cust_1" }) };
            throw new Error(`unexpected token ${token}`);
        });
        handler = () => ({ status: 200, body: validCustomer({ id: "cust_1" }) });
        const result = await billingOn.getCustomerIdForProject("p1");
        expect(result).toBe("cust_1");
        expect(typeof result).toBe("string");
    });
});

// =============================================================================
// requireBillingCustomer()
// =============================================================================

describe("requireBillingCustomer() with USE_BILLING=false", () => {
    it("returns the hardcoded guest customer (id ALWAYS 'guest-user') with userId swapped to the real authenticated user's id", async () => {
        authMocks.requireAuth.mockResolvedValue({ id: "real-user-42", supabaseId: "x", createdAt: new Date().toISOString() });
        const usersResolve = vi.fn();
        withRepos({ usersRepository: { fetch: usersResolve } });

        const result = await billingOff.requireBillingCustomer();

        expect(result.id).toBe("guest-user"); // NOT "real-user-42" -- only userId is swapped
        expect(result.userId).toBe("real-user-42");
        expect(result.subscriptionPlan).toBe("free");
        expect(result.subscriptionStatus).toBe("active");
    });

    it("still calls container.resolve('usersRepository') even though the resolved repo is never used on this path", async () => {
        // requireBillingCustomer() resolves usersRepository unconditionally,
        // BEFORE checking USE_BILLING. If a real usersRepository token isn't
        // registered in a given deployment, that alone can throw even with
        // billing fully disabled. A port must preserve (or deliberately and
        // visibly drop) this eager resolve.
        await billingOff.requireBillingCustomer();
        expect(containerMocks.resolve).toHaveBeenCalledWith("usersRepository");
    });

    it("never calls the billing service", async () => {
        await billingOff.requireBillingCustomer();
        expect(requests).toHaveLength(0);
    });
});

describe("requireBillingCustomer() with USE_BILLING=true", () => {
    it("no email on the authenticated user: redirects to /onboarding before touching billing", async () => {
        authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", createdAt: new Date().toISOString() }); // no email
        await expect(billingOn.requireBillingCustomer()).rejects.toThrow("REDIRECT:/onboarding");
        expect(requests).toHaveLength(0);
    });

    it("user already has a billingCustomerId: fetches the existing Customer, does not create one", async () => {
        authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", email: "u1@x.com", billingCustomerId: "cust_existing", createdAt: new Date().toISOString() });
        const customer = validCustomer({ id: "cust_existing" });
        handler = () => ({ status: 200, body: customer });

        const result = await billingOn.requireBillingCustomer();

        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("GET");
        expect(requests[0].url).toBe("/api/customers/cust_existing");
        expect(result).toEqual(customer);
    });

    it("user has no billingCustomerId: creates a customer (POST /api/customers with {userId, email}), then persists the id via usersRepository.updateBillingCustomerId, and returns the created Customer", async () => {
        authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", email: "u1@x.com", createdAt: new Date().toISOString() }); // no billingCustomerId
        const updateBillingCustomerId = vi.fn().mockResolvedValue(undefined);
        withRepos({ usersRepository: { updateBillingCustomerId } });
        const created = validCustomer({ id: "cust_new" });
        handler = () => ({ status: 200, body: created });

        const result = await billingOn.requireBillingCustomer();

        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("POST");
        expect(requests[0].url).toBe("/api/customers");
        expect(requests[0].body).toEqual({ userId: "u1", email: "u1@x.com" });
        expect(updateBillingCustomerId).toHaveBeenCalledWith("u1", "cust_new");
        expect(result).toEqual(created);
    });

    it("customer creation fails (non-2xx from the billing service): throws, and never reaches usersRepository.updateBillingCustomerId", async () => {
        // createBillingCustomer() is unexported (internal to requireBillingCustomer's
        // "no billingCustomerId yet" branch) but shares the exact same
        // fetch/!response.ok/throw shape as every other function here --
        // pinned through its only caller.
        authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", email: "u1@x.com", createdAt: new Date().toISOString() });
        const updateBillingCustomerId = vi.fn();
        withRepos({ usersRepository: { updateBillingCustomerId } });
        handler = () => ({ status: 500, raw: "db unavailable" });

        await expect(billingOn.requireBillingCustomer()).rejects.toThrow(
            /Failed to create billing customer: 500 Internal Server Error db unavailable/
        );
        expect(updateBillingCustomerId).not.toHaveBeenCalled();
    });
});

// =============================================================================
// requireActiveBillingSubscription()
// =============================================================================

describe("requireActiveBillingSubscription()", () => {
    it("USE_BILLING=false: returns the guest customer and never redirects, regardless of subscription status", async () => {
        const result = await billingOff.requireActiveBillingSubscription();
        expect(result.id).toBe("guest-user");
        expect(navMocks.redirect).not.toHaveBeenCalled();
    });

    it.each(["active", "past_due"] as const)(
        "USE_BILLING=true, subscriptionStatus='%s': returns the customer, does not redirect",
        async (status) => {
            authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", email: "u1@x.com", billingCustomerId: "cust_1", createdAt: new Date().toISOString() });
            handler = () => ({ status: 200, body: validCustomer({ subscriptionStatus: status }) });

            const result = await billingOn.requireActiveBillingSubscription();

            expect(result.subscriptionStatus).toBe(status);
            expect(navMocks.redirect).not.toHaveBeenCalled();
        }
    );

    it("USE_BILLING=true, subscriptionStatus missing (neither active nor past_due): redirects to /billing", async () => {
        authMocks.requireAuth.mockResolvedValue({ id: "u1", supabaseId: "u1", email: "u1@x.com", billingCustomerId: "cust_1", createdAt: new Date().toISOString() });
        handler = () => ({ status: 200, body: validCustomer() }); // subscriptionStatus omitted (optional field)

        await expect(billingOn.requireActiveBillingSubscription()).rejects.toThrow("REDIRECT:/billing");
    });
});
