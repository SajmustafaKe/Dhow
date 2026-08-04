import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for data-source.actions.ts, ahead of the port into
 * apps/dhowx. Every export is `authCheck()` then a single controller.execute()
 * call.
 *
 * `listDocsInDataSource` gets its own describe block: it accepts `page` and
 * `limit` parameters but **never forwards them to the controller** — the
 * controller call only carries `{caller, userId, sourceId}`. `total` is then
 * computed as `docs.length` of whatever the controller returned, not a true
 * cross-page count. Pinned as a functional bug below and flagged in the
 * report: any caller passing `page: 2` silently gets page-1 behavior.
 */

type Controller = { execute: ReturnType<typeof vi.fn> };
const controllers: Record<string, Controller> = {};

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((key: string) => {
            controllers[key] ??= { execute: vi.fn() };
            return controllers[key];
        }),
    },
}));

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const user = { id: "u1", supabaseId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./data-source.actions");
}

const cases: Array<{
    name: string;
    controllerKey: string;
    call: (fns: Record<string, (...args: unknown[]) => unknown>) => unknown;
    expectedArgs: Record<string, unknown>;
}> = [
    {
        name: "getDataSource",
        controllerKey: "fetchDataSourceController",
        call: (fns) => fns.getDataSource("src_1"),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1" },
    },
    {
        name: "listDataSources",
        controllerKey: "listDataSourcesController",
        call: (fns) => fns.listDataSources("proj_1"),
        expectedArgs: { caller: "user", userId: user.id, projectId: "proj_1" },
    },
    {
        name: "createDataSource",
        controllerKey: "createDataSourceController",
        call: (fns) => fns.createDataSource({ projectId: "proj_1", name: "N", data: { type: "text" } as never }),
        // `description` defaults to '' when omitted; `status` defaults to 'pending'.
        expectedArgs: { caller: "user", userId: user.id, data: { projectId: "proj_1", name: "N", description: "", status: "pending", data: { type: "text" } } },
    },
    {
        name: "recrawlWebDataSource",
        controllerKey: "recrawlWebDataSourceController",
        call: (fns) => fns.recrawlWebDataSource("src_1"),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1" },
    },
    {
        name: "deleteDataSource",
        controllerKey: "deleteDataSourceController",
        call: (fns) => fns.deleteDataSource("src_1"),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1" },
    },
    {
        name: "toggleDataSource",
        controllerKey: "toggleDataSourceController",
        call: (fns) => fns.toggleDataSource("src_1", false),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1", active: false },
    },
    {
        name: "addDocsToDataSource",
        controllerKey: "addDocsToDataSourceController",
        call: (fns) => fns.addDocsToDataSource({ sourceId: "src_1", docData: [{ name: "f1.txt", data: { type: "text" } as never }] }),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1", docs: [{ name: "f1.txt", data: { type: "text" } }] },
    },
    {
        name: "deleteDocFromDataSource",
        controllerKey: "deleteDocFromDataSourceController",
        call: (fns) => fns.deleteDocFromDataSource({ docId: "doc_1" }),
        expectedArgs: { caller: "user", userId: user.id, docId: "doc_1" },
    },
    {
        name: "getDownloadUrlForFile",
        controllerKey: "getDownloadUrlForFileController",
        call: (fns) => fns.getDownloadUrlForFile("file_1"),
        expectedArgs: { caller: "user", userId: user.id, fileId: "file_1" },
    },
    {
        name: "getUploadUrlsForFilesDataSource",
        controllerKey: "getUploadUrlsForFilesController",
        call: (fns) => fns.getUploadUrlsForFilesDataSource("src_1", [{ name: "f.txt", type: "text/plain", size: 10 }]),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1", files: [{ name: "f.txt", type: "text/plain", size: 10 }] },
    },
    {
        name: "updateDataSource",
        controllerKey: "updateDataSourceController",
        call: (fns) => fns.updateDataSource({ sourceId: "src_1", description: "new desc" }),
        expectedArgs: { caller: "user", userId: user.id, sourceId: "src_1", data: { description: "new desc" } },
    },
];

for (const { name, controllerKey, call, expectedArgs } of cases) {
    describe(name, () => {
        it("authenticates first, then forwards the exact request shape to the controller", async () => {
            const fns = await loadActions();
            controllers[controllerKey].execute.mockResolvedValue("ok");

            await call(fns as never);

            expect(authCheck).toHaveBeenCalledTimes(1);
            expect(controllers[controllerKey].execute).toHaveBeenCalledWith(expectedArgs);
        });

        it("propagates an authCheck failure and never reaches the controller", async () => {
            authCheck.mockRejectedValue(new Error("User not authenticated"));
            const fns = await loadActions();

            await expect(call(fns as never)).rejects.toThrow("User not authenticated");
            expect(controllers[controllerKey].execute).not.toHaveBeenCalled();
        });
    });
}

describe("listDocsInDataSource — page/limit are accepted but silently ignored", () => {
    it("does not forward page or limit to the controller at all", async () => {
        const { listDocsInDataSource } = await loadActions();
        controllers["listDocsInDataSourceController"].execute.mockResolvedValue([{ id: "doc_1" }, { id: "doc_2" }]);

        await listDocsInDataSource({ sourceId: "src_1", page: 2, limit: 5 });

        // BUG: page/limit never appear in this call. Requesting "page 2" is
        // indistinguishable from "page 1" — the controller call is identical.
        expect(controllers["listDocsInDataSourceController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            sourceId: "src_1",
        });
    });

    it("`total` is the length of whatever the controller returned for this one call, not a true cross-page count", async () => {
        const { listDocsInDataSource } = await loadActions();
        const docs = [{ id: "doc_1" }, { id: "doc_2" }, { id: "doc_3" }];
        controllers["listDocsInDataSourceController"].execute.mockResolvedValue(docs);

        const result = await listDocsInDataSource({ sourceId: "src_1" });

        expect(result).toEqual({ files: docs, total: 3 });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { listDocsInDataSource } = await loadActions();

        await expect(listDocsInDataSource({ sourceId: "src_1" })).rejects.toThrow("User not authenticated");
        expect(controllers["listDocsInDataSourceController"].execute).not.toHaveBeenCalled();
    });
});
