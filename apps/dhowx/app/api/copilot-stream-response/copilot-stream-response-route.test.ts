import { describe, it, expect, vi } from "vitest";

/**
 * Characterization tests for `app/api/copilot-stream-response/[streamId]`
 * (GET), ahead of the port into apps/dhowx.
 *
 * Same no-try/catch-around-requireAuth pin as the sibling
 * `stream-response` route. Two things unique to this file:
 *
 *  - Event routing is a closed if/else-if chain on shape
 *    (`'content' in event` → "message", `type === 'tool-call'` →
 *    "tool-call", `type === 'tool-result'` → "tool-result"). An event
 *    matching NONE of these (no `content`, and `type` anything else) is
 *    SILENTLY DROPPED — no SSE frame is emitted for it at all.
 *  - The error path calls `controller.error(...)` in the `catch`, but the
 *    `finally` block UNCONDITONALLY still calls `controller.enqueue(...)`
 *    twice more and `controller.close()`. Enqueuing on an already-errored
 *    `ReadableStreamDefaultController` throws per the Streams spec; this
 *    test observes what that actually does to the Response here rather
 *    than assuming the spec text — see the error-path test below for the
 *    pinned, observed outcome.
 */

const { requireAuthMock, controllerMock } = vi.hoisted(() => ({
    requireAuthMock: vi.fn(),
    controllerMock: { execute: vi.fn() },
}));

vi.mock("@/app/lib/auth", () => ({
    requireAuth: requireAuthMock,
}));

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((name: string) => {
            if (name === "runCopilotCachedTurnController") return controllerMock;
            throw new Error(`unexpected container.resolve(${name})`);
        }),
    },
}));

const { GET } = await import("./[streamId]/route");

const params = (streamId = "stream-1") => ({ params: Promise.resolve({ streamId }) });
const reqWithAuth = (auth?: string) =>
    new Request("http://localhost/x", auth ? { headers: { Authorization: auth } } : undefined);

describe("copilot-stream-response/[streamId] (GET) — auth", () => {
    it("rejects (no JSON 401) when requireAuth rejects — there is no try/catch around it", async () => {
        requireAuthMock.mockRejectedValue(new Error("not authenticated"));
        await expect(GET(reqWithAuth(), params())).rejects.toThrow("not authenticated");
        expect(controllerMock.execute).not.toHaveBeenCalled();
    });

    it("passes caller, userId, apiKey (from Authorization: Bearer <key>), and key: params.streamId", async () => {
        requireAuthMock.mockResolvedValue({ id: "user-7" });
        async function* empty() {}
        controllerMock.execute.mockReturnValue(empty());
        await GET(reqWithAuth("Bearer sk-xyz"), params("stream-42"));
        expect(controllerMock.execute).toHaveBeenCalledWith({
            caller: "user",
            userId: "user-7",
            apiKey: "sk-xyz",
            key: "stream-42",
        });
    });
});

describe("copilot-stream-response/[streamId] (GET) — event routing", () => {
    const run = async (events: unknown[]) => {
        requireAuthMock.mockResolvedValue({ id: "u1" });
        async function* gen() {
            for (const e of events) yield e;
        }
        controllerMock.execute.mockReturnValue(gen());
        const res = await GET(reqWithAuth(), params());
        return res.text();
    };

    it("routes a { content } event to 'event: message'", async () => {
        const text = await run([{ content: "hello" }]);
        expect(text).toContain(`event: message\ndata: ${JSON.stringify({ content: "hello" })}\n\n`);
    });

    it("routes a { type: 'tool-call' } event (no content field) to 'event: tool-call'", async () => {
        const event = { type: "tool-call", name: "search" };
        const text = await run([event]);
        expect(text).toContain(`event: tool-call\ndata: ${JSON.stringify(event)}\n\n`);
    });

    it("routes a { type: 'tool-result' } event to 'event: tool-result'", async () => {
        const event = { type: "tool-result", result: "42" };
        const text = await run([event]);
        expect(text).toContain(`event: tool-result\ndata: ${JSON.stringify(event)}\n\n`);
    });

    it("silently drops an event matching none of the three shapes — no frame is emitted for it", async () => {
        const dropped = { type: "unknown-thing" };
        const kept = { content: "kept" };
        const text = await run([dropped, kept]);
        expect(text).not.toContain("unknown-thing");
        expect(text).toContain(`event: message\ndata: ${JSON.stringify(kept)}\n\n`);
    });

    it("always appends 'event: done' then 'event: end' after the generator completes normally", async () => {
        const text = await run([{ content: "x" }]);
        expect(text.endsWith(`event: done\ndata: ${JSON.stringify({ type: "done" })}\n\nevent: end\n\n`)).toBe(true);
    });
});

describe("copilot-stream-response/[streamId] (GET) — error path (observed, not assumed)", () => {
    it("errors the stream with the catch block's message; the finally block's post-error enqueue/close is a no-op, not a crash or a duplicate frame", async () => {
        // Verified by direct ReadableStream experiment: calling controller.enqueue()/close()
        // after controller.error() throws "Invalid state: Controller is already closed" —
        // but that throw happens inside start()'s already-errored stream, so per the Streams
        // spec it is discarded rather than surfaced. The reader only ever sees the FIRST
        // error passed to controller.error(): this route's own "Something went wrong..."
        // message, not the generator's original "provider timeout", and not a second error
        // from the finally block.
        requireAuthMock.mockResolvedValue({ id: "u1" });
        async function* events() {
            yield { content: "partial" };
            throw new Error("provider timeout");
        }
        controllerMock.execute.mockReturnValue(events());
        const res = await GET(reqWithAuth(), params());
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("partial");
        await expect(reader.read()).rejects.toThrow("Something went wrong. Please try again.");
    });
});
