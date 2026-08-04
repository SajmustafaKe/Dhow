import { describe, it, expect, vi } from "vitest";
import { ProjectActionAuthorizationPolicy } from "@/src/application/policies/project-action-authorization.policy";
import { BadRequestError, NotAuthorizedError } from "@/src/entities/errors/common";
import type { IProjectMembersRepository } from "@/src/application/repositories/project-members.repository.interface";
import type { IApiKeysRepository } from "@/src/application/repositories/api-keys.repository.interface";

/**
 * Characterization tests for `ProjectActionAuthorizationPolicy`, ahead of the
 * port into apps/dhowx.
 *
 * This is the ONLY authorization policy in apps/dhow, and it is the tenant
 * boundary: 58 distinct call sites (57 use-cases + one server action) funnel
 * every project-scoped read/write through this single `authorize()` method
 * before touching a repository. The repositories themselves do zero tenant
 * filtering (`MongodbProjectsRepository.fetch` is a bare `findOne({ _id: id
 * })` — see mongodb.projects.repository.ts:55-65) — this method is the entire
 * defense. A port that inverts one of its `if`s, swaps an argument order, or
 * changes which error class it throws is a cross-tenant data leak, not a
 * cosmetic regression.
 *
 * Every deny path is asserted by error CLASS (`instanceof`), not just "it
 * throws" — `BadRequestError` and `NotAuthorizedError` both extend the plain
 * `Error` base with no `.name` override (entities/errors/common.ts), so
 * `instanceof` is the only thing that discriminates a "malformed request"
 * (400-shaped) from "you are not allowed" (403-shaped) once this reaches an
 * HTTP boundary. Swapping the error class silently changes the status code a
 * caller sees for the exact same condition.
 */

function setup() {
    const projectMembersRepository: IProjectMembersRepository = {
        exists: vi.fn(),
        create: vi.fn(),
        findByUserId: vi.fn(),
        deleteByProjectId: vi.fn(),
    };
    const apiKeysRepository: IApiKeysRepository = {
        checkAndConsumeKey: vi.fn(),
        create: vi.fn(),
        listAll: vi.fn(),
        delete: vi.fn(),
        deleteAll: vi.fn(),
    };
    const policy = new ProjectActionAuthorizationPolicy({ projectMembersRepository, apiKeysRepository });
    return { policy, projectMembersRepository, apiKeysRepository };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
    try {
        await p;
        throw new Error("expected authorize() to reject, but it resolved");
    } catch (e) {
        return e;
    }
}

describe("ProjectActionAuthorizationPolicy — caller: 'user'", () => {
    it("denies with BadRequestError, not NotAuthorizedError, when userId is missing — and never queries membership", async () => {
        const { policy, projectMembersRepository } = setup();
        const err = await caught(policy.authorize({ caller: "user", projectId: "proj_1" }));
        expect(err).toBeInstanceOf(BadRequestError);
        expect(err).not.toBeInstanceOf(NotAuthorizedError);
        expect(projectMembersRepository.exists).not.toHaveBeenCalled();
    });

    it("denies with BadRequestError when userId is an empty string — this is a falsy check (!userId), not a strict undefined check", async () => {
        const { policy, projectMembersRepository } = setup();
        const err = await caught(policy.authorize({ caller: "user", userId: "", projectId: "proj_1" }));
        expect(err).toBeInstanceOf(BadRequestError);
        expect(projectMembersRepository.exists).not.toHaveBeenCalled();
    });

    it("THE tenant boundary: denies with NotAuthorizedError (not BadRequestError) when the caller is not a member of the project", async () => {
        const { policy, projectMembersRepository } = setup();
        vi.mocked(projectMembersRepository.exists).mockResolvedValue(false);
        const err = await caught(
            policy.authorize({ caller: "user", userId: "user_outsider", projectId: "proj_belongs_to_someone_else" }),
        );
        expect(err).toBeInstanceOf(NotAuthorizedError);
        expect(err).not.toBeInstanceOf(BadRequestError);
    });

    it("queries membership as exists(projectId, userId) — that argument order is load-bearing, not incidental", async () => {
        const { policy, projectMembersRepository } = setup();
        vi.mocked(projectMembersRepository.exists).mockResolvedValue(true);
        await policy.authorize({ caller: "user", userId: "user_1", projectId: "proj_9" });
        expect(projectMembersRepository.exists).toHaveBeenCalledWith("proj_9", "user_1");
        expect(projectMembersRepository.exists).toHaveBeenCalledTimes(1);
    });

    it("resolves (does not throw, does not return a value) when the caller IS a member", async () => {
        const { policy, projectMembersRepository } = setup();
        vi.mocked(projectMembersRepository.exists).mockResolvedValue(true);
        await expect(
            policy.authorize({ caller: "user", userId: "user_1", projectId: "proj_1" }),
        ).resolves.toBeUndefined();
    });

    it("never touches the api-keys repository on the user path", async () => {
        const { policy, apiKeysRepository, projectMembersRepository } = setup();
        vi.mocked(projectMembersRepository.exists).mockResolvedValue(true);
        await policy.authorize({ caller: "user", userId: "user_1", projectId: "proj_1" });
        expect(apiKeysRepository.checkAndConsumeKey).not.toHaveBeenCalled();
    });
});

describe("ProjectActionAuthorizationPolicy — everything else falls to the API-key branch", () => {
    it("denies with BadRequestError when apiKey is missing, for caller: 'api' — and never calls checkAndConsumeKey", async () => {
        const { policy, apiKeysRepository } = setup();
        const err = await caught(policy.authorize({ caller: "api", projectId: "proj_1" }));
        expect(err).toBeInstanceOf(BadRequestError);
        expect(apiKeysRepository.checkAndConsumeKey).not.toHaveBeenCalled();
    });

    it("denies with BadRequestError when apiKey is an empty string", async () => {
        const { policy, apiKeysRepository } = setup();
        const err = await caught(policy.authorize({ caller: "api", apiKey: "", projectId: "proj_1" }));
        expect(err).toBeInstanceOf(BadRequestError);
        expect(apiKeysRepository.checkAndConsumeKey).not.toHaveBeenCalled();
    });

    it("THE tenant boundary: denies with NotAuthorizedError, not BadRequestError, when the key check fails", async () => {
        const { policy, apiKeysRepository } = setup();
        vi.mocked(apiKeysRepository.checkAndConsumeKey).mockResolvedValue(false);
        const err = await caught(policy.authorize({ caller: "api", apiKey: "wrong-key", projectId: "proj_1" }));
        expect(err).toBeInstanceOf(NotAuthorizedError);
        expect(err).not.toBeInstanceOf(BadRequestError);
    });

    it("queries/consumes the key as checkAndConsumeKey(projectId, apiKey) — argument order pin", async () => {
        const { policy, apiKeysRepository } = setup();
        vi.mocked(apiKeysRepository.checkAndConsumeKey).mockResolvedValue(true);
        await policy.authorize({ caller: "api", apiKey: "sk_live_123", projectId: "proj_9" });
        expect(apiKeysRepository.checkAndConsumeKey).toHaveBeenCalledWith("proj_9", "sk_live_123");
        expect(apiKeysRepository.checkAndConsumeKey).toHaveBeenCalledTimes(1);
    });

    it("resolves when the key check succeeds", async () => {
        const { policy, apiKeysRepository } = setup();
        vi.mocked(apiKeysRepository.checkAndConsumeKey).mockResolvedValue(true);
        await expect(
            policy.authorize({ caller: "api", apiKey: "sk_live_123", projectId: "proj_1" }),
        ).resolves.toBeUndefined();
    });

    it("never touches the project-members repository on the api path", async () => {
        const { policy, apiKeysRepository, projectMembersRepository } = setup();
        vi.mocked(apiKeysRepository.checkAndConsumeKey).mockResolvedValue(true);
        await policy.authorize({ caller: "api", apiKey: "k", projectId: "proj_1" });
        expect(projectMembersRepository.exists).not.toHaveBeenCalled();
    });

    it("has no runtime enforcement of the 'caller' enum despite its zod-typed signature: any value that is not the exact string 'user' silently falls to the api-key branch", async () => {
        // The method signature is typed `z.infer<typeof inputSchema>` where
        // inputSchema constrains `caller` to z.enum(["user", "api"]) — but the
        // method body never calls `inputSchema.parse`/`.safeParse` on `data`.
        // Discrimination is done with a bare `if (caller === "user") {...} else
        // {...}`, so a caller value of "job_worker", "API", or a typo reaches
        // the api-key branch exactly like "api" would. Every current call site
        // is internal, so this is not attacker-reachable today — but it means
        // there is no defense-in-depth if a future call site passes an
        // unvalidated `caller` straight from a request body.
        const { policy, apiKeysRepository } = setup();
        vi.mocked(apiKeysRepository.checkAndConsumeKey).mockResolvedValue(true);
        await policy.authorize({
            // @ts-expect-error - exercising a value the type system forbids but the runtime accepts
            caller: "definitely-not-user-or-api",
            apiKey: "k",
            projectId: "proj_1",
        });
        expect(apiKeysRepository.checkAndConsumeKey).toHaveBeenCalledWith("proj_1", "k");
    });
});
