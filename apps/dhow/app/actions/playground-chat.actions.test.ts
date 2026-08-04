import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for playground-chat.actions.ts, ahead of the port
 * into apps/dhowx. Both exports are `authCheck()` then a controller.execute()
 * call — resolved from the container inside the function body (not at
 * module scope, unlike most other files in this directory).
 */

type Controller = { execute: ReturnType<typeof vi.fn> };
const controllers: Record<string, Controller> = {
    // These two are resolved from the container *inside* the function body
    // (after authCheck), not at module scope — so they don't exist yet when
    // a test file first imports the module. Pre-seed them so
    // `controllers[key].execute.mockResolvedValue(...)` can be set up
    // before the action under test ever runs.
    createPlaygroundConversationController: { execute: vi.fn() },
    createCachedTurnController: { execute: vi.fn() },
};

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

const user = { id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./playground-chat.actions");
}

describe("createConversation", () => {
    it("authenticates first, then forwards {userId, projectId, workflow, isLiveWorkflow}", async () => {
        const { createConversation } = await loadActions();
        const conversation = { id: "conv_1" };
        controllers["createPlaygroundConversationController"].execute.mockResolvedValue(conversation);

        const result = await createConversation({
            projectId: "proj_1",
            workflow: { startAgent: "a" } as never,
            isLiveWorkflow: true,
        });

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["createPlaygroundConversationController"].execute).toHaveBeenCalledWith({
            userId: user.id,
            projectId: "proj_1",
            workflow: { startAgent: "a" },
            isLiveWorkflow: true,
        });
        expect(result).toBe(conversation);
    });

    it("propagates an authCheck failure without resolving/calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { createConversation } = await loadActions();

        await expect(
            createConversation({ projectId: "proj_1", workflow: {} as never, isLiveWorkflow: false })
        ).rejects.toThrow("User not authenticated");
        expect(controllers["createPlaygroundConversationController"]?.execute).not.toHaveBeenCalled();
    });
});

describe("createCachedTurn", () => {
    it("authenticates first, then forwards {caller:'user', userId, conversationId, input:{messages}}, unwrapping {key}", async () => {
        const { createCachedTurn } = await loadActions();
        controllers["createCachedTurnController"].execute.mockResolvedValue({ key: "cache_key_1" });

        const result = await createCachedTurn({ conversationId: "conv_1", messages: [{ role: "user", content: "hi" }] as never });

        expect(controllers["createCachedTurnController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            conversationId: "conv_1",
            input: { messages: [{ role: "user", content: "hi" }] },
        });
        // Only `.key` is unwrapped into the return shape — any other field
        // the controller resolves is dropped.
        expect(result).toEqual({ key: "cache_key_1" });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { createCachedTurn } = await loadActions();

        await expect(createCachedTurn({ conversationId: "conv_1", messages: [] })).rejects.toThrow("User not authenticated");
        expect(controllers["createCachedTurnController"]?.execute).not.toHaveBeenCalled();
    });
});
