import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateApiKeyUseCase, MaxKeysReachedError } from "./create-api-key.use-case";
import { BadRequestError, NotAuthorizedError } from "@/src/entities/errors/common";

/**
 * Characterization tests for CreateApiKeyUseCase, ahead of the port into
 * apps/dhowx.
 *
 * Unlike most use-cases in this directory, this one has NO usage-quota check
 * at all -- only authz, then a hard cap of 3 keys per project enforced with
 * `keys.length >= 3`. That boundary (2 succeeds, 3 throws, never a 4th key
 * created) is the single most important pin here: an off-by-one during a
 * port (`> 3` instead of `>= 3`) would silently let a 4th key through.
 *
 * `MaxKeysReachedError` is a use-case-local class exported from this file
 * that extends `BadRequestError` -- pinning the inheritance matters because
 * upstream HTTP handlers likely catch `BadRequestError` broadly to map to a
 * 400 response, and a port that makes this a plain `Error` would silently
 * fall through to a 500.
 */

const listAll = vi.fn();
const create = vi.fn();
const authorize = vi.fn();

const apiKeysRepository = { listAll, create, delete: vi.fn(), deleteAll: vi.fn(), checkAndConsumeKey: vi.fn() } as never;
const projectActionAuthorizationPolicy = { authorize } as never;

const makeUseCase = () =>
    new CreateApiKeyUseCase({
        apiKeysRepository,
        projectActionAuthorizationPolicy,
    });

const existingKey = (id: string) => ({
    id,
    projectId: "proj_1",
    key: `key_${id}`,
    createdAt: "2024-01-01T00:00:00.000Z",
});

const baseRequest = (over: Record<string, unknown> = {}) => ({
    caller: "user" as const,
    userId: "user_1",
    projectId: "proj_1",
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(undefined);
    listAll.mockResolvedValue([]);
    create.mockImplementation(async (data: { projectId: string; key: string }) => ({
        id: "new_key_id",
        projectId: data.projectId,
        key: data.key,
        createdAt: "2024-06-01T00:00:00.000Z",
    }));
});

describe("CreateApiKeyUseCase.execute", () => {
    it("runs authorize -> listAll -> create, in that order", async () => {
        const order: string[] = [];
        authorize.mockImplementation(async () => {
            order.push("authorize");
        });
        listAll.mockImplementation(async () => {
            order.push("listAll");
            return [];
        });
        create.mockImplementation(async () => {
            order.push("create");
            return existingKey("new");
        });

        await makeUseCase().execute(baseRequest());

        expect(order).toEqual(["authorize", "listAll", "create"]);
    });

    it("lists keys for the request's projectId before counting", async () => {
        await makeUseCase().execute(baseRequest({ projectId: "proj_xyz" }));

        expect(listAll).toHaveBeenCalledWith("proj_xyz");
    });

    it("boundary: 2 existing keys succeeds and creates a 3rd", async () => {
        listAll.mockResolvedValue([existingKey("a"), existingKey("b")]);

        const result = await makeUseCase().execute(baseRequest());

        expect(create).toHaveBeenCalledTimes(1);
        expect(result.id).toBe("new_key_id");
    });

    it("boundary: 3 existing keys throws MaxKeysReachedError and does NOT create a 4th", async () => {
        listAll.mockResolvedValue([existingKey("a"), existingKey("b"), existingKey("c")]);

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(MaxKeysReachedError);
        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(
            "You can only have up to 3 API keys per project.",
        );

        expect(create).not.toHaveBeenCalled();
    });

    it("boundary: more than 3 existing keys also throws (not just exactly 3)", async () => {
        listAll.mockResolvedValue([existingKey("a"), existingKey("b"), existingKey("c"), existingKey("d")]);

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(MaxKeysReachedError);
        expect(create).not.toHaveBeenCalled();
    });

    it("generates a 64-char hex key and passes {projectId, key} to create", async () => {
        await makeUseCase().execute(baseRequest({ projectId: "proj_7" }));

        expect(create).toHaveBeenCalledTimes(1);
        const [arg] = create.mock.calls[0] as [{ projectId: string; key: string }];
        expect(arg.projectId).toBe("proj_7");
        expect(arg.key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns whatever apiKeysRepository.create resolves to", async () => {
        const created = existingKey("returned_key");
        create.mockResolvedValue(created);

        const result = await makeUseCase().execute(baseRequest());

        expect(result).toBe(created);
    });

    it("propagates authz failure before listAll or create run", async () => {
        authorize.mockRejectedValue(new NotAuthorizedError("not a member"));

        await expect(makeUseCase().execute(baseRequest())).rejects.toThrow(NotAuthorizedError);

        expect(listAll).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it("MaxKeysReachedError is an instanceof BadRequestError", () => {
        const err = new MaxKeysReachedError("boom");
        expect(err).toBeInstanceOf(BadRequestError);
        expect(err).toBeInstanceOf(MaxKeysReachedError);
    });
});
