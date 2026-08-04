import { describe, it, expect, vi } from "vitest";

/**
 * Characterization tests for `app/api/composio/webhook` (POST), ahead of the
 * port into apps/dhowx.
 *
 * `handleComposioWebhookRequestController` is resolved from the DI
 * container at MODULE IMPORT TIME (`route.ts:6`), so `@/di/container` must
 * be mocked before this module is imported.
 *
 * THE PIN: this route ALWAYS returns `200 { success: true }`, even when the
 * controller throws. The error is only `logger.log`ged, never surfaced —
 * Composio (or any webhook sender) can never distinguish "processed" from
 * "silently failed" via the HTTP response. This is load-bearing for the
 * port: a rewrite that "improves" this by propagating the error as a 500
 * would change Composio's retry behaviour.
 */

const { controllerMock } = vi.hoisted(() => ({
    controllerMock: { execute: vi.fn() },
}));

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((name: string) => {
            if (name === "handleComposioWebhookRequestController") return controllerMock;
            throw new Error(`unexpected container.resolve(${name})`);
        }),
    },
}));

const { POST } = await import("./webhook/route");

describe("composio/webhook (POST)", () => {
    it("forwards the raw text payload and headers-as-object to the controller", async () => {
        controllerMock.execute.mockResolvedValue(undefined);
        const req = new Request("http://localhost/api/composio/webhook", {
            method: "POST",
            headers: { "x-signature": "abc123", "content-type": "application/json" },
            body: JSON.stringify({ type: "slack_receive_message" }),
        });
        await POST(req);
        expect(controllerMock.execute).toHaveBeenCalledTimes(1);
        const call = controllerMock.execute.mock.calls[0][0];
        expect(call.payload).toBe(JSON.stringify({ type: "slack_receive_message" }));
        expect(call.headers["x-signature"]).toBe("abc123");
        expect(call.headers["content-type"]).toBe("application/json");
    });

    it("returns 200 { success: true } when the controller succeeds", async () => {
        controllerMock.execute.mockResolvedValue(undefined);
        const req = new Request("http://localhost/api/composio/webhook", { method: "POST", body: "{}" });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
    });

    it("STILL returns 200 { success: true } when the controller throws — the error is swallowed, not surfaced", async () => {
        controllerMock.execute.mockRejectedValue(new Error("downstream use-case exploded"));
        const req = new Request("http://localhost/api/composio/webhook", { method: "POST", body: "{}" });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
    });

    it("returns 200 { success: true } even for an empty body", async () => {
        controllerMock.execute.mockResolvedValue(undefined);
        const req = new Request("http://localhost/api/composio/webhook", { method: "POST" });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(controllerMock.execute).toHaveBeenCalledWith(expect.objectContaining({ payload: "" }));
    });
});
