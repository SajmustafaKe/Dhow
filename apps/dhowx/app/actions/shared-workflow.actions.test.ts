import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for shared-workflow.actions.ts, ahead of the port
 * into apps/dhowx.
 *
 * Both exports gate on `requireAuth()` (mocked here; its own USE_AUTH branch
 * is exercised in app/lib/auth's own callers, not re-tested here). The
 * behaviors worth pinning:
 *   - `createSharedWorkflowFromJson` validates the parsed JSON against the
 *     full `Workflow` zod schema and throws a specific, path-annotated
 *     message on failure — not a generic "invalid JSON".
 *   - The TTL is a fixed 24h (86400s), returned to the caller as
 *     `ttlSeconds` — a UI relying on this to show a countdown breaks
 *     silently if the constant changes without the return value changing.
 *   - `loadSharedWorkflow` collapses "no such id" and "expired" into the
 *     *same* message, `'Not found or expired'` — the UI cannot distinguish
 *     the two failure modes from the thrown error alone.
 *   - The `Workflow` schema is re-validated on *read*, not just on write: a
 *     document that fails to parse throws the same "Invalid workflow JSON"
 *     error as a bad write, even though nothing about the read request was
 *     malformed.
 *
 * `nanoid` is real (deterministic enough for `toMatch(/^[A-Za-z0-9_-]+$/)`
 * assertions); only `@/app/lib/mongodb` and `@/app/lib/auth` are mocked.
 */

const requireAuth = vi.fn();
vi.mock("@/app/lib/auth", () => ({ requireAuth }));

const insertOne = vi.fn();
const findOne = vi.fn();
vi.mock("@/app/lib/mongodb", () => ({
    db: { collection: vi.fn(() => ({ insertOne, findOne })) },
}));

const user = { id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

function validWorkflow() {
    return {
        agents: [
            {
                name: "main",
                type: "conversation",
                description: "d",
                instructions: "i",
                model: "gpt-4o",
                ragReturnType: "chunks",
                ragK: 3,
            },
        ],
        prompts: [],
        tools: [],
        startAgent: "main",
        lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    };
}

beforeEach(() => {
    requireAuth.mockReset();
    requireAuth.mockResolvedValue(user);
    insertOne.mockReset();
    findOne.mockReset();
});

async function loadActions() {
    return await import("./shared-workflow.actions");
}

describe("createSharedWorkflowFromJson", () => {
    it("requires auth before touching the JSON at all", async () => {
        requireAuth.mockRejectedValue(new Error("redirected to login"));
        const { createSharedWorkflowFromJson } = await loadActions();

        await expect(createSharedWorkflowFromJson("not json")).rejects.toThrow("redirected to login");
        expect(insertOne).not.toHaveBeenCalled();
    });

    it("malformed (non-JSON) input throws the raw JSON.parse SyntaxError", async () => {
        const { createSharedWorkflowFromJson } = await loadActions();

        await expect(createSharedWorkflowFromJson("{not valid")).rejects.toThrow(SyntaxError);
    });

    it("valid JSON that fails the Workflow schema throws a path-annotated 'Invalid workflow JSON' message", async () => {
        const { createSharedWorkflowFromJson } = await loadActions();

        await expect(createSharedWorkflowFromJson(JSON.stringify({ startAgent: "main" }))).rejects.toThrow(
            /^Invalid workflow JSON: agents: /
        );
        expect(insertOne).not.toHaveBeenCalled();
    });

    it("a valid workflow is stored with a 24h (86400s) TTL, and that TTL is echoed back to the caller", async () => {
        insertOne.mockResolvedValue({ acknowledged: true });
        const { createSharedWorkflowFromJson } = await loadActions();

        const result = await createSharedWorkflowFromJson(JSON.stringify(validWorkflow()));

        expect(result.ttlSeconds).toBe(86400);
        expect(result.id).toMatch(/^[A-Za-z0-9_-]+$/);
        const [doc] = insertOne.mock.calls[0];
        expect(doc._id).toBe(result.id);
        expect(doc.expiresAt.getTime() - doc.createdAt.getTime()).toBe(86400 * 1000);
    });
});

describe("loadSharedWorkflow", () => {
    it("requires auth before querying Mongo", async () => {
        requireAuth.mockRejectedValue(new Error("redirected to login"));
        const { loadSharedWorkflow } = await loadActions();

        await expect(loadSharedWorkflow("abc")).rejects.toThrow("redirected to login");
        expect(findOne).not.toHaveBeenCalled();
    });

    it("throws 'Not found or expired' when no document matches the id", async () => {
        findOne.mockResolvedValue(null);
        const { loadSharedWorkflow } = await loadActions();

        await expect(loadSharedWorkflow("missing")).rejects.toThrow("Not found or expired");
    });

    it("throws the SAME 'Not found or expired' message for a present-but-expired document — the two cases are indistinguishable to the caller", async () => {
        findOne.mockResolvedValue({ workflow: validWorkflow(), expiresAt: new Date(Date.now() - 1000) });
        const { loadSharedWorkflow } = await loadActions();

        await expect(loadSharedWorkflow("expired")).rejects.toThrow("Not found or expired");
    });

    it("re-validates the stored workflow against the Workflow schema on read, not just on write", async () => {
        findOne.mockResolvedValue({ workflow: { startAgent: "main" }, expiresAt: new Date(Date.now() + 60_000) });
        const { loadSharedWorkflow } = await loadActions();

        await expect(loadSharedWorkflow("bad-doc")).rejects.toThrow(/^Invalid workflow JSON: /);
    });

    it("returns the schema-parsed workflow with defaults filled in for fields the stored doc omitted", async () => {
        const raw = validWorkflow();
        // @ts-expect-error -- intentionally simulate a stored doc missing a
        // defaulted field, to prove the read path actually fills it in.
        delete raw.agents[0].ragReturnType;
        findOne.mockResolvedValue({ workflow: raw, expiresAt: new Date(Date.now() + 60_000) });
        const { loadSharedWorkflow } = await loadActions();

        const result = await loadSharedWorkflow("ok");

        expect(result.startAgent).toBe("main");
        // ragReturnType is z.enum(...).default('chunks') with no trailing
        // .optional(), so it's reliably filled in when the stored JSON omits it.
        expect(result.agents[0].ragReturnType).toBe("chunks");
    });
});
