import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";

/**
 * Characterization tests for the multi-agent copilot, ahead of the port into
 * apps/dhowx and the ai@4 -> ai@5 migration that port requires (`copilot.ts`
 * is the only file in this wave that calls `generateObject`/`streamText`/`tool`
 * from the `ai` package directly).
 *
 * These drive `getEditAgentInstructionsResponse` and `streamMultiAgentResponse`
 * end to end against a local OpenAI-compatible mock: no network, no API key,
 * no recorded fixtures. The seam is `PROVIDER_BASE_URL`/`PROVIDER_API_KEY`/
 * `PROVIDER_COPILOT_MODEL`, read into module constants at import time
 * (copilot.ts:17-19), so the server must be listening and env set before the
 * dynamic import below -- the same reason agent-loop.test.ts imports late.
 *
 * Three things are pinned that a rename-only migration could silently break:
 *
 * 1. Usage-field mapping is billing-critical. `usage.promptTokens`/
 *    `completionTokens` (ai@4) becomes `usage.inputTokens`/`outputTokens`
 *    (ai@5), but the *tracked* item always uses `inputTokens`/`outputTokens`
 *    (that's this repo's own `LLMUsage` shape in billing_types.ts, not the
 *    SDK's). A port that keeps reading the old field names would silently
 *    track `undefined` -> `NaN` credits.
 *
 * 2. The tool definition's `parameters` key (ai@4) becomes `inputSchema`
 *    (ai@5) -- pinned by asserting the real JSON-schema the provider receives
 *    on the wire, which is unaffected by the SDK's internal field name and
 *    so stays the actual behavioural contract across the migration.
 *
 * 3. The fullStream event shapes consumed by `streamMultiAgentResponse`'s
 *    for-await loop: `text-delta.textDelta` -> `.text`, `tool-call.args` ->
 *    `.input`, `tool-result.result` -> `.output`, and the step-finish event
 *    itself is renamed `step-finish` -> `finish-step`. copilot.ts maps every
 *    one of these into `CopilotStreamEvent`, which is this test suite's
 *    output boundary -- so pinning event *output* shape here also pins that
 *    the mapping was ported correctly.
 */

type Captured = { url: string; body: Record<string, unknown> };

const objectCaptured: Captured[] = [];
let objectReply: { agent_instructions: string } = { agent_instructions: "Be a helpful billing assistant." };
let objectUsage = { prompt_tokens: 123, completion_tokens: 45 };

const streamCaptured: Captured[] = [];
let streamRequestCount = 0;
/** 0 => plain text reply. >0 => that many tool-call hops before the final text reply. */
let toolCallHops: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
let finalText = "Here are the tools.";

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        const url = req.url ?? "";

        if (body.tool_choice && typeof body.tool_choice === "object") {
            // generateObject's tool-mode request (non-streaming).
            objectCaptured.push({ url, body });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                id: "cmpl-1", object: "chat.completion", created: 1, model: "gpt-4.1",
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant", content: null,
                        tool_calls: [{ id: "call_obj", type: "function", function: { name: "json", arguments: JSON.stringify(objectReply) } }],
                    },
                    finish_reason: "tool_calls",
                }],
                usage: { prompt_tokens: objectUsage.prompt_tokens, completion_tokens: objectUsage.completion_tokens, total_tokens: objectUsage.prompt_tokens + objectUsage.completion_tokens },
            }));
            return;
        }

        // streamText's streaming request.
        streamRequestCount++;
        streamCaptured.push({ url, body });

        const frame = (o: object) =>
            `data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", ...o })}\n\n`;

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

        const hop = toolCallHops[streamRequestCount - 1];
        if (hop) {
            res.write(frame({
                choices: [{
                    index: 0,
                    delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: hop.id, type: "function", function: { name: hop.name, arguments: JSON.stringify(hop.args) } }] },
                    finish_reason: null,
                }],
            }));
            res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 200 + streamRequestCount, completion_tokens: 20 + streamRequestCount, total_tokens: 0 } }));
        } else {
            res.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: finalText }, finish_reason: null }] }));
            res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300 + streamRequestCount, completion_tokens: 10 + streamRequestCount, total_tokens: 0 } }));
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
process.env.PROVIDER_COPILOT_MODEL = "gpt-4.1";

const { getEditAgentInstructionsResponse, streamMultiAgentResponse } = await import("./copilot");
const { UsageTracker } = await import("@/app/lib/billing");

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const workflow = (over: Record<string, unknown> = {}) => ({
    agents: [],
    prompts: [],
    tools: [],
    startAgent: "assistant",
    lastUpdatedAt: "2026-08-03T12:00:00.000Z",
    ...over,
});

describe("getEditAgentInstructionsResponse", () => {
    beforeEach(() => {
        objectCaptured.length = 0;
        objectReply = { agent_instructions: "Be a helpful billing assistant." };
        objectUsage = { prompt_tokens: 123, completion_tokens: 45 };
    });

    it("calls the model in tool-mode object generation, with temperature 0 and the assembled system+user messages", async () => {
        await getEditAgentInstructionsResponse(
            new UsageTracker(), "proj_1", null,
            [{ role: "user", content: "make it friendlier" }],
            workflow(), [],
        );

        expect(objectCaptured).toHaveLength(1);
        const req = objectCaptured[0].body;
        expect(req.model).toBe("gpt-4.1");
        expect(req.temperature).toBe(0);
        expect(req.tool_choice).toEqual({ type: "function", function: { name: "json" } });

        const tools = req.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
        expect(tools).toHaveLength(1);
        expect(tools[0].function.name).toBe("json");
        expect(tools[0].function.parameters).toMatchObject({
            type: "object",
            properties: { agent_instructions: { type: "string" } },
            required: ["agent_instructions"],
        });

        const messages = req.messages as Array<{ role: string; content: string }>;
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain("helpful co-pilot for designing and deploying multi-agent systems");
        expect(messages[1].role).toBe("user");
        // updateLastUserMessage wraps the original content JSON-stringified after the assembled prompts.
        expect(messages[1].content).toContain('User: "make it friendlier"');
        expect(messages[1].content).toContain('"startAgent":"assistant"');
    });

    it("returns the parsed agent_instructions string from the model's structured response", async () => {
        objectReply = { agent_instructions: "Be extra concise." };
        const result = await getEditAgentInstructionsResponse(
            new UsageTracker(), "proj_1", null,
            [{ role: "user", content: "shorter please" }],
            workflow(), [],
        );
        expect(result).toBe("Be extra concise.");
    });

    it("tracks LLM usage with inputTokens/outputTokens mapped from the provider's prompt/completion tokens", async () => {
        objectUsage = { prompt_tokens: 777, completion_tokens: 88 };
        const tracker = new UsageTracker();
        await getEditAgentInstructionsResponse(
            tracker, "proj_1", null,
            [{ role: "user", content: "hi" }],
            workflow(), [],
        );
        expect(tracker.flush()).toEqual([{
            type: "LLM_USAGE",
            modelName: "gpt-4.1",
            inputTokens: 777,
            outputTokens: 88,
            context: "copilot.llm_usage",
        }]);
    });
});

describe("streamMultiAgentResponse", () => {
    beforeEach(() => {
        streamCaptured.length = 0;
        streamRequestCount = 0;
        toolCallHops = [];
        finalText = "Here are the tools.";
    });

    async function turn(messages: unknown[], dataSources: unknown[] = [], triggers: unknown[] = []) {
        const tracker = new UsageTracker();
        const events: Record<string, unknown>[] = [];
        for await (const e of streamMultiAgentResponse(
            tracker, "proj_1", null, messages as never, workflow(), dataSources as never, triggers as never,
        )) {
            events.push(e as Record<string, unknown>);
        }
        return { events, tracked: tracker.flush() };
    }

    describe("a plain text turn", () => {
        it("sends both copilot tools every turn with tool_choice auto and streaming enabled", async () => {
            await turn([{ role: "user", content: "hello" }]);

            expect(streamCaptured).toHaveLength(1);
            const req = streamCaptured[0].body;
            expect(req.tool_choice).toBe("auto");
            expect(req.stream).toBe(true);

            const tools = req.tools as Array<{ function: { name: string; parameters: unknown } }>;
            const names = tools.map((t) => t.function.name).sort();
            expect(names).toEqual(["search_relevant_tools", "search_relevant_triggers"]);

            const searchTools = tools.find((t) => t.function.name === "search_relevant_tools")!;
            expect(searchTools.function.parameters).toMatchObject({
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            });

            const searchTriggers = tools.find((t) => t.function.name === "search_relevant_triggers")!;
            expect(searchTriggers.function.parameters).toMatchObject({
                type: "object",
                properties: { toolkitSlug: { type: "string" }, query: { type: "string" } },
                required: ["toolkitSlug"],
            });
        });

        it("yields one plain-content event per text delta, with no discriminating type field", async () => {
            finalText = "Sure, happy to help.";
            const { events } = await turn([{ role: "user", content: "hello" }]);
            expect(events).toEqual([{ content: "Sure, happy to help." }]);
        });

        it("tracks one LLM_USAGE entry for the single step, inputTokens/outputTokens mapped correctly", async () => {
            const { tracked } = await turn([{ role: "user", content: "hello" }]);
            expect(tracked).toEqual([{
                type: "LLM_USAGE",
                modelName: "gpt-4.1",
                inputTokens: 301,
                outputTokens: 11,
                context: "copilot.llm_usage",
            }]);
        });
    });

    describe("a tool-call turn (search_relevant_tools)", () => {
        beforeEach(() => {
            toolCallHops = [{ id: "call_1", name: "search_relevant_tools", args: { query: "gmail" } }];
        });

        it("round-trips two requests: the tool call, then the final answer", async () => {
            await turn([{ role: "user", content: "find me a gmail tool" }]);
            expect(streamCaptured).toHaveLength(2);
        });

        it("yields a tool-call event with the parsed args and a query shortcut, then a tool-result event", async () => {
            const { events } = await turn([{ role: "user", content: "find me a gmail tool" }]);
            expect(events).toEqual([
                {
                    type: "tool-call",
                    toolName: "search_relevant_tools",
                    toolCallId: "call_1",
                    args: { query: "gmail" },
                    query: "gmail",
                },
                {
                    type: "tool-result",
                    toolCallId: "call_1",
                    // USE_COMPOSIO_TOOLS is unset in this env, so the real Composio
                    // search is never attempted -- this is the real, deterministic
                    // fallback behaviour, not a stub for the test.
                    result: "No tools found!",
                },
                { content: "Here are the tools." },
            ]);
        });

        it("tracks one LLM_USAGE entry per step (two steps for a one-hop tool call)", async () => {
            const { tracked } = await turn([{ role: "user", content: "find me a gmail tool" }]);
            expect(tracked).toEqual([
                { type: "LLM_USAGE", modelName: "gpt-4.1", inputTokens: 201, outputTokens: 21, context: "copilot.llm_usage" },
                { type: "LLM_USAGE", modelName: "gpt-4.1", inputTokens: 302, outputTokens: 12, context: "copilot.llm_usage" },
            ]);
        });
    });

    describe("a tool-call turn (search_relevant_triggers)", () => {
        beforeEach(() => {
            toolCallHops = [{ id: "call_2", name: "search_relevant_triggers", args: { toolkitSlug: "gmail", query: "new email" } }];
        });

        it("yields the tool's real (feature-flag-gated) unavailable message, not a mock", async () => {
            const { events } = await turn([{ role: "user", content: "any gmail triggers?" }]);
            expect(events[0]).toEqual({
                type: "tool-call",
                toolName: "search_relevant_triggers",
                toolCallId: "call_2",
                args: { toolkitSlug: "gmail", query: "new email" },
                query: "new email",
            });
            expect(events[1]).toEqual({
                type: "tool-result",
                toolCallId: "call_2",
                result: "Trigger search is currently unavailable.",
            });
        });
    });

    describe("prompt assembly", () => {
        it("embeds the workflow, data sources, and triggers into the last user message, in a fixed order", async () => {
            await turn(
                [{ role: "user", content: "what do we have" }],
                [{ id: "ds_1", name: "Docs", description: "desc", data: { type: "text" } }],
                [{ id: "trig_1", type: "one_time", name: "Reminder", nextRunAt: "2026-09-01T00:00:00.000Z", input: {}, status: "pending" }],
            );

            const req = streamCaptured[0].body;
            const messages = req.messages as Array<{ role: string; content: string }>;
            const userContent = messages[messages.length - 1].content;

            expect(userContent).toContain('"startAgent":"assistant"'); // current workflow prompt
            expect(userContent).toContain('"name":"Docs"'); // data sources prompt
            expect(userContent).toContain('"name":"Reminder"'); // triggers prompt
            expect(userContent).toContain("**CURRENT TIME**");
            expect(userContent).toContain('User: "what do we have"');

            // Fixed order: workflow, then context (empty here), then data sources, then time, then triggers, then the user's own message.
            const workflowIdx = userContent.indexOf('"startAgent"');
            const dataSourcesIdx = userContent.indexOf('"name":"Docs"');
            const timeIdx = userContent.indexOf("**CURRENT TIME**");
            const triggersIdx = userContent.indexOf('"name":"Reminder"');
            const userIdx = userContent.indexOf('User: "what do we have"');
            expect(workflowIdx).toBeLessThan(dataSourcesIdx);
            expect(dataSourcesIdx).toBeLessThan(timeIdx);
            expect(timeIdx).toBeLessThan(triggersIdx);
            expect(triggersIdx).toBeLessThan(userIdx);
        });
    });
});
