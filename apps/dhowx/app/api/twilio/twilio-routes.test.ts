import { describe, it, expect, vi } from "vitest";
import { POST as inboundCallPOST } from "./inbound_call/route";
import { POST as turnPOST } from "./turn/[callSid]/route";

/**
 * Characterization tests for `app/api/twilio/**`, ahead of the port into
 * apps/dhowx.
 *
 * Both handlers are direct stubs: `return new Response('Not implemented',
 * { status: 501 })` is their first statement, and everything after it —
 * including the call into `getResponse` from
 * `@/src/application/lib/agents-runtime/agents` — sits inside a `/* ... *\/`
 * block comment, so it is unreachable, not merely unexecuted this run.
 *
 * `getResponse` itself (agents.ts:1560) unconditionally
 * `throw new Error("Not implemented!")`. If a port revives either of these
 * routes by deleting the 501 line WITHOUT also implementing `getResponse`,
 * the route breaks immediately on the first real call — mocking
 * `getResponse` to throw here and asserting it is never invoked pins that
 * these two facts (the early 501, and getResponse's own unimplemented
 * state) currently compose safely only because of ordering.
 */

const getResponseMock = vi.fn(() => {
    throw new Error("getResponse called — voice-turn code ran past the 501 stub");
});
vi.mock("@/src/application/lib/agents-runtime/agents", () => ({
    getResponse: getResponseMock,
}));

const twilioConfigsCollectionMock = { findOne: vi.fn() };
const twilioInboundCallsCollectionMock = { findOne: vi.fn(), updateOne: vi.fn() };
vi.mock("@/app/lib/mongodb", () => ({
    twilioConfigsCollection: twilioConfigsCollectionMock,
    twilioInboundCallsCollection: twilioInboundCallsCollectionMock,
}));

const formDataRequest = (fields: Record<string, string>) => {
    const body = new URLSearchParams(fields);
    return new Request("http://localhost/api/twilio/x", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
};

describe("twilio/inbound_call (POST) — direct stub, no params", () => {
    it("returns 501 without touching Mongo or the agent runtime, for a well-formed Twilio payload", async () => {
        const res = await inboundCallPOST(
            formDataRequest({
                To: "+15550000000",
                Direction: "inbound",
                CallSid: "CA_test",
                From: "+15551234567",
            }),
        );
        expect(res.status).toBe(501);
        expect(await res.text()).toBe("Not implemented");
        expect(getResponseMock).not.toHaveBeenCalled();
        expect(twilioConfigsCollectionMock.findOne).not.toHaveBeenCalled();
        expect(twilioInboundCallsCollectionMock.findOne).not.toHaveBeenCalled();
    });

    it("returns 501 even for a completely empty body (no form-data parsing occurs)", async () => {
        const res = await inboundCallPOST(new Request("http://localhost/api/twilio/x", { method: "POST" }));
        expect(res.status).toBe(501);
    });
});

describe("twilio/turn/[callSid] (POST) — direct stub, params never awaited", () => {
    it("returns 501 without ever awaiting params, even a rejecting params promise", async () => {
        const rejecting = Promise.reject(new Error("params awaited — turn stub reads params"));
        rejecting.catch(() => {}); // pre-catch: proves-by-construction the route never awaits it either
        const res = await turnPOST(formDataRequest({ SpeechResult: "hello", Confidence: "0.9" }), {
            params: rejecting,
        });
        expect(res.status).toBe(501);
        expect(await res.text()).toBe("Not implemented");
        expect(getResponseMock).not.toHaveBeenCalled();
        expect(twilioInboundCallsCollectionMock.findOne).not.toHaveBeenCalled();
    });

    it("returns 501 for a malformed callSid param value (resolves but is still never read)", async () => {
        const res = await turnPOST(formDataRequest({ SpeechResult: "hi", Confidence: "0.5" }), {
            params: Promise.resolve({ callSid: "" }),
        });
        expect(res.status).toBe(501);
    });
});
