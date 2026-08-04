import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";

/**
 * Characterization tests for the LIVE agent loop, ahead of the port into
 * apps/dhowx.
 *
 * These drive `streamResponse` end to end against a local OpenAI-compatible
 * mock: no network, no API key, no recorded fixtures. The seam is
 * `PROVIDER_BASE_URL`, read into a module constant at import time
 * (`agents.ts:24`), so the server must be listening and the env set before the
 * dynamic import below — the same reason the other suites here import late.
 *
 * Two things are pinned that nothing else covers.
 *
 * First, the live agent-creation path. `USE_NATIVE_HANDOFFS` is unset in every
 * config in this repo, so production runs `createAgentsLegacy` with
 * `pipelineStateManager = null` — the native-handoff path and PipelineStateManager
 * are dormant behind a flag.
 *
 * Second, prompt assembly. What actually reaches the model is a composed system
 * message (SDK handoff preamble + the agent's name, description and
 * instructions) followed by the conversation's own system message as a separate
 * entry. That composition is invisible from the call site and no type describes
 * it; a port that reorders or merges these changes model behaviour silently.
 */

type Captured = { url: string; body: Record<string, unknown> };

const captured: Captured[] = [];
let reply = "Hello from mock.";

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        captured.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
        const frame = (o: object) =>
            `data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", ...o })}\n\n`;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] }));
        res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
    });
});

const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.PROVIDER_API_KEY = "test-key";

const { streamResponse } = await import("@/src/application/lib/agents-runtime/agents");
const { UsageTracker } = await import("@/app/lib/billing");

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const agent = (over: Record<string, unknown> = {}) => ({
    name: "assistant",
    type: "conversation",
    description: "helps with billing",
    instructions: "Be concise.",
    model: "gpt-4.1",
    outputVisibility: "user_facing",
    controlType: "retain",
    toggleAble: true,
    disabled: false,
    ragReturnType: "chunks",
    ragK: 3,
    ...over,
});

const workflow = (over: Record<string, unknown> = {}) => ({
    agents: [agent()],
    prompts: [],
    tools: [],
    startAgent: "assistant",
    lastUpdatedAt: "2026-08-03T12:00:00.000Z",
    ...over,
});

const turn = async (wf: Record<string, unknown>, messages: unknown[]) => {
    const events: Record<string, unknown>[] = [];
    for await (const e of streamResponse("proj_1", wf as never, messages as never, new UsageTracker())) {
        events.push(e as Record<string, unknown>);
    }
    return events;
};

const userTurn = [
    { role: "system", content: "You are a billing assistant." },
    { role: "user", content: "where is my invoice" },
];

describe("a plain conversational turn", () => {
    beforeEach(() => {
        captured.length = 0;
        reply = "Hello from mock.";
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("calls the provider exactly once", async () => {
        await turn(workflow(), userTurn);
        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe("/v1/chat/completions");
    });

    it("emits the model's reply as an external assistant message", async () => {
        const events = await turn(workflow(), userTurn);
        expect(events).toContainEqual({
            role: "assistant",
            content: "Hello from mock.",
            agentName: "assistant",
            responseType: "external",
        });
    });

    it("attributes the reply to the agent that produced it", async () => {
        const wf = workflow({ agents: [agent({ name: "billing_bot" })], startAgent: "billing_bot" });
        const events = await turn(wf, userTurn);
        const assistant = events.find((e) => e.role === "assistant");
        expect(assistant?.agentName).toBe("billing_bot");
    });

    it("requests a streaming completion", async () => {
        await turn(workflow(), userTurn);
        expect(captured[0].body.stream).toBe(true);
    });

    it("uses the model named on the agent, not the process default", async () => {
        process.env.PROVIDER_DEFAULT_MODEL = "should-not-be-used";
        const wf = workflow({ agents: [agent({ model: "gpt-4o-mini" })] });
        await turn(wf, userTurn);
        expect(captured[0].body.model).toBe("gpt-4o-mini");
    });

    it("omits the tools field entirely when the workflow declares none", async () => {
        // Absent, not null. Some providers reject an explicit null here, so the
        // distinction is worth pinning rather than rounding off.
        expect(captured[0]).toBeUndefined();
        await turn(workflow(), userTurn);
        expect("tools" in captured[0].body).toBe(false);
    });
});

describe("prompt assembly", () => {
    beforeEach(() => {
        captured.length = 0;
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    const messagesSent = async () => {
        await turn(workflow(), userTurn);
        return captured[0].body.messages as Array<{ role: string; content: string }>;
    };

    it("sends the composed agent prompt and the conversation system message separately", async () => {
        // Two system entries, not one merged block. The agent's composed
        // instructions come first; the caller's system message follows.
        const messages = await messagesSent();
        expect(messages.map((m) => m.role)).toEqual(["system", "system", "user"]);
        expect(messages[1].content).toBe("You are a billing assistant.");
        expect(messages[2].content).toBe("where is my invoice");
    });

    it("opens the composed prompt with the SDK's multi-agent preamble", async () => {
        // RECOMMENDED_PROMPT_PREFIX from @openai/agents-core/extensions. It tells
        // the model not to mention transfers; losing it makes agents narrate
        // their own handoffs to the user.
        const messages = await messagesSent();
        expect(messages[0].content).toContain("multi-agent system called the Agents SDK");
        expect(messages[0].content).toContain("do not mention or draw attention to these transfers");
    });

    it("includes the agent's own name, description and instructions", async () => {
        const messages = await messagesSent();
        expect(messages[0].content).toContain("## Your Name\nassistant");
        expect(messages[0].content).toContain("## Description\nhelps with billing");
        expect(messages[0].content).toContain("Be concise.");
    });
});

describe("the live handoff mode", () => {
    beforeEach(() => {
        captured.length = 0;
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("defaults to LEGACY handoffs, not the native SDK path", async () => {
        // USE_NATIVE_HANDOFFS is unset in docker-compose and every .env in this
        // repo, so createAgentsLegacy runs and pipelineStateManager stays null.
        // The native path — and PipelineStateManager with it — is dormant.
        //
        // Pinned because the port has to decide deliberately: flip the flag on,
        // or delete the dormant path. Silently shipping with it flipped changes
        // how every handoff works.
        const lines: string[] = [];
        const original = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
        try {
            await turn(workflow(), userTurn);
        } finally {
            console.log = original;
        }

        expect(lines.some((l) => l.includes("Using LEGACY handoffs"))).toBe(true);
        expect(lines.some((l) => l.includes("Using NATIVE SDK handoffs"))).toBe(false);
    });
});
