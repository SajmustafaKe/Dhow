import { describe, it, expect, vi } from "vitest";

/**
 * Characterization tests for `app/api/stream-response/[streamId]` (GET),
 * ahead of the port into apps/dhowx.
 *
 * THE PIN: `const user = await requireAuth();` has NO surrounding
 * try/catch. An unauthenticated caller (requireAuth rejecting/throwing)
 * makes the whole GET handler reject — Next.js's own error boundary is what
 * turns that into a response, not this file. A port that wraps this in a
 * try/catch "for safety" would change observable behaviour (it currently
 * never returns a JSON 401 from this route).
 *
 * SECOND PIN, contrasted directly against `v1/[projectId]/chat`'s stream
 * (same repo, different error strategy): here, when the underlying
 * generator throws mid-stream, the route CATCHES it, enqueues one more
 * `event: message` frame carrying a `{type:"error", ...}` TurnEvent
 * payload, then still emits `event: end` and calls `controller.close()`.
 * The SSE stream completes NORMALLY (no `ReadableStream` error state) even
 * on failure — unlike `v1/[projectId]/chat`, which aborts the stream via
 * `controller.error()`. A consumer reading this stream never sees a
 * rejected read; it sees an in-band error event followed by a clean end.
 */

const { requireAuthMock, runCachedTurnControllerMock } = vi.hoisted(() => ({
    requireAuthMock: vi.fn(),
    runCachedTurnControllerMock: { execute: vi.fn() },
}));

vi.mock("@/app/lib/auth", () => ({
    requireAuth: requireAuthMock,
}));

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((name: string) => {
            if (name === "runCachedTurnController") return runCachedTurnControllerMock;
            throw new Error(`unexpected container.resolve(${name})`);
        }),
    },
}));

const { GET } = await import("./[streamId]/route");

const params = (streamId = "stream-1") => ({ params: Promise.resolve({ streamId }) });

describe("stream-response/[streamId] (GET) — auth", () => {
    it("rejects (no JSON 401) when requireAuth rejects — there is no try/catch around it", async () => {
        requireAuthMock.mockRejectedValue(new Error("not authenticated"));
        await expect(GET(new Request("http://localhost/x"), params())).rejects.toThrow("not authenticated");
        expect(runCachedTurnControllerMock.execute).not.toHaveBeenCalled();
    });

    it("passes caller: 'user', the authenticated user's id, and params.streamId as cachedTurnKey", async () => {
        requireAuthMock.mockResolvedValue({ id: "user-42" });
        async function* empty() {}
        runCachedTurnControllerMock.execute.mockReturnValue(empty());
        await GET(new Request("http://localhost/x"), params("stream-99"));
        expect(runCachedTurnControllerMock.execute).toHaveBeenCalledWith({
            caller: "user",
            userId: "user-42",
            cachedTurnKey: "stream-99",
        });
    });
});

describe("stream-response/[streamId] (GET) — SSE framing", () => {
    it("sets text/event-stream headers", async () => {
        requireAuthMock.mockResolvedValue({ id: "u1" });
        async function* empty() {}
        runCachedTurnControllerMock.execute.mockReturnValue(empty());
        const res = await GET(new Request("http://localhost/x"), params());
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
        expect(res.headers.get("Connection")).toBe("keep-alive");
    });

    it("frames each yielded event as 'event: message' and appends 'event: end' on clean completion", async () => {
        requireAuthMock.mockResolvedValue({ id: "u1" });
        async function* events() {
            yield { type: "text", content: "hi" };
            yield { type: "done" };
        }
        runCachedTurnControllerMock.execute.mockReturnValue(events());
        const res = await GET(new Request("http://localhost/x"), params());
        const text = await res.text();
        expect(text).toBe(
            `event: message\ndata: ${JSON.stringify({ type: "text", content: "hi" })}\n\n` +
                `event: message\ndata: ${JSON.stringify({ type: "done" })}\n\n` +
                `event: end\n\n`,
        );
    });

    it("on a mid-stream throw: emits an in-band error TurnEvent then STILL closes cleanly with event: end (no stream-level error)", async () => {
        requireAuthMock.mockResolvedValue({ id: "u1" });
        async function* events() {
            yield { type: "text", content: "partial" };
            throw new Error("provider timeout");
        }
        runCachedTurnControllerMock.execute.mockReturnValue(events());
        const res = await GET(new Request("http://localhost/x"), params());
        // A rejected/errored ReadableStream would make .text() throw; it doesn't.
        const text = await res.text();
        expect(text).toBe(
            `event: message\ndata: ${JSON.stringify({ type: "text", content: "partial" })}\n\n` +
                `event: message\ndata: ${JSON.stringify({
                    type: "error",
                    error: "Something went wrong. Please try again.",
                    isBillingError: false,
                })}\n\n` +
                `event: end\n\n`,
        );
    });
});
