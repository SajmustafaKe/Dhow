import { describe, it, expect, beforeEach, vi } from "vitest";
import { UsageTracker } from "@/app/lib/billing";
import { streamResponse, getResponse } from "@/src/application/lib/agents-runtime/agents";

/**
 * Characterization tests for the one path through `streamResponse` that reaches
 * an observable result without touching a model, ahead of the port into
 * apps/dhowx.
 *
 * `streamResponse` short-circuits before any agent is constructed when the only
 * message is a system message: it emits a greeting turn and returns. That is the
 * first thing every new conversation hits, and it is fully deterministic — no
 * network, no SDK, no API key.
 *
 * The rest of the generator drives `@openai/agents` against a live model and is
 * out of scope here; it needs recorded fixtures and a fake model provider, not
 * unit pins. What is covered is the entry contract: what normalizes the input,
 * when the short-circuit fires, and exactly what it emits.
 */

const workflow = (over: Record<string, unknown> = {}) =>
    ({
        agents: [],
        prompts: [],
        tools: [],
        startAgent: "welcome_agent",
        lastUpdatedAt: "2026-08-03T12:00:00.000Z",
        ...over,
    }) as never;

const systemMessage = { role: "system" as const, content: "You are a billing assistant." };

const drain = async (workflowArg: unknown, messages: unknown[]) => {
    const events: Record<string, unknown>[] = [];
    for await (const event of streamResponse(
        "proj_1",
        workflowArg as never,
        messages as never,
        new UsageTracker(),
    )) {
        events.push(event as Record<string, unknown>);
    }
    return events;
};

describe("streamResponse greeting short-circuit", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("emits exactly one event for a lone system message", async () => {
        const events = await drain(workflow(), [systemMessage]);
        expect(events).toHaveLength(1);
    });

    it("falls back to a default greeting when the workflow has none", async () => {
        const [event] = await drain(workflow(), [systemMessage]);
        expect(event).toMatchObject({
            role: "assistant",
            content: "How can I help you today?",
            agentName: "welcome_agent",
            responseType: "external",
        });
    });

    it("uses the workflow's greeting prompt when one exists", async () => {
        const [event] = await drain(
            workflow({
                prompts: [{ name: "greeting", type: "greeting", prompt: "Welcome to Dhow." }],
            }),
            [systemMessage],
        );
        expect(event.content).toBe("Welcome to Dhow.");
    });

    it("ignores non-greeting prompts when picking the greeting", async () => {
        const [event] = await drain(
            workflow({
                prompts: [
                    { name: "style", type: "style_prompt", prompt: "Be terse." },
                    { name: "greeting", type: "greeting", prompt: "Hello from Dhow." },
                ],
            }),
            [systemMessage],
        );
        expect(event.content).toBe("Hello from Dhow.");
    });

    it("attributes the greeting to startAgent, not to any agent in the list", async () => {
        // The agents array is empty here, so this cannot be coming from agent
        // construction — the greeting is emitted before any agent exists.
        const [event] = await drain(workflow({ startAgent: "concierge" }), [systemMessage]);
        expect(event.agentName).toBe("concierge");
    });

    it("greets on a completely empty message list", async () => {
        // Empty input gets a system message prepended by ensureSystemMessage,
        // which then satisfies the length-1 short-circuit. So "no messages" and
        // "only a system message" behave identically.
        const events = await drain(workflow(), []);
        expect(events).toHaveLength(1);
        expect(events[0].content).toBe("How can I help you today?");
    });
});

describe("input normalization", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("MUTATES the caller's array, prepending a system message", async () => {
        // A side effect on an argument, not a returned copy. Pinned because it
        // is invisible at the call site and a port that starts copying would
        // change what the caller observes afterwards.
        const messages: unknown[] = [];
        await drain(workflow(), messages);

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ role: "system" });
    });

    it("fills a blank system message with default context including the date", async () => {
        const messages: Record<string, unknown>[] = [{ role: "system", content: "" }];
        await drain(workflow(), messages);

        expect(messages[0].content).toContain("You are a helpful assistant.");
        expect(messages[0].content).toContain("The date-time right now is");
    });

    it("leaves a non-blank system message untouched", async () => {
        const messages: Record<string, unknown>[] = [
            { role: "system", content: "You are a billing assistant." },
        ];
        await drain(workflow(), messages);

        expect(messages[0].content).toBe("You are a billing assistant.");
    });
});

describe("getResponse", () => {
    // Throws unconditionally — the whole body is commented out beneath the
    // throw. Reachable today only through three routes that are themselves 501
    // stubs (the widget turn route and two Twilio voice routes), so nothing hits
    // it in production.
    //
    // That changes under parity: reviving those stubs makes this a live crash on
    // the first request. Pinned so the failure is a red test during the port
    // rather than a mystery 500 after it.
    it("throws Not implemented", async () => {
        await expect(
            getResponse("proj_1", workflow(), [systemMessage] as never),
        ).rejects.toThrow("Not implemented!");
    });
});
