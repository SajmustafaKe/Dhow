import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for conversation.actions.ts, ahead of the port into
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

const user = { id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
});

async function loadActions() {
    return await import("./conversation.actions");
}

describe("listConversations", () => {
    it("authenticates first, then forwards {caller, userId, projectId, cursor, limit}", async () => {
        const { listConversations } = await loadActions();
        controllers["listConversationsController"].execute.mockResolvedValue({ items: [], nextCursor: null });

        await listConversations({ projectId: "proj_1", cursor: "c1", limit: 20 });

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["listConversationsController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            cursor: "c1",
            limit: 20,
        });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { listConversations } = await loadActions();

        await expect(listConversations({ projectId: "proj_1" })).rejects.toThrow("User not authenticated");
        expect(controllers["listConversationsController"].execute).not.toHaveBeenCalled();
    });
});

describe("fetchConversation", () => {
    it("authenticates first, then forwards {caller, userId, conversationId}", async () => {
        const { fetchConversation } = await loadActions();
        const conversation = { id: "conv_1" };
        controllers["fetchConversationController"].execute.mockResolvedValue(conversation);

        await expect(fetchConversation({ conversationId: "conv_1" })).resolves.toBe(conversation);
        expect(controllers["fetchConversationController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            conversationId: "conv_1",
        });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { fetchConversation } = await loadActions();

        await expect(fetchConversation({ conversationId: "conv_1" })).rejects.toThrow("User not authenticated");
        expect(controllers["fetchConversationController"].execute).not.toHaveBeenCalled();
    });
});
