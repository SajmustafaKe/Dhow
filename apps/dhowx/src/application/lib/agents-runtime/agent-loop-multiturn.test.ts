import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";

/**
 * Characterization tests for the multi-request paths through the live agent
 * loop: tool-call round trips and agent-to-agent transfers.
 *
 * Extends the single-turn harness in agent-loop.test.ts with a *scriptable*
 * mock — each provider request pops the next scripted reply, so a conversation
 * that takes three round trips can be driven deterministically. Still no
 * network and no API key; the seam is `PROVIDER_BASE_URL` read at import time
 * (`agents.ts:24`), so the server must be up before the dynamic import.
 *
 * These are the paths a port breaks without any type error: a tool result that
 * never gets fed back, or a transfer that loses the target agent, both look like
 * a model that simply answered badly.
 */

type Script =
    | { kind: "text"; content: string }
    | { kind: "toolCall"; name: string; args: string };

const captured: Array<Record<string, unknown>> = [];
let script: Script[] = [];

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        captured.push(JSON.parse(raw || "{}"));
        // Fall back to a plain reply once the script is exhausted, so an
        // unexpected extra round trip surfaces as a bad assertion rather than a
        // hang.
        const next = script.shift() ?? { kind: "text" as const, content: "fallback reply" };

        const frame = (o: object) =>
            `data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", ...o })}\n\n`;

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

        if (next.kind === "text") {
            res.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: next.content }, finish_reason: null }] }));
            res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        } else {
            res.write(frame({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: next.name, arguments: next.args } }] }, finish_reason: null }] }));
            res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        }
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

const mockTool = (over: Record<string, unknown> = {}) => ({
    name: "lookup_invoice",
    description: "Look up an invoice",
    mockTool: true,
    mockInstructions: "Return an invoice total.",
    parameters: { type: "object", properties: { id: { type: "string" } } },
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

beforeEach(() => {
    captured.length = 0;
    script = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("tool-call round trip", () => {
    const withTool = () => ({
        // An agent's tools come from @mentions in its instructions, not from a
        // field on the agent — sanitizeTextWithMentions parses
        // `[@tool:name](#mention)` out of the prompt text and resolves it
        // against workflow.tools. Declaring the tool without mentioning it
        // leaves the agent with no tools at all.
        agents: [agent({ instructions: "Be concise. Use [@tool:lookup_invoice](#mention)." })],
        prompts: [],
        tools: [mockTool()],
        startAgent: "assistant",
        lastUpdatedAt: "2026-08-03T12:00:00.000Z",
    });

    it("offers the declared tool to the model", async () => {
        script = [{ kind: "text", content: "done" }];
        await turn(withTool(), userTurn);

        const tools = captured[0].tools as Array<{ function: { name: string } }>;
        expect(tools.map((t) => t.function.name)).toContain("lookup_invoice");
    });

    it("executes the tool and feeds its result back for a second completion", async () => {
        // Three provider round trips: the agent's tool call, the mock tool's own
        // generateText (invokeMockTool synthesises a result via the same
        // provider), then the agent's final answer.
        script = [
            { kind: "toolCall", name: "lookup_invoice", args: '{"id":"inv_1"}' },
            { kind: "text", content: "Invoice total is $250." },
            { kind: "text", content: "Your invoice inv_1 is $250." },
        ];

        const events = await turn(withTool(), userTurn);

        expect(captured.length).toBeGreaterThanOrEqual(3);
        const final = events.filter((e) => e.role === "assistant" && e.responseType === "external");
        expect(final.at(-1)?.content).toBe("Your invoice inv_1 is $250.");
    });

    it("sends the tool result back to the model as a tool message", async () => {
        script = [
            { kind: "toolCall", name: "lookup_invoice", args: '{"id":"inv_1"}' },
            { kind: "text", content: "Invoice total is $250." },
            { kind: "text", content: "Your invoice is $250." },
        ];
        await turn(withTool(), userTurn);

        // The agent's follow-up request must carry the tool exchange, otherwise
        // the model answers with no idea what the tool returned.
        const followUp = captured.at(-1)!.messages as Array<{ role: string }>;
        expect(followUp.some((m) => m.role === "tool")).toBe(true);
    });

    it("emits the tool call and its result as observable events", async () => {
        script = [
            { kind: "toolCall", name: "lookup_invoice", args: '{"id":"inv_1"}' },
            { kind: "text", content: "Invoice total is $250." },
            { kind: "text", content: "Your invoice is $250." },
        ];
        const events = await turn(withTool(), userTurn);

        // Consumers render these; losing them makes tool use invisible in the UI.
        expect(events.some((e) => Array.isArray(e.toolCalls))).toBe(true);
        expect(events.some((e) => e.role === "tool")).toBe(true);
    });
});

describe("agent-to-agent transfer", () => {
    const twoAgents = () => ({
        agents: [
            // Same mechanism as tools: connected agents come from
            // `[@agent:name](#mention)` in the instructions.
            agent({
                name: "triage",
                description: "routes requests",
                instructions: "Send billing questions to [@agent:billing](#mention).",
            }),
            agent({ name: "billing", description: "handles invoices" }),
        ],
        prompts: [],
        tools: [],
        startAgent: "triage",
        lastUpdatedAt: "2026-08-03T12:00:00.000Z",
    });

    it("offers a transfer tool for each connected agent", async () => {
        script = [{ kind: "text", content: "handled here" }];
        await turn(twoAgents(), userTurn);

        const tools = (captured[0].tools ?? []) as Array<{ function: { name: string } }>;
        const names = tools.map((t) => t.function.name);
        expect(names.some((n) => n.startsWith("transfer_to"))).toBe(true);
    });

    it("switches agents and lets the target answer", async () => {
        const tools = await (async () => {
            script = [{ kind: "text", content: "probe" }];
            await turn(twoAgents(), userTurn);
            return ((captured[0].tools ?? []) as Array<{ function: { name: string } }>)
                .map((t) => t.function.name)
                .filter((n) => n.startsWith("transfer_to"));
        })();

        captured.length = 0;
        script = [
            { kind: "toolCall", name: tools[0], args: "{}" },
            { kind: "text", content: "Billing here — your invoice is $250." },
        ];

        const events = await turn(twoAgents(), userTurn);

        const answers = events.filter((e) => e.role === "assistant" && e.responseType === "external");
        expect(answers.at(-1)?.content).toBe("Billing here — your invoice is $250.");
        // The answer is attributed to the agent that produced it, not the one
        // that started the turn.
        expect(answers.at(-1)?.agentName).toBe("billing");
    });

    it("emits transfer_to_agent events around the switch", async () => {
        const transferTool = await (async () => {
            script = [{ kind: "text", content: "probe" }];
            await turn(twoAgents(), userTurn);
            return ((captured[0].tools ?? []) as Array<{ function: { name: string } }>)
                .map((t) => t.function.name)
                .find((n) => n.startsWith("transfer_to"))!;
        })();

        captured.length = 0;
        script = [
            { kind: "toolCall", name: transferTool, args: "{}" },
            { kind: "text", content: "Billing here." },
        ];

        const events = await turn(twoAgents(), userTurn);

        // createTransferEvents emits a paired assistant tool call + tool result,
        // both named transfer_to_agent regardless of the SDK's tool name.
        const call = events.find((e) =>
            Array.isArray(e.toolCalls) &&
            (e.toolCalls as Array<{ function: { name: string } }>)[0]?.function.name === "transfer_to_agent",
        );
        const result = events.find((e) => e.role === "tool" && e.toolName === "transfer_to_agent");

        expect(call).toBeDefined();
        expect(result).toBeDefined();
        expect(result?.content).toContain("billing");
    });
});
