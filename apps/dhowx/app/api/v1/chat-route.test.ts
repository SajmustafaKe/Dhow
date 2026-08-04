import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Characterization tests for `app/api/v1/[projectId]/chat` (POST), ahead of
 * the port into apps/dhowx.
 *
 * THE PIN: this route performs NO auth check of its own. It reads
 * `Authorization: Bearer <key>` (or, for a malformed header, `undefined`)
 * and forwards it as `apiKey` straight into `runTurnController.execute`
 * without ever short-circuiting on a missing/malformed header — all
 * authorization is delegated entirely to the controller/use-case layer
 * (outside this file's scope). A request with NO Authorization header at
 * all still reaches the controller.
 */

const { runTurnControllerMock } = vi.hoisted(() => ({
    runTurnControllerMock: { execute: vi.fn() },
}));

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((name: string) => {
            if (name === "runTurnController") return runTurnControllerMock;
            throw new Error(`unexpected container.resolve(${name})`);
        }),
    },
}));

const { POST } = await import("./[projectId]/chat/route");

const req = (opts: { body?: unknown; raw?: string; authorization?: string } = {}) =>
    new NextRequest("http://localhost/api/v1/proj-1/chat", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(opts.authorization !== undefined ? { Authorization: opts.authorization } : {}),
        },
        body: opts.raw ?? JSON.stringify(opts.body ?? { messages: [] }),
    });

const params = (projectId = "proj-1") => ({ params: Promise.resolve({ projectId }) });

describe("v1/[projectId]/chat (POST) — malformed input", () => {
    it("400s with { error: 'Invalid request' } on unparsable JSON", async () => {
        const res = await POST(req({ raw: "{not json" }), params());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid request" });
        expect(runTurnControllerMock.execute).not.toHaveBeenCalled();
    });

    it("400s on a body that parses as JSON but fails the ApiRequest schema (messages missing)", async () => {
        const res = await POST(req({ body: { conversationId: "c1" } }), params());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid request" });
        expect(runTurnControllerMock.execute).not.toHaveBeenCalled();
    });
});

describe("v1/[projectId]/chat (POST) — no route-level auth gate", () => {
    it("reaches the controller with apiKey undefined when there is no Authorization header at all", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", turn: { id: "t1" } });
        const res = await POST(req({ body: { messages: [] } }), params());
        expect(res.status).toBe(200);
        expect(runTurnControllerMock.execute).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
    });

    it("extracts the token after 'Bearer '", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", turn: { id: "t1" } });
        await POST(req({ body: { messages: [] }, authorization: "Bearer sk-abc123" }), params());
        expect(runTurnControllerMock.execute).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-abc123" }));
    });

    it("yields apiKey undefined for a malformed Authorization header with no space (no 'Bearer' scheme)", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", turn: { id: "t1" } });
        await POST(req({ body: { messages: [] }, authorization: "sk-abc123" }), params());
        expect(runTurnControllerMock.execute).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
    });
});

describe("v1/[projectId]/chat (POST) — non-streaming", () => {
    it("passes projectId from params and coerces an empty-string conversationId to undefined", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "new-conv", turn: { id: "t1" } });
        await POST(req({ body: { messages: [], conversationId: "" } }), params("proj-xyz"));
        expect(runTurnControllerMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: "proj-xyz", conversationId: undefined, stream: false }),
        );
    });

    it("200s with { conversationId, turn } on success", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", turn: { id: "t1", output: [] } });
        const res = await POST(req({ body: { messages: [] } }), params());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ conversationId: "c1", turn: { id: "t1", output: [] } });
    });

    it("500s with a specific message when the controller's response has neither 'turn' nor 'stream'", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1" });
        const res = await POST(req({ body: { messages: [] } }), params());
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "No turn data found in response" });
    });
});

describe("v1/[projectId]/chat (POST) — streaming", () => {
    async function* fakeEvents() {
        yield { type: "message_delta", content: "hi" };
        yield { type: "done" };
    }

    it("returns an SSE stream with the correct headers and 'event: message' framing per event when stream: true", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", stream: fakeEvents() });
        const res = await POST(req({ body: { messages: [], stream: true } }), params());
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
        expect(res.headers.get("Connection")).toBe("keep-alive");
        const text = await res.text();
        expect(text).toBe(
            `event: message\ndata: ${JSON.stringify({ type: "message_delta", content: "hi" })}\n\n` +
                `event: message\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
        );
    });

    it("errors the stream (does not silently truncate) when the generator throws mid-iteration", async () => {
        async function* throwingEvents() {
            yield { type: "message_delta", content: "partial" };
            throw new Error("upstream provider blew up");
        }
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", stream: throwingEvents() });
        const res = await POST(req({ body: { messages: [], stream: true } }), params());
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("message_delta");
        await expect(reader.read()).rejects.toThrow("Something went wrong. Please try again.");
    });

    it("does not stream when stream: true but the controller response has no 'stream' key (falls through to turn handling)", async () => {
        runTurnControllerMock.execute.mockResolvedValue({ conversationId: "c1", turn: { id: "t1" } });
        const res = await POST(req({ body: { messages: [], stream: true } }), params());
        expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
        expect(await res.json()).toEqual({ conversationId: "c1", turn: { id: "t1" } });
    });
});
