import { describe, it, expect, vi, beforeEach } from "vitest";
import { AddDocsToDataSourceUseCase } from "./add-docs-to-data-source.use-case";
import { NotFoundError, QuotaExceededError } from "@/src/entities/errors/common";

/**
 * Characterization tests for AddDocsToDataSourceUseCase, ahead of the port
 * into apps/dhowx.
 *
 * This use-case deviates from the common authz->quota->work skeleton shared
 * by the rest of this directory: it fetches the DataSource FIRST (to derive
 * `source.projectId` for the authz/quota calls) and only 404s BEFORE authz
 * or quota are ever touched. A port that reorders this to "authorize first"
 * would need a projectId from somewhere else in the request shape, and would
 * change what an unauthenticated caller learns about a bad sourceId.
 *
 * The other load-bearing pin is the final `update` call: it unconditionally
 * resets `status`/`billingError`/`attempts`, even overwriting an existing
 * error state, and passes `bumpVersion=true`. If `bulkCreate` throws, this
 * reset never happens and the source is left in whatever state it was in
 * before — pinned explicitly since "the docs got added but nothing else
 * changed" is easy to accidentally silently swallow during a port.
 */

const fetch = vi.fn();
const update = vi.fn();
const bulkCreate = vi.fn();
const authorize = vi.fn();
const assertAndConsumeProjectAction = vi.fn();

const dataSourcesRepository = { fetch, update } as never;
const dataSourceDocsRepository = { bulkCreate } as never;
const projectActionAuthorizationPolicy = { authorize } as never;
const usageQuotaPolicy = { assertAndConsumeProjectAction, assertAndConsumeRunJobAction: vi.fn() } as never;

const makeUseCase = () =>
    new AddDocsToDataSourceUseCase({
        dataSourceDocsRepository,
        dataSourcesRepository,
        usageQuotaPolicy,
        projectActionAuthorizationPolicy,
    });

const baseSource = (over: Record<string, unknown> = {}) => ({
    id: "src_1",
    name: "source",
    description: "desc",
    projectId: "proj_1",
    active: true,
    status: "ready" as const,
    version: 1,
    error: null,
    billingError: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: null,
    attempts: 0,
    lastAttemptAt: null,
    data: { type: "text" as const },
    ...over,
});

const baseRequest = (over: Record<string, unknown> = {}) => ({
    caller: "user" as const,
    userId: "user_1",
    sourceId: "src_1",
    docs: [{ name: "doc.txt", data: { type: "text" as const, content: "hello" } }],
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    fetch.mockResolvedValue(baseSource());
    authorize.mockResolvedValue(undefined);
    assertAndConsumeProjectAction.mockResolvedValue(undefined);
    bulkCreate.mockResolvedValue(["doc_1"]);
    update.mockResolvedValue(baseSource({ status: "pending" }));
});

describe("AddDocsToDataSourceUseCase.execute", () => {
    it("runs fetch -> authz -> quota -> bulkCreate -> update, in that exact order", async () => {
        const order: string[] = [];
        fetch.mockImplementation(async () => {
            order.push("fetch");
            return baseSource();
        });
        authorize.mockImplementation(async () => {
            order.push("authorize");
        });
        assertAndConsumeProjectAction.mockImplementation(async () => {
            order.push("quota");
        });
        bulkCreate.mockImplementation(async () => {
            order.push("bulkCreate");
            return ["doc_1"];
        });
        update.mockImplementation(async () => {
            order.push("update");
            return baseSource();
        });

        await makeUseCase().execute(baseRequest());

        expect(order).toEqual(["fetch", "authorize", "quota", "bulkCreate", "update"]);
    });

    it("authorizes and consumes quota using source.projectId, not any projectId on the request", async () => {
        fetch.mockResolvedValue(baseSource({ projectId: "proj_from_source" }));

        await makeUseCase().execute(baseRequest());

        expect(authorize).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: "proj_from_source" }),
        );
        expect(assertAndConsumeProjectAction).toHaveBeenCalledWith("proj_from_source");
    });

    it("passes projectId, sourceId and docs through to bulkCreate", async () => {
        const docs = [{ name: "a.txt", data: { type: "text" as const, content: "hello" } }];
        fetch.mockResolvedValue(baseSource({ projectId: "proj_9" }));

        await makeUseCase().execute(baseRequest({ sourceId: "src_1", docs }));

        expect(bulkCreate).toHaveBeenCalledWith("proj_9", "src_1", docs);
    });

    it("404s on missing source BEFORE authz or quota are ever called", async () => {
        fetch.mockResolvedValue(null);

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(NotFoundError);

        expect(authorize).not.toHaveBeenCalled();
        expect(assertAndConsumeProjectAction).not.toHaveBeenCalled();
        expect(bulkCreate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("resets status/billingError/attempts on the final update, with bumpVersion=true", async () => {
        await makeUseCase().execute(baseRequest());

        expect(update).toHaveBeenCalledWith(
            "src_1",
            { status: "pending", billingError: null, attempts: 0 },
            true,
        );
    });

    it("unconditionally clears prior error state, even when source was errored with attempts", async () => {
        // Source fixture deliberately carries a prior error state; the update
        // call must still reset it to pending/null/0 regardless.
        fetch.mockResolvedValue(
            baseSource({ status: "error", billingError: "billing failed", attempts: 5 }),
        );

        await makeUseCase().execute(baseRequest());

        expect(update).toHaveBeenCalledWith(
            "src_1",
            { status: "pending", billingError: null, attempts: 0 },
            true,
        );
    });

    it("leaves the source untouched (no update call) when bulkCreate fails", async () => {
        bulkCreate.mockRejectedValue(new Error("db write failed"));

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow("db write failed");

        expect(update).not.toHaveBeenCalled();
    });

    it("propagates a QuotaExceededError uncaught, before bulkCreate runs", async () => {
        assertAndConsumeProjectAction.mockRejectedValue(new QuotaExceededError("quota"));

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(QuotaExceededError);

        expect(bulkCreate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });
});
