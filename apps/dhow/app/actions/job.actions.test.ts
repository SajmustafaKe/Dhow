import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for job.actions.ts, ahead of the port into
 * apps/dhowx. Both exports are `authCheck()` then a single
 * controller.execute() call.
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
    return await import("./job.actions");
}

describe("listJobs", () => {
    it("authenticates first, then forwards {caller, userId, projectId, filters, cursor, limit}", async () => {
        const { listJobs } = await loadActions();
        controllers["listJobsController"].execute.mockResolvedValue({ items: [], nextCursor: null });

        const result = await listJobs({ projectId: "proj_1", filters: { status: "completed" } as never, cursor: "c1", limit: 10 });

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["listJobsController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            filters: { status: "completed" },
            cursor: "c1",
            limit: 10,
        });
        expect(result).toEqual({ items: [], nextCursor: null });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { listJobs } = await loadActions();

        await expect(listJobs({ projectId: "proj_1" })).rejects.toThrow("User not authenticated");
        expect(controllers["listJobsController"].execute).not.toHaveBeenCalled();
    });
});

describe("fetchJob", () => {
    it("authenticates first, then forwards {caller, userId, jobId}", async () => {
        const { fetchJob } = await loadActions();
        const job = { id: "job_1", status: "running" };
        controllers["fetchJobController"].execute.mockResolvedValue(job);

        await expect(fetchJob({ jobId: "job_1" })).resolves.toBe(job);
        expect(controllers["fetchJobController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            jobId: "job_1",
        });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { fetchJob } = await loadActions();

        await expect(fetchJob({ jobId: "job_1" })).rejects.toThrow("User not authenticated");
        expect(controllers["fetchJobController"].execute).not.toHaveBeenCalled();
    });
});
