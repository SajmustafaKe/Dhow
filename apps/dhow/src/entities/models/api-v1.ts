import { z } from 'zod';

/**
 * Chat-widget API v1 wire schemas.
 *
 * Vendored from the `rowboat-shared` package (`github:rowboatlabs/shared`),
 * which `apps/dhow/package.json` used to install straight from RowBoat Labs'
 * GitHub org at `npm install` time. That was a live supply-chain dependency on
 * infrastructure this project does not control, for ~100 lines of Zod schemas
 * with no runtime logic and one dependency (zod) already present here.
 *
 * Content is the upstream `dist/types/apiV1` verbatim, re-typed as source.
 * Upstream also shipped a divergent `api_v1` module; it was never re-exported
 * from the package index, so it is not carried over.
 *
 * Consumed by the `/api/widget/v1/*` routes. Those handlers are currently 501
 * stubs with their real implementations commented out beneath them — reviving
 * them is part of RowBoat feature parity, so these schemas are load-bearing,
 * not dead weight.
 */

export const SystemMessage = z.object({
    role: z.literal("system"),
    content: z.string(),
});

export const UserMessage = z.object({
    role: z.literal("user"),
    content: z.string(),
});

export const AssistantMessage = z.object({
    role: z.literal("assistant"),
    content: z.string(),
    agenticSender: z.string().nullable().optional(),
    agenticResponseType: z.union([
        z.literal('internal'),
        z.literal('external'),
    ]),
});

export const AssistantMessageWithToolCalls = z.object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
            name: z.string(),
            arguments: z.string(),
        }),
    })),
    agenticSender: z.string().nullable().optional(),
    agenticResponseType: z.union([
        z.literal('internal'),
        z.literal('external'),
    ]),
});

export const ToolMessage = z.object({
    role: z.literal("tool"),
    content: z.string(),
    tool_call_id: z.string(),
    tool_name: z.string(),
});

const BaseChatMessage = z.object({
    version: z.literal('v1'),
    chatId: z.string(),
    createdAt: z.string().datetime(),
});

export const ChatMessage = BaseChatMessage
    .and(z.union([
        SystemMessage,
        UserMessage,
        AssistantMessage,
        AssistantMessageWithToolCalls,
        ToolMessage,
    ]));

export const ChatCloseReason = z.union([
    z.literal('user-closed-chat'),
    z.literal('assistant-closed-chat'),
    z.literal('timeout'),
    z.literal('error'),
]);

export const ChatUserData = z.object({
    userId: z.string(),
    userName: z.string().optional(),
});

export const Chat = z.object({
    version: z.literal('v1'),
    projectId: z.string(),
    userId: z.string(),
    createdAt: z.string().datetime(),
    closed: z.boolean().optional(),
    closedAt: z.string().datetime().optional(),
    closeReason: ChatCloseReason.optional(),
    agenticState: z.unknown().optional(),
    userData: ChatUserData,
});

export const ApiCreateChatRequest = z.object({});

export const ApiCreateChatResponse = Chat
    .and(z.object({
        id: z.string(),
    }));

export const ApiGetChatResponse = ApiCreateChatResponse;

export const ApiGetChatsResponse = z.object({
    chats: z.array(Chat.and(z.object({
        id: z.string(),
    }))),
    next: z.string().optional(),
    previous: z.string().optional(),
});

export const ApiChatTurnRequest = z.object({
    message: z.string(), // user message
});

export const ApiChatTurnResponse = ChatMessage
    .and(BaseChatMessage)
    .and(AssistantMessage)
    .and(z.object({
        id: z.string(),
    }));

export const ApiGetChatMessagesResponse = z.object({
    messages: z.array(ChatMessage.and(z.object({
        id: z.string(),
    }))),
    next: z.string().optional(),
    previous: z.string().optional(),
});

export const ApiCreateGuestSessionRequest = z.object({});

export const ApiCreateGuestSessionResponse = z.object({
    sessionId: z.string(),
});

export const ApiCreateUserSessionRequest = z.object({
    userDataJwt: z.string(),
});

export const ApiCreateUserSessionResponse = z.object({
    sessionId: z.string(),
});
